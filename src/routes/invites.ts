/**
 * Invite routes — Flow B (Dashboard Role Activation).
 *
 * GET  /api/invites/:token  — validate token, return prefill data (name/role/org)
 * POST /api/invites/:token/accept — set password, activate user, create session
 * POST /api/invites        — org-admin bulk invite creation (org-tree flow)
 */

import argon2 from "argon2";
import { and, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import { invites, orgs, users } from "../db/schema.js";
import { toPublicOrg } from "../db/orgs.js";
import { handleDatabaseError } from "../lib/dbErrors.js";
import {
  INVITE_TTL_MS,
  createSession,
  generateInviteToken,
  hashToken,
  toPublicUser,
} from "../lib/auth.js";
import { sendInviteEmail } from "../lib/mail.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { inviteCreateLimiter } from "../middleware/rateLimit.js";

const router = Router();

const APP_ORIGIN = process.env["APP_ORIGIN"] ?? "http://localhost:5173";

// ---------------------------------------------------------------------------
// POST /api/invites — org-admin bulk invite creation
// ---------------------------------------------------------------------------

const createInvitesSchema = z.object({
  userIds: z
    .array(z.string().uuid("A valid user id is required"))
    .min(1, "Select at least one person to invite")
    .max(200, "You can invite up to 200 people at once"),
});

/**
 * Creates fresh activation invites for the given org users and emails each one.
 * Per-user semantics:
 *  - Only users in the caller's org, with status "invited" and an email, are
 *    eligible. Anyone else is reported as skipped (with reason), never failed.
 *  - Any existing *pending* invite is revoked and replaced by a fresh token
 *    (matching the "revoke + new link" resend behaviour).
 *  - If the email fails to send, the invite row is revoked so no dead link is
 *    left behind and the user is reported as a failure.
 */
router.post(
  "/",
  requireAuth,
  requireAdmin,
  inviteCreateLimiter,
  async (req, res) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    if (!user.orgId) {
      res.status(403).json({ message: "Account is not attached to an organisation" });
      return;
    }

    const result = createInvitesSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ errors: result.error.flatten().fieldErrors });
      return;
    }

    // Deduplicate, preserving order.
    const userIds = [...new Set(result.data.userIds)];

    try {
      const [org] = await db
        .select()
        .from(orgs)
        .where(eq(orgs.id, user.orgId))
        .limit(1);

      if (!org) {
        res.status(404).json({ message: "Organisation not found" });
        return;
      }

      const [targetRows, pendingRows] = await Promise.all([
        db
          .select()
          .from(users)
          .where(and(eq(users.orgId, user.orgId), inArray(users.id, userIds))),
        db
          .select({ id: invites.id, targetUserId: invites.targetUserId })
          .from(invites)
          .where(
            and(
              eq(invites.orgId, user.orgId),
              inArray(invites.targetUserId, userIds),
              eq(invites.status, "pending"),
            ),
          ),
      ]);

      const targetsById = new Map(targetRows.map((u) => [u.id, u]));
      const pendingByTarget = new Map(
        pendingRows.map((i) => [i.targetUserId, i.id]),
      );

      const sent: Array<{ userId: string; email: string }> = [];
      const skipped: Array<{ userId: string; reason: string }> = [];
      const failures: Array<{ userId: string; reason: string }> = [];

      for (const targetUserId of userIds) {
        const target = targetsById.get(targetUserId);

        if (!target) {
          skipped.push({ userId: targetUserId, reason: "not_in_org" });
          continue;
        }
        if (!target.email) {
          skipped.push({ userId: targetUserId, reason: "no_email" });
          continue;
        }
        if (target.status !== "invited") {
          skipped.push({ userId: targetUserId, reason: target.status });
          continue;
        }

        const { rawToken, tokenHash } = generateInviteToken();
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

        try {
          // Revoke any existing pending invite and insert the fresh one.
          const [newInvite] = await db.transaction(async (tx) => {
            const pendingId = pendingByTarget.get(targetUserId);
            if (pendingId) {
              await tx
                .update(invites)
                .set({ status: "revoked" })
                .where(eq(invites.id, pendingId));
            }

            return tx
              .insert(invites)
              .values({
                orgId: user.orgId!,
                targetUserId,
                tokenHash,
                expiresAt,
              })
              .returning();
          });

          if (!newInvite) {
            failures.push({ userId: targetUserId, reason: "insert_failed" });
            continue;
          }

          // Send email; on failure revoke so no dead link remains.
          try {
            await sendInviteEmail({
              to: target.email,
              userName: target.name,
              orgName: org.name,
              sentByName: user.name,
              inviteUrl: `${APP_ORIGIN}/accept/${rawToken}`,
            });
            sent.push({ userId: targetUserId, email: target.email });
          } catch (err) {
            await db
              .update(invites)
              .set({ status: "revoked" })
              .where(eq(invites.id, newInvite.id));
            const message =
              err instanceof Error ? err.message : String(err);
            failures.push({ userId: targetUserId, reason: `email: ${message}` });
          }
        } catch (err) {
          failures.push({
            userId: targetUserId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      res.status(200).json({
        sent,
        skipped,
        failures,
        summary: {
          total: userIds.length,
          sent: sent.length,
          skipped: skipped.length,
          failed: failures.length,
        },
      });
    } catch (err) {
      console.error("[invites] create failed", err);
      res
        .status(500)
        .json({ message: "Something went wrong. Please try again." });
    }
  },
);

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
