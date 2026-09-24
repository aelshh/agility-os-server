import { integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { drills } from "./drills.js";
import { users } from "./users.js";

/**
 * A knowledge-dump file attached to a course (drill). The raw file lives on
 * disk under the server uploads dir; this row tracks it and, where supported,
 * holds the extracted text used for prompting and FAQ generation.
 */
export const courseDocuments = pgTable("course_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  courseId: uuid("course_id")
    .notNull()
    .references(() => drills.id, { onDelete: "cascade" }),
  originalName: varchar("original_name", { length: 255 }).notNull(),
  storedName: varchar("stored_name", { length: 255 }).notNull(),
  mimeType: varchar("mime_type", { length: 100 })
    .notNull()
    .default("application/octet-stream"),
  sizeBytes: integer("size_bytes").notNull(),
  textContent: text("text_content"),
  uploadedBy: uuid("uploaded_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CourseDocumentRow = typeof courseDocuments.$inferSelect;
export type NewCourseDocument = typeof courseDocuments.$inferInsert;