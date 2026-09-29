import { Router } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { courseEnrollments, drills, users, dailyCheckins } from "../db/schema.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

router.get("/", requireAuth, requireRole("architect", "content_curator"), async (req, res) => {
  const user = req.user!;
  if (!user.orgId) {
    res.status(400).json({ message: "Organisation context is required." });
    return;
  }
  const orgId = user.orgId;

  try {
    const enrollments = await db
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

    const checkins = await db
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

    const rawCalls = [...enrollments, ...checkins];
    const calls = rawCalls
      .filter((c) => c.status !== "pending" && c.status !== "queued")
      .sort((a, b) => {
        const timeA = (a.calledAt ?? new Date(0)).getTime();
        const timeB = (b.calledAt ?? new Date(0)).getTime();
        return timeB - timeA;
      });

    res.json(calls);
  } catch (error) {
    console.error("Error fetching call logs:", error);
    res.status(500).json({ error: "Failed to fetch call logs" });
  }
});

export const callsRouter = router;
