/**
 * Admin management routes — grant/revoke org-admin access.
 *
 * GET  /api/admins           — list active admins for the caller's org
 * POST /api/admins           — grant admin to a user in the org {userId}
 * POST /api/admins/:userId/revoke — revoke admin (locked if last active)
 *
 * All require an authenticated org admin (requireAdmin).
 */

import { and, eq, isNull, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { admins, users } from "../db/schema.js";
import { db } from "../db/index.js";
import { handleDatabaseError } from "../lib/dbErrors.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

router.use(requireAuth, requireAdmin);

// ---------------------------------------------------------------------------
// Admin list shape (canonical public fields)
// ---------------------------------------------------------------------------

type AdminListItem = {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  grantedAt: Date;
  grantedByName: string | null;
  isSelf: boolean;
};

async function listAdminsForOrg(
  orgId: string,
  selfUserId: string,
): Promise<AdminListItem[]> {
  const rows = await db
    .select({
      id: admins.id,
      userId: admins.userId,
      grantedAt: admins.grantedAt,
      grantedByName: users.name,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: users.role,
    })
    .from(admins)
    .innerJoin(users, eq(admins.userId, users.id))
    .where(and(eq(admins.orgId, orgId), isNull(admins.revokedAt)))
    .orderBy(admins.grantedAt);

  // Resolve "granted by" display name via a second join on granted_by.
  const adminIds = rows.map((r) => r.id);
  const granters = adminIds.length
    ? await db
        .select({
          adminId: admins.id,
          granterName: users.name,
        })
        .from(admins)
        .innerJoin(users, eq(admins.grantedBy, users.id))
        .where(
          and(
            eq(admins.orgId, orgId),
            isNull(admins.revokedAt),
          ),
        )
    : [];

  const grantersById = new Map(granters.map((g) => [g.adminId, g.granterName]));

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.name,
    email: r.email,
    phone: r.phone,
    role: r.role,
    grantedAt: r.grantedAt,
    grantedByName: grantersById.get(r.id) ?? null,
    isSelf: r.userId === selfUserId,
  }));
}

// ---------------------------------------------------------------------------
// GET / — list active admins
// ---------------------------------------------------------------------------

router.get("/", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  try {
    const adminsList = await listAdminsForOrg(user.orgId!, user.id);
    res.status(200).json({ adminsCount: adminsList.length, admins: adminsList });
  } catch (err) {
    console.error("[admins] list failed", err);
    res.status(500).json({ message: "Failed to load admins" });
  }
});

// ---------------------------------------------------------------------------
// POST / — grant admin to a user in the org
// ---------------------------------------------------------------------------

const grantSchema = z.object({
  userId: z.string().uuid("A valid user id is required"),
});

router.post("/", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const result = grantSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ errors: result.error.flatten().fieldErrors });
    return;
  }

  const targetUserId = result.data.userId;

  try {
    const [target] = await db
      .select()
      .from(users)
      .where(
        and(eq(users.id, targetUserId), eq(users.orgId, user.orgId!)),
      )
      .limit(1);

    if (!target || target.status !== "active") {
      res.status(400).json({
        message:
          "This user is not an active member of your organisation.",
      });
      return;
    }

    // Re-granting an already-active admin is a no-op success.
    const [existing] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(
        and(
          eq(admins.orgId, user.orgId!),
          eq(admins.userId, targetUserId),
          isNull(admins.revokedAt),
        ),
      )
      .limit(1);

    if (existing) {
      res.status(200).json({ alreadyAdmin: true, userId: targetUserId });
      return;
    }

    const [granted] = await db
      .insert(admins)
      .values({ orgId: user.orgId!, userId: targetUserId, grantedBy: user.id })
      .returning();

    if (!granted) {
      res.status(500).json({ message: "Failed to grant admin access" });
      return;
    }

    res.status(201).json({
      adminId: granted.id,
      userId: granted.userId,
      grantedAt: granted.grantedAt,
    });
  } catch (err) {
    if (handleDatabaseError(err, res)) return;
    console.error("[admins] grant failed", err);
    res.status(500).json({ message: "Failed to grant admin access" });
  }
});

// ---------------------------------------------------------------------------
// POST /:userId/revoke — revoke admin (locked if last active)
// ---------------------------------------------------------------------------

router.post("/:userId/revoke", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const targetUserId = req.params["userId"];
  if (!targetUserId || typeof targetUserId !== "string") {
    res.status(400).json({ message: "A valid user id is required" });
    return;
  }

  try {
    const [existing] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(
        and(
          eq(admins.orgId, user.orgId!),
          eq(admins.userId, targetUserId),
          isNull(admins.revokedAt),
        ),
      )
      .limit(1);

    if (!existing) {
      res.status(200).json({ revoked: false, userId: targetUserId });
      return;
    }

    // Last-admin lockout guard: an org must always keep at least one admin.
    const countRows = await db
      .select({ activeCount: sql<number>`count(*)` })
      .from(admins)
      .where(
        and(
          eq(admins.orgId, user.orgId!),
          ne(admins.userId, targetUserId),
          isNull(admins.revokedAt),
        ),
      );
    const activeCount = countRows[0]?.activeCount ?? 0;

    if (Number(activeCount) === 0) {
      res.status(400).json({
        message:
          "You cannot revoke the last admin. Grant admin to someone else first.",
        lastAdmin: true,
      });
      return;
    }

    await db
      .update(admins)
      .set({ revokedBy: user.id, revokedAt: new Date() })
      .where(eq(admins.id, existing.id));

    res.status(200).json({ revoked: true, adminId: existing.id, userId: targetUserId });
  } catch (err) {
    console.error("[admins] revoke failed", err);
    res.status(500).json({ message: "Failed to revoke admin access" });
  }
});

export const adminsRouter = router;