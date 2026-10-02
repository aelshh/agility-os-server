import { Router } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { courseEnrollments, drills, users, dailyCheckins } from "../db/schema.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

function formatCheckinSummary(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        return formatCheckinSummary(parsed);
      }
    } catch {
      return raw;
    }
    return raw;
  }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const parts: string[] = [];
    if (obj.report && typeof obj.report === "string" && obj.report.trim()) {
      parts.push(`Progress: ${obj.report.trim()}`);
    }
    if (obj.priorities && typeof obj.priorities === "string" && obj.priorities.trim()) {
      parts.push(`Priorities: ${obj.priorities.trim()}`);
    }
    if (obj.blockers && typeof obj.blockers === "string" && obj.blockers.trim()) {
      parts.push(`Blockers: ${obj.blockers.trim()}`);
    }
    if (obj.suggestions && typeof obj.suggestions === "string" && obj.suggestions.trim()) {
      parts.push(`Suggestions: ${obj.suggestions.trim()}`);
    }
    if (obj.updates && typeof obj.updates === "string" && obj.updates.trim()) {
      parts.push(`Updates: ${obj.updates.trim()}`);
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  return "";
}

router.get("/", requireAuth, requireRole("architect", "content_curator"), async (req, res) => {
  const user = req.user!;
  if (!user.orgId) {
    res.status(400).json({ message: "Organisation context is required." });
    return;
  }
  const orgId = user.orgId;

  const {
    startDate,
    endDate,
    type,
    status,
    search,
    page,
    pageSize,
  } = req.query;

  try {
    const fetchCourses = !type || type === "all" || type === "course";
    const fetchCheckins = !type || type === "all" || type === "checkin";

    let enrollments: any[] = [];
    if (fetchCourses) {
      enrollments = await db
        .select({
          id: courseEnrollments.id,
          type: sql<string>`'course'`.as("type"),
          status: courseEnrollments.status,
          score: courseEnrollments.score,
          durationSecs: courseEnrollments.durationSecs,
          telenowSessionId: courseEnrollments.telenowSessionId,
          recordingUrl: courseEnrollments.recordingUrl,
          calledAt: courseEnrollments.calledAt,
          completedAt: courseEnrollments.completedAt,
          createdAt: courseEnrollments.createdAt,
          userName: users.name,
          userEmail: users.email,
          userPhone: users.phone,
          userRole: users.role,
          userRegion: users.region,
          title: drills.title,
          summary: courseEnrollments.summary,
          sentiment: courseEnrollments.sentiment,
          sentimentScore: courseEnrollments.sentimentScore,
          talkRatio: courseEnrollments.talkRatio,
          qaScorecard: courseEnrollments.qaScorecard,
          coachingTips: courseEnrollments.coachingTips,
          actionItems: courseEnrollments.actionItems,
          objections: courseEnrollments.objections,
          topics: courseEnrollments.topics,
          transcript: courseEnrollments.transcript,
        })
        .from(courseEnrollments)
        .leftJoin(users, eq(courseEnrollments.userId, users.id))
        .leftJoin(drills, eq(courseEnrollments.courseId, drills.id))
        .where(eq(courseEnrollments.orgId, orgId))
        .orderBy(desc(courseEnrollments.createdAt));
    }

    let checkins: any[] = [];
    if (fetchCheckins) {
      const rawCheckins = await db
        .select({
          id: dailyCheckins.id,
          type: sql<string>`'checkin'`.as("type"),
          status: dailyCheckins.status,
          score: sql<number | null>`null`.as("score"),
          durationSecs: sql<number | null>`null`.as("durationSecs"),
          telenowSessionId: dailyCheckins.telenowSessionId,
          recordingUrl: dailyCheckins.recordingUrl,
          calledAt: dailyCheckins.calledAt,
          completedAt: dailyCheckins.completedAt,
          createdAt: dailyCheckins.createdAt,
          userName: users.name,
          userEmail: users.email,
          userPhone: users.phone,
          userRole: users.role,
          userRegion: users.region,
          title: sql<string>`'Daily Check-in'`.as("title"),
          summary: dailyCheckins.summary,
          sentiment: sql<string | null>`null`.as("sentiment"),
          sentimentScore: sql<number | null>`null`.as("sentimentScore"),
          talkRatio: sql<unknown>`null`.as("talkRatio"),
          qaScorecard: sql<unknown>`null`.as("qaScorecard"),
          coachingTips: sql<unknown>`null`.as("coachingTips"),
          actionItems: sql<unknown>`null`.as("actionItems"),
          objections: sql<unknown>`null`.as("objections"),
          topics: sql<unknown>`null`.as("topics"),
          transcript: sql<unknown>`null`.as("transcript"),
        })
        .from(dailyCheckins)
        .leftJoin(users, eq(dailyCheckins.userId, users.id))
        .where(eq(dailyCheckins.orgId, orgId))
        .orderBy(desc(dailyCheckins.createdAt));

      checkins = rawCheckins.map((c) => ({
        ...c,
        summary: formatCheckinSummary(c.summary),
      }));
    }

    const rawCalls = [...enrollments, ...checkins];
    let calls = rawCalls
      .filter((c) => c.status !== "pending" && c.status !== "queued")
      .sort((a, b) => {
        const timeA = (a.calledAt ?? a.completedAt ?? a.createdAt ?? new Date(0)).getTime();
        const timeB = (b.calledAt ?? b.completedAt ?? b.createdAt ?? new Date(0)).getTime();
        return timeB - timeA;
      });

    // Date filters
    if (startDate && typeof startDate === "string") {
      const startMs = new Date(startDate).getTime();
      if (!isNaN(startMs)) {
        calls = calls.filter((c) => {
          const t = (c.calledAt ?? c.completedAt ?? c.createdAt ?? new Date(0)).getTime();
          return t >= startMs;
        });
      }
    }

    if (endDate && typeof endDate === "string") {
      let endMs: number;
      if (/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        // End of the selected day in local / UTC interpretation
        endMs = new Date(`${endDate}T23:59:59.999Z`).getTime();
      } else {
        endMs = new Date(endDate).getTime();
      }
      if (!isNaN(endMs)) {
        calls = calls.filter((c) => {
          const t = (c.calledAt ?? c.completedAt ?? c.createdAt ?? new Date(0)).getTime();
          return t <= endMs;
        });
      }
    }

    // Status filter
    if (status && typeof status === "string" && status !== "all") {
      calls = calls.filter((c) => c.status === status);
    }

    // Search filter
    if (search && typeof search === "string" && search.trim()) {
      const q = search.trim().toLowerCase();
      calls = calls.filter((c) => {
        const name = (c.userName || "").toLowerCase();
        const email = (c.userEmail || "").toLowerCase();
        const phone = (c.userPhone || "").toLowerCase();
        const role = (c.userRole || "").toLowerCase();
        const title = (c.title || "").toLowerCase();
        return (
          name.includes(q) ||
          email.includes(q) ||
          phone.includes(q) ||
          role.includes(q) ||
          title.includes(q)
        );
      });
    }

    // Compute aggregated stats for the filtered set
    const totalCalls = calls.length;
    const completedCalls = calls.filter((c) => c.status === "completed").length;
    const scoredList = calls.filter((c) => c.score !== null && c.score !== undefined);
    const avgScore =
      scoredList.length > 0
        ? Math.round(
            scoredList.reduce((sum, c) => sum + (c.score || 0), 0) / scoredList.length,
          )
        : null;
    const totalDurationSecs = calls.reduce((sum, c) => sum + (c.durationSecs || 0), 0);

    const stats = {
      totalCalls,
      completedCalls,
      avgScore,
      totalDurationSecs,
    };

    // Pagination
    const pageNum = page ? Math.max(1, parseInt(String(page), 10) || 1) : 1;
    const limitNum = pageSize
      ? Math.max(1, Math.min(100, parseInt(String(pageSize), 10) || 25))
      : (page ? 25 : calls.length || 25);
    const totalPages = Math.max(1, Math.ceil(totalCalls / limitNum));

    const paginatedCalls =
      page || pageSize
        ? calls.slice((pageNum - 1) * limitNum, pageNum * limitNum)
        : calls;

    res.json({
      calls: paginatedCalls,
      total: totalCalls,
      page: pageNum,
      pageSize: limitNum,
      totalPages,
      stats,
    });
  } catch (error) {
    console.error("Error fetching call logs:", error);
    res.status(500).json({ error: "Failed to fetch call logs" });
  }
});

export const callsRouter = router;
