/**
 * Org-timezone date/time helpers built on `Intl` (no new dependency).
 *
 * Orgs store a `timezone` string (IANA name like "Asia/Kolkata", or an offset
 * like "+05:30"). Every daily check-in run is scheduled against this zone:
 *   - `runDate` is the calendar date in the ORG timezone (so idempotency
 *     matches what the scheduler "sees" as today), and
 *   - "due" is when the org-local clock passes the schedule's `timeLocal`.
 */

function zonedParts(zone: string, at: Date): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    timeZoneName: undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);

  const out: Record<string, number> = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    out[part.type] = Number.parseInt(part.value, 10);
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export interface ZoneNow {
  /** "YYYY-MM-DD" calendar date in the zone. */
  date: string;
  hours: number;
  minutes: number;
}

/** Current date + clock in the given org timezone. */
export function zonedNow(zone: string, at: Date = new Date()): ZoneNow {
  const parts = zonedParts(zone, at);
  return {
    date: `${parts["year"] ?? 0}-${pad(parts["month"] ?? 1)}-${pad(
      parts["day"] ?? 1,
    )}`,
    hours: parts["hour"] ?? 0,
    minutes: parts["minute"] ?? 0,
  };
}

/** "HH:mm" of the org-local clock right now. */
export function zonedTimeLabel(zone: string, at: Date = new Date()): string {
  const { hours, minutes } = zonedNow(zone, at);
  return `${pad(hours)}:${pad(minutes)}`;
}

/**
 * Whether the org-local clock has reached `timeLocal` ("HH:mm") by `at`.
 * Used by the daily scheduler to decide if a schedule is due today.
 */
export function isTimeReached(
  zone: string,
  timeLocal: string,
  at: Date = new Date(),
): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeLocal.trim());
  if (!match) return false;
  const target =
    Number.parseInt(match[1] ?? "0", 10) * 60 +
    Number.parseInt(match[2] ?? "0", 10);
  const { hours, minutes } = zonedNow(zone, at);
  return hours * 60 + minutes >= target;
}

/** Validates a "HH:mm" submission (0-23 hours, 0-59 minutes). */
export function isValidTimeLabel(value: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const h = Number.parseInt(match[1] ?? "0", 10);
  const m = Number.parseInt(match[2] ?? "0", 10);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}