/**
 * Provisioning service — the "make course creation functional" hook.
 *
 * Called when a course is approved (published). Steps, in order:
 *   1. Ensure the deployment-wide Telenow webhook endpoint exists (so call
 *      outcomes reach our receiver). Idempotent — reuses the stored signing
 *      secret once registered.
 *   2. Create a Telenow agent for the course: systemPrompt carries the coach
 *      persona + course knowledge + practice questions; post-call analysis is
 *      configured from the scoring rubric.
 *   3. Push the audience snapshot (course_enrollments) as campaign targets and
 *      create a Telenow campaign that starts dialing immediately (respecting
 *      the org timezone + business-hour window).
 *   4. Record agent/campaign ids + provisioning status on the drill.
 *
 * A failure is NOT fatal to the review: the course stays published and the
 * drill is marked `provisioning_status = failed` with a human-readable error,
 * recoverable via POST /api/drills/:id/provision.
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "../db/index.js";
import {
  courseDocuments,
  courseEnrollments,
  drills,
  drillAudience,
  telenowWebhooks,
  users,
} from "../db/schema.js";
import type { CourseDocumentRow, DrillRow, OrgRow } from "../db/schema.js";
import {
  getTelenowClientForOrg,
  TelenowClient,
  TelenowError,
  TelenowNotConfiguredError,
} from "./telenow.js";

const APP_BASE_URL = process.env["APP_BASE_URL"] ?? "http://localhost:3000";
const WEBHOOK_PATH = "/api/webhooks/telenow";

const MAX_REFERENCE_CHARS = 8000;
const MAX_DOC_CHARS = 3000;
const MAX_QA_CRITERIA = 30;

// ---------------------------------------------------------------------------
// Webhook endpoint
// ---------------------------------------------------------------------------

async function ensureWebhookRegistered(
  org: OrgRow,
  client: TelenowClient,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(telenowWebhooks)
    .where(eq(telenowWebhooks.orgId, org.id))
    .limit(1);

  if (existing) return existing.signingSecret;

  const targetUrl = `${APP_BASE_URL.replace(/\/+$/, "")}${WEBHOOK_PATH}/${org.id}`;
  const { telenowHookId, signingSecret } = await client.registerWebhook({
    targetUrl,
    events: ["call.ended", "call.analyzed"],
    telenowOrgId: org.telenowOrgId ?? undefined,
  });

  await db
    .insert(telenowWebhooks)
    .values({
      orgId: org.id,
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
        createdAt: new Date(),
      },
    });

  return signingSecret;
}

/**
 * Organizational Telenow webhook endpoint. Idempotent.
 */
export { ensureWebhookRegistered };

/** Signing secret for verifying incoming webhook signatures by orgId. */
export async function loadWebhookSigningSecret(orgId?: string): Promise<string | null> {
  if (orgId) {
    const [row] = await db
      .select({ signingSecret: telenowWebhooks.signingSecret })
      .from(telenowWebhooks)
      .where(eq(telenowWebhooks.orgId, orgId))
      .limit(1);
    return row?.signingSecret ?? null;
  }
  const [row] = await db
    .select({ signingSecret: telenowWebhooks.signingSecret })
    .from(telenowWebhooks)
    .orderBy(asc(telenowWebhooks.createdAt))
    .limit(1);
  return row?.signingSecret ?? null;
}

// ---------------------------------------------------------------------------
// Audience snapshot
// ---------------------------------------------------------------------------

/**
 * Copies the curator's `drill_audience` selection into the delivery ledger
 * (`course_enrollments`). Practitioners without a phone number are recorded as
 * `skipped` — they cannot be called.
 */
