import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import {
  courseEnrollments,
  courseScheduleNotifications,
  courseScheduleRuns,
  courseSchedules,
  dailyCheckinSchedules,
  drills,
  orgs,
  users,
} from "../db/schema.js";
import { handleDatabaseError } from "../lib/dbErrors.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import {
  executeCourseScheduleRun,
  sendSchedulePriorNotification,
} from "../lib/courseScheduleWorker.js";
import { zonedNow } from "../lib/timezone.js";

const CREATOR_ROLES = ["content_curator", "architect"] as const;

export const courseSchedulesRouter = Router();

const scheduleTypeSchema = z.enum(["one_time", "recurring"]);
const scheduleStatusSchema = z.enum([
  "scheduled",
  "active",
  "paused",
  "completed",
  "cancelled",
]);

const createScheduleSchema = z.object({
  courseId: z.string().uuid("Invalid course id."),
  title: z.string().trim().min(1, "Title is required.").max(255),
  description: z.string().trim().max(2000).optional().nullable(),
  scheduleType: scheduleTypeSchema.default("recurring"),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Start date must be in YYYY-MM-DD format."),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "End date must be in YYYY-MM-DD format.")
    .optional()
    .nullable(),
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1, "At least one day of the week must be selected for recurring schedules.")
    .default([1, 2, 3, 4, 5]),
  timeWindowStart: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time window start must be in HH:mm format.")
    .default("10:00"),
  timeWindowEnd: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time window end must be in HH:mm format.")
    .default("14:00"),
  timezone: z.string().trim().max(50).optional(),
  notifyWhatsappPrior: z.boolean().default(true),
  notifyMinutesBefore: z.number().int().min(0).max(1440).default(30),
  customMessage: z.string().trim().max(1000).optional().nullable(),
  audienceType: z.enum(["course_default", "custom"]).default("course_default"),
  audienceIds: z.array(z.string().uuid()).default([]),
});

const updateScheduleSchema = createScheduleSchema.partial().extend({
  status: scheduleStatusSchema.optional(),
});

function parseMinutes(timeStr: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) return 0;
  return (
    Number.parseInt(match[1] ?? "0", 10) * 60 +
    Number.parseInt(match[2] ?? "0", 10)
  );
}

// ---------------------------------------------------------------------------
// GET / — List schedules
// ---------------------------------------------------------------------------
courseSchedulesRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const user = req.user;
  const orgId = user?.orgId;
  if (!user || !orgId) {
    res.status(user ? 400 : 401).json({
      message: user
        ? "You must belong to an organisation."
        : "Not authenticated",
    });
    return;
  }

  const courseId = req.query["courseId"] as string | undefined;
  const status = req.query["status"] as string | undefined;

  try {
    const conditions = [eq(courseSchedules.orgId, orgId)];
    if (courseId) {
      conditions.push(eq(courseSchedules.courseId, courseId));
    }
    if (status) {
      conditions.push(eq(courseSchedules.status, status as any));
    }

    const rows = await db
      .select({
        schedule: courseSchedules,
        course: {
          id: drills.id,
          title: drills.title,
          description: drills.description,
          status: drills.status,
        },
        creator: {
          id: users.id,
          name: users.name,
          email: users.email,
        },
      })
      .from(courseSchedules)
      .innerJoin(drills, eq(drills.id, courseSchedules.courseId))
      .innerJoin(users, eq(users.id, courseSchedules.createdBy))
      .where(and(...conditions))
      .orderBy(desc(courseSchedules.createdAt));

    // Also count enrolled practitioners for each course
    const courseIds = Array.from(new Set(rows.map((r) => r.schedule.courseId)));
    const enrollmentCounts = new Map<string, number>();

    if (courseIds.length > 0) {
      const counts = await db
        .select({
          courseId: courseEnrollments.courseId,
          count: sql<number>`count(*)::int`,
        })
        .from(courseEnrollments)
        .where(
          and(
            eq(courseEnrollments.orgId, orgId),
            inArray(courseEnrollments.courseId, courseIds),
          ),
        )
        .groupBy(courseEnrollments.courseId);

      for (const c of counts) {
        enrollmentCounts.set(c.courseId, c.count);
      }
    }

    const result = rows.map((r) => ({
      ...r.schedule,
      course: r.course,
      creator: r.creator,
      enrolledCount:
        r.schedule.audienceType === "custom"
          ? (r.schedule.audienceIds as string[]).length
          : enrollmentCounts.get(r.schedule.courseId) ?? 0,
    }));

    res.status(200).json({ schedules: result });
  } catch (err) {
    if (handleDatabaseError(err, res)) return;
    console.error("[courseSchedules] list failed", err);
    res.status(500).json({ message: "Failed to load schedules." });
  }
});

