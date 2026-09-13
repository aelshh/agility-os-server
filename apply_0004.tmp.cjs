const { Client } = require("pg");

const url =
  "postgresql://neondb_owner:npg_s3FCBYhQAc0S@ep-dry-dew-ay4yba5b-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

const stmts = [
  'ALTER TABLE "email_verifications" ALTER COLUMN "user_id" DROP NOT NULL',
  'ALTER TABLE "email_verifications" ADD COLUMN "email" text',
  'CREATE INDEX IF NOT EXISTS "email_verifications_email_idx" ON "email_verifications" ("email")',
  'CREATE TABLE IF NOT EXISTS "email_verification_grants" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "email" text NOT NULL, "token_hash" text NOT NULL, "expires_at" timestamp with time zone NOT NULL, "used_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL)',
  'CREATE INDEX IF NOT EXISTS "email_verification_grants_email_idx" ON "email_verification_grants" ("email")',
];

(async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  for (const s of stmts) {
    console.log("Running:", s.slice(0, 80));
    await client.query(s);
    console.log("  OK");
  }
  await client.end();
  console.log("All done");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});