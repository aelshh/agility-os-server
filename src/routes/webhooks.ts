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

async function handleCallEnded(
  payload: Record<string, unknown>,
  orgId?: string | null,
): Promise<boolean> {
  const enrollment = await findEnrollment(payload, orgId);
  if (!enrollment) return false;

  // Analysis may already have landed (ordering is not guaranteed) — never
  // downgrade a `completed` run.
  if (enrollment.status === "completed") return true;

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

  const patch: EnrollmentUpdate = { status: nextStatus };
  if (sessionId) patch.telenowSessionId = sessionId;
  if (recording) {
    const url = asString(recording["url"]);
    if (url) patch.recordingUrl = url;
  }

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

  const analysis = asObj(payload["analysis"]);
  const scoreRaw = asNumber(analysis?.["score"]) ?? asNumber(payload["score"]);
  if (scoreRaw === null) return true; // no usable score — nothing to record

  const occurredAtRaw = asString(payload["occurredAt"]);
  const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date();
  const sessionId = asString(payload["sessionId"]);

  const patch: EnrollmentUpdate = {
    status: "completed",
    score: Math.round(Math.min(100, Math.max(0, scoreRaw))),
    completedAt: occurredAt,
  };
  if (sessionId) patch.telenowSessionId = sessionId;

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

  // Summarize the spoken update when a transcript is available.
  const analysis = asObj(payload["analysis"]);
  const transcript =
    asString(analysis?.["transcript"]) ?? asString(payload["transcript"]);
  if (transcript) {
    const summary = await generateCheckinSummary(transcript).catch(() => null);
    if (summary) patch.summary = summary;
  }

  await db
    .update(dailyCheckins)
    .set(patch)
    .where(eq(dailyCheckins.id, checkin.id));

  return true;
}

export const webhooksRouter = router;