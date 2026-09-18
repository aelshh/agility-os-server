import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";
import { users } from "./users.js";

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

export const inviteStatusEnum = pgEnum("invite_status", [
  "pending",
  "accepted",
  "expired",
  "revoked",
]);

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * Activation-token lifecycle for dashboard-role email invites (Flow B).
 * Phase 1: tokens are issued manually by an architect.
 * Phase 2: tokens are issued automatically after a sync batch is approved.
 */
export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),

  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),

  targetUserId: uuid("target_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  /**
   * SHA-256 hash of the raw token. Never store the raw token in the DB.
   * The raw token is returned once at creation time and embedded in the email link.
   */
  tokenHash: text("token_hash").notNull().unique(),

  /** 72-hour expiry per spec §6. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

  status: inviteStatusEnum("status").notNull().default("pending"),

  acceptedAt: timestamp("accepted_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type InviteRow = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
