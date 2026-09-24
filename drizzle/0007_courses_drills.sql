-- Course (drill) content unit — spec §2.2, MVP single-review gate lifecycle.
-- Follows the hand-written migration convention used by 0002-0006.

-- 1. Enums

DO $$ BEGIN
  CREATE TYPE "public"."drill_strategy" AS ENUM (
    'consultative',
    'disruptive',
    'competitive',
    'financial'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."drill_phase" AS ENUM (
    'assess',
    'choose',
    'execute'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."drill_persona_emotion" AS ENUM (
    'cooperative',
    'neutral',
    'skeptical',
    'hostile',
    'rushed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."drill_status" AS ENUM (
    'draft',
    'pending_review',
    'published',
    'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Drills table

CREATE TABLE IF NOT EXISTS "drills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"strategy" "public"."drill_strategy" NOT NULL,
	"tactic" varchar(100),
	"phase" "public"."drill_phase" NOT NULL,
	"difficulty_tier" integer DEFAULT 1 NOT NULL,
	"persona_name" varchar(100) NOT NULL,
	"persona_prompt" text NOT NULL,
	"persona_emotion" "public"."drill_persona_emotion" NOT NULL,
	"scoring_rubric" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compliance_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_duration_sec" integer DEFAULT 120 NOT NULL,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"region_scope" text[] DEFAULT '{}' NOT NULL,
	"role_scope" text[] DEFAULT '{}' NOT NULL,
	"expires_at" timestamp with time zone,
	"status" "public"."drill_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"reviewed_by" uuid,
	"review_comment" text,
	"reviewed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drills_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "drills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "drills_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action
);

-- 3. Query index for org-scoped list/approval queues

CREATE INDEX IF NOT EXISTS "drills_org_status_idx" ON "drills" ("org_id","status");