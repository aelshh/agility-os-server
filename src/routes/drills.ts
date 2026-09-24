/**
 * Course (drill) content routes — spec §5.3 (Content Curator APIs), MVP subset.
 *
 * GET  /api/drills              — list courses for the caller's org
 * GET  /api/drills/:id          — fetch a single course
 * POST /api/drills              — create a course (status: draft)
 * PUT  /api/drills/:id          — edit a draft / rejected course
 * POST /api/drills/:id/submit   — draft|rejected -> pending_review
 * POST /api/drills/:id/approve  — pending_review -> published (architect) + auto-generate coach persona
 * POST /api/drills/:id/reject   — pending_review -> rejected (architect)
 * POST /api/drills/:id/documents        — upload a knowledge-dump file
 * DELETE /api/drills/:id/documents/:docId — delete a knowledge-dump file
 * POST /api/drills/:id/generate-faqs    — draft practice questions from the knowledge dump
 * POST /api/drills/:id/generate-persona — (re)generate + persist the coach persona
 *
 * Create/edit/submit: requireAuth + requireRole(content_curator, architect).
 * Approve/reject:     requireAuth + requireRole(architect).
 * Every query is scoped to the caller's org (multi-tenant).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { and, asc, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { z } from "zod";

import { db } from "../db/index.js";
import {
  courseDocuments,
  drills,
  orgs,
  users,
} from "../db/schema.js";
import type { CourseDocumentRow, DrillRow } from "../db/schema.js";
import { generateCoachPersona, generateFaqSuggestions } from "../lib/ai/prompts.js";
import { aiEnabled } from "../lib/ai/client.js";
import { handleDatabaseError } from "../lib/dbErrors.js";
import { extractText } from "../lib/docs/extractText.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UPLOADS_ROOT = path.join(SERVER_ROOT, "uploads");

const router = Router();

const CREATOR_ROLES = ["content_curator", "architect"] as const;

const STATUSES = [
  "draft",
  "pending_review",
  "published",
  "rejected",
] as const;

/** Caps course create/update/submit volume per IP. */
const drillWriteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many requests. Please try again in a few minutes.",
  },
});

/** Knowledge-dump uploads are parsed in-memory, extracted to text, then written to disk. */
const DOC_UPLOAD_LIMIT = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOC_UPLOAD_LIMIT, files: 1 },
});

// Aliased user joins (a drill can be authored and reviewed by different users).
const creators = alias(users, "creators");
const reviewers = alias(users, "reviewers");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const faqSchema = z
  .array(z.string().trim().min(1).max(1000))
  .max(100, "Too many practice questions.")
  .default([]);

const createDrillSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(255),
  description: z.string().trim().max(2000).default(""),
  // Persona is no longer authored in the UI. Accepted for backward
  // compatibility; it is normally generated server-side (see lib/ai).
  personaName: z.string().trim().max(100).optional().default(""),
  personaPrompt: z.string().trim().max(10000).optional().default(""),
  knowledgeText: z.string().trim().max(60000).default(""),
  faqs: faqSchema,
  scoringRubric: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        weight: z.number().min(0).max(100),
        description: z.string().trim().max(1000).optional(),
      }),
    )
    .default([])
    .superRefine((rubric, ctx) => {
      if (rubric.length === 0) return;
      const total = rubric.reduce((sum, c) => sum + c.weight, 0);
      if (total !== 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Rubric weights must add up to 100.",
        });
      }
    }),
  maxDurationSec: z.number().int().min(10).max(3600).default(120),
  isMandatory: z.boolean().default(false),
  regionScope: z.array(z.string().trim().min(1)).default([]),
  roleScope: z.array(z.string().trim().min(1)).default([]),
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional()
    .default(null),
});

const updateDrillSchema = createDrillSchema.partial();

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