export async function snapshotAudience(
  courseId: string,
  orgId: string,
): Promise<void> {
  const selected = await db
    .select({ userId: drillAudience.userId })
    .from(drillAudience)
    .where(eq(drillAudience.courseId, courseId));

  await db
    .delete(courseEnrollments)
    .where(eq(courseEnrollments.courseId, courseId));

  if (selected.length === 0) return;

  const reps = await db
    .select({ id: users.id, phone: users.phone })
    .from(users)
    .where(and(inArray(users.id, selected.map((s) => s.userId)), eq(users.orgId, orgId)));

  if (reps.length === 0) return;

  const rowsToInsert: Array<typeof courseEnrollments.$inferInsert> = reps.map(
    (rep) => ({
      orgId,
      courseId,
      userId: rep.id,
      status:
        rep.phone && rep.phone.trim().length > 0 ? ("pending" as const) : ("skipped" as const),
    }),
  );

  await db.insert(courseEnrollments).values(rowsToInsert);
}

/**
 * Adds the curator's `drill_audience` selection into the delivery ledger
 * (`course_enrollments`) — for a course that already published. Existing
 * enrollments are preserved (call history + scores are never reset or
 * re-dialed); only practitioners not yet enrolled are inserted as `pending`
 * (or `skipped` without a phone). Returns the number of rows added.
 */
export async function mergeAudience(
  courseId: string,
  orgId: string,
): Promise<number> {
  const selected = await db
    .select({ userId: drillAudience.userId })
    .from(drillAudience)
    .where(eq(drillAudience.courseId, courseId));

  if (selected.length === 0) return 0;

  const existingRows = await db
    .select({ userId: courseEnrollments.userId })
    .from(courseEnrollments)
    .where(eq(courseEnrollments.courseId, courseId));

  const enrolled = new Set(existingRows.map((row) => row.userId));
  const newcomers = selected.filter((s) => !enrolled.has(s.userId));
  if (newcomers.length === 0) return 0;

  const reps = await db
    .select({ id: users.id, phone: users.phone })
    .from(users)
    .where(
      and(inArray(users.id, newcomers.map((s) => s.userId)), eq(users.orgId, orgId)),
    );

  if (reps.length === 0) return 0;

  const rowsToInsert: Array<typeof courseEnrollments.$inferInsert> = reps.map(
    (rep) => ({
      orgId,
      courseId,
      userId: rep.id,
      status:
        rep.phone && rep.phone.trim().length > 0
          ? ("pending" as const)
          : ("skipped" as const),
    }),
  );

  await db.insert(courseEnrollments).values(rowsToInsert);
  return rowsToInsert.length;
}

