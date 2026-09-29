/**
 * Telenow webhook receiver.
 *
 * Mounted at POST /api/webhooks, BEFORE the global JSON body parser
 * (see index.ts) — Telenow's HMAC-SHA256 signature covers the raw request
 * bytes, so the body must be consumed as a Buffer.
 *
 * Supports both organizational-scoped path (/api/webhooks/telenow/:orgId)
 * and legacy/fallback path (/api/webhooks/telenow).
 *
 * Contract (Telenow "Webhook events" reference):
 *   - Header `X-VoiceAI-Signature: sha256=<hex>` — HMAC-SHA256 of the raw body
 *     with the endpoint signing secret.
 *   - Header `X-VoiceAI-Delivery` — stable across retries; de-duplicate on it.
 *   - Header `X-VoiceAI-Event` — the event type.
 *   - Deliveries are at-least-once and out of order; processing is idempotent.
 *   - `occurredAt` is present on every event — reject outside our replay window.
 *   - Always reply 2xx (a 410 disables the endpoint for every subscription).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, or } from "drizzle-orm";
import express, { Router } from "express";

import { db } from "../db/index.js";
import { courseEnrollments, dailyCheckins } from "../db/schema.js";
import { loadWebhookSigningSecret } from "../lib/provisionCourse.js";
import { generateCheckinSummary } from "../lib/ai/prompts.js";

const router = Router();

const SIGNATURE_ALG = "sha256";
const REPLAY_FUTURE_MS = 5 * 60 * 1000;
const REPLAY_PAST_MS = 2 * 60 * 60 * 1000;

// At-least-once delivery -> duplicates are routine. In-memory dedupe with a
// TTL; safe for a single-instance deployment.
const seenDeliveries = new Map<string, number>();
const DEDUPE_TTL_MS = 10 * 60 * 1000;

function isDuplicate(deliveryId: string): boolean {
  const now = Date.now();
  const expiry = seenDeliveries.get(deliveryId);
  if (expiry !== undefined && expiry > now) return true;
  if (seenDeliveries.size > 5000) {
    for (const [id, expireAt] of seenDeliveries) {
      if (expireAt <= now) seenDeliveries.delete(id);
    }
  }
  seenDeliveries.set(deliveryId, now + DEDUPE_TTL_MS);
  return false;
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

type EnrollmentUpdate = Partial<typeof courseEnrollments.$inferInsert>;

router.post(
  ["/telenow/:orgId", "/telenow"],
  express.raw({ type: "*/*", limit: "6mb" }),
  async (req, res) => {
    const rawBody: Buffer = req.body;
    const orgId =
      (typeof req.params["orgId"] === "string" && req.params["orgId"].length > 0
        ? req.params["orgId"]
        : null) ||
      (typeof req.query["orgId"] === "string" && req.query["orgId"].length > 0
        ? req.query["orgId"]
        : null);

    // -- Signature verification (raw bytes) --------------------------------
    const secret = await loadWebhookSigningSecret(orgId ?? undefined);
    const signatureHeader = req.headers["x-voiceai-signature"];
    const signature =
      typeof signatureHeader === "string" ? signatureHeader.trim() : "";
    const [, signatureHex] = signature.split("=");

    if (!secret || !signature.toLowerCase().startsWith(`${SIGNATURE_ALG}=`)) {
      res.status(401).json({ message: "Missing or invalid signature." });
      return;
    }
    if (!signatureHex) {
      res.status(401).json({ message: "Missing or invalid signature." });
      return;
    }

    const expected = createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    if (!safeEqualHex(signatureHex, expected)) {
      res.status(401).json({ message: "Signature verification failed." });
      return;
    }

    let payload: Record<string, unknown> | null = null;
    try {
      payload = asObj(JSON.parse(rawBody.toString("utf8")));
    } catch {
      res.status(400).json({ message: "Malformed JSON body." });
      return;
    }
    if (!payload) {
      res.status(400).json({ message: "Expected a JSON object." });
      return;
    }

    // -- Replay window ------------------------------------------------------
    console.log("[Webhook] Received event:", payload["event"]);
    console.log("[Webhook] Payload:", JSON.stringify(payload, null, 2));

    const occurredAtStr = asString(payload["occurredAt"]);
    if (occurredAtStr) {
      const occurredAt = new Date(occurredAtStr).getTime();
      const now = Date.now();
      if (
        !Number.isFinite(occurredAt) ||
        occurredAt > now + REPLAY_FUTURE_MS ||
        occurredAt < now - REPLAY_PAST_MS
      ) {
        res.status(400).json({ message: "Event is outside the accepted window." });
        return;
      }
    }

    // -- De-duplicate on delivery id ----------------------------------------
    const deliveryId =
      asString(req.headers["x-voiceai-delivery"]) ?? asString(payload["delivery"]);
    if (deliveryId && isDuplicate(deliveryId)) {
      res.status(200).json({ message: "duplicate" });
      return;
    }

    // -- Route by event type -------------------------------------------------
    const eventType =
      asString(req.headers["x-voiceai-event"]) ?? asString(payload["event"]);

    if (eventType === "call.ended") {
      const handled =
        (await handleCallEnded(payload, orgId)) ||
        (await handleCheckinCallEnded(payload, orgId));
      void handled;
    } else if (eventType === "call.analyzed") {
      const handled =
        (await handleCallAnalyzed(payload, orgId)) ||
        (await handleCheckinCallAnalyzed(payload, orgId));
      void handled;
    }

    res.status(200).json({ message: "ok" });
  },
);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function findEnrollment(
  payload: Record<string, unknown>,
  orgId?: string | null,
): Promise<{ id: string; status: string } | null> {
  const identifier = asString(payload["identifier"]);
  const sessionId = asString(payload["sessionId"]);

  if (!identifier && !sessionId) return null;

  const conditions = [];
  if (identifier) conditions.push(eq(courseEnrollments.id, identifier));
  if (sessionId)
    conditions.push(eq(courseEnrollments.telenowSessionId, sessionId));

  const whereList = [or(...conditions)!];
  if (orgId) {
    whereList.push(eq(courseEnrollments.orgId, orgId));
  }

  const [row] = await db
    .select({ id: courseEnrollments.id, status: courseEnrollments.status })
    .from(courseEnrollments)
    .where(and(...whereList))
    .limit(1);

  return row ?? null;
}

