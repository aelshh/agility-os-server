import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";
import { users } from "./users.js";

/**
 * Org admin memberships.
 *
 * `users.role` stays HRMS-derived and is used for onboarding features; admin
 * access is a separate, org-scoped grant tracked here. A row with
 * `revoked_at IS NULL` is an active admin. The partial unique index prevents
 * duplicate *active* memberships while preserving full revocation history.
 */
export const admins = pgTable(
  "org_admins",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Who granted admin — null for the org-bootstrap founder. */
    grantedBy: uuid("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),

    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Who revoked admin — null while still active. */
    revokedBy: uuid("revoked_by").references(() => users.id, {
      onDelete: "set null",
    }),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("org_admins_org_id_idx").on(table.orgId),
    uniqueIndex("org_admins_active_user_unique")
      .on(table.orgId, table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export type AdminRow = typeof admins.$inferSelect;
export type NewAdmin = typeof admins.$inferInsert;