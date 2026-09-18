import argon2 from "argon2";
import { and, eq, isNull, ne } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import {
  admins,
  employees,
  orgs,
  sessions,
  teams,
  users,
} from "../db/schema.js";
import { toPublicOrg } from "../db/orgs.js";
import { toPublicUser } from "../lib/auth.js";
import { handleDatabaseError } from "../lib/dbErrors.js";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  passwordChangeLimiter,
  profileUpdateLimiter,
} from "../middleware/rateLimit.js";

const router = Router();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Must stay in sync with the language options in client/src/data/options.ts. */
const PROFILE_LANGUAGES = [
  "en",
  "hi",
  "ta",
  "te",
  "mr",
  "ar",
  "fr",
  "de",
  "pt",
  "es",
] as const;

const emptyToNull = z.preprocess(
  (val) => (val === "" ? null : val),
  z.string().nullable(),
);

const updateProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(100, "Name cannot exceed 100 characters")
    .optional(),
  phone: emptyToNull
    .pipe(
      z
        .string()
        .min(7, "Phone number must be at least 7 digits")
        .max(20, "Phone number cannot exceed 20 characters")
        .nullable(),
    )
    .optional(),
  languagePref: z.enum(PROFILE_LANGUAGES).optional(),
  region: emptyToNull
    .pipe(
      z
        .string()
        .min(1, "Region is required")
        .max(100, "Region cannot exceed 100 characters")
        .nullable(),
    )
    .optional(),
  image: emptyToNull
    .pipe(
      z.union([
        z.string().url("Please provide a valid image URL"),
        z.literal(null),
      ]),
    )
    .optional(),
});

const changePasswordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, "Current password is required")
      .max(128),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(128),
    newPasswordConfirm: z.string().min(1, "Please confirm your new password"),
  })
  .refine((d) => d.newPassword === d.newPasswordConfirm, {
    message: "Passwords don't match.",
    path: ["newPasswordConfirm"],
  });

// ---------------------------------------------------------------------------
// GET /api/profile — full read model for the profile page
// ---------------------------------------------------------------------------

