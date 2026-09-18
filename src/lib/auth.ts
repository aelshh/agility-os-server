import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";

import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import type { UserRow } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const SESSION_COOKIE_NAME = "session";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const sessionCookieBase = {
  httpOnly: true,
  secure: process.env["NODE_ENV"] === "production",
  sameSite: "lax" as const,
  maxAge: SESSION_TTL_MS,
};

export async function createSession(
  userId: string,
  res: Response,
): Promise<void> {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessions).values({ userId, token, expiresAt });

  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieBase);
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME);
}

// ---------------------------------------------------------------------------
// Public user shape — strips sensitive fields before sending to client
// ---------------------------------------------------------------------------

export type PublicUser = {
  id: string;
  orgId: string | null;
  role: UserRow["role"];
  status: UserRow["status"];
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  image: string | null;
  languagePref: string;
  region: string | null;
  source: UserRow["source"];
  isSales: boolean;
  activatedAt: Date | null;
  createdAt: Date;
};

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    orgId: user.orgId ?? null,
    role: user.role,
    status: user.status,
    name: user.name ?? null,
    email: user.email ?? null,
    emailVerified: user.emailVerified,
    phone: user.phone ?? null,
    phoneVerified: user.phoneVerified,
    image: user.image ?? null,
    languagePref: user.languagePref,
    region: user.region ?? null,
    source: user.source,
    isSales: user.isSales,
    activatedAt: user.activatedAt ?? null,
    createdAt: user.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Invite token helpers
// ---------------------------------------------------------------------------

const INVITE_TOKEN_BYTES = 32; // 256 bits of entropy → URL-safe hex

/**
 * Generates a cryptographically random invite token and its SHA-256 hash.
 * Store ONLY the hash in the DB. Return the raw token to embed in the email link.
 */
export function generateInviteToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(INVITE_TOKEN_BYTES).toString("hex");
  const tokenHash = hashToken(rawToken);
  return { rawToken, tokenHash };
}

/**
 * SHA-256 hash of a raw token string. Use for DB lookup.
 */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** 72-hour invite expiry per spec §6. */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;