import { Router } from "express";
import { z } from "zod";

import {
  processCsvUpload,
  getOrgTree,
  getHrmsStatus,
} from "../lib/hrms/index.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

const csvPlatformSchema = z.enum(["keka", "darwinbox", "peoplehr"]);

// ---------------------------------------------------------------------------
// GET /status — does this org have employees?
// ---------------------------------------------------------------------------

router.get("/status", requireAuth, async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }
  if (!user.orgId) {
    res.status(200).json({ connected: false, employeeCount: 0, platform: null });
    return;
  }

  const status = await getHrmsStatus(user.orgId);
  res.status(200).json(status);
});

// ---------------------------------------------------------------------------
// POST /upload — persist a parsed CSV directory and build the org tree
// ---------------------------------------------------------------------------

const employeeSchema = z.object({
  externalHrmsId: z.string().min(1, "Employee id is required"),
  externalManagerId: z.string().nullable().optional(),
  name: z.string().min(1, "Name is required"),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  designation: z.string().nullable().optional(),
  hireDate: z.string().nullable().optional(),
  rowNumber: z.number().int().optional(),
});

const rowErrorSchema = z.object({
  rowNumber: z.number(),
  message: z.string(),
});

const uploadSchema = z.object({
  platform: csvPlatformSchema,
  employees: z.array(employeeSchema).max(100_000, "Too many rows"),
  errors: z.array(rowErrorSchema).optional().default([]),
});

router.post("/upload", requireAuth, async (req, res) => {
  const result = uploadSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ errors: result.error.issues });
    return;
  }

  const user = req.user;
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }
  if (!user.orgId) {
    res.status(403).json({ message: "Account is not attached to an organisation" });
    return;
  }

  const { platform, employees, errors } = result.data;

  const normalized = employees.map((e) => ({
    externalHrmsId: e.externalHrmsId,
    externalManagerId: e.externalManagerId ?? null,
    name: e.name,
    email: e.email ?? null,
    phone: e.phone ?? null,
    department: e.department ?? null,
    designation: e.designation ?? null,
    hireDate: e.hireDate ?? null,
    ...(e.rowNumber !== undefined ? { rowNumber: e.rowNumber } : {}),
  }));

  try {
    const outcome = await processCsvUpload(user.orgId, platform, normalized, errors);
    res.status(200).json({
      platform,
      status: "success",
      summary: outcome.summary,
      tree: outcome.tree,
      errors: outcome.errors,
    });
  } catch (err) {
    console.error("[hrms] csv upload failed", err);
    res.status(500).json({ message: "Failed to import employee data" });
  }
});

// ---------------------------------------------------------------------------
// GET /tree — the current org tree for visualization
// ---------------------------------------------------------------------------

router.get("/tree", requireAuth, async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }
  if (!user.orgId) {
    res.status(200).json({ employees: [], teams: [], reportingEdges: [], userRolesById: {} });
    return;
  }

  const tree = await getOrgTree(user.orgId);
  res.status(200).json(tree);
});

export const hrmsRouter = router;