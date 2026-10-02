import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.js";

async function runMigration() {
  console.log("[migration] Running course schedules, runs, and notifications schema migration...");
  try {
    // 1. Create Enums if not exist
    await db.execute(sql`
      DO $$ BEGIN
        CREATE TYPE course_schedule_type AS ENUM ('one_time', 'recurring');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await db.execute(sql`
      DO $$ BEGIN
        CREATE TYPE course_schedule_status AS ENUM ('scheduled', 'active', 'paused', 'completed', 'cancelled');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await db.execute(sql`
      DO $$ BEGIN
        CREATE TYPE course_schedule_run_status AS ENUM ('scheduled', 'notified', 'calling', 'completed', 'failed', 'skipped');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await db.execute(sql`
      DO $$ BEGIN
        CREATE TYPE course_schedule_notification_status AS ENUM ('queued', 'sent', 'failed', 'skipped');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // 2. Create course_schedules table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS course_schedules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        course_id UUID NOT NULL REFERENCES drills(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        schedule_type course_schedule_type NOT NULL DEFAULT 'recurring',
        start_date VARCHAR(10) NOT NULL,
        end_date VARCHAR(10),
        days_of_week JSONB NOT NULL DEFAULT '[1, 2, 3, 4, 5]'::jsonb,
        time_window_start VARCHAR(5) NOT NULL DEFAULT '10:00',
        time_window_end VARCHAR(5) NOT NULL DEFAULT '14:00',
        timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
        notify_whatsapp_prior BOOLEAN NOT NULL DEFAULT true,
        notify_minutes_before INTEGER NOT NULL DEFAULT 30,
        custom_message TEXT,
        status course_schedule_status NOT NULL DEFAULT 'scheduled',
        audience_type VARCHAR(50) NOT NULL DEFAULT 'course_default',
        audience_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_run_date VARCHAR(10),
        last_notification_sent_at TIMESTAMPTZ,
        created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS course_schedules_org_idx ON course_schedules (org_id);
      CREATE INDEX IF NOT EXISTS course_schedules_course_idx ON course_schedules (course_id);
      CREATE INDEX IF NOT EXISTS course_schedules_status_idx ON course_schedules (status);
    `);
    console.log("✓ Created course_schedules table & indices");

    // 3. Create course_schedule_runs table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS course_schedule_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        schedule_id UUID NOT NULL REFERENCES course_schedules(id) ON DELETE CASCADE,
        course_id UUID NOT NULL REFERENCES drills(id) ON DELETE CASCADE,
        run_date VARCHAR(10) NOT NULL,
        status course_schedule_run_status NOT NULL DEFAULT 'scheduled',
        telenow_campaign_id VARCHAR(255),
        notified_count INTEGER NOT NULL DEFAULT 0,
        targets_count INTEGER NOT NULL DEFAULT 0,
        completed_count INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS course_schedule_runs_schedule_date_uq ON course_schedule_runs (schedule_id, run_date);
      CREATE INDEX IF NOT EXISTS course_schedule_runs_org_idx ON course_schedule_runs (org_id);
      CREATE INDEX IF NOT EXISTS course_schedule_runs_course_idx ON course_schedule_runs (course_id);
    `);
    console.log("✓ Created course_schedule_runs table & indices");

    // 4. Create course_schedule_notifications table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS course_schedule_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        schedule_id UUID NOT NULL REFERENCES course_schedules(id) ON DELETE CASCADE,
        run_id UUID REFERENCES course_schedule_runs(id) ON DELETE SET NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        phone VARCHAR(50) NOT NULL,
        status course_schedule_notification_status NOT NULL DEFAULT 'queued',
        wamid VARCHAR(255),
        sent_at TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS course_schedule_notifications_schedule_idx ON course_schedule_notifications (schedule_id);
      CREATE INDEX IF NOT EXISTS course_schedule_notifications_user_idx ON course_schedule_notifications (user_id);
      CREATE INDEX IF NOT EXISTS course_schedule_notifications_run_idx ON course_schedule_notifications (run_id);
    `);
    console.log("✓ Created course_schedule_notifications table & indices");

    console.log("[migration] Course schedule migration completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("[migration] Migration failed:", err);
    process.exit(1);
  }
}

void runMigration();