type PublicDrill = {
  id: string;
  orgId: string;
  title: string;
  description: string;
  knowledgeText: string;
  faqs: unknown;
  personaName: string | null;
  personaPrompt: string | null;
  personaGeneratedAt: Date | null;
  scoringRubric: unknown;
  maxDurationSec: number;
  isMandatory: boolean;
  regionScope: string[];
  roleScope: string[];
  expiresAt: Date | null;
  status: (typeof STATUSES)[number];
  createdBy: string;
  createdByName: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewComment: string | null;
  reviewedAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type PublicDocument = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
};

type PublicCourse = PublicDrill & { docs: PublicDocument[] };

type DrillWithNames = DrillRow & {
  createdByName: string | null;
  reviewedByName: string | null;
};

const drillBaseColumns = {
  id: drills.id,
  orgId: drills.orgId,
  title: drills.title,
  description: drills.description,
  knowledgeText: drills.knowledgeText,
  faqs: drills.faqs,
  personaName: drills.personaName,
  personaPrompt: drills.personaPrompt,
  personaGeneratedAt: drills.personaGeneratedAt,
  scoringRubric: drills.scoringRubric,
  maxDurationSec: drills.maxDurationSec,
  isMandatory: drills.isMandatory,
  regionScope: drills.regionScope,
  roleScope: drills.roleScope,
  expiresAt: drills.expiresAt,
  status: drills.status,
  createdBy: drills.createdBy,
  reviewedBy: drills.reviewedBy,
  reviewComment: drills.reviewComment,
  reviewedAt: drills.reviewedAt,
  publishedAt: drills.publishedAt,
  createdAt: drills.createdAt,
  updatedAt: drills.updatedAt,
};

function toPublicDrill(drill: DrillWithNames): PublicDrill {
  return {
    id: drill.id,
    orgId: drill.orgId,
    title: drill.title,
    description: drill.description,
    knowledgeText: drill.knowledgeText,
    faqs: drill.faqs,
    personaName: drill.personaName,
    personaPrompt: drill.personaPrompt,
    personaGeneratedAt: drill.personaGeneratedAt,
    scoringRubric: drill.scoringRubric,
    maxDurationSec: drill.maxDurationSec,
    isMandatory: drill.isMandatory,
    regionScope: drill.regionScope,
    roleScope: drill.roleScope,
    expiresAt: drill.expiresAt,
    status: drill.status,
    createdBy: drill.createdBy,
    createdByName: drill.createdByName,
    reviewedBy: drill.reviewedBy,
    reviewedByName: drill.reviewedByName,
    reviewComment: drill.reviewComment,
    reviewedAt: drill.reviewedAt,
    publishedAt: drill.publishedAt,
    createdAt: drill.createdAt,
    updatedAt: drill.updatedAt,
  };
}

function toPublicDocument(doc: Pick<CourseDocumentRow, "id" | "originalName" | "mimeType" | "sizeBytes" | "createdAt">): PublicDocument {
  return {
    id: doc.id,
    originalName: doc.originalName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    createdAt: doc.createdAt,
  };
}

async function loadDocumentsByCourse(
  courseIds: string[],
): Promise<Map<string, PublicDocument[]>> {
  if (courseIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: courseDocuments.id,
      courseId: courseDocuments.courseId,
      originalName: courseDocuments.originalName,
      mimeType: courseDocuments.mimeType,
      sizeBytes: courseDocuments.sizeBytes,
      createdAt: courseDocuments.createdAt,
    })
    .from(courseDocuments)
    .where(inArray(courseDocuments.courseId, courseIds))
    .orderBy(asc(courseDocuments.createdAt));

  const byCourse = new Map<string, PublicDocument[]>();
  for (const row of rows) {
    const list = byCourse.get(row.courseId) ?? [];
    list.push(toPublicDocument(row));
    byCourse.set(row.courseId, list);
  }
  return byCourse;
}

function toPublicCourse(
  drill: PublicDrill,
  docs: PublicDocument[],
): PublicCourse {
  return { ...drill, docs };
}

/**
 * Generates and persists the coach persona for a course — runs once at
 * publish (or on demand via POST /:id/generate-persona) and is reused for
 * every later call. No-ops when AI is disabled, the persona already exists
 * (unless forced), or the course has no knowledge content yet.
 */
