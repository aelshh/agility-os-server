import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { Router } from "express";
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  discovery,
  fetchUserInfo,
  randomState,
  skipSubjectCheck,
  type Configuration,
} from "openid-client";
import { z } from "zod";

import { db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  createSession,
  toPublicUser,
} from "../lib/auth.js";
import { extractDatabaseError } from "../lib/dbErrors.js";
import { sendOtpEmail } from "../lib/mail.js";
import { createOtp } from "../lib/otp.js";
import { isWorkEmail, WORK_EMAIL_MESSAGE } from "../lib/workEmail.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: z
    .string()
    .email()
    .max(255)
    .toLowerCase()
    .refine(isWorkEmail, WORK_EMAIL_MESSAGE),
  password: z.string().min(1).max(128),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_OAUTH_STATE_COOKIE = "oauth_state";
const GOOGLE_SCOPE = "openid email profile";
const GOOGLE_ISSUER_URL = "https://accounts.google.com";

/**
 * Used to run a dummy verify on the password path to prevent timing-based
 * user-enumeration attacks (always take ~the same time whether user exists or not).
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$U4xhPu9lXmqmL+ppl23zHg$RyQs4RPGW5C8oWIK+6+4F4Oz3qJDuhPyp045J/6NMwI";

// ---------------------------------------------------------------------------
// Google OIDC config (lazy singleton)
// ---------------------------------------------------------------------------

function appOrigin(): string {
  return process.env["APP_ORIGIN"] ?? "http://localhost:5173";
}

function loginPath(): string {
  return `${appOrigin()}/login`;
}

function googleCallbackUrl(): string {
  return `${appOrigin()}/api/auth/google/callback`;
}

function clearStateCookie(res: import("express").Response): void {
  res.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, { path: "/" });
}

let googleConfigPromise: Promise<Configuration | null> | null = null;

function getGoogleConfig(): Promise<Configuration | null> {
  const clientId = process.env["GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];

  if (!clientId || !clientSecret) {
    return Promise.resolve(null);
  }

  if (!googleConfigPromise) {
    googleConfigPromise = discovery(new URL(GOOGLE_ISSUER_URL), clientId, {
      client_secret: clientSecret,
      redirect_uris: [googleCallbackUrl()],
      response_types: ["code"],
    }).catch((err) => {
      googleConfigPromise = null;
      throw err;
    });
  }

  return googleConfigPromise;
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

router.post("/login", async (req, res) => {
  const result = loginSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({ errors: result.error.flatten().fieldErrors });
    return;
  }

  const { email, password } = result.data;

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      // Timing-safe: always hash even when user not found
      await argon2.verify(DUMMY_PASSWORD_HASH, password);
      res.status(401).json({ message: "Invalid email or password" });
      return;
    }

    if (user.status === "churned") {
      res.status(403).json({ message: "This account has been deactivated." });
      return;
    }

    if (!user.passwordHash) {
      res.status(401).json({
        message:
          "This account uses Google Sign-In. Please continue with Google.",
      });
      return;
    }

    const valid = await argon2.verify(user.passwordHash, password);

    if (!valid) {
      res.status(401).json({ message: "Invalid email or password" });
      return;
    }

    // Email not yet verified — withhold the session and issue a fresh OTP
    // so the client can drop straight into the verification screen.
    if (!user.emailVerified || user.status === "invited") {
      try {
        const otp = await createOtp(user.id);
        await sendOtpEmail({
          to: user.email ?? email,
          otp,
          userName: user.name,
        });
      } catch (err) {
        console.error("[auth] failed to send login verification OTP", err);
      }

      res.status(403).json({
        message: "Please verify your email to continue.",
        requiresVerification: true,
        email: user.email,
      });
      return;
    }

    await createSession(user.id, res);

    res.status(200).json({ user: toPublicUser(user) });
  } catch (err) {
    console.error("[auth] login failed", err);
    res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

router.get("/me", requireAuth, (req, res) => {
  res.status(200).json({ user: req.user });
});

// ---------------------------------------------------------------------------
// DELETE /api/auth/session — logout
// ---------------------------------------------------------------------------

router.delete("/session", async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];

  if (token) {
    await db.delete(sessions).where(eq(sessions.token, token));
  }

  clearSessionCookie(res);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /api/auth/google — initiate OAuth flow
// ---------------------------------------------------------------------------

router.get("/google", async (req, res) => {
  const config = await getGoogleConfig();

  if (!config) {
    res.status(503).json({ message: "Google Sign-In is not configured" });
    return;
  }

  const state = randomState();

  res.cookie(GOOGLE_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    maxAge: 10 * 60 * 1000, // 10 minutes
  });

  const url = buildAuthorizationUrl(config, {
    scope: GOOGLE_SCOPE,
    state,
    redirect_uri: googleCallbackUrl(),
  });

  res.redirect(url.toString());
});

// ---------------------------------------------------------------------------
// GET /api/auth/google/callback — hardened: NO auto-creation of unknown emails
// ---------------------------------------------------------------------------

router.get("/google/callback", async (req, res) => {
  const config = await getGoogleConfig();

  if (!config) {
    res.status(503).json({ message: "Google Sign-In is not configured" });
    return;
  }

  const login = loginPath();
  const state = req.query["state"];
  const cookieState = req.cookies?.[GOOGLE_OAUTH_STATE_COOKIE];

  // Always clear the state cookie after reading
  clearStateCookie(res);

  if (typeof state !== "string" || state !== cookieState) {
    console.error("[auth] OAuth state mismatch", {
      queryState: state,
      cookieState,
    });
    res.redirect(`${login}?auth=state_mismatch`);
    return;
  }

  try {
    const origin = appOrigin();
    const currentUrl = new URL(`${origin}${req.originalUrl}`);

    let tokens;
    try {
      tokens = await authorizationCodeGrant(config, currentUrl, {
        expectedState: state,
      });
    } catch (err) {
      console.error("[auth] Google token exchange failed", err);
      res.redirect(`${login}?auth=token_error`);
      return;
    }

    const idTokenClaims = tokens.claims();
    const expectedSubject = idTokenClaims?.sub ?? skipSubjectCheck;

    let userinfo;
    try {
      userinfo = await fetchUserInfo(
        config,
        tokens.access_token as string,
        expectedSubject,
      );
    } catch (err) {
      console.error("[auth] Google fetchUserInfo failed", err);
      res.redirect(`${login}?auth=userinfo_error`);
      return;
    }

    const sub = userinfo["sub"];
    const email = userinfo["email"];

    if (typeof sub !== "string" || typeof email !== "string") {
      console.error("[auth] Google userinfo missing claims", { sub, email });
      res.redirect(`${login}?auth=missing_claims`);
      return;
    }

    // Try to find by google_id first, then fall back to email
    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.googleId, sub))
      .limit(1);

    if (!user) {
      // Look up by email (user exists in tree but hasn't linked Google yet)
      const [byEmail] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (!byEmail) {
        // *** HARDENED: Unknown email — do NOT auto-create. ***
        // All users must be provisioned through org bootstrap or invite flow.
        res.redirect(`${login}?auth=no_account`);
        return;
      }

      // Existing tree member — bind Google sub for future logins
      try {
        const [updated] = await db
          .update(users)
          .set({
            googleId: sub,
            image:
              typeof userinfo["picture"] === "string"
                ? userinfo["picture"]
                : byEmail.image,
            emailVerified: true,
          })
          .where(eq(users.id, byEmail.id))
          .returning();

        user = updated;
      } catch (err) {
        const pgErr = extractDatabaseError(err);
        if (pgErr?.code === "23505") {
          console.error("[auth] Google account conflict on link", {
            email,
            sub,
            constraint: pgErr.constraint,
          });
          res.redirect(`${login}?auth=account_conflict`);
          return;
        }
        throw err;
      }
    }

    if (!user) {
      console.error("[auth] Google callback: user resolved to null");
      res.redirect(`${login}?auth=error`);
      return;
    }

    if (user.status === "churned") {
      res.redirect(`${login}?auth=deactivated`);
      return;
    }

    await createSession(user.id, res);
    res.redirect(appOrigin());
  } catch (err) {
    console.error("[auth] google callback failed", err);
    res.redirect(`${login}?auth=error`);
  }
});

export const authRouter = router;
