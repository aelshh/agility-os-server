/**
 * One-shot migration runner.
 * Executes a drizzle SQL migration file against the database.
 * Run with: node --env-file=.env scripts/apply-migration.mjs <file>
 * Defaults to the v2 schema when no file is provided.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

const target = process.argv[2] ?? "0002_agility_v2_schema.sql";

const sql = readFileSync(
  join(__dirname, "../drizzle", target),
  "utf8",
);

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
console.log("[migration] Connected to database");

try {
  await client.query(sql);
  console.log(`[migration] ✅ ${target} applied successfully`);
} catch (err) {
  console.error("[migration] ❌ Failed:", err.message);
  process.exit(1);
} finally {
  await client.end();
}

