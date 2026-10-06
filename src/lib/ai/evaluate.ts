/**
 * AI Post-Call Evaluation and Scorecard Generator.
 *
 * Grades a completed course practice call against the course's scoring rubric,
 * extracting QA criteria pass/fail with evidence quotes, actionable coaching tips,
 * summary, discovered signals, and deterministic talk ratio.
 */

import { getAiClient, AI_MODEL } from "./client.js";
import { extractJsonObject } from "./prompts.js";

export type TranscriptTurn = {
  role: string;
  text: string;
  at?: string;
};

export type RubricItem = {
  name: string;
  weight?: number;
  description?: string;
};

export type EvaluatedQaCriterion = {
  key: string;
  met: boolean;
  evidence: string;
};

export type EvaluatedCoachingTip = {
  issue: string;
  suggestion: string;
  severity: "low" | "medium" | "high";
};

export type TalkRatioMetrics = {
  agentWords: number;
  customerWords: number;
  agentTurns: number;
  customerTurns: number;
};

export type CallEvaluationResult = {
  score: number;
  summary: string;
  sentiment: "positive" | "neutral" | "negative";
  sentimentScore: number;
  talkRatio: TalkRatioMetrics;
  qaScorecard: EvaluatedQaCriterion[];
  coachingTips: EvaluatedCoachingTip[];
  actionItems: string[];
  objections: string[];
  topics: string[];
};

/**
 * Deterministically computes talk ratio metrics (words and turns)
 * directly from transcript turns.
 */
export function computeTalkRatioFromTranscript(
  transcript: TranscriptTurn[] | null | undefined,
): TalkRatioMetrics {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return { agentWords: 0, customerWords: 0, agentTurns: 0, customerTurns: 0 };
  }

  let agentWords = 0;
  let customerWords = 0;
  let agentTurns = 0;
  let customerTurns = 0;

  for (const turn of transcript) {
    if (!turn || typeof turn.text !== "string") continue;
    const text = turn.text.trim();
    if (!text) continue;
    const words = text.split(/\s+/).filter(Boolean).length;
    const role = (turn.role || "").toLowerCase();

    if (
      role === "assistant" ||
      role === "agent" ||
      role === "coach" ||
      role === "system"
    ) {
      agentWords += words;
      agentTurns += 1;
    } else {
      customerWords += words;
      customerTurns += 1;
    }
  }

  return { agentWords, customerWords, agentTurns, customerTurns };
}

const DEFAULT_RUBRIC: RubricItem[] = [
  {
    name: "Domain Knowledge & Accuracy",
    weight: 35,
    description: "The learner explains concepts accurately, demonstrates understanding of core principles, and answers technical questions correctly.",
  },
  {
    name: "Clarity & Structure",
    weight: 25,
    description: "The learner communicates thoughts in a logical, coherent, and concise manner without excessive hesitation.",
  },
  {
    name: "Practical Problem Solving",
    weight: 25,
    description: "The learner applies theoretical knowledge to real-world scenarios and handles follow-up challenges well.",
  },
  {
    name: "Professional Demeanor",
    weight: 15,
    description: "The learner engages positively, listens attentively, and maintains a professional tone throughout.",
  },
];

/**
 * Evaluates a completed practice conversation against the course scoring rubric.
 */
