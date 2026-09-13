-- AgilityOS v2 — Full schema migration
-- Drops the legacy `user` table and rebuilds the complete v2 data model.
-- Sessions are also recreated to reference the new `users` table.
--
-- WARNING: This drops all existing user and session data.
-- Run only on a fresh dev database or with a data-migration plan.

-- ── 1. Drop legacy tables (order matters for FK deps) ──────────────────────

DROP TABLE IF EXISTS "sessions" CASCADE;
DROP TABLE IF EXISTS "user" CASCADE;

-- ── 2. Enums ──────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "public"."user_role" AS ENUM (
    'practitioner',
    'field_coach',
    'content_curator',
    'quality_gate',
    'strategist',
    'architect',
    'talent_steward'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."user_status" AS ENUM ('invited', 'active', 'churned');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."user_source" AS ENUM ('hrms', 'csv', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."invite_status" AS ENUM ('pending', 'accepted', 'expired', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. Core tables ────────────────────────────────────────────────────────

CREATE TABLE "orgs" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name"           varchar(255) NOT NULL,
  "timezone"       varchar(64) NOT NULL,
  "language"       varchar(10) NOT NULL DEFAULT 'en',
  "default_region" varchar(100) NOT NULL,
  "config"         jsonb DEFAULT '{}',
  "is_active"      boolean NOT NULL DEFAULT true,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "teams" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"           uuid NOT NULL,
  "name"             varchar(255) NOT NULL,
  "parent_team_id"   uuid,
  "external_hrms_id" varchar(255),
  "hrms_department"  varchar(100),
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "users" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"           uuid,
  "external_hrms_id" varchar(255) UNIQUE,
  "role"             "user_role" NOT NULL DEFAULT 'practitioner',
  "name"             varchar(255),
  "phone"            varchar(20),
  "phone_verified"   boolean NOT NULL DEFAULT false,
  "email"            varchar(255),
  "email_verified"   boolean NOT NULL DEFAULT false,
  "password_hash"    text,
  "google_id"        text UNIQUE,
  "image"            text,
  "language_pref"    varchar(10) NOT NULL DEFAULT 'en',
  "region"           varchar(100),
  "team_id"          uuid,
  "manager_id"       uuid,
  "hire_date"        date,
  "hire_reason"      text,
  "current_level"    jsonb DEFAULT '{}',
  "streak_count"     integer NOT NULL DEFAULT 0,
  "last_drill_at"    timestamp with time zone,
  "is_sales"         boolean NOT NULL DEFAULT true,
  "source"           "user_source" NOT NULL DEFAULT 'manual',
  "status"           "user_status" NOT NULL DEFAULT 'invited',
  "activated_at"     timestamp with time zone,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "sessions" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"    uuid NOT NULL,
  "token"      text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "invites" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"          uuid NOT NULL,
  "target_user_id"  uuid NOT NULL,
  "token_hash"      text NOT NULL UNIQUE,
  "expires_at"      timestamp with time zone NOT NULL,
  "status"          "invite_status" NOT NULL DEFAULT 'pending',
  "accepted_at"     timestamp with time zone,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now()
);

-- ── 4. Foreign keys ──────────────────────────────────────────────────────

ALTER TABLE "teams"
  ADD CONSTRAINT "teams_org_id_orgs_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;

ALTER TABLE "users"
  ADD CONSTRAINT "users_org_id_orgs_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT;

ALTER TABLE "users"
  ADD CONSTRAINT "users_team_id_teams_id_fk"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

ALTER TABLE "invites"
  ADD CONSTRAINT "invites_org_id_orgs_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;

ALTER TABLE "invites"
  ADD CONSTRAINT "invites_target_user_id_users_id_fk"
  FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- ── 5. Indexes (per spec §7) ─────────────────────────────────────────────

-- Partial unique: users.phone where not null
CREATE UNIQUE INDEX "users_phone_unique_idx"
  ON "users" ("phone")
  WHERE "phone" IS NOT NULL;

-- Partial unique: users.email where not null
CREATE UNIQUE INDEX "users_email_unique_idx"
  ON "users" ("email")
  WHERE "email" IS NOT NULL;

-- Fast HRMS sync lookups
CREATE INDEX "users_org_hrms_idx"
  ON "users" ("org_id", "external_hrms_id");

-- Invite token lookup
CREATE INDEX "invites_token_hash_idx"
  ON "invites" ("token_hash");

-- Session token lookup
CREATE INDEX "sessions_token_idx"
  ON "sessions" ("token");
