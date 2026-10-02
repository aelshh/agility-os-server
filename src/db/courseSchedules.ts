import {
  boolean,
  date,
  index,
  integer,
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
import { drills } from "./drills.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const courseScheduleTypeEnum = pgEnum("course_schedule_type", [
  "one_time",
  "recurring",
]);

export const courseScheduleStatusEnum = pgEnum("course_schedule_status", [
  "scheduled",
  "active",
  "paused",
  "completed",
  "cancelled",
]);

export const courseScheduleRunStatusEnum = pgEnum("course_schedule_run_status", [
  "scheduled",
  "notified",
  "calling",
  "completed",
  "failed",
  "skipped",
]);

export const courseScheduleNotificationStatusEnum = pgEnum(
  "course_schedule_notification_status",
  ["queued", "sent", "failed", "skipped"],
);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Course Schedule configuration.
 * Allows managers to schedule courses for specific dates or recurring days of the week,
 * specifying active calling hours and advance WhatsApp notifications.
 */
export const courseSchedules = pgTable(
  "course_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),

    courseId: uuid("course_id")
      .notNull()
      .references(() => drills.id, { onDelete: "cascade" }),

    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),

    scheduleType: courseScheduleTypeEnum("schedule_type")
      .notNull()
      .default("recurring"),

    /** "YYYY-MM-DD" start date of schedule or specific one-time date */
    startDate: varchar("start_date", { length: 10 }).notNull(),

    /** Optional "YYYY-MM-DD" end date for recurring schedules */
    endDate: varchar("end_date", { length: 10 }),

    /** Days of week (0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat) */
    daysOfWeek: jsonb("days_of_week").$type<number[]>().notNull().default([1, 2, 3, 4, 5]),

    /** "HH:mm" start of the active calling window in org/schedule timezone (e.g. "10:00") */
    timeWindowStart: varchar("time_window_start", { length: 5 }).notNull().default("10:00"),

    /** "HH:mm" end of the active calling window in org/schedule timezone (e.g. "14:00") */
    timeWindowEnd: varchar("time_window_end", { length: 5 }).notNull().default("14:00"),

    /** IANA timezone name (e.g. "Asia/Kolkata", "America/New_York") */
    timezone: varchar("timezone", { length: 50 }).notNull().default("UTC"),

    /** Whether to send an advance reminder over WhatsApp */
    notifyWhatsappPrior: boolean("notify_whatsapp_prior").notNull().default(true),

    /** Advance notice lead time in minutes (e.g. 15, 30, 60, 0) */
    notifyMinutesBefore: integer("notify_minutes_before").notNull().default(30),

    /** Optional custom message note to include in the WhatsApp notification */
    customMessage: text("custom_message"),

    status: courseScheduleStatusEnum("status").notNull().default("scheduled"),

    /** "course_default" (all enrolled in course) or "custom" */
    audienceType: varchar("audience_type", { length: 50 }).notNull().default("course_default"),

    /** Specific target practitioner user IDs (if custom audience) */
    audienceIds: jsonb("audience_ids").$type<string[]>().notNull().default([]),

    lastRunDate: varchar("last_run_date", { length: 10 }),
    lastNotificationSentAt: timestamp("last_notification_sent_at", { withTimezone: true }),

    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("course_schedules_org_idx").on(table.orgId),
    index("course_schedules_course_idx").on(table.courseId),
    index("course_schedules_status_idx").on(table.status),
  ],
);

/**
 * Ledger of individual daily execution runs for course schedules.
 */
export const courseScheduleRuns = pgTable(
  "course_schedule_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),

    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => courseSchedules.id, { onDelete: "cascade" }),

    courseId: uuid("course_id")
      .notNull()
      .references(() => drills.id, { onDelete: "cascade" }),

    /** "YYYY-MM-DD" date in schedule timezone */
    runDate: varchar("run_date", { length: 10 }).notNull(),

    status: courseScheduleRunStatusEnum("status").notNull().default("scheduled"),

    telenowCampaignId: varchar("telenow_campaign_id", { length: 255 }),

    notifiedCount: integer("notified_count").notNull().default(0),
    targetsCount: integer("targets_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),

    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("course_schedule_runs_schedule_date_uq").on(
      table.scheduleId,
      table.runDate,
    ),
    index("course_schedule_runs_org_idx").on(table.orgId),
    index("course_schedule_runs_course_idx").on(table.courseId),
  ],
);

/**
 * Log of WhatsApp advance reminder notifications sent to practitioners.
 */
export const courseScheduleNotifications = pgTable(
  "course_schedule_notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),

    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => courseSchedules.id, { onDelete: "cascade" }),

    runId: uuid("run_id").references(() => courseScheduleRuns.id, {
      onDelete: "set null",
    }),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    phone: varchar("phone", { length: 50 }).notNull(),

    status: courseScheduleNotificationStatusEnum("status")
      .notNull()
      .default("queued"),

    wamid: varchar("wamid", { length: 255 }),

    sentAt: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("course_schedule_notifications_schedule_idx").on(table.scheduleId),
    index("course_schedule_notifications_user_idx").on(table.userId),
    index("course_schedule_notifications_run_idx").on(table.runId),
  ],
);

export type CourseScheduleRow = typeof courseSchedules.$inferSelect;
export type NewCourseSchedule = typeof courseSchedules.$inferInsert;
export type CourseScheduleRunRow = typeof courseScheduleRuns.$inferSelect;
export type CourseScheduleNotificationRow =
  typeof courseScheduleNotifications.$inferSelect;
