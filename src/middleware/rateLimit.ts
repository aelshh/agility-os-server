import { rateLimit } from "express-rate-limit";

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

const standardHeaders = true;
const legacyHeaders = false;
// ---------------------------------------------------------------------------
// Limiters
// ---------------------------------------------------------------------------

/** Prevents mass org bootstrap abuse. */
export const orgBootstrapLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 3,
  standardHeaders,
  legacyHeaders,
  message: {
    message: "Too many requests. Please try again in a few minutes.",
  },
});

/** Caps OTP guesses per IP (per-code attempts are tracked separately). */
export const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 5,
  standardHeaders,
  legacyHeaders,
  message: {
    message: "Too many requests. Please try again in a few minutes.",
  },
});

/** Caps resend requests per IP. */
export const otpResendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 3,
  standardHeaders,
  legacyHeaders,
  message: {
    message: "Too many requests. Please try again in a few minutes.",
  },
});

/** Caps bulk invite creation per IP (a batch may contain many users). */
export const inviteCreateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 50,
  standardHeaders,
  legacyHeaders,
  message: {
    message: "Too many invite requests. Please try again in a few minutes.",
  },
});

/** Caps profile-field edits per IP. */
export const profileUpdateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 30,
  standardHeaders,
  legacyHeaders,
  message: {
    message: "Too many requests. Please try again in a few minutes.",
  },
});

/** Caps password-change attempts per IP (current-password guessing). */
export const passwordChangeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 5,
  standardHeaders,
  legacyHeaders,
  message: {
    message: "Too many requests. Please try again in a few minutes.",
  },
});
