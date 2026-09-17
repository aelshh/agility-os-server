import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../db/index.js";
import { employees, type EmployeeRow } from "../../db/employees.js";
import { orgs } from "../../db/orgs.js";
import { reportingEdges } from "../../db/reportingEdges.js";
import { teams, type NewTeam } from "../../db/teams.js";
import { users, type NewUser, type UserRole, type UserRow } from "../../db/users.js";

// ---------------------------------------------------------------------------
// Role derivation (§4.3 of the Signup Flow Spec)
//
// Designation keyword matching is applied first (categories below), falling
// back to the has-direct-reports rule (→ field_coach) and finally
// → practitioner. The category lists are the documented defaults and can be
// overridden per-org via `orgs.config.role_mapping`.
// ---------------------------------------------------------------------------

interface RoleMapping {
  architect: string[];
  strategist: string[];
  quality_gate: string[];
  content_curator: string[];
  talent_steward: string[];
}

const DEFAULT_ROLE_MAPPING: RoleMapping = {
  architect: ["ceo", "coo", "owner", "founder", "managing director", "chief executive officer", "chief operating officer"],
  strategist: ["vp", "cvo", "cro", "vice president", "chief revenue", "head of sales", "sales director", "sales leadership", "chief financial officer", "chief technology officer"],
  quality_gate: ["compliance", "medical affairs", "legal", "regulatory", "quality", "mlr"],
  content_curator: ["l&d", "learning", "enablement", "product education", "training", "curriculum", "ld"],
  talent_steward: ["hr", "people", "talent", "human resource", "chro", "chief human"],
};

function keywordCategory(
  designation: string,
  mapping: RoleMapping,
): UserRole | null {
  const lowered = designation.toLowerCase();
  const order: Exclude<UserRole, "practitioner" | "field_coach">[] = [
    "architect",
    "strategist",
    "quality_gate",
    "content_curator",
    "talent_steward",
  ];
  for (const role of order) {
    if (mapping[role].some((kw) => lowered.includes(kw))) return role;
  }
  return null;
}

export function deriveRole(
  designation: string | null | undefined,
  hasDirectReports: boolean,
  config: unknown,
): UserRole {
  const mapping = mergeRoleMapping(config);

  const designationRole =
    designation?.trim() ? keywordCategory(designation.trim(), mapping) : null;
  if (designationRole) return designationRole;

  if (hasDirectReports) return "field_coach";
  return "practitioner";
}

function mergeRoleMapping(config: unknown): RoleMapping {
  if (
    config &&
    typeof config === "object" &&
    "role_mapping" in config &&
    config.role_mapping &&
    typeof config.role_mapping === "object"
  ) {
    const custom = config.role_mapping as Partial<Record<keyof RoleMapping, unknown>>;
    const merged: RoleMapping = { ...DEFAULT_ROLE_MAPPING };
    (Object.keys(merged) as (keyof RoleMapping)[]).forEach((key) => {
      const value = custom[key];
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        merged[key] = value as string[];
      }
    });
    return merged;
  }
  return DEFAULT_ROLE_MAPPING;
}

// ---------------------------------------------------------------------------
// Tree build
// ---------------------------------------------------------------------------

export interface TreeBuildResult {
  teamsCreated: number;
  teamsLinked: number;
  usersProvisioned: number;
  usersUpdated: number;
  usersFailed: number;
  edgesCreated: number;
  edgesClosed: number;
  managersAssigned: number;
  unresolvedManagerRefs: string[];
}

/**
 * Builds the org tree (teams → employees → users → reporting edges) from the
 * org's active employee records. Associates team via department, derives
 * roles from designation, provisions invited users, and wires the manager
 * graph.
 */
