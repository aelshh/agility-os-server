/**
 * Email verification routes — OTP.
 *
 * POST /api/verify/otp     — submit the 6-digit code; activates account + creates session
 * POST /api/verify/resend  — issue a fresh code (rate limited, no account enumeration)
 *
 * The session is withheld at bootstrap and only issued here on success.
 */

import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { createSession, toPublicUser } from "../lib/auth.js";
import { sendOtpEmail } from "../lib/mail.js";
import { createOtp, verifyOtp, createOtpByEmail, verifyOtpByEmail } from "../lib/otp.js";
import { isWorkEmail, WORK_EMAIL_MESSAGE } from "../lib/workEmail.js";
import { otpResendLimiter, otpVerifyLimiter } from "../middleware/rateLimit.js";

const router = Router();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const emailField = z
  .string()
  .email()
  .max(255)
  .toLowerCase()
  .refine(isWorkEmail, WORK_EMAIL_MESSAGE);

const verifySchema = z.object({
  email: emailField,
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code"),
});

const resendSchema = z.object({
  email: emailField,
});

// ---------------------------------------------------------------------------
// POST /api/verify/otp
// ---------------------------------------------------------------------------

router.post("/otp", otpVerifyLimiter, async (req, res) => {
  const result = verifySchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({ errors: result.error.issues });
    return;
  }

  const { email, otp } = result.data;

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      res.status(400).json({ message: "Invalid or expired code" });
      return;
    }

    if (user.status === "churned") {
      res.status(403).json({ message: "This account has been deactivated." });
      return;
    }

    // Already verified — issue a session directly (idempotent re-login path).
    if (user.emailVerified && user.status === "active") {
      await createSession(user.id, res);
      res.status(200).json({ user: toPublicUser(user) });
      return;
    }

    const outcome = await verifyOtp(user.id, otp);

    if (!outcome.ok) {
      if (outcome.reason === "locked") {
        res.status(429).json({
          message: "Too many attempts. Request a new code.",
          requiresVerification: true,
        });
        return;
      }

      if (outcome.reason === "expired") {
        res.status(400).json({
          message: "This code has expired. Request a new one.",
          requiresVerification: true,
        });
        return;
      }

      res.status(400).json({ message: "Invalid or expired code" });
      return;
    }

    const [activated] = await db
      .update(users)
      .set({
        emailVerified: true,
        status: "active",
        activatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning();

    if (!activated) {
      res.status(500).json({ message: "Failed to activate account." });
      return;
    }

    await createSession(activated.id, res);

    res.status(200).json({ user: toPublicUser(activated) });
  } catch (err) {
    console.error("[verify] otp failed", err);
    res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/verify/resend
// ---------------------------------------------------------------------------

router.post("/resend", otpResendLimiter, async (req, res) => {
  const result = resendSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({ errors: result.error.issues });
    return;
  }

  const { email } = result.data;

  // Always respond the same way to avoid account enumeration.
  const generic = { message: "If that account needs verification, a new code has been sent." };

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user || user.status === "churned") {
      res.status(200).json(generic);
      return;
    }

    if (user.emailVerified && user.status === "active") {
      res.status(200).json(generic);
      return;
    }

    const otp = await createOtp(user.id);
    await sendOtpEmail({
      to: user.email ?? email,
      otp,
      userName: user.name,
    });

    res.status(200).json(generic);
  } catch (err) {
    console.error("[verify] resend failed", err);
    res.status(200).json(generic);
  }
});

// ---------------------------------------------------------------------------
// POST /api/verify/send — issue an OTP to an email BEFORE an account exists
// (org bootstrap step 0). Rate limited; generic response (no enumeration).
// ---------------------------------------------------------------------------

router.post("/send", otpResendLimiter, async (req, res) => {
  const result = resendSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({ errors: result.error.issues });
    return;
  }

  const { email } = result.data;

  try {
    const otp = await createOtpByEmail(email);
    await sendOtpEmail({ to: email, otp });
  } catch (err) {
    console.error("[verify] send failed", err);
  }

  res
    .status(200)
    .json({ message: "If that account needs verification, a new code has been sent." });
});

// ---------------------------------------------------------------------------
// POST /api/verify/preverify — verify an email via OTP before the account exists.
// Never creates a session/user; issues a single-use grant consumed by /api/orgs.
// ---------------------------------------------------------------------------

router.post("/preverify", otpVerifyLimiter, async (req, res) => {
  const result = verifySchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({ errors: result.error.issues });
    return;
  }

  const { email, otp } = result.data;

  try {
    const outcome = await verifyOtpByEmail(email, otp);

    if (!outcome.ok) {
      if (outcome.reason === "locked") {
        res.status(429).json({
          message: "Too many attempts. Request a new code.",
        });
        return;
      }

      if (outcome.reason === "expired") {
        res.status(400).json({
          message: "This code has expired. Request a new one.",
        });
        return;
      }

      res.status(400).json({ message: "Invalid or expired code" });
      return;
    }

    res.status(200).json({ verified: true, token: outcome.token });
  } catch (err) {
    console.error("[verify] preverify failed", err);
    res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
});

export const verifyRouter = router;