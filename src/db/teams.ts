import {
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";

/**
 * Teams / department hierarchy stub.
 * Phase 1: created manually or via org bootstrap.
 * Phase 2: fully populated by HRMS sync.
 */
export const teams = pgTable("teams", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  /** Self-referencing FK for nested departments. */
  parentTeamId: uuid("parent_team_id"),
  /** Primary match key against HRMS department records. */
  externalHrmsId: varchar("external_hrms_id", { length: 255 }),
  /** Raw department name from HRMS — used for non-sales flagging. */
  hrmsDepartment: varchar("hrms_department", { length: 100 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type TeamRow = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