// ---------------------------------------------------------------------------
// GET /calendar/events — Expanded calendar occurrences
// ---------------------------------------------------------------------------
courseSchedulesRouter.get("/calendar/events", requireAuth, async (req: Request, res: Response) => {
  const user = req.user;
  const orgId = user?.orgId;
  if (!user || !orgId) {
    res.status(user ? 400 : 401).json({
      message: user
        ? "You must belong to an organisation."
        : "Not authenticated",
    });
    return;
  }

  const from = (req.query["from"] as string) || "2020-01-01";
  const to = (req.query["to"] as string) || "2030-12-31";
  const courseId = req.query["courseId"] as string | undefined;

  try {
    const conditions = [
      eq(courseSchedules.orgId, orgId),
      inArray(courseSchedules.status, ["scheduled", "active", "paused", "completed"]),
    ];
    if (courseId) {
      conditions.push(eq(courseSchedules.courseId, courseId));
    }

    const rows = await db
      .select({
        schedule: courseSchedules,
        course: {
          id: drills.id,
          title: drills.title,
          status: drills.status,
        },
      })
      .from(courseSchedules)
      .innerJoin(drills, eq(drills.id, courseSchedules.courseId))
      .where(and(...conditions));

    const [org] = await db
      .select()
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);

    const events: Array<{
      id: string;
      scheduleId: string;
      eventType: "course" | "checkin";
      courseId?: string;
      courseTitle?: string;
      title: string;
      description: string | null;
      date: string;
      startTime: string;
      endTime: string;
      timezone: string;
      status: string;
      scheduleType: string;
      notifyWhatsappPrior?: boolean;
      notifyMinutesBefore?: number;
      ownerName?: string;
      ownerId?: string;
      questionScript?: string | null;
      voice?: string;
      voiceProvider?: string;
      phoneNumber?: string | null;
    }> = [];

    // 1. Course Schedules
    for (const { schedule, course } of rows) {
      const zone = schedule.timezone || org?.timezone || "UTC";

      if (schedule.scheduleType === "one_time") {
        if (schedule.startDate >= from && schedule.startDate <= to) {
          events.push({
            id: `course_${schedule.id}_${schedule.startDate}`,
            scheduleId: schedule.id,
            eventType: "course",
            courseId: schedule.courseId,
            courseTitle: course.title,
            title: schedule.title,
            description: schedule.description,
            date: schedule.startDate,
            startTime: schedule.timeWindowStart,
            endTime: schedule.timeWindowEnd,
            timezone: zone,
            status: schedule.status,
            scheduleType: schedule.scheduleType,
            notifyWhatsappPrior: schedule.notifyWhatsappPrior,
            notifyMinutesBefore: schedule.notifyMinutesBefore,
          });
        }
      } else {
        const effectiveStartStr =
          schedule.startDate > from ? schedule.startDate : from;
        const effectiveEndStr =
          schedule.endDate && schedule.endDate < to ? schedule.endDate : to;

        const effectiveStart = new Date(effectiveStartStr + "T00:00:00Z");
        const effectiveEnd = new Date(effectiveEndStr + "T00:00:00Z");

        const days = Array.isArray(schedule.daysOfWeek)
          ? (schedule.daysOfWeek as number[])
          : [1, 2, 3, 4, 5];

        const cur = new Date(effectiveStart);
        while (cur <= effectiveEnd) {
          const dayOfWeek = cur.getUTCDay();
          const dateStr = cur.toISOString().slice(0, 10);

          if (days.includes(dayOfWeek)) {
            events.push({
              id: `course_${schedule.id}_${dateStr}`,
              scheduleId: schedule.id,
              eventType: "course",
              courseId: schedule.courseId,
              courseTitle: course.title,
              title: schedule.title,
              description: schedule.description,
              date: dateStr,
              startTime: schedule.timeWindowStart,
              endTime: schedule.timeWindowEnd,
              timezone: zone,
              status: schedule.status,
              scheduleType: schedule.scheduleType,
              notifyWhatsappPrior: schedule.notifyWhatsappPrior,
              notifyMinutesBefore: schedule.notifyMinutesBefore,
            });
          }

          cur.setUTCDate(cur.getUTCDate() + 1);
        }
      }
    }

    // 2. Daily Check-in Schedules (if not filtering by specific courseId)
    if (!courseId) {
      const checkinSchedules = await db
        .select({
          schedule: dailyCheckinSchedules,
          owner: {
            id: users.id,
            name: users.name,
            email: users.email,
          },
        })
        .from(dailyCheckinSchedules)
        .innerJoin(users, eq(users.id, dailyCheckinSchedules.ownerUserId))
        .where(
          and(
            eq(dailyCheckinSchedules.orgId, orgId),
            eq(dailyCheckinSchedules.enabled, true),
          ),
        );

      for (const { schedule, owner } of checkinSchedules) {
        const zone = org?.timezone || "UTC";
        const effectiveStartStr = from;
        const effectiveEndStr = to;

        const effectiveStart = new Date(effectiveStartStr + "T00:00:00Z");
        const effectiveEnd = new Date(effectiveEndStr + "T00:00:00Z");

        // Calculate a 30-minute window for checkin event display
        const [startHourStr, startMinStr] = (schedule.timeLocal || "08:45").split(":");
        const startMinutes =
          (parseInt(startHourStr || "8", 10) * 60) +
          parseInt(startMinStr || "45", 10);
        const endMinutes = (startMinutes + 30) % (24 * 60);
        const endHour = String(Math.floor(endMinutes / 60)).padStart(2, "0");
        const endMin = String(endMinutes % 60).padStart(2, "0");
        const endTimeLocal = `${endHour}:${endMin}`;

        const checkinDays = [1, 2, 3, 4, 5]; // Weekdays Mon-Fri

        const cur = new Date(effectiveStart);
        while (cur <= effectiveEnd) {
          const dayOfWeek = cur.getUTCDay();
          const dateStr = cur.toISOString().slice(0, 10);

          if (checkinDays.includes(dayOfWeek)) {
            events.push({
              id: `checkin_${schedule.id}_${dateStr}`,
              scheduleId: schedule.id,
              eventType: "checkin",
              courseId: "",
              courseTitle: "Daily Team Check-in",
              title: schedule.title || "Daily Check-in",
              description: `Daily AI voice check-in for team reports of ${owner.name || "Manager"}.`,
              date: dateStr,
              startTime: schedule.timeLocal,
              endTime: endTimeLocal,
              timezone: zone,
              status: schedule.enabled ? "active" : "paused",
              scheduleType: "recurring",
              notifyWhatsappPrior: false,
              notifyMinutesBefore: 0,
              ownerName: owner.name ?? "Manager",
              ownerId: owner.id,
              questionScript: schedule.questionScript,
              voice: schedule.voice,
              voiceProvider: schedule.voiceProvider,
              phoneNumber: schedule.phoneNumber,
            });
          }

          cur.setUTCDate(cur.getUTCDate() + 1);
        }
      }
    }

    res.status(200).json({ events });
  } catch (err) {
    if (handleDatabaseError(err, res)) return;
    console.error("[courseSchedules] get calendar events failed", err);
    res.status(500).json({ message: "Failed to load calendar events." });
  }
});

