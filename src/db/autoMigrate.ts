import { sql } from "drizzle-orm";
import { db } from "./index.js";

/**
 * Ensures critical new columns exist on startup to prevent queries from failing
 * before manual migrations are executed.
 */
export async function ensureSchemaColumns(): Promise<void> {
  try {
    await db.execute(sql`
      ALTER TABLE orgs ADD COLUMN IF NOT EXISTS default_whatsapp_channel_id varchar(255);
      ALTER TABLE drills ADD COLUMN IF NOT EXISTS whatsapp_channel_id varchar(255);
      ALTER TABLE course_schedules ADD COLUMN IF NOT EXISTS whatsapp_channel_id varchar(255);
      ALTER TABLE drills ADD COLUMN IF NOT EXISTS whatsapp_resources jsonb DEFAULT '[]'::jsonb NOT NULL;
      ALTER TABLE course_documents ADD COLUMN IF NOT EXISTS s3_key varchar(500);
      ALTER TABLE course_documents ADD COLUMN IF NOT EXISTS storage_url text;
    `);
  } catch (err) {
    console.warn("[autoMigrate] Schema column check notice:", (err as Error).message);
  }
}