function parseTranscript(
  val: unknown,
): Array<{ role: string; text: string; at?: string }> | null {
  if (!Array.isArray(val)) return null;
  const turns: Array<{ role: string; text: string; at?: string }> = [];
  for (const item of val) {
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const role = typeof obj["role"] === "string" ? obj["role"] : "speaker";
      const text = typeof obj["text"] === "string" ? obj["text"] : "";
      const at = typeof obj["at"] === "string" ? obj["at"] : undefined;
      if (text.trim().length > 0) {
        if (at !== undefined) {
          turns.push({ role, text, at });
        } else {
          turns.push({ role, text });
        }
      }
    }
  }
  return turns.length > 0 ? turns : null;
}

function parseTalkRatio(val: unknown): {
  agentWords: number;
  customerWords: number;
  agentTurns: number;
  customerTurns: number;
} | null {
  const obj = asObj(val);
  if (!obj) return null;
  return {
    agentWords: asNumber(obj["agentWords"]) ?? 0,
    customerWords: asNumber(obj["customerWords"]) ?? 0,
    agentTurns: asNumber(obj["agentTurns"]) ?? 0,
    customerTurns: asNumber(obj["customerTurns"]) ?? 0,
  };
}

function parseQaScorecard(
  val: unknown,
): Array<{ key: string; met: boolean; evidence: string }> | null {
  if (!Array.isArray(val)) return null;
  const list: Array<{ key: string; met: boolean; evidence: string }> = [];
  for (const item of val) {
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const key =
        typeof obj["key"] === "string"
          ? obj["key"]
          : typeof obj["name"] === "string"
            ? obj["name"]
            : "Criterion";
      const met = Boolean(obj["met"] ?? obj["passed"] ?? obj["result"]);
      const evidence =
        typeof obj["evidence"] === "string"
          ? obj["evidence"]
          : typeof obj["quote"] === "string"
            ? obj["quote"]
            : "";
      list.push({ key, met, evidence });
    }
  }
  return list.length > 0 ? list : null;
}

