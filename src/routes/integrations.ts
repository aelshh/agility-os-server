import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import { dailyCheckinSchedules, drills, orgs, telenowWebhooks, users } from "../db/schema.js";
import { decryptSecret, encryptSecret, maskApiKey } from "../lib/crypto.js";
import {
  getTelenowClientForOrg,
  TelenowClient,
  TelenowError,
  TelenowNotConfiguredError,
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

const assignNumberSchema = z.object({
  courseId: z.string().uuid("Invalid course id"),
});

const NUMBER_VIEW_ROLES = [
  "architect",
  "content_curator",
  "field_coach",
  "quality_gate",
  "strategist",
  "talent_steward",
] as const;

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

// ---------------------------------------------------------------------------
// GET /api/org/numbers — List workspace phone numbers enriched with course mappings
// ---------------------------------------------------------------------------

router.get(
  "/numbers",
  requireAuth,
  requireRole(...NUMBER_VIEW_ROLES),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    try {
      let clientObj;
      try {
        clientObj = await getTelenowClientForOrg(user.orgId);
      } catch (err) {
        if (err instanceof TelenowNotConfiguredError) {
          res.status(200).json({ numbers: [], total: 0 });
          return;
        }
        throw err;
      }

      const { client, telenowOrgId } = clientObj;
      const { numbers, total } = await client.listNumbers(telenowOrgId);

      // Fetch all courses in this organization to match phone mappings
      const orgCourses = await db
        .select({
          id: drills.id,
          title: drills.title,
          status: drills.status,
          telenowAgentId: drills.telenowAgentId,
          phoneNumberId: drills.phoneNumberId,
          phoneNumber: drills.phoneNumber,
        })
        .from(drills)
        .where(eq(drills.orgId, user.orgId));

      const courseByAgentId = new Map<string, (typeof orgCourses)[0]>();
      const courseByNumberId = new Map<string, (typeof orgCourses)[0]>();

      for (const c of orgCourses) {
        if (c.telenowAgentId) courseByAgentId.set(c.telenowAgentId, c);
        if (c.phoneNumberId) courseByNumberId.set(c.phoneNumberId, c);
      }

      // Fetch all check-in schedules in this organization to match phone mappings
      const orgCheckins = await db
        .select({
          id: dailyCheckinSchedules.id,
          title: dailyCheckinSchedules.title,
          phoneNumberId: dailyCheckinSchedules.phoneNumberId,
          telenowAgentId: dailyCheckinSchedules.telenowAgentId,
          ownerName: users.name,
        })
        .from(dailyCheckinSchedules)
        .leftJoin(users, eq(dailyCheckinSchedules.ownerUserId, users.id))
        .where(eq(dailyCheckinSchedules.orgId, user.orgId));

      const checkinByAgentId = new Map<string, (typeof orgCheckins)[0]>();
      const checkinByNumberId = new Map<string, (typeof orgCheckins)[0]>();

      for (const ch of orgCheckins) {
        if (ch.telenowAgentId) checkinByAgentId.set(ch.telenowAgentId, ch);
        if (ch.phoneNumberId) checkinByNumberId.set(ch.phoneNumberId, ch);
      }

      const enrichedNumbers = numbers.map((num) => {
        const matchedCourse =
          (num.agentId ? courseByAgentId.get(num.agentId) : null) ??
          courseByNumberId.get(num.id) ??
          null;

        const matchedCheckin =
          (num.agentId ? checkinByAgentId.get(num.agentId) : null) ??
          checkinByNumberId.get(num.id) ??
          null;

        return {
          ...num,
          assignedCourse: matchedCourse
            ? {
                id: matchedCourse.id,
                title: matchedCourse.title,
                status: matchedCourse.status,
                telenowAgentId: matchedCourse.telenowAgentId,
              }
            : null,
          assignedCheckin: matchedCheckin
            ? {
                id: matchedCheckin.id,
                title: matchedCheckin.title,
                ownerName: matchedCheckin.ownerName ?? null,
              }
            : null,
        };
      });

      res.status(200).json({
        numbers: enrichedNumbers,
        total: total || enrichedNumbers.length,
      });
    } catch (err) {
      console.error("[integrations] GET /numbers error:", err);
      res.status(500).json({
        message: (err as Error).message || "Failed to load phone numbers.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/org/numbers/:id/assign — Assign a phone number to a course agent
// ---------------------------------------------------------------------------

router.post(
  "/numbers/:id/assign",
  requireAuth,
  requireRole("architect", "content_curator"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    const parseRes = assignNumberSchema.safeParse(req.body);
    if (!parseRes.success) {
      res.status(400).json({
        message: parseRes.error.issues[0]?.message ?? "Invalid request body.",
      });
      return;
    }

    const { courseId } = parseRes.data;
    const numberId = String(req.params["id"] ?? "");
    if (!numberId) {
      res.status(400).json({ message: "Number ID is required." });
      return;
    }

    try {
      const { client, telenowOrgId } = await getTelenowClientForOrg(user.orgId);

      const [course] = await db
        .select()
        .from(drills)
        .where(and(eq(drills.id, courseId), eq(drills.orgId, user.orgId)))
        .limit(1);

      if (!course) {
        res.status(404).json({ message: "Course not found." });
        return;
      }

      const { numbers } = await client.listNumbers(telenowOrgId);
      const targetNumber = numbers.find((n) => n.id === numberId);
      if (!targetNumber) {
        res.status(404).json({ message: "Phone number not found in workspace." });
        return;
      }

      // If course is already published and has an agent ID, bind immediately on carrier
      if (course.telenowAgentId) {
        try {
          await client.assignNumberAgent(
            numberId,
            course.telenowAgentId,
            telenowOrgId,
          );
        } catch (assignErr) {
          const errMsg = (assignErr as Error).message || "";
          if (
            errMsg.includes("409") ||
            errMsg.includes("Conflict") ||
            errMsg.includes("allocated")
          ) {
            res.status(409).json({
              message:
                "This number is currently allocated to a team member or another inbound line. Please unallocate it first.",
            });
            return;
          }
          throw assignErr;
        }
      }

      // Clear any other course in this org that was using this phone number
      await db
        .update(drills)
        .set({ phoneNumberId: null, phoneNumber: null })
        .where(
          and(
            eq(drills.orgId, user.orgId),
            eq(drills.phoneNumberId, numberId),
          ),
        );

      // Update the targeted course with this number
      await db
        .update(drills)
        .set({
          phoneNumberId: targetNumber.id,
          phoneNumber: targetNumber.e164,
        })
        .where(eq(drills.id, course.id));

      res.status(200).json({
        success: true,
        message: `Assigned ${targetNumber.e164} to ${course.title}`,
        numberId: targetNumber.id,
        phoneNumber: targetNumber.e164,
        courseId: course.id,
        courseTitle: course.title,
      });
    } catch (err) {
      console.error("[integrations] POST /numbers/:id/assign error:", err);
      res.status(500).json({
        message: (err as Error).message || "Failed to assign phone number.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/org/numbers/:id/agent — Unassign agent from a phone number
// ---------------------------------------------------------------------------

router.delete(
  "/numbers/:id/agent",
  requireAuth,
  requireRole("architect", "content_curator"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    const numberId = String(req.params["id"] ?? "");
    if (!numberId) {
      res.status(400).json({ message: "Number ID is required." });
      return;
    }

    try {
      const { client, telenowOrgId } = await getTelenowClientForOrg(user.orgId);

      await client.unassignNumberAgent(numberId, telenowOrgId);

      // Clear DB references to this number
      await db
        .update(drills)
        .set({ phoneNumberId: null, phoneNumber: null })
        .where(
          and(
            eq(drills.orgId, user.orgId),
            eq(drills.phoneNumberId, numberId),
          ),
        );

      res.status(200).json({
        success: true,
        message: "Course agent unassigned from phone number.",
      });
    } catch (err) {
      console.error("[integrations] DELETE /numbers/:id/agent error:", err);
      res.status(500).json({
        message: (err as Error).message || "Failed to unassign phone number.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/org/numbers/connection-status — Check carrier connection health
// ---------------------------------------------------------------------------

router.get(
  "/numbers/connection-status",
  requireAuth,
  requireRole(...NUMBER_VIEW_ROLES),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    try {
      const { client, telenowOrgId } = await getTelenowClientForOrg(user.orgId);
      const statuses = await client.checkNumberConnections(telenowOrgId);
      res.status(200).json({ connections: statuses });
    } catch (err) {
      console.error("[integrations] GET /numbers/connection-status error:", err);
      res.status(500).json({
        message:
          (err as Error).message || "Failed to check connection status.",
      });
    }
  },
);

export const orgIntegrationsRouter = router;
