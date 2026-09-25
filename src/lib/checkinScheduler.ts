/**
 * Daily check-in scheduler — the recurring trigger.
 *
 * There is no global cron infra in this codebase, so a lightweight in-process
 * ticker scans enabled schedules every minute and provisions a run for any
 * schedule whose org-local clock has reached `timeLocal` today and whose run
 * ledger has no row for today yet (idempotent).
 *
 * Single-instance friendly: the (schedule_id, run_date) unique constraint plus
 * an in-process run guard in the provisioning lib make duplicate runs
 * impossible even if the tick overlaps or a manual "run now" fires together
 * with the ticker.
 */

import { and, eq } from "drizzle-orm";

import { db } from "../db/index.js";
import {
  dailyCheckinRuns,
  dailyCheckinSchedules,
  orgs,
} from "../db/schema.js";
import { provisionDailyCheckinRun } from "./dailyCheckins.js";
import { isTimeReached, zonedNow } from "./timezone.js";

const TICK_MS = 60 * 1000;

/** Guard against overlapping ticks when a scan is slow. */
let ticking = false;

export async function runDueDailyCheckins(
  at: Date = new Date(),
): Promise<void> {
  if (ticking) return;
  ticking = true;

  try {
    const schedules = await db
      .select({
        schedule: dailyCheckinSchedules,
        timezone: orgs.timezone,
      })
      .from(dailyCheckinSchedules)
      .innerJoin(orgs, eq(orgs.id, dailyCheckinSchedules.orgId))
      .where(eq(dailyCheckinSchedules.enabled, true));

    for (const { schedule, timezone } of schedules) {
      const today = zonedNow(timezone, at).date;

      if (!isTimeReached(timezone, schedule.timeLocal, at)) continue;

      const [existing] = await db
        .select({ id: dailyCheckinRuns.id })
        .from(dailyCheckinRuns)
        .where(
          and(
            eq(dailyCheckinRuns.scheduleId, schedule.id),
            eq(dailyCheckinRuns.runDate, today),
          ),
        )
        .limit(1);

      if (existing) continue;

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

      // Another tick already created it — nothing to do.
      if (!run) continue;

      void provisionDailyCheckinRun(run.id).then((outcome) => {
        if (!outcome.ok) {
          console.error("[checkin-scheduler] run failed", run.id, outcome.error);
        }
      });
    }
  } catch (err) {
    console.error("[checkin-scheduler] tick failed", err);
  } finally {
    ticking = false;
  }
}

/**
 * Starts the in-process ticker. Called once from server bootstrap. The timer
 * is unref'd so it never keeps the process alive by itself.
 */
export function startDailyCheckinScheduler(): void {
  void runDueDailyCheckins();
  const timer = setInterval(() => void runDueDailyCheckins(), TICK_MS);
  timer.unref?.();
}