async function generateAndPersistPersona(
  drill: DrillRow,
  orgId: string,
  force = false,
): Promise<DrillRow> {
  try {
    if (!aiEnabled) return drill;
    if (!force && drill.personaGeneratedAt) return drill;

    const docs = await db
      .select()
      .from(courseDocuments)
      .where(eq(courseDocuments.courseId, drill.id));

    const hasKnowledge =
      drill.knowledgeText.trim().length > 0 ||
      docs.some((doc) => (doc.textContent ?? "").trim().length > 0);
    if (!hasKnowledge) return drill;

    const [org] = await db
      .select()
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    if (!org) return drill;

    const persona = await generateCoachPersona({ course: drill, org, docs });
    if (!persona) return drill;

    const [updated] = await db
      .update(drills)
      .set({
        personaName: persona.name,
        personaPrompt: persona.prompt,
        personaGeneratedAt: new Date(),
      })
      .where(eq(drills.id, drill.id))
      .returning();

    return updated ?? drill;
  } catch (err) {
    console.error("[drills] persona generation skipped", err);
    return drill;
  }
}

// ---------------------------------------------------------------------------
// GET / — list courses for the caller's org
// ---------------------------------------------------------------------------

router.get(
  "/",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  async (req, res) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    if (!user.orgId) {
      res.status(400).json({
        message: "You must belong to an organisation to view courses.",
      });
      return;
    }

    const statusFilter = req.query["status"];
    const status =
      typeof statusFilter === "string" &&
      (STATUSES as readonly string[]).includes(statusFilter)
        ? (statusFilter as (typeof STATUSES)[number])
        : undefined;

    try {
      const conditions = [eq(drills.orgId, user.orgId)];
      if (status) conditions.push(eq(drills.status, status));

      // Creators see their own drafts/rejected; everyone in the org sees the
      // content that has left the creator's desk (pending review + published).
      // Architects see everything in the org.
      if (user.role !== "architect") {
        conditions.push(
          or(
            inArray(drills.status, ["pending_review", "published"]),
            eq(drills.createdBy, user.id),
          )!,
        );
      }

      const rows = await db
        .select({ ...drillBaseColumns, createdByName: creators.name, reviewedByName: reviewers.name })
        .from(drills)
        .leftJoin(creators, eq(drills.createdBy, creators.id))
        .leftJoin(reviewers, eq(drills.reviewedBy, reviewers.id))
        .where(and(...conditions))
        .orderBy(asc(drills.createdAt));

      const ids = rows.map((r) => r.id);
      const docs = await loadDocumentsByCourse(ids);

      res.status(200).json({
        courses: rows.map((row) =>
          toPublicCourse(toPublicDrill(row), docs.get(row.id) ?? []),
        ),
      });
    } catch (err) {
      console.error("[drills] list failed", err);
      res.status(500).json({ message: "Failed to load courses." });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /:id — fetch a single course (org-scoped)
// ---------------------------------------------------------------------------

router.get(
  "/:id",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res
        .status(user ? 400 : 401)
        .json({
          message: user
            ? "You must belong to an organisation."
            : "Not authenticated",
        });
      return;
    }

    const drillId = req.params["id"];
    if (!drillId || typeof drillId !== "string") {
      res.status(400).json({ message: "A valid course id is required" });
      return;
    }

    try {
      const [row] = await db
        .select({ ...drillBaseColumns, createdByName: creators.name, reviewedByName: reviewers.name })
        .from(drills)
        .leftJoin(creators, eq(drills.createdBy, creators.id))
        .leftJoin(reviewers, eq(drills.reviewedBy, reviewers.id))
        .where(and(eq(drills.id, drillId), eq(drills.orgId, user.orgId)))
        .limit(1);

      if (!row) {
        res.status(404).json({ message: "Course not found." });
        return;
      }

      const docs = await loadDocumentsByCourse([row.id]);

      res.status(200).json({ course: toPublicCourse(toPublicDrill(row), docs.get(row.id) ?? []) });
    } catch (err) {
      console.error("[drills] get failed", err);
      res.status(500).json({ message: "Failed to load course." });
    }
  },
);

