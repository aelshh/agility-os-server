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

export function extractJsonObject(content: string | null | undefined): Record<string, unknown> | null {
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
          "tone, language, the exact questions to ask the learner, and the call flow. " +
          "CRITICAL INSTRUCTION: The call flow MUST dictate that the coach's VERY FIRST message is a greeting where they identify themselves as the user's practice coach and ask if the user is ready to begin (NEVER ask 'how can I assist you today'). Once the user confirms, the coach MUST first teach the concepts from the reference material, and ONLY start asking questions after teaching is complete.",
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

export type CheckinStructuredSummary = {
  report: string;
  priorities: string;
  blockers: string;
  suggestions: string;
  updates: string;
  sentiment: "positive" | "neutral" | "needs_attention" | "blocked";
  keyTakeaway: string;
  answers: Array<{
    question: string;
    answer: string;
  }>;
};

/**
 * Structured digest of a daily check-in call transcript. Produces
 * { report, priorities, blockers, suggestions, updates, sentiment, keyTakeaway, answers }
 * straight from the spoken text. Returns null when no LLM provider is configured
 * or the output can't be parsed.
 */
export async function generateCheckinSummary(
  transcript: string,
  questions?: string[],
): Promise<CheckinStructuredSummary | null> {
  const client = getAiClient();
  if (!client) return null;

  const text = truncate(transcript.trim(), 12_000);
  if (text.length < 3) return null;

  const questionsHint =
    questions && questions.length > 0
      ? `\nThe AI voice assistant asked the following questions during the call:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "";

  const completion = await client.chat.completions.create({
    model: AI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are an expert executive assistant summarizing a daily voice check-in call between an AI voice assistant and a team member. " +
          "Extract accurate, structured answers from the transcript. Reply ONLY with JSON of the form:\n" +
          "{\n" +
          '  "report": "<Accomplishments / progress made since last check-in>",\n' +
          '  "priorities": "<Main priorities or planned tasks for today>",\n' +
          '  "blockers": "<Blockers, impediments, illness, or support needed, or empty string if none>",\n' +
          '  "suggestions": "<Suggestions or feedback to share, or empty string if none>",\n' +
          '  "updates": "<Other key updates or context, or empty string if none>",\n' +
          '  "sentiment": "<one of: \\"positive\\", \\"neutral\\", \\"needs_attention\\", \\"blocked\\">",\n' +
          '  "keyTakeaway": "<A crisp 1-sentence executive summary of caller status>",\n' +
          '  "answers": [\n' +
          '    { "question": "<question asked>", "answer": "<concise summary of caller\'s spoken answer>" }\n' +
          "  ]\n" +
          "}\n\n" +
          "Guidelines:\n" +
          "- If a topic wasn't mentioned, return an empty string \"\" or empty array [].\n" +
          "- If the caller reported illness, inability to work, or being blocked, set sentiment to \"needs_attention\" or \"blocked\" and clearly state in blockers.\n" +
          "- For \"answers\", summarize the direct answer to each question asked during the call.\n" +
          "- Write in professional, clear English. Never invent facts not in the transcript.",
      },
      {
        role: "user",
        content: `Transcript of the check-in call:${questionsHint}\n\n${text}`,
      },
    ],
  });

  const parsed = extractJsonObject(completion.choices[0]?.message?.content);
  if (!parsed) return null;

  const asText = (v: unknown) =>
    (typeof v === "string" ? v.trim() : "").slice(0, 2000);

  const report = asText(parsed["report"]);
  const priorities = asText(parsed["priorities"]);
  const blockers = asText(parsed["blockers"]);
  const suggestions = asText(parsed["suggestions"]);
  const updates = asText(parsed["updates"]);
  const keyTakeaway = asText(parsed["keyTakeaway"]);

  const rawSentiment = asText(parsed["sentiment"]).toLowerCase();
  const sentiment: CheckinStructuredSummary["sentiment"] =
    rawSentiment === "positive" ||
    rawSentiment === "neutral" ||
    rawSentiment === "needs_attention" ||
    rawSentiment === "blocked"
      ? rawSentiment
      : blockers.length > 0
        ? "needs_attention"
        : "neutral";

  const rawAnswers = Array.isArray(parsed["answers"]) ? parsed["answers"] : [];
  const answers: Array<{ question: string; answer: string }> = [];
  for (const item of rawAnswers) {
    if (typeof item === "object" && item !== null) {
      const q = asText((item as Record<string, unknown>)["question"]);
      const a = asText((item as Record<string, unknown>)["answer"]);
      if (q && a) {
        answers.push({ question: q, answer: a });
      }
    }
  }

  if (!report && !priorities && !blockers && !suggestions && !updates && answers.length === 0) {
    return null;
  }

  return {
    report,
    priorities,
    blockers,
    suggestions,
    updates,
    sentiment,
    keyTakeaway: keyTakeaway || report || updates || "Check-in completed.",
    answers,
  };
}

export type RubricCriterionSuggestion = {
  name: string;
  weight: number;
  description: string;
};

function normalizeRubricWeights(list: RubricCriterionSuggestion[]): void {
  if (list.length === 0) return;
  const currentTotal = list.reduce((sum, item) => sum + item.weight, 0);
  if (currentTotal === 100) return;

  if (currentTotal === 0) {
    const even = Math.floor(100 / list.length);
    const remainder = 100 - even * list.length;
    list.forEach((item, idx) => {
      item.weight = even + (idx < remainder ? 1 : 0);
    });
    return;
  }

  // Scale proportionally to sum to 100
  let runningSum = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item) continue;
    if (i === list.length - 1) {
      item.weight = Math.max(1, 100 - runningSum);
    } else {
      const scaled = Math.max(1, Math.round((item.weight / currentTotal) * 100));
      item.weight = scaled;
      runningSum += scaled;
    }
  }
}

/**
 * Suggests a balanced scoring rubric (3 to 5 criteria summing to 100%)
 * based on course context, knowledge notes/docs, and practice questions.
 * Returns [] when no provider is configured.
 */
export async function generateRubricSuggestions(input: {
  course: CourseLike;
  org: OrgLike;
  docs: DocLike[];
}): Promise<RubricCriterionSuggestion[]> {
  const client = getAiClient();
  if (!client) return [];

  const { course, org, docs } = input;
  const reference = buildReference(course, docs);
  const questions = asFaqs(course.faqs);

  const questionBlock =
    questions.length > 0
      ? `Practice questions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "";

  const completion = await client.chat.completions.create({
    model: AI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You generate scoring rubrics for corporate spoken voice training. " +
          "Given a training course and its reference materials, create 3 to 5 distinct, measurable evaluation criteria to grade a learner's verbal performance during an AI practice call. " +
          "Each criterion must have: " +
          "- name: A concise, descriptive title (<= 50 chars). " +
          "- weight: An integer percentage weighting between 10 and 50. ALL CRITERIA WEIGHTS MUST SUM TO EXACTLY 100. " +
          "- description: 1-2 clear sentences explaining what 'good' performance looks like on this criterion. " +
          'Reply ONLY with JSON of the form: {"rubric": [{"name": "...", "weight": 25, "description": "..."}, ...]}.',
      },
      {
        role: "user",
        content: [
          `Organisation: ${org.name}.`,
          `Course title: ${course.title}.`,
          `Course description: ${course.description?.trim() || "(none)"}.`,
          questionBlock,
          reference
            ? `Reference material:\n${reference}`
            : "No reference material provided — base criteria on course title and description.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });

  const parsed = extractJsonObject(completion.choices[0]?.message?.content);
  if (!parsed) return [];

  const raw = Array.isArray(parsed["rubric"]) ? parsed["rubric"] : [];
  const list: RubricCriterionSuggestion[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj["name"] === "string" ? obj["name"].trim() : "";
    const description =
      typeof obj["description"] === "string" ? obj["description"].trim() : "";
    const weightRaw =
      typeof obj["weight"] === "number" && Number.isFinite(obj["weight"])
        ? Math.round(obj["weight"])
        : 0;

    if (name.length > 0) {
      list.push({
        name: name.slice(0, 100),
        weight: Math.max(1, Math.min(100, weightRaw)),
        description: description.slice(0, 500),
      });
    }
  }

  if (list.length === 0) return [];

  // Normalize weights so they always sum up to exactly 100
  normalizeRubricWeights(list);

  return list;
}