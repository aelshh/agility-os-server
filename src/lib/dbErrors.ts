/**
 * Production-grade PostgreSQL database error handler.
 *
 * Translates PostgreSQL errors (such as 23505 unique_violation, 23503 fk_violation)
 * into structured HTTP responses (409 Conflict, 400 Bad Request) with field-level
 * error messages matching the Zod error format ({ errors: { field: [message] } }).
 */

import type { Response } from "express";

export interface PostgresError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
  schema?: string;
}

/**
 * Extracts the underlying PostgreSQL error from an unknown caught error.
 * Drizzle ORM wraps native database errors in `err.cause`.
 */
export function extractDatabaseError(err: unknown): PostgresError | null {
  if (!err || typeof err !== "object") return null;

  const candidate = ((err as { cause?: unknown }).cause ??
    err) as PostgresError;

  if (candidate && typeof candidate.code === "string") {
    return candidate;
  }

  return null;
}

export interface DatabaseErrorHandlerOptions {
  /**
   * Maps a database constraint name to a specific client-facing form field.
   * Example: { "users_phone_unique_idx": "adminPhone", "users_email_unique_idx": "adminEmail" }
   */
  constraintFieldMap?: Record<string, string>;

  /**
   * Custom messages per constraint.
   */
  customMessages?: Record<string, string>;
}

/**
 * Known default constraint mappings across the application.
 */
const DEFAULT_CONSTRAINT_MAP: Record<
  string,
  { field: string; message: string }
> = {
  // users unique indexes
  users_phone_unique_idx: {
    field: "phone",
    message: "This phone number is already registered with another account.",
  },
  users_email_unique_idx: {
    field: "email",
    message: "An account with this email already exists.",
  },
  users_phone_key: {
    field: "phone",
    message: "This phone number is already registered with another account.",
  },
  users_email_key: {
    field: "email",
    message: "An account with this email already exists.",
  },
  users_email_unique: {
    field: "email",
    message: "An account with this email already exists.",
  },
  user_email_unique: {
    field: "email",
    message: "An account with this email already exists.",
  },
  users_google_id_unique: {
    field: "googleId",
    message: "This Google account is already linked to another user.",
  },
  users_external_hrms_id_unique: {
    field: "externalHrmsId",
    message:
      "An employee with this HRMS ID already exists in the organization.",
  },
  invites_token_hash_unique: {
    field: "token",
    message: "An invite with this token already exists.",
  },
  sessions_token_unique: {
    field: "token",
    message: "Session token collision. Please try again.",
  },
};

/**
 * Handles database errors and sends an appropriate HTTP response.
 * Returns `true` if the error was recognized and handled; `false` otherwise.
 */
export function handleDatabaseError(
  err: unknown,
  res: Response,
  options?: DatabaseErrorHandlerOptions,
): boolean {
  const pgErr = extractDatabaseError(err);
  if (!pgErr) return false;

  // ── 23505: Unique violation ──────────────────────────────────────────────
  if (pgErr.code === "23505") {
    const constraint = pgErr.constraint ?? "";
    const defaultInfo = DEFAULT_CONSTRAINT_MAP[constraint];

    // Determine target field
    let field = options?.constraintFieldMap?.[constraint] ?? defaultInfo?.field;

    // Fallback: extract field from constraint name or detail if not mapped
    if (!field) {
      if (constraint.includes("phone")) field = "phone";
      else if (constraint.includes("email")) field = "email";
      else if (constraint.includes("name")) field = "name";
      else if (pgErr.detail?.includes("Key (phone)")) field = "phone";
      else if (pgErr.detail?.includes("Key (email)")) field = "email";
      else field = "general";
    }

    // Determine user-facing message
    let message = options?.customMessages?.[constraint] ?? defaultInfo?.message;

    if (!message) {
      if (field.toLowerCase().includes("phone")) {
        message =
          "This phone number is already registered with another account.";
      } else if (field.toLowerCase().includes("email")) {
        message = "An account with this email already exists.";
      } else {
        message = "A record with these details already exists.";
      }
    }

    res.status(409).json({
      message,
      errors: {
        [field]: [message],
      },
    });

    return true;
  }

  // ── 23503: Foreign key violation ─────────────────────────────────────────
  if (pgErr.code === "23503") {
    res.status(400).json({
      message: "Referenced resource does not exist or has been removed.",
    });
    return true;
  }

  // ── 23502: Not-null violation ────────────────────────────────────────────
  if (pgErr.code === "23502") {
    const column = pgErr.column ?? "field";
    res.status(400).json({
      message: `Required field '${column}' is missing.`,
      errors: {
        [column]: [`${column} is required.`],
      },
    });
    return true;
  }

  // ── 22001: String data right truncation ──────────────────────────────────
  if (pgErr.code === "22001") {
    res.status(400).json({
      message:
        "One or more values exceeded the maximum allowed character limit.",
    });
    return true;
  }

  return false;
}
