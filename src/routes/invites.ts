/**
 * Invite acceptance routes — Flow B (Dashboard Role Activation).
 *
 * GET  /api/invites/:token  — validate token, return prefill data (name/role/org)
 * POST /api/invites/:token/accept — set password, activate user, create session
 */

import argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import { invites, orgs, users } from "../db/schema.js";
import { toPublicOrg } from "../db/orgs.js";
import { handleDatabaseError } from "../lib/dbErrors.js";
import {
  INVITE_TTL_MS,
  createSession,
  hashToken,
  toPublicUser,
} from "../lib/auth.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/invites/:token — Validate & prefill
// ---------------------------------------------------------------------------

router.get("/:token", async (req, res) => {
  const rawToken = req.params["token"];

  if (!rawToken || typeof rawToken !== "string") {
    res.status(400).json({ message: "Invalid invite link" });
    return;
  }

  const tokenHash = hashToken(rawToken);

  try {
    const [row] = await db
      .select({
        invite: invites,
        user: users,
        org: orgs,
      })
      .from(invites)
      .innerJoin(users, eq(invites.targetUserId, users.id))
      .innerJoin(orgs, eq(invites.orgId, orgs.id))
      .where(eq(invites.tokenHash, tokenHash))
      .limit(1);

    if (!row) {
      res.status(404).json({ message: "Invite not found or already used." });
      return;
    }

    if (row.invite.status !== "pending") {
      res.status(410).json({
        message:
          row.invite.status === "accepted"
            ? "This invite has already been used."
            : "This invite has expired or been revoked.",
      });
      return;
    }

    if (row.invite.expiresAt.getTime() < Date.now()) {
      // Lazily mark expired
      await db
        .update(invites)
        .set({ status: "expired" })
        .where(eq(invites.id, row.invite.id));

      res.status(410).json({ message: "This invite link has expired." });
      return;
    }

    res.status(200).json({
      name: row.user.name,
      email: row.user.email,
      role: row.user.role,
      org: toPublicOrg(row.org),
      expiresAt: row.invite.expiresAt,
    });
  } catch (err) {
    console.error("[invites] GET failed", err);
    res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/invites/:token/accept — Set password, activate
// ---------------------------------------------------------------------------

const acceptSchema = z.object({
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
});

router.post("/:token/accept", async (req, res) => {
  const rawToken = req.params["token"];

  if (!rawToken || typeof rawToken !== "string") {
    res.status(400).json({ message: "Invalid invite link" });
    return;
  }

  const result = acceptSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({ errors: result.error.flatten().fieldErrors });
    return;
  }

  const tokenHash = hashToken(rawToken);

  try {
    const [row] = await db
      .select({ invite: invites, user: users })
      .from(invites)
      .innerJoin(users, eq(invites.targetUserId, users.id))
      .where(
        and(eq(invites.tokenHash, tokenHash), eq(invites.status, "pending")),
      )
      .limit(1);

    if (!row) {
      res.status(404).json({ message: "Invite not found or already used." });
      return;
    }

    if (row.invite.expiresAt.getTime() < Date.now()) {
      await db
        .update(invites)
        .set({ status: "expired" })
        .where(eq(invites.id, row.invite.id));
      res.status(410).json({ message: "This invite link has expired." });
      return;
    }

    const passwordHash = await argon2.hash(result.data.password);
    const now = new Date();

    // Activate user + consume invite atomically
    const [activatedUser] = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(users)
        .set({
          passwordHash,
          emailVerified: true,
          status: "active",
          activatedAt: now,
        })
        .where(eq(users.id, row.user.id))
        .returning();

      await tx
        .update(invites)
        .set({ status: "accepted", acceptedAt: now })
        .where(eq(invites.id, row.invite.id));

      return [updated];
    });

    if (!activatedUser) {
      res.status(500).json({ message: "Failed to activate account." });
      return;
    }

    await createSession(activatedUser.id, res);

    res.status(200).json({ user: toPublicUser(activatedUser) });
  } catch (err) {
    if (handleDatabaseError(err, res)) {
      return;
    }

    console.error("[invites] accept failed", err);
    res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
});

export const invitesRouter = router;
