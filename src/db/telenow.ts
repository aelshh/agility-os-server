import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { drills } from "./drills.js";
import { orgs } from "./orgs.js";
import { users } from "./users.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Per-practitioner call lifecycle for a published course.
 *
 * pending  -> selected at publish, not yet dialed
 * queued   -> pushed into a Telenow campaign
 * calling  -> a call session is open for this rep
 * answered -> a rep picked up (call.ended, answered)
 * no_answer-> dialed but nobody picked up (call.ended, unanswered)
 * completed-> the call was analyzed and scored (call.analyzed)
 * failed   -> the dial failed, or provisioning marked the whole run failed
 * skipped  -> excluded at publish (no phone / no active account)
 */
export const enrollmentStatusEnum = pgEnum("enrollment_status", [
  "pending",
  "queued",
  "calling",
  "answered",
  "no_answer",
  "completed",
  "failed",
  "skipped",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * The curator's explicit practitioner selection for a course, made in the
 * editor ("Audience" tab). Editable only while the course is draft/rejected.
 * Snapshot into `course_enrollments` when the course is published.
 */
export const drillAudience = pgTable(
  "drill_audience",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => drills.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("drill_audience_course_user_unique").on(table.courseId, table.userId),
  ],
);

/**
 * One row per practitioner per published course — the delivery ledger. Filled
 * at publish from `drill_audience`, then hydrated by Telenow webhooks
 * (call.ended / call.analyzed). The campaign target id is this row's id.
 */
export const courseEnrollments = pgTable(
  "course_enrollments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => drills.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: enrollmentStatusEnum("status").notNull().default("pending"),

    // Telenow correlation
    telenowSessionId: varchar("telenow_session_id", { length: 255 }),
    telenowCallId: varchar("telenow_call_id", { length: 255 }),

    // Outcomes (hydrated by webhooks)
    score: integer("score"),
    transcriptUrl: text("transcript_url"),
    recordingUrl: text("recording_url"),
    error: text("error"),

    calledAt: timestamp("called_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("course_enrollments_course_user_unique").on(
      table.courseId,
      table.userId,
    ),
    index("course_enrollments_course_id_idx").on(table.courseId),
  ],
);

/**
 * Organizational Telenow webhook endpoint. Each organization has its own
 * registered webhook endpoint pointing at our receiver; its HMAC `signing_secret`
 * (returned by Telenow at creation) lives here, server-side only.
 */
export const telenowWebhooks = pgTable(
  "telenow_webhooks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    telenowHookId: varchar("telenow_hook_id", { length: 255 }),
    targetUrl: text("target_url").notNull(),
    signingSecret: text("signing_secret").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("telenow_webhooks_org_id_unique").on(table.orgId),
  ],
);

export type DrillAudienceRow = typeof drillAudience.$inferSelect;
export type CourseEnrollmentRow = typeof courseEnrollments.$inferSelect;
export type TelenowWebhookRow = typeof telenowWebhooks.$inferSelect;