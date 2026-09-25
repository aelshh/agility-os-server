/**
 * Backend prompt assembly.
 *
 * All AI prompting is server-side and dynamic — built per course AND per
 * organisation (org name, language) from the course content itself. There is
 * no user-facing "AI persona" authoring; the coach persona is generated once
 * per course when the agent is created, persisted on the drill, and reused at
 * call time.
 */

import type { CourseDocumentRow, DrillRow, OrgRow } from "../../db/schema.js";
import { AI_MODEL, getAiClient } from "./client.js";

const MAX_REFERENCE_CHARS = 24_000;
const DEFAULT_QUESTION_COUNT = 8;
const MAX_QUESTION_COUNT = 10;

type CourseLike = Pick<
  DrillRow,
  "title" | "description" | "knowledgeText" | "faqs" | "scoringRubric"
>;

type DocLike = Pick<CourseDocumentRow, "originalName" | "textContent">;
type OrgLike = Pick<OrgRow, "name" | "language">;

function asFaqs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((q): q is string => typeof q === "string");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Free-text knowledge + uploaded document texts, bounded for tokens. */
function buildReference(
  course: CourseLike,
  docs: DocLike[],
): string {
  const parts: string[] = [];

  if (course.knowledgeText.trim()) {
    parts.push(`Course notes:\n${course.knowledgeText.trim()}`);
  }

  for (const doc of docs) {
    if (!doc.textContent?.trim()) continue;
    parts.push(`Document "${doc.originalName}":\n${doc.textContent.trim()}`);
  }

  if (parts.length === 0) return "";
  return truncate(parts.join("\n\n---\n\n"), MAX_REFERENCE_CHARS);
}

function extractJsonObject(content: string | null | undefined): Record<string, unknown> | null {
  if (!content) return null;
  const start = content.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(content.slice(start));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

export type GeneratedCoach = {
  name: string;
  prompt: string;
};

/**
 * Builds the practice-coach persona for one course. Runs once (see the
 * publish hook in routes/drills.ts) and persists name + prompt on the drill.
 * Returns null when no LLM provider is configured.
 */
export async function generateCoachPersona(input: {
  course: CourseLike;
  org: OrgLike;
  docs: DocLike[];
}): Promise<GeneratedCoach | null> {
  const client = getAiClient();
  if (!client) return null;

  const { course, org, docs } = input;
  const questions = asFaqs(course.faqs);
  const reference = buildReference(course, docs);

  const questionBlock = questions.length
    ? questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
    : "Ask the learner 5-8 questions that test their understanding of the course topic.";

  const completion = await client.chat.completions.create({
    model: AI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You design practice-coach personas for a corporate spoken-training product. " +
          "A learner practises by having a short voice conversation with an AI coach. " +
          "Produce one persona for one training course. Reply ONLY with JSON of the form " +
          '{"name": "<short coach name, <=25 chars>", "prompt": "<coach system prompt>"}. ' +
          "The prompt is written as instructions addressed to the coach: it states the role, " +
          "tone, language, the exact questions to ask the learner, and the call flow.",
      },
      {
        role: "user",
        content: [
          `Organisation: ${org.name}.`,
          `Coach language: ${org.language === "en" ? "English" : org.language}.`,
          `Course title: ${course.title}.`,
          `Course description: ${course.description?.trim() || "(none)"}.`,
          `Rubric (judge answers against): ${truncate(JSON.stringify(course.scoringRubric ?? []), 4000)}`,
          `Questions the coach must ask the learner during the call:\n${questionBlock}`,
          reference
            ? `Reference material (ground every answer strictly in this; never invent facts outside it):\n${reference}`
            : "No reference material provided — the coach should stay within the course description and ask natural conversational questions.",
        ].join("\n\n"),
      },
    ],
  });

  const parsed = extractJsonObject(completion.choices[0]?.message?.content);
  const name = typeof parsed?.["name"] === "string" ? parsed["name"].trim() : "";
  const prompt = typeof parsed?.["prompt"] === "string" ? parsed["prompt"].trim() : "";

  if (!name || !prompt) return null;
  return {
    name: name.slice(0, 100),
    prompt: prompt.slice(0, 10_000),
  };
}

/**
 * Suggests practice questions from the course knowledge dump. Returns [] when
 * no provider is configured. Callers surface these in the editor for the user
 * to review and edit before saving — nothing is persisted here.
 */
export async function generateFaqSuggestions(input: {
  course: CourseLike;
  org: OrgLike;
  docs: DocLike[];
  count?: number;
}): Promise<string[]> {
  const client = getAiClient();
  if (!client) return [];

  const { course, org, docs } = input;
  const reference = buildReference(course, docs);
  if (!reference) return [];

  const count = Math.min(
    Math.max(input.count ?? DEFAULT_QUESTION_COUNT, 1),
    MAX_QUESTION_COUNT,
  );

  const completion = await client.chat.completions.create({
    model: AI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You generate practice questions for corporate spoken training. " +
          "Given a course and its reference material, draft questions an AI coach would ask a learner " +
          "in a voice call to verify their understanding of the material. " +
          'Reply ONLY with JSON of the form {"questions": ["...", "..."]}.',
      },
      {
        role: "user",
        content: [
          `Organisation: ${org.name}.`,
          `Course title: ${course.title}.`,
          `Course description: ${course.description?.trim() || "(none)"}.`,
          `Reference material:\n${reference}`,
          `Propose exactly ${count} clear, concise, spoken-style questions.`,
        ].join("\n\n"),
      },
    ],
  });

  const parsed = extractJsonObject(completion.choices[0]?.message?.content);
  if (!parsed) return [];

  const raw = Array.isArray(parsed["questions"]) ? parsed["questions"] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const q = item.trim().replace(/\s+/g, " ");
    if (q.length < 3 || q.length > 300) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Structured digest of a daily check-in call transcript. Produces
 * { report, suggestions, updates } straight from the spoken text. Returns
 * null when no LLM provider is configured or the output can't be parsed.
 */
export async function generateCheckinSummary(
  transcript: string,
): Promise<{ report: string; suggestions: string; updates: string } | null> {
  const client = getAiClient();
  if (!client) return null;

  const text = truncate(transcript.trim(), 12_000);
  if (text.length < 3) return null;

  const completion = await client.chat.completions.create({
    model: AI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You summarise short daily voice check-in calls between a manager and one of their reports. " +
          "The call collects three things. Reply ONLY with JSON of the form " +
          '{"report": "<status of the report>", "suggestions": "<suggestions, or empty>", "updates": "<updates or blockers, or empty>"}. ' +
          "Write the manager-facing summary in clear, concise English. Use empty strings when nothing was said for a section. " +
          "Never invent facts not present in the transcript.",
      },
      {
        role: "user",
        content: `Transcript of the check-in call:\n${text}`,
      },
    ],
  });

  const parsed = extractJsonObject(completion.choices[0]?.message?.content);
  if (!parsed) return null;

  const asText = (v: unknown) =>
    (typeof v === "string" ? v.trim() : "").slice(0, 2000);

  const report = asText(parsed["report"]);
  const suggestions = asText(parsed["suggestions"]);
  const updates = asText(parsed["updates"]);

  if (!report && !suggestions && !updates) return null;

  return { report, suggestions, updates };
}