/**
 * Course schedule worker — the recurring engine for course practice windows
 * and prior WhatsApp reminder notifications.
 *
 * Runs every minute in-process:
 *   1. Scans enabled course schedules in their respective org timezones.
 *   2. Sends advance WhatsApp reminders before the scheduled window begins.
 *   3. Enforces calling window hours so practice calls only run during designated times.
 *   4. Launches outbound calling campaigns on Telenow when the active window opens.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  courseEnrollments,
  courseScheduleNotifications,
  courseScheduleRuns,
  courseSchedules,
  drills,
  orgs,
  users,
} from "../db/schema.js";
import type { CourseScheduleRow, DrillRow, OrgRow } from "../db/schema.js";
import { provisionCourseOnTelenow, snapshotAudience } from "./provisionCourse.js";
import {
  getTelenowClientForOrg,
  normalizeE164Phone,
  TelenowError,
} from "./telenow.js";
import { zonedNow } from "./timezone.js";

const TICK_MS = 60 * 1000;
let ticking = false;

function parseMinutes(timeStr: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) return 0;
  return Number.parseInt(match[1] ?? "0", 10) * 60 + Number.parseInt(match[2] ?? "0", 10);
}

function getZonedDayOfWeek(timezone: string, at: Date): number {
  const dayStr = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(at);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[dayStr] ?? at.getUTCDay();
}

/**
 * Dispatches the prior reminder WhatsApp message to enrolled practitioners.
 */
export async function sendSchedulePriorNotification(
  schedule: CourseScheduleRow,
  course: DrillRow,
  org: OrgRow,
  runId?: string,
): Promise<{ sentCount: number; failedCount: number; errors: string[] }> {
  let targetUserIds: string[] = [];

  if (
    schedule.audienceType === "custom" &&
    Array.isArray(schedule.audienceIds) &&
    schedule.audienceIds.length > 0
  ) {
    targetUserIds = schedule.audienceIds as string[];
  } else {
    // Default: all enrolled practitioners for this course
    const enrollments = await db
      .select({ userId: courseEnrollments.userId })
      .from(courseEnrollments)
      .where(
        and(
          eq(courseEnrollments.courseId, course.id),
          eq(courseEnrollments.orgId, org.id),
        ),
      );
    targetUserIds = enrollments.map((e) => e.userId);

    // If no enrollments exist, try snapshotting from drill_audience
    if (targetUserIds.length === 0) {
      await snapshotAudience(course.id, org.id);
      const refetched = await db
        .select({ userId: courseEnrollments.userId })
        .from(courseEnrollments)
        .where(
          and(
            eq(courseEnrollments.courseId, course.id),
            eq(courseEnrollments.orgId, org.id),
          ),
        );
      targetUserIds = refetched.map((e) => e.userId);
    }
  }

  if (targetUserIds.length === 0) {
    return { sentCount: 0, failedCount: 0, errors: ["No enrolled practitioners found for this course."] };
  }

  const targetUsers = await db
    .select({ id: users.id, name: users.name, phone: users.phone })
    .from(users)
    .where(inArray(users.id, targetUserIds));

  let sentCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  try {
    const { client } = await getTelenowClientForOrg(org.id);

    for (const user of targetUsers) {
      const rawPhone = user.phone?.trim();
      if (!rawPhone) {
        failedCount++;
        await db.insert(courseScheduleNotifications).values({
          orgId: org.id,
          scheduleId: schedule.id,
          runId: runId ?? null,
          userId: user.id,
          phone: "MISSING",
          status: "failed",
          error: "Practitioner has no phone number on file.",
        });
        continue;
      }

      const phone = normalizeE164Phone(rawPhone);
      const userName = user.name?.trim() || "there";
      const customMsg = schedule.customMessage?.trim()
        ? `\n💬 _${schedule.customMessage.trim()}_\n`
        : "";

      const message =
        `*Agility OS Training Reminder* 🔔\n\n` +
        `Hi *${userName}*, your practice session for *${course.title}* is scheduled for today!\n\n` +
        `⏰ *Active Window:* ${schedule.timeWindowStart} – ${schedule.timeWindowEnd} (${schedule.timezone})\n` +
        `${customMsg}` +
        `\nPlease be available to receive your coaching practice call or dial in directly. Good luck!\n\n` +
        `_Agility OS AI Coaching_`;

      try {
        const res = await client.sendWhatsAppMessage({
          to: phone,
          message,
        });

        await db.insert(courseScheduleNotifications).values({
          orgId: org.id,
          scheduleId: schedule.id,
          runId: runId ?? null,
          userId: user.id,
          phone,
          status: "sent",
          wamid: res.wamid ?? null,
          sentAt: new Date(),
        });
        sentCount++;
      } catch (sendErr) {
        const errMsg = (sendErr as Error).message || "WhatsApp delivery failed.";
        console.error(`[schedule-worker] WhatsApp send failed to ${phone}:`, sendErr);
        errors.push(`${userName} (${phone}): ${errMsg}`);
        await db.insert(courseScheduleNotifications).values({
          orgId: org.id,
          scheduleId: schedule.id,
          runId: runId ?? null,
          userId: user.id,
          phone,
          status: "failed",
          error: errMsg,
        });
        failedCount++;
      }
    }
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(`[schedule-worker] Failed to get WhatsApp client for org ${org.id}:`, err);
    errors.push(errMsg);
  }

  return { sentCount, failedCount, errors };
}

