-- Daily check-ins — non-practitioners schedule a daily outbound AI voice call
-- that collects reports / suggestions / updates from their DIRECT reports.
--
-- daily_checkin_schedules — one per owner (non-practitioner), org timezone time.
-- daily_checkin_runs — one row per schedule per calendar day (unique constraint
--   makes the daily scheduler idempotent).
-- daily_checkins — per-person ledger row per run; the campaign target id IS this
--   row's id so Telenow webhooks correlate exactly like course_enrollments.
--   Status reuses the existing enrollment_status enum. `recording_url` is
--   stored but never exposed to the scheduler through the API.

-- 1. Run lifecycle enum

DO $$ BEGIN
  CREATE TYPE "public"."checkin_run_status" AS ENUM (
    'pending',
    'provisioning',
    'completed',
    'failed',
    'skipped'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Schedule config

CREATE TABLE IF NOT EXISTS "public"."daily_checkin_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title" varchar(255) DEFAULT 'Daily check-in' NOT NULL,
	"time_local" varchar(5) DEFAULT '08:45' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"question_script" text,
	"telenow_agent_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_checkin_schedules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "daily_checkin_schedules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_checkin_schedules_org_owner_unique"
  ON "public"."daily_checkin_schedules" ("org_id", "owner_user_id");

CREATE INDEX IF NOT EXISTS "daily_checkin_schedules_org_idx"
  ON "public"."daily_checkin_schedules" ("org_id");

-- 3. Runs (per schedule per day)

CREATE TABLE IF NOT EXISTS "public"."daily_checkin_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"run_date" date NOT NULL,
	"status" "public"."checkin_run_status" DEFAULT 'pending' NOT NULL,
	"telenow_campaign_id" varchar(255),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_checkin_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "daily_checkin_runs_schedule_id_daily_checkin_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "daily_checkin_schedules"("id") ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_checkin_runs_schedule_date_unique"
  ON "public"."daily_checkin_runs" ("schedule_id", "run_date");

CREATE INDEX IF NOT EXISTS "daily_checkin_runs_org_idx"
  ON "public"."daily_checkin_runs" ("org_id");

CREATE INDEX IF NOT EXISTS "daily_checkin_runs_schedule_idx"
  ON "public"."daily_checkin_runs" ("schedule_id");

-- 4. Per-person ledger (campaign targets / webhook correlation)

CREATE TABLE IF NOT EXISTS "public"."daily_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "public"."enrollment_status" DEFAULT 'pending' NOT NULL,
	"telenow_session_id" varchar(255),
	"telenow_call_id" varchar(255),
	"summary" jsonb,
	"transcript_url" text,
	"recording_url" text,
	"error" text,
	"called_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_checkins_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "daily_checkins_run_id_daily_checkin_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "daily_checkin_runs"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "daily_checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "daily_checkins_run_idx"
  ON "public"."daily_checkins" ("run_id");

CREATE INDEX IF NOT EXISTS "daily_checkins_user_idx"
  ON "public"."daily_checkins" ("user_id");