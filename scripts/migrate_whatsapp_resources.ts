import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.js";

async function runMigration() {
  console.log("[migration] Running WhatsApp resources & S3 schema migration...");
  try {
    await db.execute(
      sql`ALTER TABLE drills ADD COLUMN IF NOT EXISTS whatsapp_resources jsonb DEFAULT '[]'::jsonb NOT NULL;`,
    );
    console.log("✓ Added whatsapp_resources column to drills");

    await db.execute(
      sql`ALTER TABLE course_documents ADD COLUMN IF NOT EXISTS s3_key varchar(500);`,
    );
    await db.execute(
      sql`ALTER TABLE course_documents ADD COLUMN IF NOT EXISTS storage_url text;`,
    );
    console.log("✓ Added s3_key and storage_url columns to course_documents");

    console.log("[migration] Migration completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("[migration] Migration failed:", err);
    process.exit(1);
  }
}

void runMigration();
