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
          phone: users.phone,
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

  const viewerRow = viewerUserId
    ? (userRows.find((u) => u.id === viewerUserId) ?? null)
    : null;
  const adminUserIds = new Set(adminRows.map((a) => a.userId));

  const userByExternalId = new Map(
    userRows
      .filter((u) => u.externalHrmsId)
      .map((u) => [u.externalHrmsId!, u] as const),
  );
  const pendingInviteUserIds = new Set(inviteRows.map((i) => i.targetUserId));

  // Admin access is composite: an active org_admins grant OR role=architect.
  const isEffectiveAdmin = (u: { id: string; role: string } | null) =>
    !!u && (u.role === "architect" || adminUserIds.has(u.id));

  // -------------------------------------------------------------------------
  // RBAC visibility scope (§6 of the Technical Specification):
  //  - Architects and active org admins see the whole org.
  //  - Everyone else sees only their own reporting subtree (self + all
  //    descendants via the current reporting edges).
  //  - A viewer that cannot be placed in the org graph (no HRMS record) sees
  //    an empty tree rather than leaking org-wide data.
  // -------------------------------------------------------------------------
  let visibleUserIds: Set<string> | null = null;

  if (
    viewerRow &&
    viewerUserId &&
    !(viewerRow.role === "architect" || adminUserIds.has(viewerUserId))
  ) {
    if (!viewerRow.externalHrmsId) {
      visibleUserIds = new Set();
    } else {
      // BFS down the reporting graph from the viewer.
      const descendants = new Set<string>([viewerUserId]);
      const queue = [viewerUserId];
      while (queue.length > 0) {
        const managerId = queue.pop()!;
        for (const edge of edgeRows) {
          if (edge.managerUserId !== managerId) continue;
          if (descendants.has(edge.reportUserId)) continue;
          descendants.add(edge.reportUserId);
          queue.push(edge.reportUserId);
        }
      }
      visibleUserIds = descendants;
    }
  }

  let staffSlice = staff;
  let teamRowsSlice = teamRows;
  let edgeRowsSlice = edgeRows;
  let userRowsSlice = userRows;

  if (visibleUserIds) {
    const visibleExternalIds = new Set(
      userRowsSlice
        .filter((u) => u.id && visibleUserIds!.has(u.id) && u.externalHrmsId)
        .map((u) => u.externalHrmsId!),
    );

    staffSlice = staff.filter(
      (e) => e.externalHrmsId && visibleExternalIds.has(e.externalHrmsId),
    );

    const visibleTeamIds = new Set(
      staffSlice.map((e) => e.teamId).filter((t): t is string => !!t),
    );
    teamRowsSlice = teamRows.filter((t) => visibleTeamIds.has(t.id));

    edgeRowsSlice = edgeRows.filter(
      (e) =>
        visibleUserIds!.has(e.managerUserId) &&
        visibleUserIds!.has(e.reportUserId),
    );

    userRowsSlice = userRows.filter((u) => {
      if (!u.externalHrmsId) return false;
      return visibleExternalIds.has(u.externalHrmsId);
    });
  }

  const userRolesById = Object.fromEntries(
    userRowsSlice
      .filter((u) => u.externalHrmsId)
      .map((u) => [u.externalHrmsId!, u.role]),
  );

  return {
    employees: staffSlice.map((e) => {
      const user = e.externalHrmsId
        ? (userByExternalId.get(e.externalHrmsId) ?? null)
        : null;
      return {
        id: e.id,
        externalHrmsId: e.externalHrmsId,
        externalManagerId: e.externalManagerId,
        name: e.name,
        email: e.email,
        phone: user?.phone ?? e.phone,
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
        isAdmin: user ? isEffectiveAdmin(user) : false,
      };
    }),
    teams: teamRowsSlice.map((t) => ({
      id: t.id,
      name: t.name,
      parentTeamId: t.parentTeamId,
      hrmsDepartment: t.hrmsDepartment,
    })),
    reportingEdges: edgeRowsSlice.map((e) => ({
      managerUserId: e.managerUserId,
      reportUserId: e.reportUserId,
      validTo: e.validTo,
    })),
    userRolesById,
    viewerIsAdmin: viewerRow ? isEffectiveAdmin(viewerRow) : false,
  };
}