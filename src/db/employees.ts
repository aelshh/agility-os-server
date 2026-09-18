import {
  boolean,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";
import { teams } from "./teams.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const employeeStatusEnum = pgEnum("employee_status", [
  "active",
  "terminated",
]);

export const employeeSourceEnum = pgEnum("employee_source", [
  "hrms",
  "csv",
  "manual",
]);

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * The raw, HRMS-faithful employee layer (distinct from `users` which carries
 * auth/identity concerns). Populated exclusively by the HRMS sync.
 *
 * `external_hrms_id` is the PRIMARY stable match key between sync runs —
 * an employee is never treated as "new" if this id already exists.
 */
export const employees = pgTable(
  "employees",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "restrict" }),

    /** Stable match key across HRMS sync runs, unique per org (tenant-safe). */
    externalHrmsId: varchar("external_hrms_id", { length: 255 }).notNull(),

    /** Raw HRMS manager reference — resolved into reporting_edges at sync time. */
    externalManagerId: varchar("external_manager_id", { length: 255 }),

    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 20 }),

    /** Feeds role derivation (§4.3). */
    designation: varchar("designation", { length: 100 }),
    department: varchar("department", { length: 100 }),

    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    region: varchar("region", { length: 100 }),

    hireDate: date("hire_date"),
    hireReason: text("hire_reason"),
    jdHash: text("jd_hash"),
    atsJdHash: text("ats_jd_hash"),

    /** Non-sales staff stay in the tree but are flagged, never filtered (§4.2). */
    isSales: boolean("is_sales").notNull().default(true),

    status: employeeStatusEnum("status").notNull().default("active"),
    source: employeeSourceEnum("source").notNull().default("hrms"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("employees_org_id_idx").on(table.orgId),
    uniqueIndex("employees_org_external_hrms_unique").on(table.orgId, table.externalHrmsId),
  ],
);

export type EmployeeRow = typeof employees.$inferSelect;
export type NewEmployee = typeof employees.$inferInsert;