/**
 * Daily check-in provisioning service.
 *
 * Mirrors `provisionCourseOnTelenow` for the recurring check-in schedule:
 *   1. Ensure the shared Telenow webhook endpoint exists (idempotent).
 *   2. Create the schedule's voice agent once (report / suggestions / updates
 *      script); reuse it on every run.
 *   3. Snapshot the owner's DIRECT reports into the run ledger
 *      (daily_checkins rows — pendables get 'pending', uncallable get
 *      'skipped').
 *   4. Push the pending rows as campaign targets and start a campaign.
 *   5. Mark the run 'completed' (or 'failed'/`skipped` gracefully).
 *
 * A failure is NOT fatal: the run is marked `failed` with a human-readable
 * error and the daily scheduler will simply create a fresh run tomorrow.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../db/index.js";
import {
  dailyCheckinRuns,
  dailyCheckinSchedules,
  dailyCheckins,
  orgs,
  reportingEdges,
  users,
} from "../db/schema.js";
import type { DailyCheckinScheduleRow } from "../db/schema.js";
import { ensureWebhookRegistered } from "./provisionCourse.js";
import {
  getTelenowClientForOrg,
  TelenowClient,
  TelenowError,
  TelenowNotConfiguredError,
} from "./telenow.js";

const MAX_QA_CRITERIA = 10;
const CHECKIN_CALL_SECONDS = 180; // 3 minutes — short voice update.

// ---------------------------------------------------------------------------
// Direct reports (the call targets)
// ---------------------------------------------------------------------------

export type DirectReportTarget = {
  userId: string;
  name: string;
  phone: string | null;
  userStatus: string | null;
};

/**
 * The people directly reporting to `managerUserId` right now (current edges).
 * Targets are NOT restricted to the `practitioner` role — direct reports may
 * include sub-managers; anyone with an active account + phone is callable.
 */
export async function resolveDirectReports(
  orgId: string,
  managerUserId: string,
  additionalUserIds: string[] = [],
): Promise<DirectReportTarget[]> {
  const edges = await db
    .select({ reportUserId: reportingEdges.reportUserId })
    .from(reportingEdges)
    .where(
      and(
        eq(reportingEdges.orgId, orgId),
        eq(reportingEdges.managerUserId, managerUserId),
        isNull(reportingEdges.validTo),
      ),
    );

  const reportIds = [...new Set([...edges.map((e) => e.reportUserId), ...additionalUserIds])];
  if (reportIds.length === 0) return [];

  const rows = await db
    .select({ id: users.id, name: users.name, phone: users.phone, status: users.status })
    .from(users)
    .where(and(inArray(users.id, reportIds), eq(users.orgId, orgId)));

  const byId = new Map(rows.map((r) => [r.id, r]));
  return reportIds
    .map((id) => byId.get(id))
    .filter((u): u is NonNullable<typeof u> => !!u)
    .map((u) => ({
      userId: u.id,
      name: u.name?.trim() ?? "there",
      phone: u.phone?.trim() || null,
      userStatus: u.status,
    }));
}

export function isCallable(target: DirectReportTarget): boolean {
  return target.userStatus === "active" && !!target.phone;
}

// ---------------------------------------------------------------------------
// Agent system prompt
// ---------------------------------------------------------------------------

const DEFAULT_SCRIPT =
  "1. What have you worked on since our last check-in?\n" +
  "2. What are your main priorities for today?\n" +
  "3. Are you facing any blockers or need support from the team?\n" +
  "4. Do you have any suggestions or feedback to share?";

/** Exposed so the client can prefill the editable script box. */
export { DEFAULT_SCRIPT };

