/**
 * Server-side normalization for HRMS CSV fields that cross into strict
 * Postgres columns (date) or noisy source data (phone).
 *
 * These run as a defensive guard at the write path: the client already
 * normalizes, but the API accepts arbitrary strings so the server re-validates.
 * Days-before-months wins on ambiguity — all supported platforms are Indian
 * HRMS exports (Keka / Darwinbox / PeopleHR).
 */

export interface NormalizedField {
  value: string | null;
  reason?: string;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_DATE_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validDayMonth(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  if (day > (DAYS_IN_MONTH[month - 1] ?? 0)) return false;
  if (month === 2 && day === 29) {
    if (year % 4 !== 0 || (year % 100 === 0 && year % 400 !== 0)) return false;
  }
  return true;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Converts a raw CSV date cell into Postgres-compatible `YYYY-MM-DD`.
 * Accepts ISO plus day-first formats; anything else yields null + a reason.
 */
export function normalizeHireDate(raw: string | null): NormalizedField {
  const value = raw?.trim();
  if (!value) return { value: null };
  if (value.length > 12) return { value: null, reason: `hire date "${value}" could not be read` };

  const iso = ISO_DATE_RE.exec(value);
  if (iso) return { value };

  const dmy = DMY_DATE_RE.exec(value);
  if (dmy) {
    const [, dayRaw, monthRaw, yearRaw] = dmy;
    if (!dayRaw || !monthRaw || !yearRaw) {
      return { value: null, reason: `hire date "${value}" could not be read` };
    }
    const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    if (validDayMonth(year, month, day)) {
      return { value: `${year}-${pad2(month)}-${pad2(day)}` };
    }
  }

  return { value: null, reason: `hire date "${value}" could not be read` };
}

const SCIENTIFIC_PHONE_RE = /^[0-9.+]*e[+-]?\d+$/i;

/**
 * Sanitizes a CSV phone cell to `+<digits>`. Spreadsheet-style scientific
 * notation (e.g. `9.199E+11`) means the original digits were already lost in
 * the export — flag it so the admin re-exports phone as text.
 */
export function normalizePhone(raw: string | null): NormalizedField {
  const value = raw?.trim();
  if (!value) return { value: null };

  if (SCIENTIFIC_PHONE_RE.test(value)) {
    return {
      value: null,
      reason: `phone "${value}" looks like a spreadsheet number — re-export as text`,
    };
  }

  const digits = value.replace(/[^\d+]/g, "");
  if (!digits) return { value: null };
  if (digits.indexOf("+") !== digits.lastIndexOf("+")) {
    return { value: null, reason: `phone "${value}" could not be read` };
  }
  if (digits === "+") return { value: null };

  return { value: digits.startsWith("+") ? digits : `+${digits}` };
}