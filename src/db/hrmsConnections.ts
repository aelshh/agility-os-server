import {
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const hrmsProviderEnum = pgEnum("hrms_provider", ["csv"]);

export const connectionStatusEnum = pgEnum("connection_status", [
  "active",
  "expired",
]);

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * Stores per-org HRMS upload provenance.
 *
 * The `credential` column holds the CSV platform used for the upload
 * ("keka" | "darwinbox" | "peoplehr"). A single row per org records the
 * most recent CSV import for audit/provenance purposes.
 */
export const hrmsConnections = pgTable(
  "hrms_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "restrict" }),

    provider: hrmsProviderEnum("provider").notNull(),

    /** Account token (Merge) or integration ID (Kombo). */
    credential: varchar("credential", { length: 500 }).notNull(),

    status: connectionStatusEnum("status").notNull().default("active"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("hrms_connections_org_id_idx").on(table.orgId),
    uniqueIndex("hrms_connections_org_provider_unique").on(
      table.orgId,
      table.provider,
    ),
  ],
);

export type HrmsConnectionRow = typeof hrmsConnections.$inferSelect;
export type NewHrmsConnection = typeof hrmsConnections.$inferInsert;