function buildCheckinSystemPrompt(
  schedule: DailyCheckinScheduleRow,
  schedulerName: string,
): string {
  const managerName = schedulerName || "your manager";
  const title = schedule.title || "Daily check-in";
  const rawScript = schedule.questionScript?.trim() || DEFAULT_SCRIPT;

  // Support legacy prompt format if present
  if (rawScript.includes("You are running a short daily voice check-in")) {
    return (
      rawScript
        .replaceAll("{{scheduler_name}}", managerName)
        .replaceAll("{{schedule_title}}", title) +
      "\n\nCall the person who dialed in and collect their spoken update. Do not score the caller harshly — this is an update gathering call, not an assessment."
    );
  }

  // Construct structured agent prompt around manager's questions
  return (
    `You are an automated voice assistant conducting a friendly daily check-in on behalf of ${managerName} for "${title}".\n\n` +
    `Your role is to ask the employee the following check-in questions in a warm, professional, conversational manner:\n\n` +
    `${rawScript}\n\n` +
    `Guidelines for the call:\n` +
    `- Greet the employee warmly and state that you are collecting their quick daily update for ${managerName}.\n` +
    `- Ask each question one at a time and listen attentively to their response.\n` +
    `- Ask brief follow-ups only if an answer is ambiguous or unclear.\n` +
    `- Keep the entire call focused and brief (under 3 minutes).\n` +
    `- Conclude the call pleasantly and thank them for their time.\n` +
    `- Summarize their answers accurately without grading or evaluating them — this is an informational update, not a test.`
  );
}

// ---------------------------------------------------------------------------
// Agent create-or-reuse
// ---------------------------------------------------------------------------

/**
 * Returns the Telenow agent id for a schedule, creating it once and storing it
 * on the schedule row for reuse on every daily run.
 */
async function getOrCreateCheckinAgent(
  schedule: DailyCheckinScheduleRow,
  schedulerName: string,
  client: TelenowClient,
): Promise<string> {
  if (!schedule.voice?.trim() || !schedule.voiceProvider?.trim()) {
    throw new TelenowError(
      "A voice persona and TTS provider are required for this daily check-in. Please select a voice in check-in settings.",
      400,
    );
  }

  const agentId = await client.createAgent({
    name: `Check-in: ${schedule.title}`,
    systemPrompt: buildCheckinSystemPrompt(schedule, schedulerName),
    maxDurationSec: CHECKIN_CALL_SECONDS,
    ttsVoice: schedule.voice.trim(),
    ttsProvider: schedule.voiceProvider.trim(),
    opener: `Hi there! This is your daily voice check-in for ${schedulerName || "your manager"}. Do you have a couple minutes for a quick status update?`,
    qaCriteria: [
      { key: "report_given", description: "Did the report give a status update?" },
      { key: "suggestions_given", description: "Did the report share suggestions?" },
      { key: "updates_given", description: "Did the report share updates or blockers?" },
    ].slice(0, MAX_QA_CRITERIA),
    // Idempotency namespace — not a course, so any stable string works.
    courseId: `checkin-${schedule.id}`,
  });

  if (schedule.phoneNumberId) {
    try {
      await client.assignNumberAgent(schedule.phoneNumberId, agentId);
    } catch (err) {
      console.warn(
        `[checkins] Failed to assign phone number ${schedule.phoneNumberId} to agent ${agentId}:`,
        err,
      );
    }
  }

  await db
    .update(dailyCheckinSchedules)
    .set({ telenowAgentId: agentId })
    .where(eq(dailyCheckinSchedules.id, schedule.id));

  return agentId;
}

// ---------------------------------------------------------------------------
// Run ledger snapshot
// ---------------------------------------------------------------------------

async function snapshotTargetsIntoRun(input: {
  runId: string;
  orgId: string;
  scheduleId: string;
  ownerUserId: string;
  additionalUserIds?: string[];
}): Promise<{ pending: number; skipped: number }> {
  const targets = await resolveDirectReports(input.orgId, input.ownerUserId, input.additionalUserIds ?? []);

  if (targets.length === 0) return { pending: 0, skipped: 0 };

  const rows: Array<typeof dailyCheckins.$inferInsert> = targets.map((t) => ({
    runId: input.runId,
    orgId: input.orgId,
    userId: t.userId,
    status: isCallable(t) ? ("pending" as const) : ("skipped" as const),
  }));

  await db.insert(dailyCheckins).values(rows);

  return {
    pending: rows.filter((r) => r.status === "pending").length,
    skipped: rows.length - rows.filter((r) => r.status === "pending").length,
  };
}

// ---------------------------------------------------------------------------
// Per-run provisioning
// ---------------------------------------------------------------------------

/** In-process guard so a run is never provisioned twice (scheduler + manual). */
const inFlightRuns = new Set<string>();

