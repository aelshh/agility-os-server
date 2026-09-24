-- Courses revamp — courses now train employees on anything (generic training),
-- not just sales. Remove the sales-only taxonomy and persona disposition.
-- Follows the hand-written migration convention used by 0002-0007.

-- 1. Drop sales-only / persona-disposition columns

ALTER TABLE "public"."drills"
  DROP COLUMN IF EXISTS "strategy",
  DROP COLUMN IF EXISTS "tactic",
  DROP COLUMN IF EXISTS "phase",
  DROP COLUMN IF EXISTS "difficulty_tier",
  DROP COLUMN IF EXISTS "persona_emotion",
  DROP COLUMN IF EXISTS "compliance_flags";

-- 2. Drop now-unused enum types

DROP TYPE IF EXISTS "public"."drill_strategy";
DROP TYPE IF EXISTS "public"."drill_phase";
DROP TYPE IF EXISTS "public"."drill_persona_emotion";