import {
  index,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";
import { users } from "./users.js";

/**
 * Graph-based representation of management hierarchies.
 * Populated by the CSV upload tree builder.
 */
export const reportingEdges = pgTable(
  "reporting_edges",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),

    managerUserId: uuid("manager_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    reportUserId: uuid("report_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** NULL = currently valid edge. Set on manager change or termination. */
    validFrom: timestamp("valid_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("reporting_edges_org_id_idx").on(table.orgId),
    index("reporting_edges_manager_idx").on(table.managerUserId),
    index("reporting_edges_report_idx").on(table.reportUserId),
  ],
);

export type ReportingEdgeRow = typeof reportingEdges.$inferSelect;
export type NewReportingEdge = typeof reportingEdges.$inferInsert;
