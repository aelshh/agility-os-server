ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "default_whatsapp_channel_id" varchar(255);
ALTER TABLE "drills" ADD COLUMN IF NOT EXISTS "whatsapp_channel_id" varchar(255);
ALTER TABLE "course_schedules" ADD COLUMN IF NOT EXISTS "whatsapp_channel_id" varchar(255);
