import { Router } from "express";
import { z } from "zod";
import { getTelenowClientForOrg, TelenowNotConfiguredError } from "../lib/telenow.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

const testMessageSchema = z.object({
  to: z.string().min(1, "Phone number is required"),
  channelId: z.string().optional(),
  message: z.string().optional(),
});

const createSessionSchema = z.object({
  label: z.string().max(100).optional(),
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
      const { client, telenowOrgId } = await getTelenowClientForOrg(user.orgId);
      const channels = await client.listWhatsAppChannels(telenowOrgId);
      res.status(200).json({ channels });
    } catch (err) {
      if (err instanceof TelenowNotConfiguredError) {
        res.status(200).json({ channels: [] });
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

    const { to, channelId, message } = parseResult.data;

    try {
      const { client, telenowOrgId } = await getTelenowClientForOrg(user.orgId);
      const defaultText =
        "👋 Hello from AgilityOS! Your WhatsApp channel is connected and ready to deliver coaching updates, reminders, and learning materials.";
      const sendPayload: {
        to: string;
        channelId?: string;
        message?: string;
      } = {
        to,
        message: message?.trim() || defaultText,
      };
      if (channelId) {
        sendPayload.channelId = channelId;
      }

      const result = await client.sendWhatsAppMessage(
        sendPayload,
        telenowOrgId,
      );

      res.status(200).json({
        success: true,
        wamid: result.wamid,
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
