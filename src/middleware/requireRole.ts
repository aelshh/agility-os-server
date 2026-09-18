/**
 * RBAC middleware factory.
 *
 * Usage:
 *   router.post('/sensitive', requireAuth, requireRole('architect'), handler)
 *
 * Enforced in middleware, not the UI — per spec §8 rule.
 */

import type { RequestHandler } from "express";
import type { UserRow } from "../db/schema.js";

type Role = UserRow["role"];

export function requireRole(...allowedRoles: Role[]): RequestHandler {
  return (req, res, next) => {
    const user = req.user;

    if (!user) {
      // requireAuth should always run before requireRole
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    if (!allowedRoles.includes(user.role as Role)) {
      res.status(403).json({
        message: "You do not have permission to perform this action",
        requiredRoles: allowedRoles,
        yourRole: user.role,
      });
      return;
    }

    next();
  };
}