function parseCoachingTips(
  val: unknown,
): Array<{ issue: string; suggestion: string; severity: "low" | "medium" | "high" }> | null {
  if (!Array.isArray(val)) return null;
  const list: Array<{
    issue: string;
    suggestion: string;
    severity: "low" | "medium" | "high";
  }> = [];
  for (const item of val) {
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const issue =
        typeof obj["issue"] === "string"
          ? obj["issue"]
          : typeof obj["feedback"] === "string"
            ? obj["feedback"]
            : "";
      const suggestion =
        typeof obj["suggestion"] === "string"
          ? obj["suggestion"]
          : typeof obj["action"] === "string"
            ? obj["action"]
            : "";
      const rawSev =
        typeof obj["severity"] === "string"
          ? obj["severity"].toLowerCase()
          : "medium";
      const severity: "low" | "medium" | "high" =
        rawSev === "high" || rawSev === "low" ? rawSev : "medium";
      if (issue.length > 0 || suggestion.length > 0) {
        list.push({ issue, suggestion, severity });
      }
    }
  }
  return list.length > 0 ? list : null;
}

function parseStringArray(val: unknown): string[] | null {
  if (!Array.isArray(val)) return null;
  const list = val.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return list.length > 0 ? list : null;
}

async function handleCallEnded(
  payload: Record<string, unknown>,
  orgId?: string | null,
): Promise<boolean> {
  const enrollment = await findEnrollment(payload, orgId);
  if (!enrollment) return false;

  const occurredAtRaw = asString(payload["occurredAt"]);
  const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date();
  const sessionId = asString(payload["sessionId"]);
  const recording = asObj(payload["recording"]);

  // A reopened conversation marks the call answered; a dead / never-connected
  // dial (no human, no duration) is a no-answer.
  const answeredBy = asString(payload["answeredBy"]);
  const durationSecs = asNumber(payload["durationSecs"]) ?? 0;
  const connected = answeredBy === "human" || durationSecs > 0;
  const nextStatus = connected ? "answered" : "no_answer";

  const patch: EnrollmentUpdate = {
    durationSecs,
  };
  // If enrollment is not already completed, update status
  if (enrollment.status !== "completed") {
    patch.status = nextStatus;
  }
  if (sessionId) patch.telenowSessionId = sessionId;
  if (recording) {
    const url = asString(recording["url"]);
    if (url) patch.recordingUrl = url;
  }
  const transcript = parseTranscript(payload["transcript"]);
  if (transcript) patch.transcript = transcript;

  await db
    .update(courseEnrollments)
    .set({
      ...patch,
      calledAt: occurredAt,
    })
    .where(eq(courseEnrollments.id, enrollment.id));

  return true;
}

async function handleCallAnalyzed(
  payload: Record<string, unknown>,
  orgId?: string | null,
): Promise<boolean> {
  const enrollment = await findEnrollment(payload, orgId);
  if (!enrollment) return false;

  const analysis = asObj(payload["analysis"]) ?? payload;
  const scoreRaw = asNumber(analysis?.["score"]) ?? asNumber(payload["score"]);
  if (scoreRaw === null) return true; // no usable score — nothing to record

  const occurredAtRaw = asString(payload["occurredAt"]);
  const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date();
  const sessionId = asString(payload["sessionId"]);
  const recording = asObj(payload["recording"]);

  const durationSecs =
    asNumber(payload["durationSecs"]) ?? asNumber(analysis?.["durationSecs"]);
  const summary = asString(analysis?.["summary"]);
  const sentiment = asString(analysis?.["sentiment"]);
  const sentimentScore = asNumber(analysis?.["sentimentScore"]);
  const talkRatio = parseTalkRatio(analysis?.["talkRatio"]);
  const qaScorecard =
    parseQaScorecard(analysis?.["qa"]) ??
    parseQaScorecard(analysis?.["qaScorecard"]);
  const coachingTips =
    parseCoachingTips(analysis?.["coaching"]) ??
    parseCoachingTips(analysis?.["coachingTips"]);
  const actionItems = parseStringArray(analysis?.["actionItems"]);
  const objections = parseStringArray(analysis?.["objections"]);
  const topics = parseStringArray(analysis?.["topics"]);
  const latencyMetrics = asObj(analysis?.["latencyMetrics"]) as
    | { avgResponseMs?: number; sttMs?: number; llmMs?: number; ttsMs?: number }
    | null;
  const transcript = parseTranscript(payload["transcript"]);

  const patch: EnrollmentUpdate = {
    status: "completed",
    score: Math.round(Math.min(100, Math.max(0, scoreRaw))),
    completedAt: occurredAt,
  };
  if (sessionId) patch.telenowSessionId = sessionId;
  if (durationSecs !== null) patch.durationSecs = durationSecs;
  if (summary) patch.summary = summary;
  if (sentiment) patch.sentiment = sentiment;
  if (sentimentScore !== null) patch.sentimentScore = Math.round(sentimentScore * 100);
  if (talkRatio) patch.talkRatio = talkRatio;
  if (qaScorecard) patch.qaScorecard = qaScorecard;
  if (coachingTips) patch.coachingTips = coachingTips;
  if (actionItems) patch.actionItems = actionItems;
  if (objections) patch.objections = objections;
  if (topics) patch.topics = topics;
  if (latencyMetrics) patch.latencyMetrics = latencyMetrics;
  if (transcript) patch.transcript = transcript;
  if (recording) {
    const url = asString(recording["url"]);
    if (url) patch.recordingUrl = url;
  }

  await db
    .update(courseEnrollments)
    .set(patch)
    .where(eq(courseEnrollments.id, enrollment.id));

  return true;
}

