import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { orgs } from "../db/schema.js";
import { getTelenowClientForOrg, TelenowNotConfiguredError } from "../lib/telenow.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

const testMessageSchema = z.object({
  to: z.string().min(1, "Phone number is required"),
  channelId: z.string().optional(),
  template: z.string().optional(),
  message: z.string().optional(),
});

const createSessionSchema = z.object({
  label: z.string().max(100).optional(),
});

const setDefaultChannelSchema = z.object({
  channelId: z.string().min(1, "Channel ID is required"),
});

// ---------------------------------------------------------------------------
// GET /api/org/whatsapp/channels — List active connected WhatsApp channels
// ---------------------------------------------------------------------------
router.get(
  "/channels",
  requireAuth,
  requireRole("architect"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    try {
      const [orgRow] = await db
        .select({ defaultWhatsappChannelId: orgs.defaultWhatsappChannelId })
        .from(orgs)
        .where(eq(orgs.id, user.orgId))
        .limit(1);

      const defaultChannelId = orgRow?.defaultWhatsappChannelId ?? null;

      const { client, telenowOrgId } = await getTelenowClientForOrg(user.orgId);
      const channels = await client.listWhatsAppChannels(telenowOrgId);
      res.status(200).json({
        channels,
        defaultChannelId,
      });
    } catch (err) {
      if (err instanceof TelenowNotConfiguredError) {
        res.status(200).json({ channels: [], defaultChannelId: null });
        return;
      }
      console.error("[whatsapp] GET /channels error:", err);
      res.status(500).json({
        message: (err as Error).message || "Failed to fetch WhatsApp channels.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /api/org/whatsapp/default-channel — Set organization default sending channel
// ---------------------------------------------------------------------------
router.put(
  "/default-channel",
  requireAuth,
  requireRole("architect"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    const parseResult = setDefaultChannelSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        message: parseResult.error.issues[0]?.message || "Invalid channel ID",
      });
      return;
    }

    const { channelId } = parseResult.data;

    try {
      await db
        .update(orgs)
        .set({ defaultWhatsappChannelId: channelId })
        .where(eq(orgs.id, user.orgId));

      res.status(200).json({
        success: true,
        defaultChannelId: channelId,
        message: "Default WhatsApp sending channel updated.",
      });
    } catch (err) {
      console.error("[whatsapp] PUT /default-channel error:", err);
      res.status(500).json({
        message: (err as Error).message || "Failed to update default WhatsApp channel.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/org/whatsapp/sessions — Create new QR pairing session
// ---------------------------------------------------------------------------
router.post(
  "/sessions",
  requireAuth,
  requireRole("architect"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    const parseResult = createSessionSchema.safeParse(req.body);
    const label = parseResult.success ? parseResult.data.label : undefined;

    try {
      const { client, telenowOrgId } = await getTelenowClientForOrg(user.orgId);
      const session = await client.createWhatsAppSession(label, telenowOrgId);
      res.status(200).json(session);
    } catch (err) {
      console.error("[whatsapp] POST /sessions error:", err);
      res.status(500).json({
        message: (err as Error).message || "Failed to initiate WhatsApp QR session.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/org/whatsapp/sessions/:sessionId — Get pairing session status & QR
// ---------------------------------------------------------------------------
router.get(
  "/sessions/:sessionId",
  requireAuth,
  requireRole("architect"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    const sessionId = String(req.params["sessionId"] ?? "");
    if (!sessionId) {
      res.status(400).json({ message: "Session ID is required." });
      return;
    }

    try {
      const { client, telenowOrgId } = await getTelenowClientForOrg(user.orgId);
      const session = await client.getWhatsAppSession(sessionId, telenowOrgId);
      res.status(200).json(session);
    } catch (err) {
      console.error(`[whatsapp] GET /sessions/${sessionId} error:`, err);
      res.status(500).json({
        message: (err as Error).message || "Failed to retrieve session status.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/org/whatsapp/sessions/:sessionId — Cancel/delete pairing session
// ---------------------------------------------------------------------------
router.delete(
  "/sessions/:sessionId",
  requireAuth,
  requireRole("architect"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    const sessionId = String(req.params["sessionId"] ?? "");
    if (!sessionId) {
      res.status(400).json({ message: "Session ID is required." });
      return;
    }

    try {
      const { client, telenowOrgId } = await getTelenowClientForOrg(user.orgId);
      await client.deleteWhatsAppSession(sessionId, telenowOrgId);
      res.status(200).json({ success: true, message: "Session closed." });
    } catch (err) {
      console.error(`[whatsapp] DELETE /sessions/${sessionId} error:`, err);
      res.status(500).json({
        message: (err as Error).message || "Failed to delete session.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/org/whatsapp/channels/:channelId — Disconnect a WhatsApp channel
// ---------------------------------------------------------------------------
router.delete(
  "/channels/:channelId",
  requireAuth,
  requireRole("architect"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    const channelId = String(req.params["channelId"] ?? "");
    if (!channelId) {
      res.status(400).json({ message: "Channel ID is required." });
      return;
    }

    try {
      const { client, telenowOrgId } = await getTelenowClientForOrg(user.orgId);
      await client.deleteWhatsAppChannel(channelId, telenowOrgId);
      res.status(200).json({ success: true, message: "WhatsApp channel disconnected." });
    } catch (err) {
      console.error(`[whatsapp] DELETE /channels/${channelId} error:`, err);
      res.status(500).json({
        message: (err as Error).message || "Failed to disconnect WhatsApp channel.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/org/whatsapp/templates — List approved templates for a channel
// ---------------------------------------------------------------------------
router.get(
  "/templates",
  requireAuth,
  requireRole("architect"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    const channelId = typeof req.query["channelId"] === "string" ? req.query["channelId"] : undefined;

    try {
      const { client, telenowOrgId } = await getTelenowClientForOrg(user.orgId);
      let targetChannelId = channelId;

      if (!targetChannelId) {
        const channels = await client.listWhatsAppChannels(telenowOrgId);
        if (channels.length > 0 && channels[0]?.id) {
          targetChannelId = channels[0].id;
        }
      }

      if (!targetChannelId) {
        res.status(200).json({ templates: [] });
        return;
      }

      const templates = await client.listWhatsAppTemplates(targetChannelId, telenowOrgId);
      res.status(200).json({ templates });
    } catch (err) {
      if (err instanceof TelenowNotConfiguredError) {
        res.status(200).json({ templates: [] });
        return;
      }
      console.error("[whatsapp] GET /templates error:", err);
      res.status(500).json({
        message: (err as Error).message || "Failed to fetch templates.",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/org/whatsapp/test-message — Send test verification message
// ---------------------------------------------------------------------------
router.post(
  "/test-message",
  requireAuth,
  requireRole("architect"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res.status(400).json({ message: "Organisation context is required." });
      return;
    }

    const parseResult = testMessageSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        message: parseResult.error.issues[0]?.message || "Invalid input",
      });
      return;
    }

    const { to, channelId, template, message } = parseResult.data;

    try {
      const { client, telenowOrgId, org } = await getTelenowClientForOrg(user.orgId);
      const recipientName = user.name?.trim() || "Team";
      const orgName = org.name?.trim() || "AgilityOS";

      let wamid: string;

      // Determine template to use (intercepts the legacy default string as channel_connection_test)
      const isLegacyDefaultText =
        Boolean(message && message.includes("Hello from AgilityOS! Your WhatsApp channel is connected"));

      const chosenTemplate =
        template?.trim() ||
        (!message || isLegacyDefaultText ? "channel_connection_test" : null);

      if (chosenTemplate === "course_schedule_reminder") {
        const tplRes = await client.sendWhatsAppTemplate(
          {
            channelId,
            to,
            template: "course_schedule_reminder",
            language: "en_US",
            variables: [recipientName, "Sales Practice Drill", "10:00 – 12:00 (UTC)", "Be ready for practice!"],
          },
          telenowOrgId,
        );
        wamid = tplRes.wamid;
      } else if (chosenTemplate === "course_learning_resource") {
        const tplRes = await client.sendWhatsAppTemplate(
          {
            channelId,
            to,
            template: "course_learning_resource",
            language: "en_US",
            variables: [recipientName, "Enterprise Objection Handling", "Objection Handling Guide", "Review before your call", "https://app.agilityos.ai"],
          },
          telenowOrgId,
        );
        wamid = tplRes.wamid;
      } else if (chosenTemplate === "practice_call_feedback") {
        const tplRes = await client.sendWhatsAppTemplate(
          {
            channelId,
            to,
            template: "practice_call_feedback",
            language: "en_US",
            variables: [recipientName, "Enterprise Objection Handling", "88", "45% Rep / 55% AI", "Keep deliberate practice active."],
          },
          telenowOrgId,
        );
        wamid = tplRes.wamid;
      } else if (chosenTemplate === "channel_connection_test" || !message) {
        const tplRes = await client.sendWhatsAppTemplate(
          {
            channelId,
            to,
            template: "channel_connection_test",
            language: "en_US",
            variables: [recipientName, orgName],
          },
          telenowOrgId,
        );
        wamid = tplRes.wamid;
      } else {
        // Free-form text was explicitly requested with a custom string
        const sendRes = await client.sendWhatsAppMessage(
          {
            to,
            channelId,
            message: message.trim(),
          },
          telenowOrgId,
        );
        wamid = sendRes.wamid;
      }

      res.status(200).json({
        success: true,
        wamid,
        message: "Test message dispatched successfully!",
      });
    } catch (err) {
      console.error("[whatsapp] POST /test-message error:", err);
      res.status(500).json({
        message: (err as Error).message || "Failed to dispatch test message.",
      });
    }
  },
);

export const whatsappRouter = router;
