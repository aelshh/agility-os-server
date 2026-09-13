ALTER TABLE "email_verifications" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_verifications" ADD COLUMN "email" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_verifications_email_idx" ON "email_verifications" ("email");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_verification_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_verification_grants_email_idx" ON "email_verification_grants" ("email");