export async function buildOrgTree(orgId: string): Promise<TreeBuildResult> {
  return db.transaction(async (tx) => {
    const result: TreeBuildResult = {
      teamsCreated: 0,
      teamsLinked: 0,
      usersProvisioned: 0,
      usersUpdated: 0,
      usersFailed: 0,
      edgesCreated: 0,
      edgesClosed: 0,
      managersAssigned: 0,
      unresolvedManagerRefs: [],
    };

    const staff = await tx
      .select()
      .from(employees)
      .where(and(eq(employees.orgId, orgId), eq(employees.status, "active")));

    if (staff.length === 0) return result;

    const [org] = await tx.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
    const config = org?.config ?? {};

    // ── 1. Teams from departments ────────────────────────────────────────
    const departments = [...new Set(staff.map((e) => e.department?.trim()).filter(Boolean))] as string[];
    const teamByDepartment = new Map<string, string>();

    const existingTeams = await tx
      .select()
      .from(teams)
      .where(eq(teams.orgId, orgId));
    const teamByHrmsId = new Map(
      existingTeams.map((t) => [t.externalHrmsId ?? t.hrmsDepartment, t]),
    );

    // Determine which departments need new teams, then create them in one write.
    const newTeamRows: NewTeam[] = [];
    for (const dept of departments) {
      const matchKey = dept.toLowerCase().replace(/\s+/g, "-");
      const existing = teamByHrmsId.get(matchKey) ?? teamByHrmsId.get(dept);
      if (existing) {
        teamByDepartment.set(dept, existing.id);
        continue;
      }
      newTeamRows.push({
        orgId,
        name: dept,
        externalHrmsId: matchKey,
        hrmsDepartment: dept,
      });
    }

    if (newTeamRows.length > 0) {
      const created = await tx
        .insert(teams)
        .values(newTeamRows)
        .returning();
      result.teamsCreated = created.length;
      for (const t of created) {
        teamByHrmsId.set(t.externalHrmsId ?? t.hrmsDepartment, t);
        if (t.hrmsDepartment) teamByDepartment.set(t.hrmsDepartment, t.id);
      }
    }

    // ── 2. Link employees to teams (one update per team) ──────────────────
    const staffByTeam = new Map<string, string[]>();
    for (const emp of staff) {
      if (!emp.department) continue;
      const teamId = teamByDepartment.get(emp.department.trim());
      if (teamId && emp.teamId !== teamId) {
        const ids = staffByTeam.get(teamId) ?? [];
        ids.push(emp.id);
        staffByTeam.set(teamId, ids);
      }
    }
    for (const [teamId, ids] of staffByTeam) {
      await tx
        .update(employees)
        .set({ teamId, updatedAt: new Date() })
        .where(inArray(employees.id, ids));
      result.teamsLinked += ids.length;
    }

    // ── 3. Resolve managers (externalManagerId → externalHrmsId) ─────────
    const empByExternalId = new Map(staff.map((e) => [e.externalHrmsId, e]));
    const directReportCount = new Map<string, number>();
    for (const emp of staff) {
      if (!emp.externalManagerId) continue;
      const resolved = empByExternalId.get(emp.externalManagerId);
      if (!resolved) {
        result.unresolvedManagerRefs.push(
          `${emp.name} → ${emp.externalManagerId}`,
        );
        continue;
      }
      directReportCount.set(
        resolved.externalHrmsId,
        (directReportCount.get(resolved.externalHrmsId) ?? 0) + 1,
      );
    }

    // ── 4. Provision users ───────────────────────────────────────────────
    let inserted = 0;
    let updated = 0;
    let failed = 0;
    const userIdByExternalId = new Map<string, string>();

    const existingUsers = await tx.select().from(users);
    const userByExternalId = new Map(
      existingUsers.filter((u) => u.externalHrmsId).map((u) => [u.externalHrmsId!, u]),
    );
    const userByEmail = new Map(
      existingUsers.filter((u) => u.email).map((u) => [u.email!.toLowerCase(), u]),
    );

    // Rows whose only match is by email on a user that lacks an HRMS id can't
    // ride the bulk upsert (it keys on external_hrms_id) — patch those few
    // individually. Everything else flows through a single multi-row upsert.
    const emailMatched: { emp: EmployeeRow; role: UserRole; user: UserRow }[] = [];
    const upsertRows: NewUser[] = [];
    const seen = new Set<string>();

    for (const emp of staff) {
      if (seen.has(emp.externalHrmsId)) continue;
      seen.add(emp.externalHrmsId);

      const existingUser =
        userByExternalId.get(emp.externalHrmsId) ??
        (emp.email ? userByEmail.get(emp.email.toLowerCase()) : undefined);

      const role = deriveRole(
        emp.designation,
        (directReportCount.get(emp.externalHrmsId) ?? 0) > 0,
        config,
      );

      if (existingUser && !existingUser.externalHrmsId) {
        emailMatched.push({ emp, role, user: existingUser });
        continue;
      }

      upsertRows.push({
        orgId,
        externalHrmsId: emp.externalHrmsId,
        role,
        name: emp.name,
        email: emp.email,
        phone: emp.phone,
        region: emp.region,
        teamId: emp.teamId,
        hireDate: emp.hireDate ?? null,
        isSales: emp.isSales,
        source: "csv",
        status: "invited",
      });
    }

    if (upsertRows.length > 0) {
      try {
        const returned = await tx
          .insert(users)
          .values(upsertRows)
          .onConflictDoUpdate({
            target: users.externalHrmsId,
            set: {
              orgId: sql`excluded.${users.orgId}`,
              externalHrmsId: sql`excluded.${users.externalHrmsId}`,
              role: sql`excluded.${users.role}`,
              name: sql`excluded.${users.name}`,
              email: sql`excluded.${users.email}`,
              phone: sql`excluded.${users.phone}`,
              region: sql`excluded.${users.region}`,
              teamId: sql`excluded.${users.teamId}`,
              hireDate: sql`excluded.${users.hireDate}`,
              isSales: sql`excluded.${users.isSales}`,
              source: sql`excluded.${users.source}`,
              status: sql`excluded.${users.status}`,
              updatedAt: new Date(),
            },
          })
          .returning({ id: users.id, externalHrmsId: users.externalHrmsId });

        for (const row of returned) {
          userIdByExternalId.set(row.externalHrmsId!, row.id);
          if (userByExternalId.has(row.externalHrmsId!)) updated += 1;
          else inserted += 1;
        }
      } catch (err) {
        console.error("[tree] bulk user upsert failed", err);
        failed = upsertRows.length;
      }
    }

    for (const { emp, role, user } of emailMatched) {
      try {
        await tx
          .update(users)
          .set({
            orgId,
            externalHrmsId: emp.externalHrmsId,
            role,
            name: emp.name,
            email: emp.email ?? user.email,
            phone: emp.phone ?? user.phone,
            region: emp.region ?? user.region,
            teamId: emp.teamId,
            hireDate: emp.hireDate ?? user.hireDate,
            isSales: emp.isSales,
            source: "csv",
            status: "invited",
          })
          .where(eq(users.id, user.id));
        updated += 1;
        userIdByExternalId.set(emp.externalHrmsId, user.id);
      } catch (err) {
        console.error("[tree] failed to update user", emp.externalHrmsId, err);
        failed += 1;
      }
    }

    result.usersProvisioned = inserted;
    result.usersUpdated = updated;
    result.usersFailed = failed;

    // ── 5. Reporting edges ───────────────────────────────────────────────
    const existingEdges = await tx
      .select()
      .from(reportingEdges)
      .where(eq(reportingEdges.orgId, orgId));

    const reportIdToManager = new Map<string, string>();
    for (const emp of staff) {
      if (!emp.externalManagerId) continue;
      const managerExternalId = empByExternalId.get(emp.externalManagerId);
      const managerUserId = managerExternalId
        ? userIdByExternalId.get(managerExternalId.externalHrmsId)
        : null;
      const reportUserId = userIdByExternalId.get(emp.externalHrmsId);
      if (managerUserId && reportUserId) {
        reportIdToManager.set(reportUserId, managerUserId);
      }
    }

    // Close stale edges in one write.
    const toClose = existingEdges
      .filter((e) => !e.validTo && e.managerUserId !== reportIdToManager.get(e.reportUserId))
      .map((e) => e.id);
    if (toClose.length > 0) {
      await tx
        .update(reportingEdges)
        .set({ validTo: new Date() })
        .where(inArray(reportingEdges.id, toClose));
    }
    result.edgesClosed = toClose.length;

    // Open new edges in one multi-row insert.
    const activeReportIds = new Set(
      existingEdges.filter((e) => !e.validTo).map((e) => e.reportUserId),
    );
    const edgeRows = [...reportIdToManager]
      .filter(([, reportUserId]) => !activeReportIds.has(reportUserId))
      .map(([reportUserId, managerUserId]) => ({
        orgId,
        managerUserId,
        reportUserId,
      }));
    if (edgeRows.length > 0) {
      await tx.insert(reportingEdges).values(edgeRows);
    }
    result.edgesCreated = edgeRows.length;

    // ── 6. Wire users.managerId from the new edges (one bulk update) ─────
    if (reportIdToManager.size > 0) {
      const assignments = [...reportIdToManager].map(
        ([reportUserId, managerUserId]) =>
          sql`(${reportUserId}::uuid, ${managerUserId}::uuid)`,
      );
      await tx.execute(sql`
        update ${users}
        set ${users.managerId} = v.manager_id, ${users.updatedAt} = now()
        from (values ${sql.join(assignments, sql`, `)}) as v(report_id, manager_id)
        where ${users.id} = v.report_id
      `);
      result.managersAssigned = reportIdToManager.size;
    }

    return result;
  });
}