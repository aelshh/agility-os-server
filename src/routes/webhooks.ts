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

import { and, eq, or, sql } from "drizzle-orm";
import express, { Router } from "express";

import { db } from "../db/index.js";
import {
  courseEnrollments,
  dailyCheckins,
  dailyCheckinRuns,
  dailyCheckinSchedules,
  drills,
  orgs,
  users,
} from "../db/schema.js";
import { loadWebhookSigningSecret } from "../lib/provisionCourse.js";
import { generateCheckinSummary } from "../lib/ai/prompts.js";
import {
  computeTalkRatioFromTranscript,
  evaluateCourseCallTranscript,
} from "../lib/ai/evaluate.js";

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
// Handlers & Helpers
// ---------------------------------------------------------------------------

function extractCorrelationIds(payload: Record<string, unknown>): {
  identifiers: string[];
  sessionId: string | null;
  callSid: string | null;
  courseId: string | null;
  checkinScheduleId: string | null;
  phoneNumber: string | null;
} {
  const vars = asObj(payload["variables"]) ?? {};

  const idSet = new Set<string>();
  const addIfValid = (val: unknown) => {
    if (
      typeof val === "string" &&
      val.trim().length > 0 &&
      val !== "null" &&
      val !== "undefined"
    ) {
      idSet.add(val.trim());
    }
  };

  addIfValid(payload["identifier"]);
  addIfValid(payload["targetId"]);
  addIfValid(payload["target_id"]);
  addIfValid(payload["rowId"]);
  addIfValid(payload["row_id"]);

  addIfValid(vars["source_row"]);
  addIfValid(vars["enrollment_id"]);
  addIfValid(vars["enrollmentId"]);
  addIfValid(vars["checkin_id"]);
  addIfValid(vars["checkinId"]);
  addIfValid(vars["identifier"]);
  addIfValid(vars["id"]);

  const sessionId = asString(payload["sessionId"]) ?? asString(payload["session_id"]);
  const callSid = asString(payload["callSid"]) ?? asString(payload["call_sid"]);

  const sourceRef =
    asString(vars["source_ref"]) ??
    asString(vars["sourceRef"]) ??
    asString(payload["source"]);

  let courseId: string | null = null;
  let checkinScheduleId: string | null = null;

  if (sourceRef) {
    const courseMatch = sourceRef.match(/agilityos-course-([0-9a-fA-F-]+)/);
    if (courseMatch && typeof courseMatch[1] === "string") courseId = courseMatch[1];

    const checkinMatch = sourceRef.match(/agilityos-checkin-([0-9a-fA-F-]+)/);
    if (checkinMatch && typeof checkinMatch[1] === "string") checkinScheduleId = checkinMatch[1];
  }

  const phoneNumber =
    asString(payload["toNumber"]) ??
    asString(payload["to_number"]) ??
    asString(payload["fromOrTo"]) ??
    asString(payload["from_or_to"]);

  return {
    identifiers: Array.from(idSet),
    sessionId,
    callSid,
    courseId,
    checkinScheduleId,
    phoneNumber,
  };
}

function parseRecordingUrl(payload: Record<string, unknown>): string | null {
  const recordingObj = asObj(payload["recording"]);
  return (
    asString(recordingObj?.["url"]) ??
    asString(payload["recordingUrl"]) ??
    asString(payload["recording_url"]) ??
    (typeof payload["recording"] === "string" ? asString(payload["recording"]) : null)
  );
}

async function resolveInternalOrgId(
  orgIdOrTelenowOrgId?: string | null,
): Promise<string | null> {
  if (!orgIdOrTelenowOrgId) return null;
  const [org] = await db
    .select({ id: orgs.id })
    .from(orgs)
    .where(
      or(
        eq(orgs.id, orgIdOrTelenowOrgId),
        eq(orgs.telenowOrgId, orgIdOrTelenowOrgId),
      ),
    )
    .limit(1);
  return org?.id ?? null;
}

