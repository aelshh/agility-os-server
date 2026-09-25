import {
  boolean,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";
import { users } from "./users.js";
import { enrollmentStatusEnum } from "./telenow.js";

/**
 * Daily check-in feature — non-practitioners schedule a daily outbound AI
 * voice call that collects reports / suggestions / updates from the people
 * directly reporting to them in the org graph.
 *
 * Three tables, following the `course_enrollments` ledger pattern:
 *   - a schedule config (owner + time of day),
 *   - one "run" row per schedule per calendar day (idempotency for the daily
 *     scheduler),
 *   - one per-person row per run (the campaign targets / webhook ledger).
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Lifecycle of one scheduled daily run. */
export const checkinRunStatusEnum = pgEnum("checkin_run_status", [
  "pending",
  "provisioning",
  "completed",
  "failed",
  "skipped",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * A daily check-in schedule owned by a non-practitioner. Calls go out to the
 * owner's DIRECT reports only (reporting_edges, valid edge), at `timeLocal`
 * in the org timezone, every day that the run has not already been created.
 */
export const dailyCheckinSchedules = pgTable(
  "daily_checkin_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),

    /** The scheduler — must be a non-practitioner with direct reports. */
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    title: varchar("title", { length: 255 }).notNull().default("Daily check-in"),

    /** "HH:mm" in the org timezone (e.g. "08:45"). */
    timeLocal: varchar("time_local", { length: 5 }).notNull().default("08:45"),

    enabled: boolean("enabled").notNull().default(true),

    /**
     * Optional natural-language script the voice agent uses to run the call.
     * Defaults to the report / suggestions / updates script.
     */
    questionScript: text("question_script"),

    /** Telenow agent created once per schedule and reused for every run. */
    telenowAgentId: varchar("telenow_agent_id", { length: 255 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("daily_checkin_schedules_org_owner_unique").on(
      table.orgId,
      table.ownerUserId,
    ),
    index("daily_checkin_schedules_org_idx").on(table.orgId),
  ],
);

/**
 * One run per schedule per calendar day (UTC date). The unique
 * (schedule_id, run_date) constraint is what makes the daily scheduler
 * idempotent — a run either exists for today or it doesn't.
 */
export const dailyCheckinRuns = pgTable(
  "daily_checkin_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => dailyCheckinSchedules.id, { onDelete: "cascade" }),

    /** Calendar date in the ORG timezone the run was created for. */
    runDate: date("run_date").notNull(),

    status: checkinRunStatusEnum("status").notNull().default("pending"),

    telenowCampaignId: varchar("telenow_campaign_id", { length: 255 }),

    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("daily_checkin_runs_schedule_date_unique").on(
      table.scheduleId,
      table.runDate,
    ),
    index("daily_checkin_runs_org_idx").on(table.orgId),
    index("daily_checkin_runs_schedule_idx").on(table.scheduleId),
  ],
);

/**
 * Per-person ledger row for a run — the campaign target id IS this row's id,
 * so webhook correlation works exactly like course_enrollments. Status reuses
 * `enrollment_status` (same semantics: pending…completed, skipped for people
 * who cannot be called).
 */
export const dailyCheckins = pgTable(
  "daily_checkins",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => dailyCheckinRuns.id, { onDelete: "cascade" }),

    /** The person being called (a direct report of the schedule owner). */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    status: enrollmentStatusEnum("status").notNull().default("pending"),

    // Telenow correlation
    telenowSessionId: varchar("telenow_session_id", { length: 255 }),
    telenowCallId: varchar("telenow_call_id", { length: 255 }),

    /** Auto-generated structured digest: {report, suggestions, updates}. */
    summary: jsonb("summary"),

    transcriptUrl: text("transcript_url"),
    /** Never exposed to the scheduler — restricted like session audio. */
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
    index("daily_checkins_run_idx").on(table.runId),
    index("daily_checkins_user_idx").on(table.userId),
  ],
);

export type DailyCheckinScheduleRow = typeof dailyCheckinSchedules.$inferSelect;
export type NewDailyCheckinSchedule = typeof dailyCheckinSchedules.$inferInsert;
export type DailyCheckinRunRow = typeof dailyCheckinRuns.$inferSelect;
export type NewDailyCheckinRun = typeof dailyCheckinRuns.$inferInsert;
export type DailyCheckinRow = typeof dailyCheckins.$inferSelect;
export type NewDailyCheckin = typeof dailyCheckins.$inferInsert;