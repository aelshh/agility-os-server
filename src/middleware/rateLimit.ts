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