async function findEnrollment(
  payload: Record<string, unknown>,
  orgId?: string | null,
): Promise<{ id: string; status: string } | null> {
  const resolvedOrgId =
    (await resolveInternalOrgId(orgId)) ??
    (await resolveInternalOrgId(asString(payload["orgId"])));

  const { identifiers, sessionId, courseId, phoneNumber } =
    extractCorrelationIds(payload);

  const conditions = [];
  for (const id of identifiers) {
    conditions.push(eq(courseEnrollments.id, id));
  }
  if (sessionId) {
    conditions.push(eq(courseEnrollments.telenowSessionId, sessionId));
  }

  if (conditions.length > 0) {
    if (resolvedOrgId) {
      const [row] = await db
        .select({ id: courseEnrollments.id, status: courseEnrollments.status })
        .from(courseEnrollments)
        .where(and(or(...conditions)!, eq(courseEnrollments.orgId, resolvedOrgId)))
        .limit(1);

      if (row) return row;
    }

    const [row] = await db
      .select({ id: courseEnrollments.id, status: courseEnrollments.status })
      .from(courseEnrollments)
      .where(or(...conditions)!)
      .limit(1);

    if (row) return row;
  }

  // Fallback: match via courseId from source_ref + user phone
  if (courseId && phoneNumber) {
    const cleanPhone = phoneNumber.replace(/\D/g, "");
    if (cleanPhone.length >= 7) {
      const whereList = [
        eq(courseEnrollments.courseId, courseId),
        sql`replace(${users.phone}, ' ', '') LIKE ${"%" + cleanPhone.slice(-10)}`,
      ];
      if (resolvedOrgId) {
        whereList.push(eq(courseEnrollments.orgId, resolvedOrgId));
      }

      const [row] = await db
        .select({ id: courseEnrollments.id, status: courseEnrollments.status })
        .from(courseEnrollments)
        .innerJoin(users, eq(courseEnrollments.userId, users.id))
        .where(and(...whereList))
        .limit(1);

      if (row) return row;
    }
  }

  return null;
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
  const callSid = asString(payload["callSid"]) ?? asString(payload["call_sid"]);
  const recordingUrl = parseRecordingUrl(payload);

  const answeredBy = asString(payload["answeredBy"]);
  const durationSecs = asNumber(payload["durationSecs"]) ?? 0;
  const connected = answeredBy === "human" || durationSecs > 0;
  const nextStatus = connected ? "answered" : "no_answer";

  const transcript = parseTranscript(payload["transcript"]);
  const talkRatio = computeTalkRatioFromTranscript(transcript);

  const patch: EnrollmentUpdate = {
    durationSecs,
    talkRatio,
  };
  if (sessionId) patch.telenowSessionId = sessionId;
  if (callSid) patch.telenowCallId = callSid;
  if (recordingUrl) patch.recordingUrl = recordingUrl;
  if (transcript) patch.transcript = transcript;

  // If call had speech / duration, evaluate the call immediately against the course scoring rubric
  if (connected && transcript && transcript.length > 0) {
    try {
      const [courseRow] = await db
        .select({
          id: drills.id,
          title: drills.title,
          description: drills.description,
          scoringRubric: drills.scoringRubric,
        })
        .from(courseEnrollments)
        .innerJoin(drills, eq(courseEnrollments.courseId, drills.id))
        .where(eq(courseEnrollments.id, enrollment.id))
        .limit(1);

      if (courseRow) {
        const evalResult = await evaluateCourseCallTranscript({
          course: courseRow,
          transcript,
          durationSecs,
        });

        patch.status = "completed";
        patch.score = evalResult.score;
        patch.summary = evalResult.summary;
        patch.sentiment = evalResult.sentiment;
        patch.sentimentScore = Math.round(evalResult.sentimentScore * 100);
        patch.talkRatio = evalResult.talkRatio;
        patch.qaScorecard = evalResult.qaScorecard;
        patch.coachingTips = evalResult.coachingTips;
        patch.actionItems = evalResult.actionItems;
        patch.objections = evalResult.objections;
        patch.topics = evalResult.topics;
        patch.completedAt = occurredAt;
      } else {
        if (enrollment.status !== "completed") {
          patch.status = nextStatus;
        }
      }
    } catch (evalErr) {
      console.error("[webhooks] Call evaluation failed in handleCallEnded:", evalErr);
      if (enrollment.status !== "completed") {
        patch.status = nextStatus;
      }
    }
  } else {
    if (enrollment.status !== "completed") {
      patch.status = nextStatus;
    }
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

  const analysis = asObj(payload["analysis"]) ?? payload;
  const scoreRaw = asNumber(analysis?.["score"]) ?? asNumber(payload["score"]);
  if (scoreRaw === null) return true; // no usable score — nothing to record

  const occurredAtRaw = asString(payload["occurredAt"]);
  const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date();
  const sessionId = asString(payload["sessionId"]);
  const callSid = asString(payload["callSid"]) ?? asString(payload["call_sid"]);
  const recordingUrl = parseRecordingUrl(payload);

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
  if (callSid) patch.telenowCallId = callSid;
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
  if (recordingUrl) patch.recordingUrl = recordingUrl;

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
  const resolvedOrgId =
    (await resolveInternalOrgId(orgId)) ??
    (await resolveInternalOrgId(asString(payload["orgId"])));

  const { identifiers, sessionId, checkinScheduleId, phoneNumber } =
    extractCorrelationIds(payload);

  const conditions = [];
  for (const id of identifiers) {
    conditions.push(eq(dailyCheckins.id, id));
  }
  if (sessionId) {
    conditions.push(eq(dailyCheckins.telenowSessionId, sessionId));
  }

  if (conditions.length > 0) {
    if (resolvedOrgId) {
      const [row] = await db
        .select({ id: dailyCheckins.id, status: dailyCheckins.status })
        .from(dailyCheckins)
        .where(and(or(...conditions)!, eq(dailyCheckins.orgId, resolvedOrgId)))
        .limit(1);

      if (row) return row;
    }

    const [row] = await db
      .select({ id: dailyCheckins.id, status: dailyCheckins.status })
      .from(dailyCheckins)
      .where(or(...conditions)!)
      .limit(1);

    if (row) return row;
  }

  // Fallback: match via checkinScheduleId + user phone
  if (checkinScheduleId && phoneNumber) {
    const cleanPhone = phoneNumber.replace(/\D/g, "");
    if (cleanPhone.length >= 7) {
      const whereList = [
        eq(dailyCheckinRuns.scheduleId, checkinScheduleId),
        sql`replace(${users.phone}, ' ', '') LIKE ${"%" + cleanPhone.slice(-10)}`,
      ];
      if (resolvedOrgId) {
        whereList.push(eq(dailyCheckins.orgId, resolvedOrgId));
      }

      const [row] = await db
        .select({ id: dailyCheckins.id, status: dailyCheckins.status })
        .from(dailyCheckins)
        .innerJoin(dailyCheckinRuns, eq(dailyCheckins.runId, dailyCheckinRuns.id))
        .innerJoin(users, eq(dailyCheckins.userId, users.id))
        .where(and(...whereList))
        .limit(1);

      if (row) return row;
    }
  }

  return null;
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
  const recordingUrl = parseRecordingUrl(payload);

  const answeredBy = asString(payload["answeredBy"]);
  const durationSecs = asNumber(payload["durationSecs"]) ?? 0;
  const connected = answeredBy === "human" || durationSecs > 0;
  const nextStatus = connected ? "answered" : "no_answer";

  const patch: Partial<typeof dailyCheckins.$inferInsert> = { status: nextStatus };
  if (sessionId) patch.telenowSessionId = sessionId;
  if (recordingUrl) patch.recordingUrl = recordingUrl;

  // Summarize the spoken update when a transcript is available.
  const transcriptArray = payload["transcript"];
  if (Array.isArray(transcriptArray) && transcriptArray.length > 0) {
    const lines = transcriptArray
      .filter((t): t is { role: string; text: string } => 
        typeof t === "object" && t !== null && typeof (t as any).role === "string" && typeof (t as any).text === "string"
      )
      .map((t) => `${t.role}: ${t.text}`);
      
    if (lines.length > 0) {
      const [scheduleRow] = await db
        .select({
          questionScript: dailyCheckinSchedules.questionScript,
        })
        .from(dailyCheckins)
        .innerJoin(dailyCheckinRuns, eq(dailyCheckins.runId, dailyCheckinRuns.id))
        .innerJoin(dailyCheckinSchedules, eq(dailyCheckinRuns.scheduleId, dailyCheckinSchedules.id))
        .where(eq(dailyCheckins.id, checkin.id))
        .limit(1);

      const questions = scheduleRow?.questionScript
        ? scheduleRow.questionScript
            .split(/\r?\n/)
            .map((l: string) => l.trim().replace(/^(\d+[.)]\s*|[-*•]\s*)/, "").trim())
            .filter(Boolean)
        : undefined;

      const summaryObj = await generateCheckinSummary(lines.join("\n"), questions).catch(() => null);
      if (summaryObj) {
        patch.summary = summaryObj;
        patch.status = "completed";
        patch.completedAt = occurredAt;
      }
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
export { handleCallEnded, handleCallAnalyzed, findEnrollment, findDailyCheckin };