// ---------------------------------------------------------------------------
// POST / — create a course (starts in draft)
// ---------------------------------------------------------------------------

router.post(
  "/",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  drillWriteLimiter,
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res
        .status(user ? 400 : 401)
        .json({
          message: user
            ? "You must belong to an organisation to create a course."
            : "Not authenticated",
        });
      return;
    }

    const parsed = createDrillSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
      return;
    }

    const data = parsed.data;

    try {
      const [row] = await db
        .insert(drills)
        .values({
          orgId: user.orgId,
          title: data.title,
          description: data.description,
          personaName: data.personaName || null,
          personaPrompt: data.personaPrompt || null,
          knowledgeText: data.knowledgeText,
          faqs: data.faqs,
          scoringRubric: data.scoringRubric,
          maxDurationSec: data.maxDurationSec,
          isMandatory: data.isMandatory,
          regionScope: data.regionScope,
          roleScope: data.roleScope,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
          status: "draft",
          createdBy: user.id,
        })
        .returning();

      if (!row) {
        res.status(500).json({ message: "Failed to create course." });
        return;
      }

      res.status(201).json({
        course: toPublicCourse(
          toPublicDrill({
            ...row,
            createdByName: user.name,
            reviewedByName: null,
          } as DrillWithNames),
          [],
        ),
      });
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[drills] create failed", err);
      res.status(500).json({ message: "Failed to create course." });
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /:id — edit a draft or rejected course
// ---------------------------------------------------------------------------

router.put(
  "/:id",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  drillWriteLimiter,
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res
        .status(user ? 400 : 401)
        .json({
          message: user
            ? "You must belong to an organisation to edit a course."
            : "Not authenticated",
        });
      return;
    }

    const drillId = req.params["id"];
    if (!drillId || typeof drillId !== "string") {
      res.status(400).json({ message: "A valid course id is required" });
      return;
    }

    const parsed = updateDrillSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
      return;
    }

    const data = parsed.data;

    try {
      const [existing] = await db
        .select()
        .from(drills)
        .where(and(eq(drills.id, drillId), eq(drills.orgId, user.orgId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ message: "Course not found." });
        return;
      }

      if (existing.status !== "draft" && existing.status !== "rejected") {
        res.status(403).json({
          message:
            "Only draft or rejected courses can be edited. Published courses are locked.",
        });
        return;
      }

      if (existing.createdBy !== user.id && user.role !== "architect") {
        res.status(403).json({ message: "You can only edit your own courses." });
        return;
      }

      const patch: Partial<typeof drills.$inferInsert> = {};
      if (data.title !== undefined) patch.title = data.title;
      if (data.description !== undefined) patch.description = data.description;
      if (data.personaName !== undefined)
        patch.personaName = data.personaName || null;
      if (data.personaPrompt !== undefined)
        patch.personaPrompt = data.personaPrompt || null;
      if (data.knowledgeText !== undefined)
        patch.knowledgeText = data.knowledgeText;
      if (data.faqs !== undefined) patch.faqs = data.faqs;
      if (data.scoringRubric !== undefined)
        patch.scoringRubric = data.scoringRubric;
      if (data.maxDurationSec !== undefined)
        patch.maxDurationSec = data.maxDurationSec;
      if (data.isMandatory !== undefined) patch.isMandatory = data.isMandatory;
      if (data.regionScope !== undefined) patch.regionScope = data.regionScope;
      if (data.roleScope !== undefined) patch.roleScope = data.roleScope;
      if (data.expiresAt !== undefined)
        patch.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;

      if (Object.keys(patch).length === 0) {
        res.status(400).json({ message: "Nothing to update." });
        return;
      }

      const [updated] = await db
        .update(drills)
        .set(patch)
        .where(eq(drills.id, drillId))
        .returning();

      if (!updated) {
        res.status(500).json({ message: "Failed to update course." });
        return;
      }

      const docs = await loadDocumentsByCourse([updated.id]);

      res.status(200).json({
        course: toPublicCourse(
          toPublicDrill({
            ...updated,
            createdByName: null,
            reviewedByName: null,
          } as DrillWithNames),
          docs.get(updated.id) ?? [],
        ),
      });
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[drills] update failed", err);
      res.status(500).json({ message: "Failed to update course." });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/submit — send a draft/rejected course into the review gate
// ---------------------------------------------------------------------------

router.post(
  "/:id/submit",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  drillWriteLimiter,
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res
        .status(user ? 400 : 401)
        .json({
          message: user
            ? "You must belong to an organisation to submit a course."
            : "Not authenticated",
        });
      return;
    }

    const drillId = req.params["id"];
    if (!drillId || typeof drillId !== "string") {
      res.status(400).json({ message: "A valid course id is required" });
      return;
    }

    try {
      const [existing] = await db
        .select()
        .from(drills)
        .where(and(eq(drills.id, drillId), eq(drills.orgId, user.orgId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ message: "Course not found." });
        return;
      }

      if (existing.status !== "draft" && existing.status !== "rejected") {
        res.status(409).json({
          message:
            "Only drafts and previously rejected courses can be submitted for review.",
        });
        return;
      }

      if (existing.createdBy !== user.id && user.role !== "architect") {
        res.status(403).json({ message: "You can only submit your own courses." });
        return;
      }

      const [updated] = await db
        .update(drills)
        .set({ status: "pending_review" })
        .where(eq(drills.id, drillId))
        .returning();

      if (!updated) {
        res.status(500).json({ message: "Failed to submit course for review." });
        return;
      }

      const docs = await loadDocumentsByCourse([updated.id]);

      res.status(200).json({
        course: toPublicCourse(
          toPublicDrill({
            ...updated,
            createdByName: null,
            reviewedByName: null,
          } as DrillWithNames),
          docs.get(updated.id) ?? [],
        ),
      });
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[drills] submit failed", err);
      res.status(500).json({ message: "Failed to submit course for review." });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/approve — architect gate: pending_review -> published
// ---------------------------------------------------------------------------

router.post(
  "/:id/approve",
  requireAuth,
  requireRole("architect"),
  drillWriteLimiter,
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res
        .status(user ? 400 : 401)
        .json({
          message: user
            ? "You must belong to an organisation to approve a course."
            : "Not authenticated",
        });
      return;
    }

    const drillId = req.params["id"];
    if (!drillId || typeof drillId !== "string") {
      res.status(400).json({ message: "A valid course id is required" });
      return;
    }

    try {
      const [existing] = await db
        .select()
        .from(drills)
        .where(and(eq(drills.id, drillId), eq(drills.orgId, user.orgId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ message: "Course not found." });
        return;
      }

      if (existing.status !== "pending_review") {
        res.status(409).json({
          message: "Only courses pending review can be approved.",
        });
        return;
      }

      const [updated] = await db
        .update(drills)
        .set({
          status: "published",
          reviewedBy: user.id,
          reviewComment: null,
          reviewedAt: new Date(),
          publishedAt: new Date(),
        })
        .where(eq(drills.id, drillId))
        .returning();

      if (!updated) {
        res.status(500).json({ message: "Failed to approve course." });
        return;
      }

      // Coach persona: generated once, stored, and reused at call time.
      const withPersona = await generateAndPersistPersona(updated, user.orgId);
      const docs = await loadDocumentsByCourse([withPersona.id]);

      res.status(200).json({
        course: toPublicCourse(
          toPublicDrill({
            ...withPersona,
            createdByName: null,
            reviewedByName: user.name,
          } as DrillWithNames),
          docs.get(withPersona.id) ?? [],
        ),
      });
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[drills] approve failed", err);
      res.status(500).json({ message: "Failed to approve course." });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/reject — architect gate: pending_review -> rejected (back to editor)
// ---------------------------------------------------------------------------

const rejectSchema = z.object({
  comment: z
    .string()
    .trim()
    .min(1, "A comment explaining the rejection is required.")
    .max(2000),
});

router.post(
  "/:id/reject",
  requireAuth,
  requireRole("architect"),
  drillWriteLimiter,
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res
        .status(user ? 400 : 401)
        .json({
          message: user
            ? "You must belong to an organisation to reject a course."
            : "Not authenticated",
        });
      return;
    }

    const drillId = req.params["id"];
    if (!drillId || typeof drillId !== "string") {
      res.status(400).json({ message: "A valid course id is required" });
      return;
    }

    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const [existing] = await db
        .select()
        .from(drills)
        .where(and(eq(drills.id, drillId), eq(drills.orgId, user.orgId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ message: "Course not found." });
        return;
      }

      if (existing.status !== "pending_review") {
        res.status(409).json({
          message: "Only courses pending review can be rejected.",
        });
        return;
      }

      const [updated] = await db
        .update(drills)
        .set({
          status: "rejected",
          reviewedBy: user.id,
          reviewComment: parsed.data.comment,
          reviewedAt: new Date(),
        })
        .where(eq(drills.id, drillId))
        .returning();

      if (!updated) {
        res.status(500).json({ message: "Failed to reject course." });
        return;
      }

      const docs = await loadDocumentsByCourse([updated.id]);

      res.status(200).json({
        course: toPublicCourse(
          toPublicDrill({
            ...updated,
            createdByName: null,
            reviewedByName: user.name,
          } as DrillWithNames),
          docs.get(updated.id) ?? [],
        ),
      });
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[drills] reject failed", err);
      res.status(500).json({ message: "Failed to reject course." });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/documents — upload a knowledge-dump file (multipart: "file")
// ---------------------------------------------------------------------------

router.post(
  "/:id/documents",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  drillWriteLimiter,
  upload.single("file"),
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res
        .status(user ? 400 : 401)
        .json({
          message: user
            ? "You must belong to an organisation to upload course files."
            : "Not authenticated",
        });
      return;
    }

    const drillId = req.params["id"];
    if (!drillId || typeof drillId !== "string") {
      res.status(400).json({ message: "A valid course id is required" });
      return;
    }

    const file = req.file;
    if (!file) {
      res
        .status(400)
        .json({ message: "A file is required (field name: \"file\")." });
      return;
    }

    try {
      const [existing] = await db
        .select()
        .from(drills)
        .where(and(eq(drills.id, drillId), eq(drills.orgId, user.orgId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ message: "Course not found." });
        return;
      }

      const textContent = await extractText(file.originalname, file.mimetype, file.buffer);

      const storedName = `${randomUUID()}${path.extname(file.originalname)}`;
      const dir = path.join(UPLOADS_ROOT, user.orgId, drillId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, storedName), file.buffer);

      const [doc] = await db
        .insert(courseDocuments)
        .values({
          courseId: drillId,
          originalName: file.originalname.slice(0, 255),
          storedName,
          mimeType: file.mimetype.slice(0, 100) || "application/octet-stream",
          sizeBytes: file.size,
          textContent: textContent ?? null,
          uploadedBy: user.id,
        })
        .returning();

      if (!doc) {
        res.status(500).json({ message: "Failed to save the uploaded file." });
        return;
      }

      res.status(201).json({ document: toPublicDocument(doc) });
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[drills] document upload failed", err);
      res.status(500).json({ message: "Failed to upload the file." });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /:id/documents/:docId — remove a knowledge-dump file
// ---------------------------------------------------------------------------

router.delete(
  "/:id/documents/:docId",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  drillWriteLimiter,
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res
        .status(user ? 400 : 401)
        .json({
          message: user
            ? "You must belong to an organisation to remove course files."
            : "Not authenticated",
        });
      return;
    }

    const drillId = req.params["id"];
    const docId = req.params["docId"];
    if (!drillId || !docId || typeof drillId !== "string" || typeof docId !== "string") {
      res.status(400).json({ message: "Valid course and document ids are required" });
      return;
    }

    try {
      const [row] = await db
        .select({ doc: courseDocuments, courseOrgId: drills.orgId })
        .from(courseDocuments)
        .innerJoin(drills, eq(courseDocuments.courseId, drills.id))
        .where(
          and(
            eq(courseDocuments.id, docId),
            eq(courseDocuments.courseId, drillId),
          ),
        )
        .limit(1);

      if (!row || row.courseOrgId !== user.orgId) {
        res.status(404).json({ message: "Document not found." });
        return;
      }

      const storedPath = path.join(
        UPLOADS_ROOT,
        user.orgId,
        drillId,
        row.doc.storedName,
      );
      rmSync(storedPath, { force: true });

      await db.delete(courseDocuments).where(eq(courseDocuments.id, docId));
      res.status(204).end();
    } catch (err) {
      if (handleDatabaseError(err, res)) return;
      console.error("[drills] document delete failed", err);
      res.status(500).json({ message: "Failed to remove the file." });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/generate-faqs — draft practice questions from the knowledge dump
// (AI-generated suggestions only; saving persists them via PUT /:id)
// ---------------------------------------------------------------------------

router.post(
  "/:id/generate-faqs",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  drillWriteLimiter,
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res
        .status(user ? 400 : 401)
        .json({
          message: user
            ? "You must belong to an organisation to generate questions."
            : "Not authenticated",
        });
      return;
    }

    const drillId = req.params["id"];
    if (!drillId || typeof drillId !== "string") {
      res.status(400).json({ message: "A valid course id is required" });
      return;
    }

    try {
      const [existing] = await db
        .select()
        .from(drills)
        .where(and(eq(drills.id, drillId), eq(drills.orgId, user.orgId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ message: "Course not found." });
        return;
      }

      if (!aiEnabled) {
        res.status(200).json({
          faqs: [],
          message: "AI question generation is not configured for this workspace.",
        });
        return;
      }

      const docs = await db
        .select()
        .from(courseDocuments)
        .where(eq(courseDocuments.courseId, drillId));

      const [org] = await db
        .select()
        .from(orgs)
        .where(eq(orgs.id, user.orgId))
        .limit(1);
      if (!org) {
        res.status(500).json({ message: "Organisation not found." });
        return;
      }

      const faqs = await generateFaqSuggestions({ course: existing, org, docs });
      if (faqs.length === 0) {
        res.status(200).json({
          faqs: [],
          message:
            "Add some knowledge first (paste notes or upload documents) so questions can be generated.",
        });
        return;
      }

      res.status(200).json({ faqs });
    } catch (err) {
      console.error("[drills] generate-faqs failed", err);
      res.status(500).json({ message: "Failed to generate questions." });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/generate-persona — (re)generate and persist the coach persona
// ---------------------------------------------------------------------------

router.post(
  "/:id/generate-persona",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  drillWriteLimiter,
  async (req, res) => {
    const user = req.user;
    if (!user || !user.orgId) {
      res
        .status(user ? 400 : 401)
        .json({
          message: user
            ? "You must belong to an organisation."
            : "Not authenticated",
        });
      return;
    }

    const drillId = req.params["id"];
    if (!drillId || typeof drillId !== "string") {
      res.status(400).json({ message: "A valid course id is required" });
      return;
    }

    try {
      const [existing] = await db
        .select()
        .from(drills)
        .where(and(eq(drills.id, drillId), eq(drills.orgId, user.orgId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ message: "Course not found." });
        return;
      }

      const resolved = await generateAndPersistPersona(existing, user.orgId, true);
      const docs = await loadDocumentsByCourse([resolved.id]);

      res.status(200).json({
        course: toPublicCourse(
          toPublicDrill({
            ...resolved,
            createdByName: null,
            reviewedByName: null,
          } as DrillWithNames),
          docs.get(resolved.id) ?? [],
        ),
      });
    } catch (err) {
      console.error("[drills] generate-persona failed", err);
      res.status(500).json({ message: "Failed to generate the coach persona." });
    }
  },
);

export const drillsRouter = router;