/**
 * Daily check-in REST API.
 *
 * Guarded to NON-practitioners (managers/admin roles schedule voice check-ins;
 * practitioners are the people being called). Everything is owner-scoped: a
 * user may only read/manage their own schedules and runs. Counselling call
 * recordings are never exposed — the run endpoint strips `recordingUrl`.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import {
  dailyCheckinRuns,
  dailyCheckinSchedules,
  dailyCheckins,
  orgs,
  users,
} from "../db/schema.js";
import { toPublicOrg } from "../db/orgs.js";
import type { PublicUser } from "../lib/auth.js";
import {
  DEFAULT_SCRIPT,
  isCallable,
  provisionDailyCheckinRun,
  resolveDirectReports,
} from "../lib/dailyCheckins.js";
import { isValidTimeLabel, zonedNow } from "../lib/timezone.js";
import { isOrgTelenowConfigured } from "../lib/telenow.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

const CHECKIN_TIME_ERROR =
  'Time must be in 24h "HH:mm" format (e.g. 08:45 or 17:30).';

const requireNonPractitioner: RequestHandler = (req, res, next) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }
  if (user.role === "practitioner") {
    res.status(403).json({
      message:
        "Daily check-in scheduling is available to managers and admins, not practitioners.",
    });
    return;
  }
  next();
};

const authNonPractitioner = [requireAuth, requireNonPractitioner];

const createScheduleSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(100, "Title cannot exceed 100 characters"),
  timeLocal: z
    .string()
    .trim()
    .refine((v) => isValidTimeLabel(v), CHECKIN_TIME_ERROR),
  questionScript: z
    .string()
    .trim()
    .max(4000, "Call script cannot exceed 4000 characters")
    .optional(),
});

const updateScheduleSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(100, "Title cannot exceed 100 characters")
    .optional(),
  timeLocal: z
    .string()
    .trim()
    .refine((v) => isValidTimeLabel(v), CHECKIN_TIME_ERROR)
    .optional(),
  questionScript: z
    .string()
    .trim()
    .max(4000, "Call script cannot exceed 4000 characters")
    .optional(),
  enabled: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isOwner(schedule: { ownerUserId: string }, user: PublicUser): boolean {
  return schedule.ownerUserId === user.id;
}

async function schedulePublicView(
  schedule: typeof dailyCheckinSchedules.$inferSelect,
): Promise<Record<string, unknown>> {
  const targets = await resolveDirectReports(schedule.orgId, schedule.ownerUserId);
  return {
    ...schedule,
    questionScript: schedule.questionScript ?? DEFAULT_SCRIPT,
    directReportCount: targets.length,
    callableCount: targets.filter(isCallable).length,
  };
}

async function loadOwnSchedule(
  scheduleId: string,
  user: PublicUser,
): Promise<typeof dailyCheckinSchedules.$inferSelect | null> {
  const [schedule] = await db
    .select()
    .from(dailyCheckinSchedules)
    .where(eq(dailyCheckinSchedules.id, scheduleId))
    .limit(1);
  if (!schedule || !isOwner(schedule, user)) return null;
  return schedule;
}

type RunListItem = {
  id: string;
  runDate: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  counts: Record<string, number>;
};

async function listRunsForSchedule(scheduleId: string): Promise<RunListItem[]> {
  const runs = await db
    .select({
      id: dailyCheckinRuns.id,
      runDate: dailyCheckinRuns.runDate,
      status: dailyCheckinRuns.status,
      startedAt: dailyCheckinRuns.startedAt,
      completedAt: dailyCheckinRuns.completedAt,
      error: dailyCheckinRuns.error,
    })
    .from(dailyCheckinRuns)
    .where(eq(dailyCheckinRuns.scheduleId, scheduleId))
    .orderBy(desc(dailyCheckinRuns.runDate), desc(dailyCheckinRuns.id))
    .limit(60);

  if (runs.length === 0) return [];

  const rows = await db
    .select({ runId: dailyCheckins.runId, status: dailyCheckins.status })
    .from(dailyCheckins)
    .where(inArray(dailyCheckins.runId, runs.map((r) => r.id)));

  const byRun = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const entry = byRun.get(row.runId) ?? {};
    entry[row.status] = (entry[row.status] ?? 0) + 1;
    byRun.set(row.runId, entry);
  }

  return runs.map((run) => ({
    ...run,
    counts: byRun.get(run.id) ?? {},
  }));
}

// ---------------------------------------------------------------------------
// GET /api/checkins/schedule — my schedules
// ---------------------------------------------------------------------------

router.get("/schedule", authNonPractitioner, async (req: Request, res: Response) => {
  const user = req.user!;

  try {
    const schedules = await db
      .select()
      .from(dailyCheckinSchedules)
      .where(eq(dailyCheckinSchedules.ownerUserId, user.id))
      .orderBy(desc(dailyCheckinSchedules.createdAt));

    const [orgRow] = user.orgId
      ? await db.select().from(orgs).where(eq(orgs.id, user.orgId)).limit(1)
      : [undefined];

    const today = orgRow ? zonedNow(orgRow.timezone).date : null;

    const out = await Promise.all(
      schedules.map(async (schedule) => {
        const base = await schedulePublicView(schedule);
        const [todayRun] = today
          ? await db
              .select({ status: dailyCheckinRuns.status })
              .from(dailyCheckinRuns)
              .where(
                and(
                  eq(dailyCheckinRuns.scheduleId, schedule.id),
                  eq(dailyCheckinRuns.runDate, today),
                ),
              )
              .limit(1)
          : [undefined];
        return { ...base, todayRunStatus: todayRun?.status ?? null };
      }),
    );

    res.status(200).json({
      schedules: out,
      timezone: orgRow ? toPublicOrg(orgRow).timezone : null,
      defaultScript: DEFAULT_SCRIPT,
    });
  } catch (err) {
    console.error("[checkins] GET /schedule failed", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/checkins/schedule — create
// ---------------------------------------------------------------------------

router.post("/schedule", authNonPractitioner, async (req: Request, res: Response) => {
  const user = req.user!;

  if (!user.orgId) {
    res.status(400).json({
      message: "You must belong to an organisation before scheduling check-ins.",
    });
    return;
  }

  const isConfigured = await isOrgTelenowConfigured(user.orgId);
  if (!isConfigured) {
    res.status(428).json({
      message:
        "Voice AI integration required. Connect your organisation's Telenow API key in Settings before creating daily check-ins.",
      code: "TELENOW_NOT_CONFIGURED",
    });
    return;
  }

  const result = createScheduleSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ errors: result.error.flatten().fieldErrors });
    return;
  }

  try {
    const [schedule] = await db
      .insert(dailyCheckinSchedules)
      .values({
        orgId: user.orgId,
        ownerUserId: user.id,
        title: result.data.title,
        timeLocal: result.data.timeLocal,
        questionScript: result.data.questionScript?.trim() || null,
      })
      .returning();

    if (!schedule) {
      res.status(500).json({ message: "Failed to create the schedule." });
      return;
    }

    res.status(201).json({
      schedule: await schedulePublicView(schedule),
      defaultScript: DEFAULT_SCRIPT,
    });
  } catch (err) {
    console.error("[checkins] POST /schedule failed", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/checkins/schedule/:id — update my schedule
// ---------------------------------------------------------------------------

router.put("/schedule/:id", authNonPractitioner, async (req: Request, res: Response) => {
  const user = req.user!;

  const result = updateScheduleSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ errors: result.error.flatten().fieldErrors });
    return;
  }

  const data = result.data;
  if (Object.keys(data).length === 0) {
    res.status(400).json({ message: "Nothing to update." });
    return;
  }

  try {
    const schedule = await loadOwnSchedule(req.params["id"] as string, user);
    if (!schedule) {
      res.status(404).json({ message: "Schedule not found." });
      return;
    }

    const patch: Partial<typeof dailyCheckinSchedules.$inferInsert> = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.timeLocal !== undefined) patch.timeLocal = data.timeLocal;
    if (data.questionScript !== undefined)
      patch.questionScript = data.questionScript.trim() || null;
    if (data.enabled !== undefined) patch.enabled = data.enabled;

    const [updated] = await db
      .update(dailyCheckinSchedules)
      .set(patch)
      .where(eq(dailyCheckinSchedules.id, schedule.id))
      .returning();

    if (!updated) {
      res.status(404).json({ message: "Schedule not found." });
      return;
    }

    res.status(200).json({
      schedule: await schedulePublicView(updated),
    });
  } catch (err) {
    console.error("[checkins] PUT /schedule/:id failed", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/checkins/schedule/:id/run-now — fire a run for today immediately
// ---------------------------------------------------------------------------

router.post("/schedule/:id/run-now", authNonPractitioner, async (req: Request, res: Response) => {
  const user = req.user!;

  try {
    const schedule = await loadOwnSchedule(req.params["id"] as string, user);
    if (!schedule) {
      res.status(404).json({ message: "Schedule not found." });
      return;
    }

    const [orgRow] = await db
      .select()
      .from(orgs)
      .where(eq(orgs.id, schedule.orgId))
      .limit(1);

    if (!orgRow) {
      res.status(400).json({ message: "Organisation not found." });
      return;
    }

    const today = zonedNow(orgRow.timezone).date;

    const [run] = await db
      .insert(dailyCheckinRuns)
      .values({
        orgId: schedule.orgId,
        scheduleId: schedule.id,
        runDate: today,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning();

    if (!run) {
      res.status(409).json({
        message: `A check-in run already exists for today (${today}).`,
      });
      return;
    }

    const outcome = await provisionDailyCheckinRun(run.id);

    const [fresh] = await db
      .select()
      .from(dailyCheckinRuns)
      .where(eq(dailyCheckinRuns.id, run.id))
      .limit(1);

    res.status(200).json({ run: fresh, outcome });
  } catch (err) {
    console.error("[checkins] run-now failed", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/checkins/schedule/:id/runs — history for one of my schedules
// ---------------------------------------------------------------------------

router.get("/schedule/:id/runs", authNonPractitioner, async (req: Request, res: Response) => {
  const user = req.user!;

  try {
    const schedule = await loadOwnSchedule(req.params["id"] as string, user);
    if (!schedule) {
      res.status(404).json({ message: "Schedule not found." });
      return;
    }

    const runs = await listRunsForSchedule(schedule.id);
    res.status(200).json({ runs });
  } catch (err) {
    console.error("[checkins] GET runs failed", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/checkins/runs/:id — detail (owner only), recordings stripped
// ---------------------------------------------------------------------------

router.get("/runs/:id", authNonPractitioner, async (req: Request, res: Response) => {
  const user = req.user!;

  try {
    const [run] = await db
      .select()
      .from(dailyCheckinRuns)
      .where(eq(dailyCheckinRuns.id, req.params["id"] as string))
      .limit(1);

    if (!run) {
      res.status(404).json({ message: "Run not found." });
      return;
    }

    const [schedule] = await db
      .select()
      .from(dailyCheckinSchedules)
      .where(eq(dailyCheckinSchedules.id, run.scheduleId))
      .limit(1);

    if (!schedule || !isOwner(schedule, user)) {
      res.status(404).json({ message: "Run not found." });
      return;
    }

    const rows = await db
      .select({
        id: dailyCheckins.id,
        userId: dailyCheckins.userId,
        status: dailyCheckins.status,
        summary: dailyCheckins.summary,
        transcriptUrl: dailyCheckins.transcriptUrl,
        error: dailyCheckins.error,
        calledAt: dailyCheckins.calledAt,
        completedAt: dailyCheckins.completedAt,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(dailyCheckins)
      .innerJoin(users, eq(users.id, dailyCheckins.userId))
      .where(eq(dailyCheckins.runId, run.id))
      .orderBy(desc(dailyCheckins.status))
      .limit(500);

    res.status(200).json({
      run: {
        id: run.id,
        runDate: run.runDate,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        error: run.error,
      },
      schedule: {
        id: schedule.id,
        title: schedule.title,
        timeLocal: schedule.timeLocal,
        questionScript: schedule.questionScript ?? DEFAULT_SCRIPT,
      },
      checkins: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        status: row.status,
        summary: row.summary,
        transcriptUrl: row.transcriptUrl,
        error: row.error,
        calledAt: row.calledAt,
        completedAt: row.completedAt,
        person: {
          name: row.name,
          email: row.email,
          image: row.image,
        },
      })),
    });
  } catch (err) {
    console.error("[checkins] GET run detail failed", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

export const checkinsRouter = router;