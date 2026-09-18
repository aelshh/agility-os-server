/**
 * POST /api/orgs — Org Bootstrap
 *
 * The ONE manual signup in the system. Creates the first tenant (org) and
 * the admin's architect account in a single atomic transaction.
 *
 * Public endpoint — no auth required (first-run setup).
 * Work-email validation is enforced: personal domains are rejected.
 *
 * The email MUST be verified beforehand via POST /api/verify/send +
 * POST /api/verify/preverify, which issue a single-use grant. That grant is
 * required here, consumed atomically, and the architect account is created
 * as already verified + active with a session issued immediately.
 */

import argon2 from "argon2";
import { eq, or } from "drizzle-orm";
import { Router } from "express";
import { email, z } from "zod";

import { db } from "../db/index.js";
import { admins, emailVerificationGrants, orgs, users } from "../db/schema.js";
import { createSession, hashToken, toPublicUser } from "../lib/auth.js";
import { handleDatabaseError } from "../lib/dbErrors.js";
import { isWorkEmail, WORK_EMAIL_MESSAGE } from "../lib/workEmail.js";
import { toPublicOrg } from "../db/orgs.js";
import { orgBootstrapLimiter } from "../middleware/rateLimit.js";

const router = Router();

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const bootstrapSchema = z.object({
  // Admin
  adminName: z.string().min(1, "Name is required").max(100).trim(),
  adminEmail: z
    .email("Please provide a valid email address")
    .max(255)
    .toLowerCase()
    .refine(isWorkEmail, WORK_EMAIL_MESSAGE),
  adminPhone: z
    .string()
    .trim()
    .transform((val) => (val === "" ? undefined : val))
    .pipe(
      z
        .string()
        .min(7, "Phone number must be at least 7 digits")
        .max(20, "Phone number cannot exceed 20 characters")
        .optional(),
    )
    .optional(),
  adminPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),

  // Org
  orgName: z.string().min(1, "Organisation name is required").max(255).trim(),
  orgTimezone: z.string().min(1, "Timezone is required").max(64).trim(),
  orgLanguage: z.string().min(2).max(10).trim().default("en"),
  defaultRegion: z
    .string()
    .min(1, "Default region is required")
    .max(100)
    .trim(),

  // One-time proof issued by POST /api/verify/preverify.
  // Email MUST be verified before an account can be created.
  emailVerificationToken: z
    .string()
    .min(1, "Please verify your work email to continue")
    .trim(),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Thrown inside the org-creation transaction when the email grant is invalid. */
class VerificationGrantError extends Error {
  constructor(public readonly code: "invalid" | "expired" | "used") {
    super(`email verification grant: ${code}`);
    this.name = "VerificationGrantError";
  }
}

router.post("/", orgBootstrapLimiter, async (req, res) => {
  const result = bootstrapSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({ errors: result.error.issues });
    return;
  }

  const data = result.data;

  try {
    // 1. Check: no existing user with that email or phone number

    const conditions = data.adminPhone
      ? or(eq(users.phone, data.adminPhone), eq(users.email, data.adminEmail))
      : eq(users.email, data.adminEmail);

    const existingUsers = await db
      .select({ email: users.email, phone: users.phone })
      .from(users)
      .where(conditions)
      .limit(2);

    if (existingUsers.length > 0) {
      const emailTaken = existingUsers.some((u) => u.email === data.adminEmail);
      const phoneTaken = data.adminPhone
        ? existingUsers.some((u) => u.phone === data.adminPhone)
        : false;

      const errors: Record<string, string[]> = {};
      if (emailTaken)
        errors.adminEmail = ["An account with Email already exists."];

      if (phoneTaken)
        errors.adminPhone = [
          "This phone number is already registered with another account.",
        ];

      const message =
        emailTaken && phoneTaken
          ? "Both email and phone number are already registered."
          : emailTaken
            ? "An account with that email already exists."
            : "This phone number is already registered with another account.";

      res.status(409).json({
        message,
        errors,
      });
      return;
    }

    const passwordHash = await argon2.hash(data.adminPassword);

    // Create org + architect user atomically.
    // The email grant is validated AND consumed inside the same transaction,
    // so a failed insert rolls the grant back (retry-safe).
    const [org, user] = await db.transaction(async (tx) => {
      // 3. Validate + consume the email verification grant.
      const tokenHash = hashToken(data.emailVerificationToken);
      const [grant] = await tx
        .select()
        .from(emailVerificationGrants)
        .where(eq(emailVerificationGrants.email, data.adminEmail))
        .limit(1);

      if (!grant || grant.tokenHash !== tokenHash) {
        throw new VerificationGrantError("invalid");
      }
      if (grant.usedAt) {
        throw new VerificationGrantError("used");
      }
      if (grant.expiresAt.getTime() < Date.now()) {
        throw new VerificationGrantError("expired");
      }

      await tx
        .update(emailVerificationGrants)
        .set({ usedAt: new Date() })
        .where(eq(emailVerificationGrants.id, grant.id));

      const [newOrg] = await tx
        .insert(orgs)
        .values({
          name: data.orgName,
          timezone: data.orgTimezone,
          language: data.orgLanguage,
          defaultRegion: data.defaultRegion,
        })
        .returning();

      if (!newOrg) throw new Error("Failed to create org");

      // 4. Email was pre-verified — account starts active with a session.
      const [newUser] = await tx
        .insert(users)
        .values({
          orgId: newOrg.id,
          name: data.adminName,
          email: data.adminEmail,
          emailVerified: true,
          phone: data.adminPhone ?? null,
          passwordHash,
          role: "architect",
          status: "active",
          source: "manual",
          activatedAt: new Date(),
        })
        .returning();

      if (!newUser) throw new Error("Failed to create admin user");

      // 5. The org founder is the first org admin (no granter recorded).
      const [newAdmin] = await tx
        .insert(admins)
        .values({ orgId: newOrg.id, userId: newUser.id })
        .returning();

      if (!newAdmin) throw new Error("Failed to grant org admin");

      return [newOrg, newUser] as const;
    });

    await createSession(user.id, res);

    res.status(201).json({
      org: toPublicOrg(org),
      user: toPublicUser(user),
    });
  } catch (err) {
    if (err instanceof VerificationGrantError) {
      const message =
        err.code === "expired"
          ? "Email verification has expired. Please verify your email again."
          : "Email verification is required. Please verify your email and try again.";
      res.status(400).json({ message });
      return;
    }

    if (
      handleDatabaseError(err, res, {
        constraintFieldMap: {
          users_phone_unique_idx: "adminPhone",
          users_phone_key: "adminPhone",
          users_email_unique_idx: "adminEmail",
          users_email_key: "adminEmail",
          users_email_unique: "adminEmail",
          user_email_unique: "adminEmail",
        },
      })
    ) {
      return;
    }

    console.error("[orgs] bootstrap failed", err);
    res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
});

export const orgsRouter = router;