router.get("/", requireAuth, async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  try {
    const [userRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    if (!userRow) {
      res.status(404).json({ message: "User not found." });
      return;
    }

    const [orgRows, employeeRows, teamRows, managerRows, adminRows] =
      await Promise.all([
        userRow.orgId
          ? db.select().from(orgs).where(eq(orgs.id, userRow.orgId)).limit(1)
          : Promise.resolve([]),
        userRow.orgId && userRow.externalHrmsId
          ? db
              .select()
              .from(employees)
              .where(
                and(
                  eq(employees.orgId, userRow.orgId),
                  eq(employees.externalHrmsId, userRow.externalHrmsId),
                ),
              )
              .limit(1)
          : Promise.resolve([]),
        userRow.teamId
          ? db
              .select({ name: teams.name })
              .from(teams)
              .where(eq(teams.id, userRow.teamId))
              .limit(1)
          : Promise.resolve([]),
        userRow.managerId
          ? db
              .select({
                name: users.name,
                email: users.email,
                image: users.image,
              })
              .from(users)
              .where(eq(users.id, userRow.managerId))
              .limit(1)
          : Promise.resolve([]),
        userRow.orgId
          ? db
              .select({ id: admins.id })
              .from(admins)
              .where(
                and(
                  eq(admins.orgId, userRow.orgId),
                  eq(admins.userId, userRow.id),
                  isNull(admins.revokedAt),
                ),
              )
              .limit(1)
          : Promise.resolve([]),
      ]);

    const employee = employeeRows[0];
    const manager = managerRows[0];

    const signInMethod =
      userRow.passwordHash != null
        ? "password"
        : userRow.googleId != null
          ? "google"
          : null;

    res.status(200).json({
      user: toPublicUser(userRow),
      org: orgRows[0] ? toPublicOrg(orgRows[0]) : null,
      isAdmin: userRow.role === "architect" || adminRows.length > 0,
      signInMethod,
      employee: employee
        ? {
            designation: employee.designation,
            department: employee.department,
            region: employee.region,
            hireDate: employee.hireDate,
            hireReason: employee.hireReason,
            isSales: employee.isSales,
            source: employee.source,
            status: employee.status,
          }
        : null,
      team: teamRows[0] ? { name: teamRows[0].name } : null,
      manager: manager
        ? {
            name: manager.name,
            email: manager.email,
            image: manager.image,
          }
        : null,
    });
  } catch (err) {
    console.error("[profile] GET failed", err);
    res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/profile — update personal fields
// ---------------------------------------------------------------------------

router.patch("/", requireAuth, profileUpdateLimiter, async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const result = updateProfileSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ errors: result.error.flatten().fieldErrors });
    return;
  }

  const data = result.data;
  if (Object.keys(data).length === 0) {
    res.status(400).json({ message: "Nothing to update." });
    return;
  }

  const patch: Partial<typeof users.$inferInsert> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.phone !== undefined) patch.phone = data.phone;
  if (data.languagePref !== undefined) patch.languagePref = data.languagePref;
  if (data.region !== undefined) patch.region = data.region;
  if (data.image !== undefined) patch.image = data.image;

  try {
    if (patch.phone != null) {
      const holders = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.phone, patch.phone))
        .limit(2);

      const takenByOther = holders.some((h) => h.id !== user.id);
      if (takenByOther) {
        const message =
          "This phone number is already registered with another account.";
        res.status(409).json({ message, errors: { phone: [message] } });
        return;
      }
    }

    const [updated] = await db
      .update(users)
      .set(patch)
      .where(eq(users.id, user.id))
      .returning();

    if (!updated) {
      res.status(404).json({ message: "User not found." });
      return;
    }

    res.status(200).json({ user: toPublicUser(updated) });
  } catch (err) {
    if (handleDatabaseError(err, res)) {
      return;
    }
    console.error("[profile] PATCH failed", err);
    res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/profile/password — change password (current password required)
// ---------------------------------------------------------------------------

router.post(
  "/password",
  requireAuth,
  passwordChangeLimiter,
  async (req, res) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    const result = changePasswordSchema.safeParse(req.body);
    if (!result.success) {
      res
        .status(400)
        .json({ errors: result.error.flatten().fieldErrors });
      return;
    }

    try {
      const [userRow] = await db
        .select()
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);

      if (!userRow) {
        res.status(404).json({ message: "User not found." });
        return;
      }

      if (!userRow.passwordHash) {
        res.status(400).json({
          message:
            "This account uses Google Sign-In and does not have a password set.",
        });
        return;
      }

      const { currentPassword, newPassword } = result.data;

      const valid = await argon2.verify(
        userRow.passwordHash,
        currentPassword,
      );

      if (!valid) {
        res.status(400).json({ message: "Current password is incorrect." });
        return;
      }

      const isSame = await argon2.verify(userRow.passwordHash, newPassword);
      if (isSame) {
        res.status(400).json({
          message: "New password must be different from the current one.",
        });
        return;
      }

      const passwordHash = await argon2.hash(newPassword);

      const [updated] = await db
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, user.id))
        .returning();

      if (!updated) {
        res.status(404).json({ message: "User not found." });
        return;
      }

      if (req.sessionId) {
        await db
          .delete(sessions)
          .where(
            and(
              eq(sessions.userId, user.id),
              ne(sessions.token, req.sessionId),
            ),
          );
      }

      res.status(200).json({
        message: "Password updated.",
        user: toPublicUser(updated),
      });
    } catch (err) {
      console.error("[profile] password change failed", err);
      res
        .status(500)
        .json({ message: "Something went wrong. Please try again." });
    }
  },
);

export const profileRouter = router;