// ---------------------------------------------------------------------------
// Daily check-in handlers
// ---------------------------------------------------------------------------

async function findDailyCheckin(
  payload: Record<string, unknown>,
  orgId?: string | null,
): Promise<{ id: string; status: string } | null> {
  const identifier = asString(payload["identifier"]);
  const sessionId = asString(payload["sessionId"]);

  if (!identifier && !sessionId) return null;

  const conditions = [];
  if (identifier) conditions.push(eq(dailyCheckins.id, identifier));
  if (sessionId)
    conditions.push(eq(dailyCheckins.telenowSessionId, sessionId));

  const whereList = [or(...conditions)!];
  if (orgId) {
    whereList.push(eq(dailyCheckins.orgId, orgId));
  }

  const [row] = await db
    .select({ id: dailyCheckins.id, status: dailyCheckins.status })
    .from(dailyCheckins)
    .where(and(...whereList))
    .limit(1);

  return row ?? null;
}

async function handleCheckinCallEnded(
  payload: Record<string, unknown>,
  orgId?: string | null,
): Promise<boolean> {
  const checkin = await findDailyCheckin(payload, orgId);
  if (!checkin) return false;

  if (checkin.status === "completed") return true;

  const occurredAtRaw = asString(payload["occurredAt"]);
  const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date();
  const sessionId = asString(payload["sessionId"]);
  const recording = asObj(payload["recording"]);

  const answeredBy = asString(payload["answeredBy"]);
  const durationSecs = asNumber(payload["durationSecs"]) ?? 0;
  const connected = answeredBy === "human" || durationSecs > 0;
  const nextStatus = connected ? "answered" : "no_answer";

  const patch: Partial<typeof dailyCheckins.$inferInsert> = { status: nextStatus };
  if (sessionId) patch.telenowSessionId = sessionId;
  if (recording) {
    const url = asString(recording["url"]);
    if (url) patch.recordingUrl = url;
  }

  // Summarize the spoken update when a transcript is available.
  const transcriptArray = payload["transcript"];
  if (Array.isArray(transcriptArray) && transcriptArray.length > 0) {
    const lines = transcriptArray
      .filter((t): t is { role: string; text: string } => 
        typeof t === "object" && t !== null && typeof (t as any).role === "string" && typeof (t as any).text === "string"
      )
      .map((t) => `${t.role}: ${t.text}`);
      
    if (lines.length > 0) {
      const summary = await generateCheckinSummary(lines.join("\n")).catch(() => null);
      if (summary) patch.summary = summary;
    }
  }

  await db
    .update(dailyCheckins)
    .set({ ...patch, calledAt: occurredAt })
    .where(eq(dailyCheckins.id, checkin.id));

  return true;
}

async function handleCheckinCallAnalyzed(
  payload: Record<string, unknown>,
  orgId?: string | null,
): Promise<boolean> {
  const checkin = await findDailyCheckin(payload, orgId);
  if (!checkin) return false;

  const occurredAtRaw = asString(payload["occurredAt"]);
  const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date();
  const sessionId = asString(payload["sessionId"]);

  const patch: Partial<typeof dailyCheckins.$inferInsert> = {
    status: "completed",
    completedAt: occurredAt,
  };
  if (sessionId) patch.telenowSessionId = sessionId;

  await db
    .update(dailyCheckins)
    .set(patch)
    .where(eq(dailyCheckins.id, checkin.id));

  return true;
}

export const webhooksRouter = router;