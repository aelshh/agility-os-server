import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";

import { db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import { SESSION_COOKIE_NAME, toPublicUser } from "../lib/auth.js";

export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];

  if (!token) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const [row] = await db
    .select({
      user: users,
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.token, token))
    .limit(1);

  if (!row) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.token, token));
    res.status(401).json({ message: "Session expired" });
    return;
  }

  req.user = toPublicUser(row.user);
  req.sessionId = row.sessionId;

  next();
};