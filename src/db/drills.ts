import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";
import { users } from "./users.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const drillStatusEnum = pgEnum("drill_status", [
  "draft",
  "pending_review",
  "published",
  "rejected",
]);

/**
 * Telenow provisioning state for a published course.
 *
 * none        -> not yet provisioned (draft/rejected, or not delivered)
 * provisioning-> agent/campaign creation in flight
 * completed   -> agent + campaign created (calls are being placed)
 * failed      -> agent/campaign creation errored; retry via POST /:id/provision
 */
export const drillProvisioningEnum = pgEnum("drill_provisioning", [
  "none",
  "provisioning",
  "completed",
  "failed",
]);

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * The AgilityOS content unit (spec §2.2). Surfaced in the UI as a "Course".
 * Courses train employees on any topic — product launches, new technology,
 * sales, onboarding, etc. — via a scenario with an AI persona the learner
 * practises against.
 *
 * MVP lifecycle: draft -> pending_review -> published (architect gate)
 * with reject returning the drill to draft for revision.
 */
export const drills = pgTable("drills", {
  id: uuid("id").defaultRandom().primaryKey(),

  // Tenant
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "restrict" }),

  // Identity
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description").notNull().default(""),

  // Knowledge dump — pasted notes plus uploaded documents (see course_documents).
  knowledgeText: text("knowledge_text").notNull().default(""),

  // Practice questions the AI coach asks the learner during a call.
  faqs: jsonb("faqs").notNull().default([]),

  // Auto-generated coach persona. Built once per course when the agent is
  // created (see lib/ai), reused at call time. Nullable until generated.
  personaName: varchar("persona_name", { length: 100 }),
  personaPrompt: text("persona_prompt"),
  personaGeneratedAt: timestamp("persona_generated_at", { withTimezone: true }),

  // Scoring
  scoringRubric: jsonb("scoring_rubric").notNull().default([]),

  // Delivery configuration
  maxDurationSec: integer("max_duration_sec").notNull().default(120),
  callWindowStart: varchar("call_window_start", { length: 5 }),
  callWindowEnd: varchar("call_window_end", { length: 5 }),
  isMandatory: boolean("is_mandatory").notNull().default(false),
  regionScope: text("region_scope").array().notNull().default([]),
  roleScope: text("role_scope").array().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }),

  // Lifecycle (single-review gate MVP)
  status: drillStatusEnum("status").notNull().default("draft"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  reviewedBy: uuid("reviewed_by").references(() => users.id, {
    onDelete: "set null",
  }),
  reviewComment: text("review_comment"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),

  // Telenow integration (knowledge base, voice, and provisioned delivery)
  voice: varchar("voice", { length: 100 })
    .notNull()
    .default(""),
  voiceProvider: varchar("voice_provider", { length: 50 })
    .notNull()
    .default("elevenlabs"),
  telenowKbId: varchar("telenow_kb_id", { length: 255 }),
  telenowAgentId: varchar("telenow_agent_id", { length: 255 }),
  telenowCampaignId: varchar("telenow_campaign_id", { length: 255 }),
  phoneNumberId: varchar("phone_number_id", { length: 255 }),
  phoneNumber: varchar("phone_number", { length: 50 }),
  provisioningStatus: drillProvisioningEnum("provisioning_status")
    .notNull()
    .default("none"),
  provisioningError: text("provisioning_error"),

  // WhatsApp deliverable resources (video links, PDFs, documents, cheat sheets)
  whatsappResources: jsonb("whatsapp_resources").notNull().default([]),
  /** Sending WhatsApp channel ID override for this course */
  whatsappChannelId: varchar("whatsapp_channel_id", { length: 255 }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CourseWhatsappResource = {
  id: string;
  title: string;
  type: "video" | "pdf" | "link" | "document" | "text";
  url?: string;
  documentId?: string;
  s3Key?: string;
  fileName?: string;
  fileSize?: number;
  description?: string;
  caption?: string;
  deliveryTrigger: "during_call" | "post_call" | "on_enroll" | "manual";
  enabled: boolean;
  createdAt?: string;
};

export type DrillRow = typeof drills.$inferSelect;
export type NewDrill = typeof drills.$inferInsert;