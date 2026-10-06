import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.js";

async function runMigration() {
  console.log("[migration] Running WhatsApp channels & sender override schema migration...");
  try {
    // 1. Add default_whatsapp_channel_id to orgs
    await db.execute(
      sql`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS default_whatsapp_channel_id varchar(255);`,
    );
    console.log("✓ Added default_whatsapp_channel_id column to orgs");

    // 2. Add whatsapp_channel_id to drills
    await db.execute(
      sql`ALTER TABLE drills ADD COLUMN IF NOT EXISTS whatsapp_channel_id varchar(255);`,
    );
    console.log("✓ Added whatsapp_channel_id column to drills");

    // 3. Add whatsapp_channel_id to course_schedules
    await db.execute(
      sql`ALTER TABLE course_schedules ADD COLUMN IF NOT EXISTS whatsapp_channel_id varchar(255);`,
    );
    console.log("✓ Added whatsapp_channel_id column to course_schedules");

    console.log("[migration] WhatsApp channels migration completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("[migration] WhatsApp channels migration failed:", err);
    process.exit(1);
  }
}

void runMigration();
