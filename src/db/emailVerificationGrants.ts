import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * One-time proofs that "an email address was verified" via OTP BEFORE the
 * account exists (org bootstrap step 0). Issued by POST /api/verify/preverify,
 * consumed atomically by POST /api/orgs. Single-use, short-lived.
 */
export const emailVerificationGrants = pgTable("email_verification_grants", {
  id: uuid("id").defaultRandom().primaryKey(),

  /** The verified work email. Must match the adminEmail at org creation. */
  email: text("email").notNull(),

  /** SHA-256 hash of the raw grant token (never stored raw). */
  tokenHash: text("token_hash").notNull(),

  /** 30-minute grant expiry. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

  /** Set when consumed by org creation (single-use). */
  usedAt: timestamp("used_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type EmailVerificationGrantRow =
  typeof emailVerificationGrants.$inferSelect;
export type NewEmailVerificationGrant =
  typeof emailVerificationGrants.$inferInsert;