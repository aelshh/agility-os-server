-- Courses: Telenow delivery — outbound AI practice calls to a selected audience.
-- On approve, the curator's audience selection (drill_audience) is snapshotted
-- into course_enrollments (the delivery ledger), then provisionCourseOnTelenow
-- creates an agent + call campaign against the chosen practitioners. Telenow
-- webhooks (call.ended / call.analyzed) hydrate each enrollment's outcomes.
--
-- telenow_webhooks is deployment-level (one shared Telenow workspace / API key):
-- a single endpoint pointing at our receiver, whose HMAC signing_secret is
-- returned exactly once by Telenow at creation.

-- 1. Drills — Telenow provisioning state

CREATE TYPE IF NOT EXISTS "public"."drill_provisioning" AS ENUM (
  'none',
  'provisioning',
  'completed',
  'failed'
);

ALTER TABLE "public"."drills"
  ADD COLUMN IF NOT EXISTS "telenow_agent_id" varchar(255),
  ADD COLUMN IF NOT EXISTS "telenow_campaign_id" varchar(255),
  ADD COLUMN IF NOT EXISTS "provisioning_status" "public"."drill_provisioning" DEFAULT 'none' NOT NULL,
  ADD COLUMN IF NOT EXISTS "provisioning_error" text;

-- 2. Practice-call lifecycle per practitioner

CREATE TYPE IF NOT EXISTS "public"."enrollment_status" AS ENUM (
  'pending',
  'queued',
  'calling',
  'answered',
  'no_answer',
  'completed',
  'failed',
  'skipped'
);

-- 3. Audience selection (curator, pre-publish)

CREATE TABLE IF NOT EXISTS "public"."drill_audience" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drill_audience_course_id_drills_id_fk" FOREIGN KEY ("course_id") REFERENCES "drills"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "drill_audience_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "drill_audience_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "drill_audience_course_user_unique"
  ON "public"."drill_audience" ("course_id", "user_id");

-- 4. Delivery ledger (one row per practitioner per published course)

CREATE TABLE IF NOT EXISTS "public"."course_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "public"."enrollment_status" DEFAULT 'pending' NOT NULL,
	"telenow_session_id" varchar(255),
	"telenow_call_id" varchar(255),
	"score" integer,
	"transcript_url" text,
	"recording_url" text,
	"error" text,
	"called_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_enrollments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "course_enrollments_course_id_drills_id_fk" FOREIGN KEY ("course_id") REFERENCES "drills"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "course_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "course_enrollments_course_user_unique"
  ON "public"."course_enrollments" ("course_id", "user_id");

CREATE INDEX IF NOT EXISTS "course_enrollments_course_id_idx"
  ON "public"."course_enrollments" ("course_id");

-- 5. Deployment-wide webhook endpoint state

CREATE TABLE IF NOT EXISTS "public"."telenow_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"telenow_hook_id" varchar(255),
	"target_url" text NOT NULL,
	"signing_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telenow_webhooks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE set null ON UPDATE no action
);