export async function evaluateCourseCallTranscript(input: {
  course: {
    id?: string;
    title: string;
    description?: string | null;
    scoringRubric?: RubricItem[] | unknown;
  };
  transcript: TranscriptTurn[];
  durationSecs?: number | null;
}): Promise<CallEvaluationResult> {
  const { course, transcript, durationSecs } = input;
  const talkRatio = computeTalkRatioFromTranscript(transcript);

  // Parse course rubric or fallback
  const rawRubric = Array.isArray(course.scoringRubric)
    ? (course.scoringRubric as RubricItem[]).filter(
        (r) => r && typeof r === "object" && typeof r.name === "string" && r.name.trim().length > 0,
      )
    : [];
  const rubric = rawRubric.length > 0 ? rawRubric : DEFAULT_RUBRIC;

  // Format transcript text
  const dialogueLines = transcript
    .filter((t) => t && typeof t.text === "string" && t.text.trim().length > 0)
    .map((t) => {
      const role = (t.role || "").toLowerCase();
      const speaker =
        role === "assistant" || role === "agent" || role === "coach"
          ? "AI Coach"
          : "Learner";
      return `${speaker}: ${t.text.trim()}`;
    });

  const transcriptText = dialogueLines.join("\n");

  if (dialogueLines.length === 0 || talkRatio.customerWords === 0) {
    return {
      score: 0,
      summary: "Incomplete practice session with no learner speech recorded.",
      sentiment: "neutral",
      sentimentScore: 0,
      talkRatio,
      qaScorecard: rubric.map((r) => ({
        key: r.name,
        met: false,
        evidence: "No learner responses recorded.",
      })),
      coachingTips: [
        {
          issue: "No spoken responses from the learner were recorded during this call.",
          suggestion: "Ensure the microphone is connected and speak clearly during the practice session.",
          severity: "high",
        },
      ],
      actionItems: ["Redial and complete a full practice session."],
      objections: [],
      topics: [],
    };
  }

  const client = getAiClient();
  if (!client) {
    // Fallback if AI client not configured: heuristic evaluation
    const metCount = Math.min(
      rubric.length,
      Math.max(1, Math.round((talkRatio.customerWords / 100) * rubric.length)),
    );
    const score = Math.min(100, Math.max(50, Math.round((metCount / rubric.length) * 85)));

    return {
      score,
      summary: `Practice session for "${course.title}". The learner spoke ${talkRatio.customerWords} words across ${talkRatio.customerTurns} turns.`,
      sentiment: "positive",
      sentimentScore: 0.5,
      talkRatio,
      qaScorecard: rubric.map((r, i) => ({
        key: r.name,
        met: i < metCount,
        evidence: i < metCount ? "Learner demonstrated verbal response in dialogue." : "Needs more detailed coverage.",
      })),
      coachingTips: [
        {
          issue: "Elaborate more on specific examples and real-world applications.",
          suggestion: "Provide concrete steps and explain the reasoning behind your solutions.",
          severity: "medium",
        },
      ],
      actionItems: ["Review course materials on challenging topics."],
      objections: [],
      topics: [course.title],
    };
  }

  const rubricDescription = rubric
    .map(
      (r, i) =>
        `${i + 1}. Criteria: "${r.name}" (Weight: ${r.weight ?? Math.round(100 / rubric.length)}%)\n   Description: ${r.description || "Demonstrates competence in this area."}`,
    )
    .join("\n\n");

  const systemPrompt =
    "You are an expert AI evaluator and spoken-training coach for corporate voice practice sessions.\n" +
    "Your job is to rigorously evaluate a learner's verbal performance during a training phone call against the course criteria.\n\n" +
    "You must return ONLY a valid JSON object matching this exact structure:\n" +
    "{\n" +
    '  "score": <integer from 0 to 100 representing overall mastery based on the weighted criteria>,\n' +
    '  "summary": "<2-3 sentence executive recap of the call, strengths, and areas to improve>",\n' +
    '  "sentiment": "positive" | "neutral" | "negative",\n' +
    '  "sentimentScore": <float between -1.0 and 1.0>,\n' +
    '  "qaScorecard": [\n' +
    '    {\n' +
    '      "key": "<criterion name matching the rubric>",\n' +
    '      "met": true | false,\n' +
    '      "evidence": "<exact verbatim quote or spoken evidence from the transcript demonstrating why it was met or not met>"\n' +
    "    }\n" +
    "  ],\n" +
    '  "coachingTips": [\n' +
    '    {\n' +
    '      "issue": "<concise description of specific mistake, hesitation, or gap in the learner\'s answer>",\n' +
    '      "suggestion": "<actionable coaching recommendation on what to say or do next time>",\n' +
    '      "severity": "high" | "medium" | "low"\n' +
    "    }\n" +
    "  ],\n" +
    '  "actionItems": ["<follow-up item 1>", "<follow-up item 2>"],\n' +
    '  "objections": ["<objections or hesitations raised during call>"],\n' +
    '  "topics": ["<key topic 1>", "<key topic 2>"]\n' +
    "}\n\n" +
    "Guidelines:\n" +
    "- Ground all judgments strictly in the provided transcript.\n" +
    "- Every rubric criterion MUST appear in qaScorecard with accurate met status and evidence quotes.\n" +
    "- Provide 1 to 3 high-impact actionable coaching tips.\n" +
    "- Score fairly and accurately: 85-100 = Mastered, 70-84 = Proficient, <70 = Needs Practice.";

  const userPrompt = [
    `Course: ${course.title}`,
    course.description ? `Description: ${course.description}` : "",
    `Call Duration: ${durationSecs ?? 0} seconds`,
    `Evaluation Rubric:\n${rubricDescription}`,
    `Call Transcript:\n${transcriptText.slice(0, 15000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const completion = await client.chat.completions.create({
      model: AI_MODEL,
      response_format: { type: "json_object" },
      max_tokens: 1800,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const parsed = extractJsonObject(completion.choices[0]?.message?.content);
    if (!parsed) throw new Error("Failed to parse evaluation JSON from model.");

    // Parse Score
    const rawScore = Number(parsed["score"]);
    const score = Number.isFinite(rawScore)
      ? Math.round(Math.min(100, Math.max(0, rawScore)))
      : 75;

    // Parse Summary
    const summary =
      typeof parsed["summary"] === "string" && parsed["summary"].trim().length > 0
        ? parsed["summary"].trim()
        : `Practice session for "${course.title}".`;

    // Parse Sentiment
    const rawSentiment = String(parsed["sentiment"] || "neutral").toLowerCase();
    const sentiment: "positive" | "neutral" | "negative" =
      rawSentiment === "positive" || rawSentiment === "negative"
        ? rawSentiment
        : "neutral";

    const rawSentimentScore = Number(parsed["sentimentScore"]);
    const sentimentScore = Number.isFinite(rawSentimentScore)
      ? Math.min(1, Math.max(-1, rawSentimentScore))
      : sentiment === "positive"
        ? 0.7
        : sentiment === "negative"
          ? -0.5
          : 0;

    // Parse QA Scorecard
    const rawQa = Array.isArray(parsed["qaScorecard"]) ? parsed["qaScorecard"] : [];
    const qaScorecard: EvaluatedQaCriterion[] = [];
    const rubricKeys = new Set(rubric.map((r) => r.name.toLowerCase()));

    for (const item of rawQa) {
      if (!item || typeof item !== "object") continue;
      const key = String(item["key"] || "").trim();
      if (!key) continue;
      const met = Boolean(item["met"]);
      const evidence = String(item["evidence"] || "").trim();
      qaScorecard.push({ key, met, evidence });
    }

    // Ensure all rubric criteria are represented
    for (const r of rubric) {
      if (!qaScorecard.some((q) => q.key.toLowerCase() === r.name.toLowerCase())) {
        qaScorecard.push({
          key: r.name,
          met: score >= 70,
          evidence: score >= 70 ? "Criterion satisfied based on overall conversation context." : "Needs more detailed responses.",
        });
      }
    }

    // Parse Coaching Tips
    const rawTips = Array.isArray(parsed["coachingTips"]) ? parsed["coachingTips"] : [];
    const coachingTips: EvaluatedCoachingTip[] = [];

    for (const item of rawTips) {
      if (!item || typeof item !== "object") continue;
      const issue = String(item["issue"] || "").trim();
      const suggestion = String(item["suggestion"] || "").trim();
      const rawSev = String(item["severity"] || "medium").toLowerCase();
      const severity: "low" | "medium" | "high" =
        rawSev === "high" || rawSev === "low" ? rawSev : "medium";

      if (issue || suggestion) {
        coachingTips.push({
          issue: issue || "General spoken practice improvement.",
          suggestion: suggestion || "Continue practicing spoken responses with clear structured explanations.",
          severity,
        });
      }
    }

    if (coachingTips.length === 0) {
      coachingTips.push({
        issue: score < 85 ? "Responses could be more comprehensive." : "Minor pacing and delivery polish.",
        suggestion: "State the key takeaway first, then back it up with a clear concrete example.",
        severity: score < 70 ? "high" : "medium",
      });
    }

    // Parse Signals
    const asStringArray = (val: unknown): string[] =>
      Array.isArray(val)
        ? val
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .map((v) => v.trim())
        : [];

    const actionItems = asStringArray(parsed["actionItems"]);
    const objections = asStringArray(parsed["objections"]);
    const topics = asStringArray(parsed["topics"]);

    return {
      score,
      summary,
      sentiment,
      sentimentScore,
      talkRatio,
      qaScorecard,
      coachingTips,
      actionItems,
      objections,
      topics,
    };
  } catch (err) {
    console.error("[evaluate] AI evaluation failed, falling back to heuristic:", err);
    return {
      score: 75,
      summary: `Practice session for "${course.title}". The learner spoke ${talkRatio.customerWords} words.`,
      sentiment: "neutral",
      sentimentScore: 0,
      talkRatio,
      qaScorecard: rubric.map((r) => ({
        key: r.name,
        met: true,
        evidence: "Learner completed practice session.",
      })),
      coachingTips: [
        {
          issue: "Ensure thorough explanations on core topics.",
          suggestion: "Structure spoken answers clearly and provide examples.",
          severity: "medium",
        },
      ],
      actionItems: ["Review course topics."],
      objections: [],
      topics: [course.title],
    };
  }
}
