-- Courses: knowledge dump + practice questions (FAQs) + auto-generated coach persona.
-- The course author pastes knowledge / uploads documents and defines the questions
-- the AI coach asks during a call. The coach persona is generated server-side once
-- per course and reused at call time (persona_name / persona_prompt are backfilled).

-- 1. Drills — add knowledge + questions columns, relax persona to nullable

ALTER TABLE "public"."drills"
  ADD COLUMN IF NOT EXISTS "knowledge_text" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "faqs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "persona_generated_at" timestamp with time zone;

ALTER TABLE "public"."drills"
  ALTER COLUMN "persona_name" DROP NOT NULL,
  ALTER COLUMN "persona_prompt" DROP NOT NULL;

-- 2. Course documents (knowledge dump file attachments)

CREATE TABLE IF NOT EXISTS "course_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"original_name" varchar(255) NOT NULL,
	"stored_name" varchar(255) NOT NULL,
	"mime_type" varchar(100) DEFAULT 'application/octet-stream' NOT NULL,
	"size_bytes" integer NOT NULL,
	"text_content" text,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_documents_course_id_drills_id_fk" FOREIGN KEY ("course_id") REFERENCES "drills"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "course_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action
);

-- 3. Query index for course-scoped document lookups

CREATE INDEX IF NOT EXISTS "course_documents_course_id_idx" ON "course_documents" ("course_id");