export async function provisionDailyCheckinRun(runId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (inFlightRuns.has(runId)) return { ok: false, error: "Provisioning already in progress." };
  inFlightRuns.add(runId);

  try {
    const [run] = await db
      .select()
      .from(dailyCheckinRuns)
      .where(eq(dailyCheckinRuns.id, runId))
      .limit(1);
    if (!run) return { ok: false, error: "Run not found." };

    const [schedule] = await db
      .select()
      .from(dailyCheckinSchedules)
      .where(eq(dailyCheckinSchedules.id, run.scheduleId))
      .limit(1);
    if (!schedule) return { ok: false, error: "Schedule not found." };

    const [org] = await db
      .select()
      .from(orgs)
      .where(eq(orgs.id, run.orgId))
      .limit(1);
    if (!org) return { ok: false, error: "Organisation not found." };

    const [owner] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, schedule.ownerUserId))
      .limit(1);

    await db
      .update(dailyCheckinRuns)
      .set({ status: "provisioning", startedAt: new Date() })
      .where(eq(dailyCheckinRuns.id, run.id));

    const { client } = await getTelenowClientForOrg(org.id);

    // 1. Shared webhook endpoint (org-specific, idempotent).
    await ensureWebhookRegistered(org, client);

    // 2. Agent — created once per schedule inside org workspace.
    const agentId = await getOrCreateCheckinAgent(schedule, owner?.name ?? "", client);

    // 3. Snapshot today's direct reports into the run ledger.
    const { pending } = await snapshotTargetsIntoRun({
      runId: run.id,
      orgId: run.orgId,
      scheduleId: run.scheduleId,
      ownerUserId: schedule.ownerUserId,
      additionalUserIds: schedule.additionalUserIds ?? [],
    });

    if (pending === 0) {
      await db
        .update(dailyCheckinRuns)
        .set({
          status: "skipped",
          completedAt: new Date(),
          error: null,
        })
        .where(eq(dailyCheckinRuns.id, run.id));
      return { ok: true };
    }

    // 4. Campaign — one target per pending row, id = row id for webhook correlation.
    const pendingRows = await db
      .select({ id: dailyCheckins.id, userId: dailyCheckins.userId })
      .from(dailyCheckins)
      .where(
        and(
          eq(dailyCheckins.runId, run.id),
          eq(dailyCheckins.status, "pending"),
        ),
      );

    const people = await db
      .select({ id: users.id, name: users.name, phone: users.phone })
      .from(users)
      .where(
        and(
          inArray(users.id, pendingRows.map((r) => r.userId)),
          eq(users.orgId, run.orgId),
        ),
      );

    const peopleById = new Map(people.map((p) => [p.id, p]));
    const targets = pendingRows
      .map((row) => {
        const person = peopleById.get(row.userId);
        const phone = person?.phone?.trim();
        if (!phone) return null;
        return {
          id: row.id,
          phone,
          variables: {
            user_name: person?.name?.trim() ?? "there",
            scheduler_name: owner?.name?.trim() ?? "your manager",
            date: run.runDate,
            checkin_id: row.id,
          },
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    if (targets.length === 0) {
      await db
        .update(dailyCheckinRuns)
        .set({ status: "skipped", completedAt: new Date() })
        .where(eq(dailyCheckinRuns.id, run.id));
      return { ok: true };
    }

    const campaignPayload: Parameters<typeof client.createCampaign>[0] = {
      name: `Check-in: ${schedule.title} - ${run.runDate}`,
      agentId,
      timezone: org.timezone,
      targets,
      source: `agilityos-checkin-${schedule.id}`,
    };
    if (schedule.phoneNumberId) {
      campaignPayload.fromNumberId = schedule.phoneNumberId;
    }

    const campaignId = await client.createCampaign(campaignPayload);

    await db
      .update(dailyCheckinRuns)
      .set({
        status: "completed",
        telenowCampaignId: campaignId,
        completedAt: new Date(),
        error: null,
      })
      .where(eq(dailyCheckinRuns.id, run.id));

    return { ok: true };
  } catch (err) {
    const message =
      err instanceof TelenowError
        ? err.message
        : `Unexpected error while running daily check-in: ${(err as Error).message}`;

    await db
      .update(dailyCheckinRuns)
      .set({ status: "failed", error: message, completedAt: new Date() })
      .where(eq(dailyCheckinRuns.id, runId));

    return { ok: false, error: message };
  } finally {
    inFlightRuns.delete(runId);
  }
}