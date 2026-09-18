-- AgilityOS v2 — Org admin layer
-- Tracks who holds admin access per org. Admins can invite employees into
-- the app and delegate/revoke admin access to other users. This is a separate
-- concern from `users.role` (roles remain HRMS-derived); being an admin is an
-- org-wide `org_admins` row, audited with grant/revoke provenance.

-- ── 1. org_admins ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "org_admins" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"      uuid NOT NULL,
  "user_id"     uuid NOT NULL,
  "granted_by"  uuid,
  "granted_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_by"  uuid,
  "revoked_at"  timestamp with time zone
);

--> statement-breakpoint
ALTER TABLE "org_admins"
  ADD CONSTRAINT "org_admins_org_id_orgs_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "org_admins"
  ADD CONSTRAINT "org_admins_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "org_admins"
  ADD CONSTRAINT "org_admins_granted_by_users_id_fk"
  FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "org_admins"
  ADD CONSTRAINT "org_admins_revoked_by_users_id_fk"
  FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE SET NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_admins_org_id_idx"
  ON "org_admins" ("org_id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_admins_active_user_unique"
  ON "org_admins" ("org_id", "user_id")
  WHERE "revoked_at" IS NULL;