import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../../db/index.js";
import { admins } from "../../db/admins.js";
import { employees } from "../../db/employees.js";
import { invites } from "../../db/invites.js";
import { reportingEdges } from "../../db/reportingEdges.js";
import { teams } from "../../db/teams.js";
import { users } from "../../db/users.js";
import {
  getHrmsStatus,
  saveEmployees,
  upsertCsvProvenance,
  type SaveResult,
} from "./store.js";
import { buildOrgTree, type TreeBuildResult } from "./treeBuilder.js";
import type { CsvPlatform, CsvRowError, NormalizedEmployee } from "./types.js";

export type { NormalizedEmployee, CsvPlatform, CsvRowError } from "./types.js";
export type { SaveResult, HrmsStatus, HrmsConnectionRow } from "./store.js";
export type { TreeBuildResult } from "./treeBuilder.js";
export { getHrmsStatus } from "./store.js";
export { buildOrgTree } from "./treeBuilder.js";
export { deriveRole } from "./treeBuilder.js";

export interface CsvUploadResult {
  summary: SaveResult;
  tree: TreeBuildResult;
  errors: CsvRowError[];
}

/**
 * Persists a client-parsed CSV employee directory and builds the org tree.
 * The client does the parsing (column mapping + platform quirks) so the user
 * gets an instant preview; the server validates shape, stores, and derives
 * teams/roles/edges in one transaction.
 */
export async function processCsvUpload(
  orgId: string,
  platform: CsvPlatform,
  directory: NormalizedEmployee[],
  errors: CsvRowError[],
): Promise<CsvUploadResult> {
  const summary = await saveEmployees(orgId, directory);
  await upsertCsvProvenance(orgId, platform);
  const tree = await buildOrgTree(orgId);
  return { summary, tree, errors: [...errors, ...summary.errors] };
}

// ---------------------------------------------------------------------------
// Org tree read model (for the visualization endpoint)
// ---------------------------------------------------------------------------

export interface OrgTreeData {
  employees: {
    id: string;
    externalHrmsId: string;
    externalManagerId: string | null;
    name: string;
    email: string | null;
    phone: string | null;
    designation: string | null;
    department: string | null;
    region: string | null;
    role: string;
    teamId: string | null;
    hireDate: string | null;
    isSales: boolean;
    status: string;
    /** Linked app user id if this employee has a provisioned account. */
    userId: string | null;
    /** Lifecycle of the provisioned account: invited | active | churned | null. */
    userStatus: string | null;
    hasPendingInvite: boolean;
    isAdmin: boolean;
  }[];
  teams: {
    id: string;
    name: string;
    parentTeamId: string | null;
    hrmsDepartment: string | null;
  }[];
  reportingEdges: {
    managerUserId: string;
    reportUserId: string;
    validTo: Date | null;
  }[];
  userRolesById: Record<string, string>;
  /** Whether the viewer is a currently active org admin. */
  viewerIsAdmin: boolean;
}

export async function getOrgTree(
  orgId: string,
  viewerUserId: string | null,
): Promise<OrgTreeData> {
  const [staff, teamRows, edgeRows, userRows, inviteRows, adminRows] =
    await Promise.all([
      db
        .select()
        .from(employees)
        .where(and(eq(employees.orgId, orgId), eq(employees.status, "active"))),
      db.select().from(teams).where(eq(teams.orgId, orgId)),
      db
        .select()
        .from(reportingEdges)
        .where(and(eq(reportingEdges.orgId, orgId), isNull(reportingEdges.validTo))),
      db
        .select({
          id: users.id,
          externalHrmsId: users.externalHrmsId,
          role: users.role,
          status: users.status,
        })
        .from(users)
        .where(eq(users.orgId, orgId)),
      db
        .select({ id: invites.id, targetUserId: invites.targetUserId })
        .from(invites)
        .where(and(eq(invites.orgId, orgId), eq(invites.status, "pending"))),
      db
        .select({ userId: admins.userId })
        .from(admins)
        .where(and(eq(admins.orgId, orgId), isNull(admins.revokedAt))),
    ]);

  const userByExternalId = new Map(
    userRows
      .filter((u) => u.externalHrmsId)
      .map((u) => [u.externalHrmsId!, u] as const),
  );
  const pendingInviteUserIds = new Set(inviteRows.map((i) => i.targetUserId));
  const adminUserIds = new Set(adminRows.map((a) => a.userId));

  const userRolesById = Object.fromEntries(
    userRows
      .filter((u) => u.externalHrmsId)
      .map((u) => [u.externalHrmsId!, u.role]),
  );

  return {
    employees: staff.map((e) => {
      const user = e.externalHrmsId
        ? (userByExternalId.get(e.externalHrmsId) ?? null)
        : null;
      return {
        id: e.id,
        externalHrmsId: e.externalHrmsId,
        externalManagerId: e.externalManagerId,
        name: e.name,
        email: e.email,
        phone: e.phone,
        designation: e.designation,
        department: e.department,
        region: e.region,
        role: userRolesById[e.externalHrmsId] ?? "practitioner",
        teamId: e.teamId,
        hireDate: e.hireDate ?? null,
        isSales: e.isSales,
        status: e.status,
        userId: user?.id ?? null,
        userStatus: user?.status ?? null,
        hasPendingInvite: user ? pendingInviteUserIds.has(user.id) : false,
        isAdmin: user ? adminUserIds.has(user.id) : false,
      };
    }),
    teams: teamRows.map((t) => ({
      id: t.id,
      name: t.name,
      parentTeamId: t.parentTeamId,
      hrmsDepartment: t.hrmsDepartment,
    })),
    reportingEdges: edgeRows.map((e) => ({
      managerUserId: e.managerUserId,
      reportUserId: e.reportUserId,
      validTo: e.validTo,
    })),
    userRolesById,
    viewerIsAdmin: viewerUserId ? adminUserIds.has(viewerUserId) : false,
  };
}