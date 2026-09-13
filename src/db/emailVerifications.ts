import {
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * One-time password records for email verification (org bootstrap, resend).
 * The raw OTP is NEVER stored — only its SHA-256 hash.
 * Supported in Postgres today; designed to be portable to Redis later.
 *
 * Rows are keyed by `userId` (account already exists — login/verify flows) OR
 * by `email` (pre-bootstrap verification, before the account exists).
 */
export const emailVerifications = pgTable("email_verifications", {
  id: uuid("id").defaultRandom().primaryKey(),

  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" }),

  /** Work email for pre-account verification (mutually exclusive with userId). */
  email: text("email"),

  /** SHA-256 hash of the 6-digit OTP. */
  otpHash: text("otp_hash").notNull(),

  /** 10-minute OTP expiry. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

  /** Failed verification attempts on this code. */
  attempts: integer("attempts").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type EmailVerificationRow = typeof emailVerifications.$inferSelect;
export type NewEmailVerification = typeof emailVerifications.$inferInsert;