/**
 * Executes a live calling run for a course schedule.
 * Launches a bulk outbound calling campaign on Telenow for target practitioners.
 */
export async function executeCourseScheduleRun(
  schedule: CourseScheduleRow,
  course: DrillRow,
  org: OrgRow,
  runDate?: string,
): Promise<{
  runId: string;
  campaignId: string | null;
  targetsCount: number;
  status: string;
  error?: string;
}> {
  const zone = schedule.timezone || org.timezone || "UTC";
  const todayDate = runDate ?? zonedNow(zone).date;

  // 1. Ensure run record in database
  let [run] = await db
    .select()
    .from(courseScheduleRuns)
    .where(
      and(
        eq(courseScheduleRuns.scheduleId, schedule.id),
        eq(courseScheduleRuns.runDate, todayDate),
      ),
    )
    .limit(1);

  if (!run) {
    [run] = await db
      .insert(courseScheduleRuns)
      .values({
        orgId: org.id,
        scheduleId: schedule.id,
        courseId: course.id,
        runDate: todayDate,
        status: "calling",
        startedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [courseScheduleRuns.scheduleId, courseScheduleRuns.runDate],
        set: {
          status: "calling",
          startedAt: new Date(),
        },
      })
      .returning();
  } else {
    [run] = await db
      .update(courseScheduleRuns)
      .set({
        status: "calling",
        startedAt: new Date(),
        error: null,
      })
      .where(eq(courseScheduleRuns.id, run.id))
      .returning();
  }

  const runId = run?.id;
  if (!runId) {
    throw new Error("Failed to initialize course schedule run record in database.");
  }

  try {
    const { client } = await getTelenowClientForOrg(org.id);

    // 2. Ensure agent exists on Telenow
    let agentId = course.telenowAgentId;
    if (!agentId) {
      console.log(
        `[schedule-worker] Course ${course.id} (${course.title}) has no Telenow agent. Auto-provisioning agent...`,
      );
      const provRes = await provisionCourseOnTelenow({ drill: course, org });
      if (!provRes.ok) {
        throw new Error(provRes.error || "Failed to provision agent for course on Telenow.");
      }
      const [refetched] = await db
        .select()
        .from(drills)
        .where(eq(drills.id, course.id))
        .limit(1);
      agentId = refetched?.telenowAgentId ?? null;
      if (!agentId) {
        throw new Error("Agent provisioning did not return a valid agent ID.");
      }
    }

    // 3. Resolve audience targets
    let targetUserIds: string[] = [];
    if (
      schedule.audienceType === "custom" &&
      Array.isArray(schedule.audienceIds) &&
      schedule.audienceIds.length > 0
    ) {
      targetUserIds = schedule.audienceIds as string[];
    } else {
      const enrollments = await db
        .select({ userId: courseEnrollments.userId })
        .from(courseEnrollments)
        .where(
          and(
            eq(courseEnrollments.courseId, course.id),
            eq(courseEnrollments.orgId, org.id),
          ),
        );
      targetUserIds = enrollments.map((e) => e.userId);

      if (targetUserIds.length === 0) {
        await snapshotAudience(course.id, org.id);
        const refetchedEnrollments = await db
          .select({ userId: courseEnrollments.userId })
          .from(courseEnrollments)
          .where(
            and(
              eq(courseEnrollments.courseId, course.id),
              eq(courseEnrollments.orgId, org.id),
            ),
          );
        targetUserIds = refetchedEnrollments.map((e) => e.userId);
      }
    }

    if (targetUserIds.length === 0) {
      console.warn(`[schedule-worker] Schedule ${schedule.id} has no target practitioners.`);
      await db
        .update(courseScheduleRuns)
        .set({
          status: "completed",
          targetsCount: 0,
          endedAt: new Date(),
          error: "No enrolled practitioners found with phone numbers.",
        })
        .where(eq(courseScheduleRuns.id, runId));

      return {
        runId,
        campaignId: null,
        targetsCount: 0,
        status: "completed",
        error: "No enrolled practitioners found.",
      };
    }

    // Ensure all target practitioners have course_enrollments records
    for (const uId of targetUserIds) {
      await db
        .insert(courseEnrollments)
        .values({
          orgId: org.id,
          courseId: course.id,
          userId: uId,
          status: "pending",
        })
        .onConflictDoNothing();
    }

    const targetUsers = await db
      .select({ id: users.id, name: users.name, phone: users.phone })
      .from(users)
      .where(inArray(users.id, targetUserIds));

    const enrollments = await db
      .select({ id: courseEnrollments.id, userId: courseEnrollments.userId })
      .from(courseEnrollments)
      .where(
        and(
          eq(courseEnrollments.courseId, course.id),
          eq(courseEnrollments.orgId, org.id),
          inArray(courseEnrollments.userId, targetUserIds),
        ),
      );

    const enrollmentByUserId = new Map(enrollments.map((e) => [e.userId, e.id]));

    const campaignTargets = targetUsers
      .map((user) => {
        const rawPhone = user.phone?.trim();
        if (!rawPhone) return null;
        const normalizedPhone = normalizeE164Phone(rawPhone);
        const enrollmentId = enrollmentByUserId.get(user.id) || user.id;
        return {
          id: enrollmentId,
          phone: normalizedPhone,
          variables: {
            user_name: user.name?.trim() || "there",
            course_title: course.title,
            enrollment_id: enrollmentId,
            schedule_id: schedule.id,
          },
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    let campaignId: string | null = null;
    if (campaignTargets.length > 0) {
      const campaignPayload: Parameters<typeof client.createCampaign>[0] = {
        name: `Scheduled: ${schedule.title} (${todayDate})`,
        agentId,
        timezone: zone,
        targets: campaignTargets,
        source: `agilityos-schedule-${schedule.id}-${todayDate}`,
      };

      if (schedule.timeWindowStart) campaignPayload.startTimeLocal = schedule.timeWindowStart;
      if (schedule.timeWindowEnd) campaignPayload.endTimeLocal = schedule.timeWindowEnd;
      if (course.phoneNumberId) campaignPayload.fromNumberId = course.phoneNumberId;

      campaignId = await client.createCampaign(campaignPayload);
      console.log(
        `[schedule-worker] Launched Telenow campaign ${campaignId} with ${campaignTargets.length} targets.`,
      );
    }

    // 4. Update run record
    await db
      .update(courseScheduleRuns)
      .set({
        telenowCampaignId: campaignId,
        targetsCount: campaignTargets.length,
        status: "calling",
        error: null,
      })
      .where(eq(courseScheduleRuns.id, runId));

    await db
      .update(courseSchedules)
      .set({
        status: "active",
        lastRunDate: todayDate,
      })
      .where(eq(courseSchedules.id, schedule.id));

    return {
      runId,
      campaignId,
      targetsCount: campaignTargets.length,
      status: "calling",
    };
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.error(`[schedule-worker] Execution failed for schedule ${schedule.id}:`, err);
    await db
      .update(courseScheduleRuns)
      .set({
        status: "failed",
        error: errorMsg,
        endedAt: new Date(),
      })
      .where(eq(courseScheduleRuns.id, runId));

    return {
      runId,
      campaignId: null,
      targetsCount: 0,
      status: "failed",
      error: errorMsg,
    };
  }
}

export async function runDueCourseSchedules(at: Date = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;

  try {
    const activeSchedules = await db
      .select({
        schedule: courseSchedules,
        course: drills,
        org: orgs,
      })
      .from(courseSchedules)
      .innerJoin(drills, eq(drills.id, courseSchedules.courseId))
      .innerJoin(orgs, eq(orgs.id, courseSchedules.orgId))
      .where(
        inArray(courseSchedules.status, ["scheduled", "active"]),
      );

    for (const { schedule, course, org } of activeSchedules) {
      const zone = schedule.timezone || org.timezone || "UTC";
      const { date: todayDate, hours, minutes } = zonedNow(zone, at);
      const currentMinuteOfDay = hours * 60 + minutes;
      const todayDayOfWeek = getZonedDayOfWeek(zone, at);

      // 1. Check if schedule is active today
      let isDayActive = false;
      if (schedule.scheduleType === "one_time") {
        isDayActive = schedule.startDate === todayDate;
      } else {
        const isAfterStart = todayDate >= schedule.startDate;
        const isBeforeEnd = !schedule.endDate || todayDate <= schedule.endDate;
        const days = Array.isArray(schedule.daysOfWeek) ? (schedule.daysOfWeek as number[]) : [];
        isDayActive = isAfterStart && isBeforeEnd && days.includes(todayDayOfWeek);
      }

      if (!isDayActive) continue;

      const windowStartMinute = parseMinutes(schedule.timeWindowStart);
      const windowEndMinute = parseMinutes(schedule.timeWindowEnd);
      const notifyMinutesBefore = schedule.notifyMinutesBefore ?? 30;
      const notifyTargetMinute = Math.max(0, windowStartMinute - notifyMinutesBefore);

      // 2. Prior WhatsApp Reminder Notification Check
      if (schedule.notifyWhatsappPrior) {
        const lastNotifDate = schedule.lastNotificationSentAt
          ? zonedNow(zone, schedule.lastNotificationSentAt).date
          : null;

        const isNotifDueNow =
          currentMinuteOfDay >= notifyTargetMinute &&
          currentMinuteOfDay < windowEndMinute &&
          lastNotifDate !== todayDate;

        if (isNotifDueNow) {
          console.log(
            `[schedule-worker] Sending prior WhatsApp notification for "${schedule.title}" (${course.title}) to learners...`,
          );
          const outcome = await sendSchedulePriorNotification(schedule, course, org);
          await db
            .update(courseSchedules)
            .set({
              lastNotificationSentAt: new Date(),
              status: "active",
            })
            .where(eq(courseSchedules.id, schedule.id));

          console.log(
            `[schedule-worker] Dispatched ${outcome.sentCount} notifications (${outcome.failedCount} failed).`,
          );
        }
      }

      // 3. Active Window Execution Check
      const isInWindow =
        currentMinuteOfDay >= windowStartMinute && currentMinuteOfDay < windowEndMinute;

      const isPastWindow = currentMinuteOfDay >= windowEndMinute;

      if (isInWindow) {
        const [existingRun] = await db
          .select()
          .from(courseScheduleRuns)
          .where(
            and(
              eq(courseScheduleRuns.scheduleId, schedule.id),
              eq(courseScheduleRuns.runDate, todayDate),
            ),
          )
          .limit(1);

        if (!existingRun || existingRun.status === "scheduled") {
          console.log(
            `[schedule-worker] Active calling window opened for "${schedule.title}". Executing run...`,
          );
          await executeCourseScheduleRun(schedule, course, org, todayDate);
        }
      } else if (isPastWindow) {
        // Close today's run if it was in calling state
        const [runningToday] = await db
          .select()
          .from(courseScheduleRuns)
          .where(
            and(
              eq(courseScheduleRuns.scheduleId, schedule.id),
              eq(courseScheduleRuns.runDate, todayDate),
              eq(courseScheduleRuns.status, "calling"),
            ),
          )
          .limit(1);

        if (runningToday) {
          await db
            .update(courseScheduleRuns)
            .set({
              status: "completed",
              endedAt: new Date(),
            })
            .where(eq(courseScheduleRuns.id, runningToday.id));

          if (schedule.scheduleType === "one_time") {
            await db
              .update(courseSchedules)
              .set({ status: "completed" })
              .where(eq(courseSchedules.id, schedule.id));
          }
        }
      }
    }
  } catch (err) {
    console.error("[schedule-worker] tick failed:", err);
  } finally {
    ticking = false;
  }
}

/**
 * Starts the in-process course schedule worker ticker.
 */
export function startCourseScheduleWorker(): void {
  void runDueCourseSchedules();
  const timer = setInterval(() => void runDueCourseSchedules(), TICK_MS);
  timer.unref?.();
  console.log("[schedule-worker] Course schedule & WhatsApp notification worker started.");
}
