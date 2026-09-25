-- Organizational Telenow AI API Keys & per-tenant webhooks
--
-- 1. orgs — store encrypted per-tenant API key, resolved workspace org id, and connection time.
-- 2. telenow_webhooks — ensure 1-to-1 unique mapping per organization with cascade on delete.

ALTER TABLE "public"."orgs" ADD COLUMN IF NOT EXISTS "telenow_api_key" text;
ALTER TABLE "public"."orgs" ADD COLUMN IF NOT EXISTS "telenow_org_id" varchar(255);
ALTER TABLE "public"."orgs" ADD COLUMN IF NOT EXISTS "telenow_connected_at" timestamp with time zone;

DO $$ BEGIN
  ALTER TABLE "public"."telenow_webhooks" DROP CONSTRAINT IF EXISTS "telenow_webhooks_org_id_orgs_id_fk";
  ALTER TABLE "public"."telenow_webhooks"
    ADD CONSTRAINT "telenow_webhooks_org_id_orgs_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "telenow_webhooks_org_id_unique"
  ON "public"."telenow_webhooks" ("org_id");