// ---------------------------------------------------------------------------
// GET /:id — Single schedule detail + runs + notifications
// ---------------------------------------------------------------------------
courseSchedulesRouter.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const user = req.user;
  const orgId = user?.orgId;
  if (!user || !orgId) {
    res.status(user ? 400 : 401).json({
      message: user
        ? "You must belong to an organisation."
        : "Not authenticated",
    });
    return;
  }

  const scheduleId = req.params["id"];
  if (!scheduleId || typeof scheduleId !== "string") {
    res.status(400).json({ message: "Schedule ID is required." });
    return;
  }

  try {
    const [row] = await db
      .select({
        schedule: courseSchedules,
        course: drills,
        creator: {
          id: users.id,
          name: users.name,
          email: users.email,
        },
      })
      .from(courseSchedules)
      .innerJoin(drills, eq(drills.id, courseSchedules.courseId))
      .innerJoin(users, eq(users.id, courseSchedules.createdBy))
      .where(
        and(
          eq(courseSchedules.id, scheduleId),
          eq(courseSchedules.orgId, orgId),
        ),
      )
      .limit(1);

    if (!row) {
      res.status(404).json({ message: "Schedule not found." });
      return;
    }

    const runs = await db
      .select()
      .from(courseScheduleRuns)
      .where(eq(courseScheduleRuns.scheduleId, scheduleId))
      .orderBy(desc(courseScheduleRuns.createdAt))
      .limit(20);

    const notifications = await db
      .select({
        notification: courseScheduleNotifications,
        user: {
          id: users.id,
          name: users.name,
          phone: users.phone,
          email: users.email,
        },
      })
      .from(courseScheduleNotifications)
      .innerJoin(users, eq(users.id, courseScheduleNotifications.userId))
      .where(eq(courseScheduleNotifications.scheduleId, scheduleId))
      .orderBy(desc(courseScheduleNotifications.createdAt))
      .limit(50);

    res.status(200).json({
      schedule: {
        ...row.schedule,
        course: row.course,
        creator: row.creator,
        runs,
        recentNotifications: notifications.map((n) => ({
          ...n.notification,
          user: n.user,
        })),
      },
    });
  } catch (err) {
    if (handleDatabaseError(err, res)) return;
    console.error("[courseSchedules] get schedule detail failed", err);
    res.status(500).json({ message: "Failed to load schedule." });
  }
});

