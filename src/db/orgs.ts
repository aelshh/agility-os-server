import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const orgs = pgTable("orgs", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  language: varchar("language", { length: 10 }).notNull().default("en"),
  defaultRegion: varchar("default_region", { length: 100 }).notNull(),
  /**
   * Stores tenant-level config: role-derivation mapping table, sync cadence, etc.
   * Typed loosely as JSONB — structured sub-types live in application code.
   */
  config: jsonb("config").default({}),
  /** Organizational Telenow AI API Key (AES-256-GCM encrypted). */
  telenowApiKey: text("telenow_api_key"),
  /** Telenow workspace org ID resolved from the API key. */
  telenowOrgId: varchar("telenow_org_id", { length: 255 }),
  /** Timestamp when Telenow API key was validated and connected. */
  telenowConnectedAt: timestamp("telenow_connected_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type OrgRow = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;

/** Publicly safe org fields (no internal config blob or raw API keys). */
export type PublicOrg = Pick<
  OrgRow,
  "id" | "name" | "timezone" | "language" | "defaultRegion"
> & {
  telenowConfigured: boolean;
  telenowConnectedAt: Date | null;
};

export function toPublicOrg(org: OrgRow): PublicOrg {
  return {
    id: org.id,
    name: org.name,
    timezone: org.timezone,
    language: org.language,
    defaultRegion: org.defaultRegion,
    telenowConfigured: Boolean(org.telenowApiKey && org.telenowApiKey.length > 0),
    telenowConnectedAt: org.telenowConnectedAt ?? null,
  };
}
