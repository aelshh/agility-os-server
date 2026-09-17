import {
  boolean,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";
import { teams } from "./teams.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", [
  "practitioner",
  "field_coach",
  "content_curator",
  "quality_gate",
  "strategist",
  "architect",
  "talent_steward",
]);

export type UserRole = (typeof userRoleEnum.enumValues)[number];

export const userStatusEnum = pgEnum("user_status", [
  "invited",
  "active",
  "churned",
]);

export const userSourceEnum = pgEnum("user_source", [
  "hrms",
  "csv",
  "manual",
]);

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),

  // Tenant
  orgId: uuid("org_id").references(() => orgs.id, { onDelete: "restrict" }),

  // HRMS linkage (Phase 2)
  externalHrmsId: varchar("external_hrms_id", { length: 255 }).unique(),

  // Identity
  role: userRoleEnum("role").notNull().default("practitioner"),
  name: varchar("name", { length: 255 }),

  // WhatsApp identity (practitioners)
  phone: varchar("phone", { length: 20 }),
  phoneVerified: boolean("phone_verified").notNull().default(false),

  // Dashboard identity (architect, field_coach, etc.)
  email: varchar("email", { length: 255 }),
  emailVerified: boolean("email_verified").notNull().default(false),
  passwordHash: text("password_hash"),
  googleId: text("google_id").unique(),

  // Profile / prefs
  image: text("image"),
  languagePref: varchar("language_pref", { length: 10 }).notNull().default("en"),
  region: varchar("region", { length: 100 }),

  // Org-tree edges (Phase 2: set by HRMS sync)
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
  /** Self-referencing — resolved via application joins to avoid circular FK issues in Drizzle. */
  managerId: uuid("manager_id"),

  // Employment data
  hireDate: date("hire_date"),
  hireReason: text("hire_reason"),

  // Computed / aggregated (updated by background jobs)
  currentLevel: jsonb("current_level").default({}),
  streakCount: integer("streak_count").notNull().default(0),
  lastDrillAt: timestamp("last_drill_at", { withTimezone: true }),

  // Classification
  isSales: boolean("is_sales").notNull().default(true),
  source: userSourceEnum("source").notNull().default("manual"),

  // Lifecycle
  status: userStatusEnum("status").notNull().default("invited"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
