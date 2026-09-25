import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import { orgs, telenowWebhooks } from "../db/schema.js";
import { decryptSecret, encryptSecret, maskApiKey } from "../lib/crypto.js";
import {
  TelenowClient,
  validateTelenowApiKey,
} from "../lib/telenow.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

const APP_BASE_URL = process.env["APP_BASE_URL"] ?? "http://localhost:3000";
const WEBHOOK_BASE_PATH = "/api/webhooks/telenow";

const apiKeySchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(1, "Telenow API key is required")
    .max(500, "API key is too long"),
});

// ---------------------------------------------------------------------------
// GET /api/org/telenow — View Telenow integration status (Architect only)
// ---------------------------------------------------------------------------

router.get(
  "/telenow",
  requireAuth,
  requireRole("architect"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    try {
      const [org] = await db
        .select({
          telenowApiKey: orgs.telenowApiKey,
          telenowOrgId: orgs.telenowOrgId,
          telenowConnectedAt: orgs.telenowConnectedAt,
        })
        .from(orgs)
        .where(eq(orgs.id, user.orgId))
        .limit(1);

      if (!org || !org.telenowApiKey) {
        res.status(200).json({
          configured: false,
          maskedKey: null,
          telenowOrgId: null,
          connectedAt: null,
          webhookRegistered: false,
        });
        return;
      }

      const plainKey = decryptSecret(org.telenowApiKey);
      const [webhook] = await db
        .select({ id: telenowWebhooks.id })
        .from(telenowWebhooks)
        .where(eq(telenowWebhooks.orgId, user.orgId))
        .limit(1);

      res.status(200).json({
        configured: true,
        maskedKey: maskApiKey(plainKey),
        telenowOrgId: org.telenowOrgId,
        connectedAt: org.telenowConnectedAt,
        webhookRegistered: Boolean(webhook),
      });
    } catch (err) {
      console.error("[integrations] GET /telenow error:", err);
      res.status(500).json({ message: "Failed to fetch Telenow status." });
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /api/org/telenow — Connect or update Telenow API key (Architect only)
// ---------------------------------------------------------------------------

router.put(
  "/telenow",
  requireAuth,
  requireRole("architect"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    const parseResult = apiKeySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        message: parseResult.error.issues[0]?.message ?? "Invalid API key format.",
      });
      return;
    }

    const { apiKey } = parseResult.data;

    try {
      // 1. Validate key against Telenow GET /api/v1/me
      const validation = await validateTelenowApiKey(apiKey);
      if (!validation.valid || !validation.telenowOrgId) {
        res.status(400).json({
          message:
            validation.error ??
            "Could not validate Telenow API key. Please ensure it is an active API key with access to Telenow.",
        });
        return;
      }

      const telenowOrgId = validation.telenowOrgId;
      const encryptedKey = encryptSecret(apiKey);
      const now = new Date();

      // 2. Persist encrypted key to orgs table
      await db
        .update(orgs)
        .set({
          telenowApiKey: encryptedKey,
          telenowOrgId,
          telenowConnectedAt: now,
        })
        .where(eq(orgs.id, user.orgId));

      // 3. Register or update the webhook endpoint on Telenow
      const targetUrl = `${APP_BASE_URL.replace(/\/+$/, "")}${WEBHOOK_BASE_PATH}/${user.orgId}`;
      let webhookRegistered = false;

      try {
        const client = new TelenowClient(apiKey);
        const { telenowHookId, signingSecret } = await client.registerWebhook({
          targetUrl,
          events: ["call.ended", "call.analyzed"],
          telenowOrgId,
        });

        await db
          .insert(telenowWebhooks)
          .values({
            orgId: user.orgId,
            telenowHookId,
            targetUrl,
            signingSecret,
          })
          .onConflictDoUpdate({
            target: telenowWebhooks.orgId,
            set: {
              telenowHookId,
              targetUrl,
              signingSecret,
              createdAt: now,
            },
          });

        webhookRegistered = true;
      } catch (webhookErr) {
        console.warn(
          "[integrations] Webhook registration warning during key connect:",
          (webhookErr as Error).message,
        );
      }

      res.status(200).json({
        message: "Telenow Voice AI connected successfully.",
        configured: true,
        maskedKey: maskApiKey(apiKey),
        telenowOrgId,
        connectedAt: now,
        webhookRegistered,
      });
    } catch (err) {
      console.error("[integrations] PUT /telenow error:", err);
      res.status(500).json({ message: "Failed to connect Telenow API key." });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/org/telenow — Disconnect Telenow integration (Architect only)
// ---------------------------------------------------------------------------

router.delete(
  "/telenow",
  requireAuth,
  requireRole("architect"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    try {
      await db
        .update(orgs)
        .set({
          telenowApiKey: null,
          telenowOrgId: null,
          telenowConnectedAt: null,
        })
        .where(eq(orgs.id, user.orgId));

      await db
        .delete(telenowWebhooks)
        .where(eq(telenowWebhooks.orgId, user.orgId));

      res.status(200).json({
        message: "Telenow Voice AI integration disconnected.",
        configured: false,
      });
    } catch (err) {
      console.error("[integrations] DELETE /telenow error:", err);
      res.status(500).json({ message: "Failed to disconnect Telenow." });
    }
  },
);

export const orgIntegrationsRouter = router;
