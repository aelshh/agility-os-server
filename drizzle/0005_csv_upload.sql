-- AgilityOS v2 — CSV upload support
-- 1. Adds the `reporting_edges` table for the org-tree graph.
-- 2. Adds the `csv` value to the `hrms_provider` enum so the per-org
--    connection row can record which CSV platform was uploaded.

-- ── 1. reporting_edges ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "reporting_edges" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"             uuid NOT NULL,
  "manager_user_id"    uuid NOT NULL,
  "report_user_id"     uuid NOT NULL,
  "valid_from"         timestamp with time zone NOT NULL DEFAULT now(),
  "valid_to"           timestamp with time zone,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint
ALTER TABLE "reporting_edges"
  ADD CONSTRAINT "reporting_edges_org_id_orgs_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "reporting_edges"
  ADD CONSTRAINT "reporting_edges_manager_user_id_users_id_fk"
  FOREIGN KEY ("manager_user_id") REFERENCES "users"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "reporting_edges"
  ADD CONSTRAINT "reporting_edges_report_user_id_users_id_fk"
  FOREIGN KEY ("report_user_id") REFERENCES "users"("id") ON DELETE CASCADE;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reporting_edges_org_id_idx"
  ON "reporting_edges" ("org_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reporting_edges_manager_idx"
  ON "reporting_edges" ("manager_user_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reporting_edges_report_idx"
  ON "reporting_edges" ("report_user_id");

-- ── 2. hrms_provider enum — add 'csv' ─────────────────────────────────────

DO $$ BEGIN
  ALTER TYPE "public"."hrms_provider" ADD VALUE IF NOT EXISTS 'csv';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;