// ---------------------------------------------------------------------------
// System prompt construction
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function buildCoachSystemPrompt(drill: DrillRow, docs: CourseDocumentRow[]): string {
  const parts: string[] = [];

  if (drill.personaPrompt && drill.personaPrompt.trim().length > 0) {
    parts.push(drill.personaPrompt.trim());
  } else {
    parts.push(
      `You are the spoken-training coach for the course "${drill.title}".`,
    );
    if (drill.description?.trim()) parts.push(drill.description.trim());
  }

  const reference: string[] = [];
  if (drill.knowledgeText && drill.knowledgeText.trim() !== "") {
    reference.push(
      `Course notes:\n${truncate(drill.knowledgeText.trim(), MAX_REFERENCE_CHARS)}`,
    );
  }
  for (const doc of docs) {
    if (!doc.textContent?.trim()) continue;
    reference.push(
      `Document "${doc.originalName}":\n${truncate(doc.textContent.trim(), MAX_DOC_CHARS)}`,
    );
  }
  if (reference.length > 0) {
    parts.push(
      "Reference material — ground every answer strictly in this and never invent facts outside it:\n" +
        reference.join("\n\n---\n\n"),
    );
  }

  const faqs = asStringArray(drill.faqs);
  if (faqs.length > 0) {
    parts.push(
      "Practice questions you must ask the learner during the call:\n" +
        faqs.map((q, i) => `${i + 1}. ${q}`).join("\n"),
    );
  }

  const rubric = Array.isArray(drill.scoringRubric)
    ? (drill.scoringRubric as Array<Record<string, unknown>>).filter(
        (entry) =>
          entry && typeof entry === "object" && typeof entry["name"] === "string",
      )
    : [];
  if (rubric.length > 0) {
    parts.push(
      "After the conversation, judge the learner against these criteria:\n" +
        rubric.map((c, i) => `${i + 1}. ${String(c["name"])}`).join("\n"),
    );
  }

  parts.push(
    "Keep the conversation natural and spoken. At the end, let the learner ask for a recap of anything they are unsure about.",
  );

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export async function provisionCourseOnTelenow(input: {
  drill: DrillRow;
  org: OrgRow;
}): Promise<{ ok: boolean; error?: string }> {
  const { drill, org } = input;

  try {
    const { client } = await getTelenowClientForOrg(org.id);

    // 1. Webhook endpoint (org-specific, idempotent).
    await ensureWebhookRegistered(org, client);

    // 2. Agent (created in org's Telenow workspace).
    const docs = await db
      .select()
      .from(courseDocuments)
      .where(eq(courseDocuments.courseId, drill.id));

    const rubricRaw =
      Array.isArray(drill.scoringRubric) &&
      drill.scoringRubric.every(
        (entry) => entry && typeof entry === "object" && "name" in entry,
      )
        ? (drill.scoringRubric as Array<Record<string, unknown>>)
        : [];

    const agentId = await client.createAgent({
      name: drill.title,
      systemPrompt: buildCoachSystemPrompt(drill, docs),
      maxDurationSec: drill.maxDurationSec,
      qaCriteria: rubricRaw.slice(0, MAX_QA_CRITERIA).map((c) => ({
        key: String(c["name"] ?? "criterion").slice(0, 60),
        description: String(c["description"] ?? c["name"] ?? "").slice(0, 300),
      })),
      courseId: drill.id,
    });

    // 3. Campaign — one target per pending enrollment, id = enrollment id so
    //    webhook correlation works without a session ledger.
    const enrollments = await db
      .select({ id: courseEnrollments.id, userId: courseEnrollments.userId })
      .from(courseEnrollments)
      .where(
        and(
          eq(courseEnrollments.courseId, drill.id),
          eq(courseEnrollments.orgId, org.id),
          eq(courseEnrollments.status, "pending"),
        ),
      );

    let campaignId: string | null = null;
    if (enrollments.length > 0) {
      const reps = await db
        .select({ id: users.id, name: users.name, phone: users.phone })
        .from(users)
        .where(inArray(users.id, enrollments.map((e) => e.userId)));

      const repById = new Map(reps.map((r) => [r.id, r]));
      const targets = enrollments
        .map((enrollment) => {
          const rep = repById.get(enrollment.userId);
          const phone = rep?.phone?.trim();
          if (!rep || !phone) return null;
          return {
            id: enrollment.id,
            phone,
            variables: {
              user_name: rep.name?.trim() ?? "there",
              course_title: drill.title,
            },
          };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);

      if (targets.length > 0) {
        campaignId = await client.createCampaign({
          name: `Training: ${drill.title}`,
          agentId,
          timezone: org.timezone,
          targets,
          source: `agilityos-course-${drill.id}`,
        });
      }
    }

    // 4. Persist.
    await db
      .update(drills)
      .set({
        telenowAgentId: agentId,
        telenowCampaignId: campaignId,
        provisioningStatus: "completed",
        provisioningError: null,
      })
      .where(eq(drills.id, drill.id));

    return { ok: true };
  } catch (err) {
    const message =
      err instanceof TelenowError
        ? err.message
        : `Unexpected error while provisioning on Telenow: ${(err as Error).message}`;

    await db
      .update(drills)
      .set({ provisioningStatus: "failed", provisioningError: message })
      .where(eq(drills.id, drill.id));

    return { ok: false, error: message };
  }
}