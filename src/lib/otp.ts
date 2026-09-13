import { randomBytes, randomFillSync } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";

import { db } from "../db/index.js";
import {
  emailVerificationGrants,
  emailVerifications,
} from "../db/schema.js";
import { hashToken } from "./auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_DIGITS = 6;
export const OTP_MAX_ATTEMPTS = 5;
export const EMAIL_GRANT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically random, uniform 6-digit OTP.
 * Avoids `Math.random()` (biased + not CSPRNG).
 */
export function generateOtp(): string {
  const bytes = new Uint8Array(OTP_DIGITS);
  randomFillSync(bytes);

  let code = "";
  for (const byte of bytes) {
    code += String(byte % 10);
  }
  return code;
}

// ---------------------------------------------------------------------------
// OTP store — Postgres-backed
//
// This is the seam where a Redis implementation can slot in later
// (see AgilityOS data layer: PostgreSQL + Redis). Keep the interface stable.
// ---------------------------------------------------------------------------

/**
 * Creates a fresh OTP for a user, invalidating any previous one.
 * Returns the RAW OTP (the only time it ever leaves the server).
 */
export async function createOtp(userId: string): Promise<string> {
  const otp = generateOtp();
  const otpHash = hashToken(otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await db.transaction(async (tx) => {
    await tx
      .delete(emailVerifications)
      .where(eq(emailVerifications.userId, userId));

    await tx.insert(emailVerifications).values({
      userId,
      otpHash,
      expiresAt,
      attempts: 0,
    });
  });

  return otp;
}

export type VerifyOtpResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "invalid" | "locked" };

/**
 * Checks a submitted OTP against the stored hash.
 * Consumes the code on success (row deleted in the same transaction).
 */
export async function verifyOtp(
  userId: string,
  code: string,
): Promise<VerifyOtpResult> {
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(eq(emailVerifications.userId, userId))
    .limit(1);

  if (!row) {
    return { ok: false, reason: "invalid" };
  }

  if (row.expiresAt.getTime() < Date.now()) {
    await db
      .delete(emailVerifications)
      .where(eq(emailVerifications.id, row.id));
    return { ok: false, reason: "expired" };
  }

  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await db
      .delete(emailVerifications)
      .where(eq(emailVerifications.id, row.id));
    return { ok: false, reason: "locked" };
  }

  const submittedHash = hashToken(code);
  const match = submittedHash === row.otpHash;

  if (!match) {
    await db
      .update(emailVerifications)
      .set({ attempts: row.attempts + 1 })
      .where(eq(emailVerifications.id, row.id));
    return { ok: false, reason: "invalid" };
  }

  // Consume the code atomically
  await db
    .delete(emailVerifications)
    .where(eq(emailVerifications.id, row.id));

  return { ok: true };
}

/** Removes any live OTP for a user (e.g. after email change). */
export async function resetOtp(userId: string): Promise<void> {
  await db
    .delete(emailVerifications)
    .where(eq(emailVerifications.userId, userId));
}

/** Returns true if the user has a live (unexpired) OTP pending. */
export async function hasPendingOtp(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: emailVerifications.id })
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.userId, userId),
        gt(emailVerifications.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return !!row;
}

// ---------------------------------------------------------------------------
// Email-keyed OTP — pre-account verification (org bootstrap step 0)
// ---------------------------------------------------------------------------

/**
 * Creates a fresh OTP for an email address (before any account exists),
 * invalidating any previous one for that email. Returns the RAW OTP.
 */
export async function createOtpByEmail(email: string): Promise<string> {
  const otp = generateOtp();
  const otpHash = hashToken(otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await db.transaction(async (tx) => {
    await tx
      .delete(emailVerifications)
      .where(eq(emailVerifications.email, email));

    await tx.insert(emailVerifications).values({
      email,
      otpHash,
      expiresAt,
      attempts: 0,
    });
  });

  return otp;
}

export type VerifyOtpByEmailResult =
  | { ok: true; token: string }
  | { ok: false; reason: "expired" | "invalid" | "locked" };

/**
 * Checks a submitted OTP against the stored hash for an email (no user yet).
 * On success: consumes the code and issues a one-time verification grant.
 */
export async function verifyOtpByEmail(
  email: string,
  code: string,
): Promise<VerifyOtpByEmailResult> {
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(eq(emailVerifications.email, email))
    .limit(1);

  if (!row) {
    return { ok: false, reason: "invalid" };
  }

  if (row.expiresAt.getTime() < Date.now()) {
    await db
      .delete(emailVerifications)
      .where(eq(emailVerifications.id, row.id));
    return { ok: false, reason: "expired" };
  }

  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await db
      .delete(emailVerifications)
      .where(eq(emailVerifications.id, row.id));
    return { ok: false, reason: "locked" };
  }

  const submittedHash = hashToken(code);
  if (submittedHash !== row.otpHash) {
    await db
      .update(emailVerifications)
      .set({ attempts: row.attempts + 1 })
      .where(eq(emailVerifications.id, row.id));
    return { ok: false, reason: "invalid" };
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + EMAIL_GRANT_TTL_MS);

  // Consume the code and issue the grant atomically.
  await db.transaction(async (tx) => {
    await tx
      .delete(emailVerifications)
      .where(eq(emailVerifications.id, row.id));

    await tx
      .delete(emailVerificationGrants)
      .where(eq(emailVerificationGrants.email, email));

    await tx.insert(emailVerificationGrants).values({
      email,
      tokenHash,
      expiresAt,
    });
  });

  return { ok: true, token };
}