// ---------------------------------------------------------------------------
// POST / — Create schedule
// ---------------------------------------------------------------------------
courseSchedulesRouter.post(
  "/",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  async (req: Request, res: Response) => {
    const user = req.user;
    const orgId = user?.orgId;
    if (!user || !orgId) {
      res.status(user ? 400 : 401).json({
        message: user
          ? "You must belong to an organisation."
          : "Not authenticated",
      });
      return;
    }

    const parsed = createScheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid schedule configuration.",
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const data = parsed.data;

    if (parseMinutes(data.timeWindowEnd) <= parseMinutes(data.timeWindowStart)) {
      res.status(400).json({
        message: "Active window end time must be later than start time.",
      });
      return;
    }

    try {
      const [course] = await db
        .select()
        .from(drills)
        .where(
          and(eq(drills.id, data.courseId), eq(drills.orgId, orgId)),
        )
        .limit(1);

      if (!course) {
        res.status(404).json({ message: "Course not found in your organisation." });
        return;
      }

      const [org] = await db
        .select()
        .from(orgs)
        .where(eq(orgs.id, orgId))
        .limit(1);

      const timezone = data.timezone || org?.timezone || "UTC";

      const [created] = await db
        .insert(courseSchedules)
        .values({
          orgId: orgId,
          courseId: data.courseId,
          title: data.title,
          description: data.description ?? null,
          scheduleType: data.scheduleType,
          startDate: data.startDate,
          endDate: data.endDate ?? null,
          daysOfWeek: data.daysOfWeek,
          timeWindowStart: data.timeWindowStart,
          timeWindowEnd: data.timeWindowEnd,
          timezone,
          notifyWhatsappPrior: data.notifyWhatsappPrior,
          notifyMinutesBefore: data.notifyMinutesBefore,
          customMessage: data.customMessage ?? null,
          status: "scheduled",
          audienceType: data.audienceType,
          audienceIds: data.audienceIds,
          createdBy: user.id,
        })
        .returning();

      res.status(201).json({ schedule: created });
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[courseSchedules] create failed", err);
      res.status(500).json({ message: "Failed to create schedule." });
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /:id — Update schedule
// ---------------------------------------------------------------------------
courseSchedulesRouter.put(
  "/:id",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  async (req: Request, res: Response) => {
    const user = req.user;
    const orgId = user?.orgId;
    if (!user || !orgId) {
      res.status(user ? 400 : 401).json({
        message: user
          ? "You must belong to an organisation."
          : "Not authenticated",
      });
      return;
    }

    const scheduleId = req.params["id"];
    if (!scheduleId || typeof scheduleId !== "string") {
      res.status(400).json({ message: "Schedule ID is required." });
      return;
    }

    const parsed = updateScheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid schedule update payload.",
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const data = parsed.data;

    try {
      const [existing] = await db
        .select()
        .from(courseSchedules)
        .where(
          and(
            eq(courseSchedules.id, scheduleId),
            eq(courseSchedules.orgId, orgId),
          ),
        )
        .limit(1);

      if (!existing) {
        res.status(404).json({ message: "Schedule not found." });
        return;
      }

      const start = data.timeWindowStart ?? existing.timeWindowStart;
      const end = data.timeWindowEnd ?? existing.timeWindowEnd;
      if (parseMinutes(end) <= parseMinutes(start)) {
        res.status(400).json({
          message: "Active window end time must be later than start time.",
        });
        return;
      }

      const [updated] = await db
        .update(courseSchedules)
        .set({
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.scheduleType !== undefined ? { scheduleType: data.scheduleType } : {}),
          ...(data.startDate !== undefined ? { startDate: data.startDate } : {}),
          ...(data.endDate !== undefined ? { endDate: data.endDate } : {}),
          ...(data.daysOfWeek !== undefined ? { daysOfWeek: data.daysOfWeek } : {}),
          ...(data.timeWindowStart !== undefined ? { timeWindowStart: data.timeWindowStart } : {}),
          ...(data.timeWindowEnd !== undefined ? { timeWindowEnd: data.timeWindowEnd } : {}),
          ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
          ...(data.notifyWhatsappPrior !== undefined
            ? { notifyWhatsappPrior: data.notifyWhatsappPrior }
            : {}),
          ...(data.notifyMinutesBefore !== undefined
            ? { notifyMinutesBefore: data.notifyMinutesBefore }
            : {}),
          ...(data.customMessage !== undefined ? { customMessage: data.customMessage } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.audienceType !== undefined ? { audienceType: data.audienceType } : {}),
          ...(data.audienceIds !== undefined ? { audienceIds: data.audienceIds } : {}),
        })
        .where(eq(courseSchedules.id, scheduleId))
        .returning();

      res.status(200).json({ schedule: updated });
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[courseSchedules] update failed", err);
      res.status(500).json({ message: "Failed to update schedule." });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /:id — Delete schedule
// ---------------------------------------------------------------------------
courseSchedulesRouter.delete(
  "/:id",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  async (req: Request, res: Response) => {
    const user = req.user;
    const orgId = user?.orgId;
    if (!user || !orgId) {
      res.status(user ? 400 : 401).json({
        message: user
          ? "You must belong to an organisation."
          : "Not authenticated",
      });
      return;
    }

    const scheduleId = req.params["id"];
    if (!scheduleId || typeof scheduleId !== "string") {
      res.status(400).json({ message: "Schedule ID is required." });
      return;
    }

    try {
      const [existing] = await db
        .select()
        .from(courseSchedules)
        .where(
          and(
            eq(courseSchedules.id, scheduleId),
            eq(courseSchedules.orgId, orgId),
          ),
        )
        .limit(1);

      if (!existing) {
        res.status(404).json({ message: "Schedule not found." });
        return;
      }

      await db.delete(courseSchedules).where(eq(courseSchedules.id, scheduleId));
      res.status(200).json({ success: true, message: "Schedule deleted successfully." });
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[courseSchedules] delete failed", err);
      res.status(500).json({ message: "Failed to delete schedule." });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/notify-now — On-demand WhatsApp broadcast
// ---------------------------------------------------------------------------
courseSchedulesRouter.post(
  "/:id/notify-now",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  async (req: Request, res: Response) => {
    const user = req.user;
    const orgId = user?.orgId;
    if (!user || !orgId) {
      res.status(user ? 400 : 401).json({
        message: user
          ? "You must belong to an organisation."
          : "Not authenticated",
      });
      return;
    }

    const scheduleId = req.params["id"];
    if (!scheduleId || typeof scheduleId !== "string") {
      res.status(400).json({ message: "Schedule ID is required." });
      return;
    }

    try {
      const [row] = await db
        .select({
          schedule: courseSchedules,
          course: drills,
          org: orgs,
        })
        .from(courseSchedules)
        .innerJoin(drills, eq(drills.id, courseSchedules.courseId))
        .innerJoin(orgs, eq(orgs.id, courseSchedules.orgId))
        .where(
          and(
            eq(courseSchedules.id, scheduleId),
            eq(courseSchedules.orgId, orgId),
          ),
        )
        .limit(1);

      if (!row) {
        res.status(404).json({ message: "Schedule not found." });
        return;
      }

      const outcome = await sendSchedulePriorNotification(
        row.schedule,
        row.course,
        row.org,
      );

      await db
        .update(courseSchedules)
        .set({ lastNotificationSentAt: new Date() })
        .where(eq(courseSchedules.id, scheduleId));

      if (outcome.sentCount === 0 && outcome.failedCount > 0) {
        const detail = outcome.errors.length > 0 ? outcome.errors[0] : "Check WhatsApp channel setup in Telenow.";
        res.status(400).json({
          success: false,
          sentCount: 0,
          failedCount: outcome.failedCount,
          message: `Failed to deliver WhatsApp reminders: ${detail}`,
        });
        return;
      }

      res.status(200).json({
        success: true,
        sentCount: outcome.sentCount,
        failedCount: outcome.failedCount,
        message: `Dispatched ${outcome.sentCount} WhatsApp reminder(s).` + (outcome.failedCount > 0 ? ` (${outcome.failedCount} failed)` : ""),
      });
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[courseSchedules] notify-now failed", err);
      res.status(500).json({ message: (err as Error).message || "Failed to broadcast reminder." });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/run-now — On-demand instant execution
// ---------------------------------------------------------------------------
courseSchedulesRouter.post(
  "/:id/run-now",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  async (req: Request, res: Response) => {
    const user = req.user;
    const orgId = user?.orgId;
    if (!user || !orgId) {
      res.status(user ? 400 : 401).json({
        message: user
          ? "You must belong to an organisation."
          : "Not authenticated",
      });
      return;
    }

    const scheduleId = req.params["id"];
    if (!scheduleId || typeof scheduleId !== "string") {
      res.status(400).json({ message: "Schedule ID is required." });
      return;
    }

    try {
      const [row] = await db
        .select({
          schedule: courseSchedules,
          course: drills,
          org: orgs,
        })
        .from(courseSchedules)
        .innerJoin(drills, eq(drills.id, courseSchedules.courseId))
        .innerJoin(orgs, eq(orgs.id, courseSchedules.orgId))
        .where(
          and(
            eq(courseSchedules.id, scheduleId),
            eq(courseSchedules.orgId, orgId),
          ),
        )
        .limit(1);

      if (!row) {
        res.status(404).json({ message: "Schedule not found." });
        return;
      }

      const outcome = await executeCourseScheduleRun(
        row.schedule,
        row.course,
        row.org,
      );

      if (outcome.status === "failed") {
        res.status(400).json({
          success: false,
          run: outcome,
          message: outcome.error || "Failed to launch practice calls.",
        });
        return;
      }

      res.status(200).json({
        success: true,
        run: outcome,
        message: `Practice calling campaign launched with ${outcome.targetsCount} practitioner(s).`,
      });
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[courseSchedules] run-now failed", err);
      res.status(500).json({ message: (err as Error).message || "Failed to trigger run." });
    }
  },
);
