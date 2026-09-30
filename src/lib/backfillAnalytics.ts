/**
 * Backfill & Re-evaluation Runner for Past Practice Calls.
 *
 * Scans course enrollments that completed a voice session (have a transcript or duration)
 * but lack AI evaluation scores, rubric scorecards, or talk ratios, and grades them.
 */

import { and, eq, isNotNull, or, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { courseEnrollments, dailyCheckins, drills } from "../db/schema.js";
import { evaluateCourseCallTranscript, computeTalkRatioFromTranscript } from "./ai/evaluate.js";
import type { TranscriptTurn } from "./ai/evaluate.js";

export async function backfillUnevaluatedCalls(): Promise<{
  evaluatedCourses: number;
  fixedCheckins: number;
}> {
  let evaluatedCourses = 0;
  let fixedCheckins = 0;

  try {
    // 1. Find course enrollments with transcript or answered status that have no score or incomplete analytics
    const unScoredRows = await db
      .select({
        id: courseEnrollments.id,
        courseId: courseEnrollments.courseId,
        status: courseEnrollments.status,
        score: courseEnrollments.score,
        durationSecs: courseEnrollments.durationSecs,
        transcript: courseEnrollments.transcript,
        qaScorecard: courseEnrollments.qaScorecard,
        coachingTips: courseEnrollments.coachingTips,
        calledAt: courseEnrollments.calledAt,
        courseTitle: drills.title,
        courseDescription: drills.description,
        scoringRubric: drills.scoringRubric,
      })
      .from(courseEnrollments)
      .innerJoin(drills, eq(courseEnrollments.courseId, drills.id))
      .where(
        and(
          or(
            isNotNull(courseEnrollments.transcript),
            eq(courseEnrollments.status, "answered"),
          ),
          or(
            isNull(courseEnrollments.score),
            isNull(courseEnrollments.qaScorecard),
            isNull(courseEnrollments.talkRatio),
            eq(courseEnrollments.status, "answered"),
          ),
        ),
      );

    for (const row of unScoredRows) {
      const transcript = (row.transcript as TranscriptTurn[] | null) ?? [];

      const evalResult = await evaluateCourseCallTranscript({
        course: {
          title: row.courseTitle,
          description: row.courseDescription,
          scoringRubric: row.scoringRubric,
        },
        transcript,
        durationSecs: row.durationSecs,
      });

      await db
        .update(courseEnrollments)
        .set({
          status: "completed",
          score: evalResult.score,
          summary: evalResult.summary,
          sentiment: evalResult.sentiment,
          sentimentScore: Math.round(evalResult.sentimentScore * 100),
          talkRatio: evalResult.talkRatio,
          qaScorecard: evalResult.qaScorecard,
          coachingTips: evalResult.coachingTips,
          actionItems: evalResult.actionItems,
          objections: evalResult.objections,
          topics: evalResult.topics,
          completedAt: row.calledAt ?? new Date(),
        })
        .where(eq(courseEnrollments.id, row.id));

      evaluatedCourses += 1;
    }

    // 2. Fix & upgrade daily check-ins summaries to structured format
    const checkins = await db.select().from(dailyCheckins);
    for (const c of checkins) {
      const structured = parseCheckinSummaryToStructured(c.summary);
      const nextStatus = c.status === "answered" || c.status === "completed" ? "completed" : c.status;
      await db
        .update(dailyCheckins)
        .set({
          summary: structured,
          status: nextStatus,
          completedAt: c.completedAt ?? c.calledAt ?? new Date(),
        })
        .where(eq(dailyCheckins.id, c.id));
      fixedCheckins += 1;
    }
  } catch (err) {
    console.error("[backfill] Failed during backfillUnevaluatedCalls:", err);
  }

  return { evaluatedCourses, fixedCheckins };
}

export function parseCheckinSummaryToStructured(raw: unknown): {
  report: string;
  priorities: string;
  blockers: string;
  suggestions: string;
  updates: string;
  sentiment: "positive" | "neutral" | "needs_attention" | "blocked";
  keyTakeaway: string;
  answers: Array<{ question: string; answer: string }>;
} {
  if (!raw) {
    return {
      report: "",
      priorities: "",
      blockers: "",
      suggestions: "",
      updates: "",
      sentiment: "neutral",
      keyTakeaway: "Check-in completed.",
      answers: [],
    };
  }

  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const report = typeof obj["report"] === "string" ? obj["report"] : "";
    const priorities = typeof obj["priorities"] === "string" ? obj["priorities"] : "";
    const blockers = typeof obj["blockers"] === "string" ? obj["blockers"] : "";
    const suggestions = typeof obj["suggestions"] === "string" ? obj["suggestions"] : "";
    const updates = typeof obj["updates"] === "string" ? obj["updates"] : "";
    const sentiment =
      obj["sentiment"] === "positive" ||
      obj["sentiment"] === "neutral" ||
      obj["sentiment"] === "needs_attention" ||
      obj["sentiment"] === "blocked"
        ? (obj["sentiment"] as "positive" | "neutral" | "needs_attention" | "blocked")
        : blockers || report.toLowerCase().includes("medical") || report.toLowerCase().includes("blocked")
          ? "needs_attention"
          : "neutral";
    const keyTakeaway =
      typeof obj["keyTakeaway"] === "string" && obj["keyTakeaway"]
        ? obj["keyTakeaway"]
        : report || updates || "Check-in completed.";
    const answers = Array.isArray(obj["answers"])
      ? (obj["answers"] as Array<{ question: string; answer: string }>)
      : [];

    return {
      report,
      priorities,
      blockers,
      suggestions,
      updates,
      sentiment,
      keyTakeaway,
      answers,
    };
  }

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        return parseCheckinSummaryToStructured(parsed);
      }
    } catch {}

    const str = raw;
    const reportMatch = str.match(/(?:Report|Accomplished|Progress):\s*([\s\S]*?)(?=(?:Suggestions|Updates|Blockers|Priorities):|$)/i);
    const suggestionsMatch = str.match(/Suggestions:\s*([\s\S]*?)(?=(?:Report|Updates|Blockers|Priorities):|$)/i);
    const updatesMatch = str.match(/(?:Updates(?:\s*\/\s*Blockers)?|Blockers):\s*([\s\S]*?)(?=(?:Report|Suggestions|Priorities):|$)/i);
    const prioritiesMatch = str.match(/Priorities:\s*([\s\S]*?)(?=(?:Report|Suggestions|Updates|Blockers):|$)/i);

    const report = reportMatch?.[1] ? reportMatch[1].trim() : "";
    const suggestions = suggestionsMatch?.[1] ? suggestionsMatch[1].trim() : "";
    const rawUpdates = updatesMatch?.[1] ? updatesMatch[1].trim() : "";
    let priorities = prioritiesMatch?.[1] ? prioritiesMatch[1].trim() : "";
    let blockers = "";

    if (rawUpdates.toLowerCase().includes("priority") && !priorities) {
      priorities = rawUpdates;
    }
    if (
      report.toLowerCase().includes("medical") ||
      report.toLowerCase().includes("blocker") ||
      rawUpdates.toLowerCase().includes("blocker")
    ) {
      blockers = report.toLowerCase().includes("medical")
        ? report
        : rawUpdates;
    }

    const isNeedsAttention = Boolean(
      blockers ||
      report.toLowerCase().includes("medical") ||
      str.toLowerCase().includes("blocker")
    );

    const answers: Array<{ question: string; answer: string }> = [];
    if (report) answers.push({ question: "What progress have you made since our last check-in?", answer: report });
    if (priorities) answers.push({ question: "What are your main priorities for today?", answer: priorities });
    if (blockers) answers.push({ question: "Are you facing any blockers or need support from the team?", answer: blockers });
    if (suggestions) answers.push({ question: "Do you have any suggestions or feedback to share?", answer: suggestions });

    const keyTakeaway =
      blockers && priorities
        ? `${blockers} · Priority: ${priorities}`
        : report || priorities || rawUpdates || "Check-in completed.";

    return {
      report: report || (answers.length === 0 ? str : ""),
      priorities,
      blockers,
      suggestions,
      updates: rawUpdates,
      sentiment: isNeedsAttention ? "needs_attention" : "neutral",
      keyTakeaway,
      answers,
    };
  }

  return {
    report: "",
    priorities: "",
    blockers: "",
    suggestions: "",
    updates: "",
    sentiment: "neutral",
    keyTakeaway: "Check-in completed.",
    answers: [],
  };
}
