import { and, count, eq, inArray } from "drizzle-orm";

import { db } from "../../db/index.js";
import { employees, employeeSourceEnum } from "../../db/employees.js";
import { hrmsConnections } from "../../db/hrmsConnections.js";
import type { HrmsConnectionRow } from "../../db/hrmsConnections.js";
import { normalizeHireDate, normalizePhone } from "./dates.js";
import type { CsvPlatform, CsvRowError, NormalizedEmployee } from "./types.js";

export type { HrmsConnectionRow } from "../../db/hrmsConnections.js";

export interface SaveResult {
  employeesFetched: number;
  inserted: number;
  updated: number;
  terminated: number;
  errors: CsvRowError[];
}

/**
 * Upserts a parsed employee directory into the org's `employees` table and
 * soft-terminates active rows that disappeared from the upload (they keep
 * their external id + history for future re-syncs).
 */
export async function saveEmployees(
  orgId: string,
  directory: NormalizedEmployee[],
): Promise<SaveResult> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: employees.id, externalHrmsId: employees.externalHrmsId, status: employees.status })
      .from(employees)
      .where(eq(employees.orgId, orgId));

    const existingByExternal = new Map(existing.map((row) => [row.externalHrmsId, row]));
    const fetchedIds = new Set(directory.map((e) => e.externalHrmsId));

    let inserted = 0;
    let updated = 0;
    const errors: CsvRowError[] = [];

    if (directory.length > 0) {
      const rows = directory.map((e) => {
        const alreadyExists = existingByExternal.has(e.externalHrmsId);
        if (alreadyExists) updated += 1;
        else inserted += 1;

        const hireDate = normalizeHireDate(e.hireDate);
        const phone = normalizePhone(e.phone);
        for (const field of [hireDate, phone]) {
          if (field.value === null && field.reason) {
            errors.push({ rowNumber: e.rowNumber ?? 0, message: field.reason });
          }
        }

        return {
          orgId,
          externalHrmsId: e.externalHrmsId,
          externalManagerId: e.externalManagerId,
          name: e.name,
          email: e.email,
          phone: phone.value,
          department: e.department,
          designation: e.designation,
          hireDate: hireDate.value,
          status: "active" as const,
          source: "csv" as const,
        };
      });

      await tx
        .insert(employees)
        .values(rows)
        .onConflictDoUpdate({
          target: [employees.orgId, employees.externalHrmsId],
          set: {
            externalManagerId: employees.externalManagerId,
            name: employees.name,
            email: employees.email,
            phone: employees.phone,
            department: employees.department,
            designation: employees.designation,
            hireDate: employees.hireDate,
            status: "active",
            source: "csv",
          },
        });
    }

    const terminatedIds = existing
      .filter((row) => row.status === "active" && !fetchedIds.has(row.externalHrmsId))
      .map((row) => row.id);

    let terminated = 0;
    if (terminatedIds.length > 0) {
      await tx
        .update(employees)
        .set({ status: "terminated", updatedAt: new Date() })
        .where(inArray(employees.id, terminatedIds));
      terminated = terminatedIds.length;
    }

    return {
      employeesFetched: directory.length,
      inserted,
      updated,
      terminated,
      errors,
    };
  });
}

export interface HrmsStatus {
  connected: boolean;
  employeeCount: number;
  platform: CsvPlatform | null;
}

export async function getHrmsStatus(orgId: string): Promise<HrmsStatus> {
  const [row] = await db
    .select({ count: count() })
    .from(employees)
    .where(and(eq(employees.orgId, orgId), eq(employees.status, "active")));

  const employeeCount = row?.count ?? 0;
  const platform = await getCsvProvenance(orgId);
  return { connected: employeeCount > 0, employeeCount, platform };
}

// ---------------------------------------------------------------------------
// CSV upload provenance
// ---------------------------------------------------------------------------

/**
 * Records which CSV platform seeded this org, for audit/provenance.
 * Mirrors the old per-org connection row but carries the platform label.
 */
export async function upsertCsvProvenance(
  orgId: string,
  platform: CsvPlatform,
): Promise<HrmsConnectionRow> {
  const [existing] = await db
    .select()
    .from(hrmsConnections)
    .where(and(eq(hrmsConnections.orgId, orgId), eq(hrmsConnections.provider, "csv")));

  if (existing) {
    const [updated] = await db
      .update(hrmsConnections)
      .set({ credential: platform, status: "active" })
      .where(eq(hrmsConnections.id, existing.id))
      .returning();
    return updated!;
  }

  const [inserted] = await db
    .insert(hrmsConnections)
    .values({ orgId, provider: "csv", credential: platform })
    .returning();
  return inserted!;
}

export async function getCsvProvenance(
  orgId: string,
): Promise<CsvPlatform | null> {
  const [row] = await db
    .select()
    .from(hrmsConnections)
    .where(
      and(
        eq(hrmsConnections.orgId, orgId),
        eq(hrmsConnections.provider, "csv"),
        eq(hrmsConnections.status, "active"),
      ),
    );
  const credential = row?.credential;
  if (credential === "keka" || credential === "darwinbox" || credential === "peoplehr") {
    return credential;
  }
  return null;
}