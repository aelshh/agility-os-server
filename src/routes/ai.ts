/**
 * Stateless AI endpoints — no persistence required.
 *
 * POST /api/ai/generate-faqs — draft practice questions from an unsaved
 * course's knowledge dump, so the course editor can generate a starting set
 * before a course row exists. Persisted-course generation (with DB-backed
 * document texts) lives in /api/drills/:id/generate-faqs.
 *
 * Auth: requireAuth + requireRole(content_curator, architect).
 */

import { eq } from "drizzle-orm";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";

import { db } from "../db/index.js";
import { orgs } from "../db/schema.js";
import type { CourseDocumentRow, DrillRow } from "../db/schema.js";
import { aiEnabled } from "../lib/ai/client.js";
import { generateFaqSuggestions } from "../lib/ai/prompts.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

const CREATOR_ROLES = ["content_curator", "architect"] as const;

/** Caps AI suggestion volume per IP. */
const aiWriteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many requests. Please try again in a few minutes.",
  },
});

const generateFaqsSchema = z.object({
  title: z.string().trim().max(255).optional().default(""),
  description: z.string().trim().max(2000).optional().default(""),
  knowledgeText: z.string().trim().max(60000).default(""),
  docsTexts: z.array(z.string().trim().max(100000)).max(20).default([]),
});

// ---------------------------------------------------------------------------
// POST /api/ai/generate-faqs — draft questions from an unsaved course
// ---------------------------------------------------------------------------

router.post(
  "/generate-faqs",
  requireAuth,
  requireRole(...CREATOR_ROLES),
  aiWriteLimiter,
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

    const parsed = generateFaqsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request payload." });
      return;
    }

    const { title, description, knowledgeText, docsTexts } = parsed.data;
    const hasReference =
      knowledgeText.trim().length > 0 ||
      docsTexts.some((text) => text.trim().length > 0);

    if (!hasReference) {
      res.status(400).json({
        message:
          "Add some knowledge first — paste notes or attach documents so questions can be generated.",
      });
      return;
    }

    if (!aiEnabled) {
      res.status(200).json({
        faqs: [],
        message: "AI question generation is not configured for this workspace.",
      });
      return;
    }

    try {
      const [org] = await db
        .select()
        .from(orgs)
        .where(eq(orgs.id, user.orgId))
        .limit(1);
      if (!org) {
        res.status(500).json({ message: "Organisation not found." });
        return;
      }

      const course: Pick<
        DrillRow,
        "title" | "description" | "knowledgeText" | "faqs" | "scoringRubric"
      > = {
        title: title || "Untitled course",
        description,
        knowledgeText,
        faqs: [],
        scoringRubric: [],
      };

      const docs: Pick<
        CourseDocumentRow,
        "originalName" | "textContent"
      >[] = docsTexts
        .map((text, i) => ({
          originalName: `document-${i + 1}`,
          textContent: text,
        }))
        .filter((doc) => doc.textContent !== null && doc.textContent.trim().length > 0);

      const faqs = await generateFaqSuggestions({ course, org, docs });
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
      console.error("[ai] generate-faqs failed", err);
      res.status(500).json({ message: "Failed to generate questions." });
    }
  },
);

export { router as aiRouter };