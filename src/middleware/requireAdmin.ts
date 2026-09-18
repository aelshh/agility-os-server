/**
 * Admin gate — org-scoped admin membership check.
 *
 * Unlike requireRole (which checks HRMS-derived role), this checks the
 * `org_admins` table for an active grant for the requesting user's org.
 * Enforced in middleware, not the UI.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { RequestHandler } from "express";

import { db } from "../db/index.js";
import { admins } from "../db/schema.js";

export const requireAdmin: RequestHandler = async (req, res, next) => {
  const user = req.user;

  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  if (!user.orgId) {
    res.status(403).json({
      message: "Your account is not attached to an organisation",
    });
    return;
  }

  const [row] = await db
    .select({ id: admins.id })
    .from(admins)
    .where(
      and(
        eq(admins.orgId, user.orgId),
        eq(admins.userId, user.id),
        isNull(admins.revokedAt),
      ),
    )
    .limit(1);

  if (!row) {
    res.status(403).json({
      message: "Admin access is required to perform this action",
    });
    return;
  }

  next();
};