/**
 * Thin Telenow integration client.
 *
 * AgilityOS uses organizational-level Telenow workspaces. Each organization
 * provides its own API key, which scopes all agents, outbound campaigns,
 * and webhooks to that organization's private Telenow workspace.
 *
 * Surfaces used:
 *   - `POST /api/agents`                — Dashboard API (envelope, X-API-Key).
 *   - `GET  /api/v1/me`                 — resolve the workspace org id from the key.
 *   - `POST /api/v1/campaigns`          — Integration API (flat) — bulk outbound calls.
 *   - `POST /api/orgs/{orgId}/webhooks` — Dashboard API — signed webhook endpoint.
 *
 * Contract notes (from Telenow docs, verified):
 *   - Request bodies are camelCase; responses are snake_case.
 *   - Dashboard endpoints wrap responses in `{ success, data }`.
 *   - Unknown request keys are ignored silently; required keys are validated.
 *   - Provider/model/voice ids are overridable via env.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs } from "../db/schema.js";
import type { OrgRow } from "../db/schema.js";
import { decryptSecret } from "./crypto.js";

const DEFAULT_API_BASE = process.env["TELENOW_API_BASE"] ?? "https://api.telenow.ai";

const VOICE_STACK = {
  llmProvider: process.env["TELENOW_LLM_PROVIDER"] ?? "openai",
  llmModel: process.env["TELENOW_LLM_MODEL"] ?? "gpt-5.4-mini",
  sttProvider: process.env["TELENOW_STT_PROVIDER"] ?? "deepgram",
};

const CAMPAIGN_CONCURRENCY =
  Number(process.env["TELENOW_CAMPAIGN_CONCURRENCY"]) || 3;

const CALL_WINDOW_START = process.env["TELENOW_CALL_WINDOW_START"] ?? "09:00";
const CALL_WINDOW_END = process.env["TELENOW_CALL_WINDOW_END"] ?? "18:00";

export class TelenowError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TelenowError";
  }
}

export class TelenowNotConfiguredError extends TelenowError {
  constructor(
    message = "Telenow Voice AI is not configured for your organisation. Please add an API key in Organisation Settings.",
  ) {
    super(message, 428);
    this.name = "TelenowNotConfiguredError";
  }
}

function toAsciiHeaderValue(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "-")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 255);
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads a key tolerating camelCase / snake_case spellings. */
function readKey(obj: Record<string, unknown> | null, key: string): unknown {
  if (!obj) return undefined;
  if (key in obj) return obj[key];
  const snake = key.replace(/[A-Z]/g, (c: string) => `_${c.toLowerCase()}`);
  if (snake in obj) return obj[snake];
  const camel = snake.replace(/_([a-z])/g, (_m: string, c: string) =>
    c.toUpperCase(),
  );
  if (camel in obj) return obj[camel];
  return undefined;
}

function asString(
  obj: Record<string, unknown> | null,
  key: string,
): string | null {
  const v = readKey(obj, key);
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Dashboard endpoints wrap responses; Integration endpoints are flat. */
function unwrapEnvelope(value: unknown): unknown {
  const obj = asObj(value);
  if (obj && obj["success"] && typeof obj["data"] === "object") {
    return obj["data"];
  }
  return value;
}

/**
 * Extracts and normalizes a phone number from various Telenow WhatsApp object shapes
 * (e.g. jid, me.id, user.id, display_phone_number, settings.phone, etc.).
 */
function extractWhatsAppPhoneNumber(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const item = raw as Record<string, unknown>;

  const candidateFields: unknown[] = [
    readKey(item, "phone"),
    readKey(item, "phoneNumber"),
    readKey(item, "phone_number"),
    readKey(item, "e164"),
    readKey(item, "number"),
    readKey(item, "display_phone_number"),
    readKey(item, "displayPhoneNumber"),
    readKey(item, "wa_id"),
    readKey(item, "waId"),
    readKey(item, "jid"),
    readKey(item, "user_id"),
    readKey(item, "id"),
  ];

  const nestedCandidates: (Record<string, unknown> | null | undefined)[] = [
    asObj(readKey(item, "me")),
    asObj(readKey(item, "user")),
    asObj(readKey(item, "account")),
    asObj(readKey(item, "metadata")),
    asObj(readKey(item, "settings")),
    asObj(readKey(item, "session")),
    asObj(readKey(item, "device")),
  ];

  for (const nested of nestedCandidates) {
    if (nested) {
      candidateFields.push(
        readKey(nested, "phone"),
        readKey(nested, "phoneNumber"),
        readKey(nested, "phone_number"),
        readKey(nested, "e164"),
        readKey(nested, "number"),
        readKey(nested, "id"),
        readKey(nested, "jid"),
        readKey(nested, "display_phone_number"),
        readKey(nested, "displayPhoneNumber"),
        readKey(nested, "wa_id"),
        readKey(nested, "waId"),
      );
    }
  }

  for (const cand of candidateFields) {
    if (!cand) continue;
    const str = String(cand).trim();
    if (!str) continue;

    // Isolate the user part if JID format (e.g. 919876543210:0@s.whatsapp.net or 15550199@c.us)
    let candidateDigits = str;
    if (candidateDigits.includes("@")) {
      candidateDigits = candidateDigits.split("@")[0] || "";
    }
    if (candidateDigits.includes(":")) {
      candidateDigits = candidateDigits.split(":")[0] || "";
    }

    // Ignore pure UUIDs or strings with alpha characters in the user part
    if (/[a-zA-Z]/.test(candidateDigits)) {
      continue;
    }

    const digits = candidateDigits.replace(/[^\d]/g, "");
    if (digits.length >= 7 && digits.length <= 16) {
      return `+${digits}`;
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// TelenowClient
// ---------------------------------------------------------------------------

export type TelenowDocumentSourceType = "inline" | "upload" | "url";
export type TelenowDocumentStatus = "pending" | "embedded" | "failed";

export type TelenowKnowledgeBase = {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  embeddingModel: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type TelenowDocument = {
  id: string;
  kbId: string;
  orgId: string;
  title: string;
  sourceType: TelenowDocumentSourceType;
  sourceUri: string | null;
  body: string;
  status: TelenowDocumentStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

function toTelenowKnowledgeBase(raw: Record<string, unknown>): TelenowKnowledgeBase {
  return {
    id: String(readKey(raw, "id") ?? ""),
    orgId: String(readKey(raw, "orgId") ?? readKey(raw, "org_id") ?? ""),
    name: String(readKey(raw, "name") ?? "Untitled"),
    description: asString(raw, "description"),
    embeddingModel: String(
      readKey(raw, "embeddingModel") ??
        readKey(raw, "embedding_model") ??
        "text-embedding-3-small",
    ),
    createdAt: String(
      readKey(raw, "createdAt") ??
        readKey(raw, "created_at") ??
        new Date().toISOString(),
    ),
    updatedAt: String(
      readKey(raw, "updatedAt") ??
        readKey(raw, "updated_at") ??
        new Date().toISOString(),
    ),
    deletedAt: asString(raw, "deletedAt") ?? asString(raw, "deleted_at"),
  };
}

function toTelenowDocument(raw: Record<string, unknown>): TelenowDocument {
  return {
    id: String(readKey(raw, "id") ?? ""),
    kbId: String(readKey(raw, "kbId") ?? readKey(raw, "kb_id") ?? ""),
    orgId: String(readKey(raw, "orgId") ?? readKey(raw, "org_id") ?? ""),
    title: String(readKey(raw, "title") ?? "Untitled"),
    sourceType: (readKey(raw, "sourceType") ??
      readKey(raw, "source_type") ??
      "inline") as TelenowDocumentSourceType,
    sourceUri: asString(raw, "sourceUri") ?? asString(raw, "source_uri"),
    body: String(readKey(raw, "body") ?? ""),
    status: (readKey(raw, "status") ?? "pending") as TelenowDocumentStatus,
    error: asString(raw, "error"),
    createdAt: String(
      readKey(raw, "createdAt") ??
        readKey(raw, "created_at") ??
        new Date().toISOString(),
    ),
    updatedAt: String(
      readKey(raw, "updatedAt") ??
        readKey(raw, "updated_at") ??
        new Date().toISOString(),
    ),
    deletedAt: asString(raw, "deletedAt") ?? asString(raw, "deleted_at"),
  };
}

export type TelenowPhoneNumber = {
  id: string;
  e164: string;
  provider: string;
  country: string;
  region: string | null;
  numberType: string;
  status: string;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean };
  agentId: string | null;
  agentName: string | null;
  allocatedToMemberId: string | null;
  createdAt: string;
};

function toTelenowPhoneNumber(raw: Record<string, unknown>): TelenowPhoneNumber {
  const caps = asObj(readKey(raw, "capabilities")) ?? {};
  const agentObj = asObj(readKey(raw, "agent"));
  const agentId =
    asString(raw, "agentId") ??
    asString(raw, "agent_id") ??
    asString(agentObj, "id");
  const agentName =
    asString(raw, "agentName") ??
    asString(raw, "agent_name") ??
    asString(agentObj, "name") ??
    asString(agentObj, "displayName");

  return {
    id: String(readKey(raw, "id") ?? ""),
    e164: String(readKey(raw, "e164") ?? readKey(raw, "number") ?? ""),
    provider: String(readKey(raw, "provider") ?? "carrier"),
    country: String(readKey(raw, "country") ?? "US"),
    region: asString(raw, "region"),
    numberType: String(
      readKey(raw, "numberType") ?? readKey(raw, "number_type") ?? "local",
    ),
    status: String(readKey(raw, "status") ?? "active"),
    capabilities: {
      voice: Boolean(readKey(caps, "voice") ?? true),
      sms: Boolean(readKey(caps, "sms")),
      mms: Boolean(readKey(caps, "mms")),
    },
    agentId: agentId ?? null,
    agentName: agentName ?? null,
    allocatedToMemberId:
      asString(raw, "allocatedToMemberId") ??
      asString(raw, "allocated_to_member_id"),
    createdAt: String(
      readKey(raw, "createdAt") ??
        readKey(raw, "created_at") ??
        new Date().toISOString(),
    ),
  };
}

export type TelenowQaCriterion = {
  key: string;
  description: string;
};

export type TelenowCampaignTarget = {
  id: string;
  phone: string;
  variables: Record<string, string>;
};

export type TelenowVoiceOption = {
  id: string;
  name: string;
  displayName: string;
  provider: string;
  gender: "female" | "male" | "neutral";
  accent?: string | undefined;
  language?: string | undefined;
  description?: string | undefined;
  previewUrl?: string | undefined;
};

export function parseVoice(
  raw: Record<string, unknown>,
  provider = "elevenlabs",
): TelenowVoiceOption {
  const id = String(readKey(raw, "id") ?? "");
  const fullName = String(readKey(raw, "name") ?? id);
  const dashIdx = fullName.indexOf(" - ");
  let displayName = fullName;
  let description: string | undefined = undefined;
  if (dashIdx !== -1) {
    displayName = fullName.slice(0, dashIdx).trim();
    description = fullName.slice(dashIdx + 3).trim();
  }

  const rawGender = String(readKey(raw, "gender") ?? "neutral").toLowerCase();
  const gender: "female" | "male" | "neutral" =
    rawGender === "female" || rawGender === "male" ? rawGender : "neutral";

  const accent = asString(raw, "accent") ?? undefined;
  const language = asString(raw, "language") ?? undefined;
  const previewUrl =
    asString(raw, "preview_url") ?? asString(raw, "previewUrl") ?? undefined;

  const rawDesc = asString(raw, "description") ?? asString(raw, "blurb");
  const rawTags = Array.isArray(readKey(raw, "tags"))
    ? (readKey(raw, "tags") as string[]).filter(Boolean).join(", ")
    : undefined;

  const finalDescription = description || rawDesc || rawTags || undefined;

  return {
    id,
    name: fullName,
    displayName,
    provider,
    gender,
    accent: accent ? accent.charAt(0).toUpperCase() + accent.slice(1) : undefined,
    language,
    description: finalDescription,
    previewUrl,
  };
}

export function normalizeE164Phone(phone: string): string {
  let cleaned = phone.replace(/[\s\(\)\-\.]/g, "");
  if (!cleaned.startsWith("+")) {
    cleaned = `+${cleaned}`;
  }
  return cleaned;
}

export class TelenowClient {
  constructor(
    readonly apiKey: string,
    readonly apiBase: string = DEFAULT_API_BASE,
  ) {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new TelenowError("A valid Telenow API key is required.");
    }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      "X-App-Key": this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (v !== undefined && v !== null) {
          headers[k] = toAsciiHeaderValue(String(v));
        }
      }
    }
    if (idempotencyKey) {
      headers["Idempotency-Key"] = toAsciiHeaderValue(idempotencyKey);
    }

    let res: Response;
    try {
      const init: RequestInit = { method, headers };
      if (body !== undefined) {
        if (typeof FormData !== "undefined" && body instanceof FormData) {
          init.body = body;
        } else {
          headers["Content-Type"] = "application/json";
          init.body = JSON.stringify(body);
        }
      }
      res = await fetch(`${this.apiBase}${path}`, init);
    } catch (err) {
      throw new TelenowError(
        `Network error calling Telenow ${method} ${path}: ${(err as Error).message}`,
      );
    }

    const raw = await res.text();
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const obj = asObj(json);
      const detail =
        asString(obj, "message") ||
        asString(obj, "error") ||
        raw.slice(0, 200) ||
        `HTTP ${res.status}`;
      throw new TelenowError(
        `Telenow ${method} ${path} failed (${res.status}): ${detail}`,
        res.status,
      );
    }

    return json;
  }

  /** Resolves the Telenow workspace org id from this API key (GET /api/v1/me). */
  async resolveOrgId(): Promise<string> {
    const json = await this.request("GET", "/api/v1/me");
    const obj = asObj(json);
    const orgId = asString(obj, "org_id");
    if (!orgId) {
      throw new TelenowError(
        "Could not resolve the Telenow workspace org id from this API key.",
      );
    }
    return orgId;
  }

  /** Fetches the full Telenow catalog (GET /api/catalog). */
  async getCatalog(): Promise<Record<string, unknown> | null> {
    try {
      const json = await this.request("GET", "/api/catalog");
      const data = unwrapEnvelope(json);
      return asObj(data);
    } catch (err) {
      console.warn("[telenow] failed to fetch catalog", err);
      return null;
    }
  }

  /** Fetches available voices for the specified provider from Telenow with dual-tier fallback. */
  async listVoices(provider = "elevenlabs"): Promise<TelenowVoiceOption[]> {
    const normalizedProvider = provider.trim().toLowerCase();

    // Tier 1: Try live provider voice query
    try {
      const json = await this.request(
        "GET",
        `/api/providers/tts/${encodeURIComponent(normalizedProvider)}/voices`,
      );
      const obj = asObj(json);
      const source = asString(obj, "source");
      const rawList = Array.isArray(obj?.["data"])
        ? (obj["data"] as Array<Record<string, unknown>>)
        : Array.isArray(json)
          ? (json as Array<Record<string, unknown>>)
          : [];

      // If live endpoint answered with voices, return them
      if (source === "live" && rawList.length > 0) {
        return rawList.map((item) => parseVoice(item, normalizedProvider));
      }

      // If response has voices and source is not fallback, return them
      if (rawList.length > 0 && source !== "fallback") {
        return rawList.map((item) => parseVoice(item, normalizedProvider));
      }
    } catch (err) {
      console.warn(
        `[telenow] live voice fetch for provider '${normalizedProvider}' failed, falling back to catalog`,
        err,
      );
    }

    // Tier 2: Fetch curated voices from central catalog
    try {
      const catalog = await this.getCatalog();
      if (catalog) {
        const ttsProviders = Array.isArray(catalog["tts"])
          ? (catalog["tts"] as Array<Record<string, unknown>>)
          : [];
        const prov = ttsProviders.find(
          (p) =>
            String(readKey(p, "id") ?? "")
              .trim()
              .toLowerCase() === normalizedProvider,
        );
        if (prov) {
          const catalogVoices = Array.isArray(readKey(prov, "voices"))
            ? (readKey(prov, "voices") as Array<Record<string, unknown>>)
            : [];
          if (catalogVoices.length > 0) {
            return catalogVoices.map((item) =>
              parseVoice(item, normalizedProvider),
            );
          }
        }
      }
    } catch (catalogErr) {
      console.warn(
        `[telenow] catalog voice fetch for provider '${normalizedProvider}' failed`,
        catalogErr,
      );
    }

    return [];
  }

  /** Creates an agent inside this organization's Telenow workspace. */
  async createAgent(input: {
    name: string;
    systemPrompt: string;
    maxDurationSec: number;
    qaCriteria: TelenowQaCriterion[];
    courseId: string;
    ttsVoice: string;
    ttsProvider: string;
    opener?: string;
  }): Promise<string> {
    const ttsVoice = input.ttsVoice?.trim();
    const ttsProvider = input.ttsProvider?.trim();
    if (!ttsVoice || !ttsProvider) {
      throw new TelenowError(
        "A TTS voice persona ID (ttsVoice) and provider (ttsProvider) are strictly required to create a voice agent.",
        400,
      );
    }

    const json = await this.request(
      "POST",
      "/api/agents",
      {
        name: input.name.slice(0, 100),
        systemPrompt: input.systemPrompt,
        llmProvider: VOICE_STACK.llmProvider,
        llmModel: VOICE_STACK.llmModel,
        sttProvider: VOICE_STACK.sttProvider,
        ttsProvider,
        ttsVoice,
        sessionConfig: { maxDuration: input.maxDurationSec },
        telephonyConfig: {
          opener: input.opener ?? "Hi there! I am your practice coach. Are you ready to begin?"
        },
        metadata: {
          agilityos: { courseId: input.courseId },
          postCallAnalysis: {
            enabled: true,
            minDurationSec: 5,
            minCustomerTurns: 1,
            qaCriteria: input.qaCriteria,
          },
        },
      },
      `agent-${input.courseId}`,
    );

    const agent = asObj(unwrapEnvelope(json));
    const id = asString(agent, "id");
    if (!id) throw new TelenowError("Telenow created an agent but returned no id.");
    return id;
  }

  /** Launches a bulk outbound calling campaign inside this organization's workspace. */
  async createCampaign(input: {
    name: string;
    agentId: string;
    timezone: string;
    targets: TelenowCampaignTarget[];
    source: string;
    startTimeLocal?: string;
    endTimeLocal?: string;
    fromNumberId?: string | null | undefined;
  }): Promise<string> {
    const campaignBody: Record<string, unknown> = {
      name: input.name.slice(0, 100),
      agentId: input.agentId,
      concurrency: CAMPAIGN_CONCURRENCY,
      timezone: input.timezone,
      source: input.source,
      start: true,
      targets: input.targets,
    };

    const startLocal = input.startTimeLocal?.trim();
    const endLocal = input.endTimeLocal?.trim();
    if (startLocal && endLocal) {
      campaignBody["startTimeLocal"] = startLocal;
      campaignBody["endTimeLocal"] = endLocal;
    }

    if (input.fromNumberId) {
      campaignBody["fromNumberId"] = input.fromNumberId;
    }

    const json = await this.request(
      "POST",
      "/api/v1/campaigns",
      campaignBody,
      `campaign-${input.name}-${Date.now()}`,
    );

    const obj = asObj(json);
    const campaign = asObj(readKey(obj ?? {}, "campaign")) ?? obj;
    const id = asString(campaign, "id");
    if (!id) throw new TelenowError("Telenow created a campaign but returned no id.");
    return id;
  }

  /** Registers a signed webhook endpoint inside this organization's Telenow workspace. */
  async registerWebhook(input: {
    targetUrl: string;
    events: string[];
    telenowOrgId?: string | undefined;
  }): Promise<{ telenowHookId: string; signingSecret: string }> {
    const orgId = input.telenowOrgId ?? (await this.resolveOrgId());
    const json = await this.request(
      "POST",
      `/api/orgs/${orgId}/webhooks`,
      {
        url: input.targetUrl,
        events: input.events,
        includeRecording: true,
        includeTranscript: true,
      },
      `webhook-${input.targetUrl}`,
    );

    const data = asObj(unwrapEnvelope(json));
    const endpoint = asObj(readKey(data ?? {}, "endpoint"));
    const telenowHookId = asString(endpoint, "id");
    const signingSecret =
      asString(data, "signing_secret") ?? asString(endpoint, "signing_secret");

    if (!telenowHookId || !signingSecret) {
      throw new TelenowError(
        "Telenow did not return a webhook endpoint id and signing secret.",
      );
    }
    return { telenowHookId, signingSecret };
  }

  /** Deletes an agent from this organization's Telenow workspace. */
  async deleteAgent(agentId: string): Promise<void> {
    try {
      await this.request("DELETE", `/api/agents/${agentId}`);
    } catch (err) {
      if (err instanceof TelenowError && err.status === 404) return;
      throw err;
    }
  }

  /** Deletes a campaign from this organization's Telenow workspace. */
  async deleteCampaign(campaignId: string): Promise<void> {
    try {
      await this.request("POST", `/api/v1/campaigns/${campaignId}/cancel`);
    } catch (err) {
      if (err instanceof TelenowError && err.status === 404) return;
      if (err instanceof TelenowError && err.status === 400 && err.message.includes("completed")) return;
      throw err;
    }
  }

  /** Creates a knowledge base in this organization's workspace. */
  async createKnowledgeBase(
    input: { name: string; description?: string | undefined },
    orgId?: string,
  ): Promise<TelenowKnowledgeBase> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const json = await this.request(
      "POST",
      `/api/orgs/${targetOrgId}/knowledge-bases`,
      {
        name: input.name.trim(),
        description: input.description?.trim() || undefined,
      },
    );
    const data = asObj(unwrapEnvelope(json));
    return toTelenowKnowledgeBase(data ?? {});
  }

  /** Lists knowledge bases in this organization's workspace. */
  async listKnowledgeBases(
    orgId?: string,
  ): Promise<{ knowledgeBases: TelenowKnowledgeBase[]; total: number }> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const json = await this.request("GET", `/api/orgs/${targetOrgId}/knowledge-bases`);
    const data = asObj(unwrapEnvelope(json));
    const rawList = Array.isArray(readKey(data, "knowledgeBases"))
      ? (readKey(data, "knowledgeBases") as Array<Record<string, unknown>>)
      : Array.isArray(data)
        ? (data as Array<Record<string, unknown>>)
        : [];
    const knowledgeBases = rawList.map(toTelenowKnowledgeBase);
    const total = Number(readKey(data, "total")) || knowledgeBases.length;
    return { knowledgeBases, total };
  }

  /** Deletes a knowledge base from this organization's workspace. */
  async deleteKnowledgeBase(kbId: string, orgId?: string): Promise<void> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    try {
      await this.request("DELETE", `/api/orgs/${targetOrgId}/knowledge-bases/${kbId}`);
    } catch (err) {
      if (err instanceof TelenowError && err.status === 404) return;
      throw err;
    }
  }

  /** Lists documents in a knowledge base. */
  async listKbDocuments(kbId: string, orgId?: string): Promise<TelenowDocument[]> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const json = await this.request(
      "GET",
      `/api/orgs/${targetOrgId}/knowledge-bases/${kbId}/documents`,
    );
    const data = asObj(unwrapEnvelope(json));
    const rawList = Array.isArray(readKey(data, "documents"))
      ? (readKey(data, "documents") as Array<Record<string, unknown>>)
      : Array.isArray(data)
        ? (data as Array<Record<string, unknown>>)
        : [];
    return rawList.map(toTelenowDocument);
  }

  /** Adds an inline text document to a knowledge base. */
  async addKbTextDocument(
    kbId: string,
    input: { title: string; body: string },
    orgId?: string,
  ): Promise<TelenowDocument> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const json = await this.request(
      "POST",
      `/api/orgs/${targetOrgId}/knowledge-bases/${kbId}/documents`,
      {
        title: input.title.trim(),
        body: input.body.trim(),
      },
    );
    const data = asObj(unwrapEnvelope(json));
    return toTelenowDocument(data ?? {});
  }

  /** Uploads a file document (.pdf, .docx, .txt, .md, .csv) to a knowledge base. */
  async uploadKbDocument(
    kbId: string,
    input: {
      fileBuffer: Buffer;
      fileName: string;
      mimeType?: string | undefined;
      title?: string | undefined;
    },
    orgId?: string,
  ): Promise<TelenowDocument> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const form = new FormData();
    const blob = new Blob([new Uint8Array(input.fileBuffer)], {
      type: input.mimeType || "application/octet-stream",
    });
    form.append("file", blob, input.fileName);
    if (input.title?.trim()) {
      form.append("title", input.title.trim());
    }

    const json = await this.request(
      "POST",
      `/api/orgs/${targetOrgId}/knowledge-bases/${kbId}/documents/upload`,
      form,
    );
    const data = asObj(unwrapEnvelope(json));
    return toTelenowDocument(data ?? {});
  }

  /** Ingests a public URL document to a knowledge base. */
  async addKbUrlDocument(
    kbId: string,
    input: { url: string; title?: string | undefined },
    orgId?: string,
  ): Promise<TelenowDocument> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const json = await this.request(
      "POST",
      `/api/orgs/${targetOrgId}/knowledge-bases/${kbId}/documents/url`,
      {
        url: input.url.trim(),
        title: input.title?.trim() || undefined,
      },
    );
    const data = asObj(unwrapEnvelope(json));
    return toTelenowDocument(data ?? {});
  }

  /** Deletes a document from a knowledge base. */
  async deleteKbDocument(kbId: string, docId: string, orgId?: string): Promise<void> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    try {
      await this.request(
        "DELETE",
        `/api/orgs/${targetOrgId}/knowledge-bases/${kbId}/documents/${docId}`,
      );
    } catch (err) {
      if (err instanceof TelenowError && err.status === 404) return;
      throw err;
    }
  }

  /** Attaches a knowledge base to an agent. */
  async attachKnowledgeBase(
    agentId: string,
    kbId: string,
    documentIds?: string[],
    orgId?: string,
  ): Promise<void> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const body = documentIds && documentIds.length > 0 ? { documentIds } : undefined;
    await this.request(
      "POST",
      `/api/orgs/${targetOrgId}/agents/${agentId}/knowledge-bases/${kbId}`,
      body,
    );
  }

  /** Detaches a knowledge base from an agent. */
  async detachKnowledgeBase(
    agentId: string,
    kbId: string,
    orgId?: string,
  ): Promise<void> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    try {
      await this.request(
        "DELETE",
        `/api/orgs/${targetOrgId}/agents/${agentId}/knowledge-bases/${kbId}`,
      );
    } catch (err) {
      if (err instanceof TelenowError && err.status === 404) return;
      throw err;
    }
  }

  /** Lists phone numbers in this organization's Telenow workspace. */
  async listNumbers(
    orgId?: string,
  ): Promise<{ numbers: TelenowPhoneNumber[]; total: number }> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const json = await this.request(
      "GET",
      `/api/voice/numbers`,
      undefined,
      undefined,
      { "X-Org-Id": targetOrgId },
    );
    const data = asObj(unwrapEnvelope(json));
    const rawList = Array.isArray(readKey(data, "numbers"))
      ? (readKey(data, "numbers") as Array<Record<string, unknown>>)
      : Array.isArray(data)
        ? (data as Array<Record<string, unknown>>)
        : [];
    const numbers = rawList.map(toTelenowPhoneNumber);
    const total = Number(readKey(data, "total")) || numbers.length;
    return { numbers, total };
  }

  /** Assigns a phone number to an agent for inbound and outbound calling. */
  async assignNumberAgent(
    numberId: string,
    agentId: string,
    orgId?: string,
  ): Promise<void> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    await this.request(
      "POST",
      `/api/voice/numbers/${numberId}/assign-agent`,
      { agentId },
      undefined,
      { "X-Org-Id": targetOrgId },
    );
  }

  /** Unassigns an agent from a phone number. */
  async unassignNumberAgent(numberId: string, orgId?: string): Promise<void> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    try {
      await this.request(
        "DELETE",
        `/api/voice/numbers/${numberId}/agent`,
        undefined,
        undefined,
        { "X-Org-Id": targetOrgId },
      );
    } catch (err) {
      if (err instanceof TelenowError && err.status === 404) return;
      throw err;
    }
  }

  /** Checks live carrier connection status for owned phone numbers. */
  async checkNumberConnections(orgId?: string): Promise<
    Array<{
      id: string;
      e164: string;
      matches: boolean | null;
    }>
  > {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const json = await this.request(
      "GET",
      `/api/voice/numbers/connection-status`,
      undefined,
      undefined,
      { "X-Org-Id": targetOrgId },
    );
    const data = asObj(unwrapEnvelope(json));
    const rawList = Array.isArray(readKey(data, "numbers"))
      ? (readKey(data, "numbers") as Array<Record<string, unknown>>)
      : [];
    return rawList.map((item) => ({
      id: String(readKey(item, "id") ?? ""),
      e164: String(readKey(item, "e164") ?? readKey(item, "number") ?? ""),
      matches:
        typeof readKey(item, "matches") === "boolean"
          ? (readKey(item, "matches") as boolean)
          : null,
    }));
  }

  // -------------------------------------------------------------------------
  // WhatsApp Messaging & Channel Management (telenow.ai/docs/wa-overview)
  // Strictly using the official Org API Key surface: /api/orgs/{orgId}/whatsapp-hub/*
  // -------------------------------------------------------------------------

  /**
   * Initiates a new WhatsApp QR pairing session.
   * Path: POST /api/orgs/{orgId}/whatsapp/sessions
   */
  async createWhatsAppSession(
    label?: string,
    orgId?: string,
  ): Promise<{
    sessionId: string;
    status: string;
    qr?: string | null;
  }> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const payload = {
      label: label?.trim() || "AgilityOS Channel",
      name: label?.trim() || "AgilityOS Channel",
    };

    const json = await this.request(
      "POST",
      `/api/orgs/${targetOrgId}/whatsapp/sessions`,
      payload,
      undefined,
      { "X-Org-Id": targetOrgId },
    );
    const data = asObj(unwrapEnvelope(json)) ?? asObj(json);
    const target = asObj(readKey(data ?? {}, "session")) ?? data;

    const sessionId =
      asString(target, "id") ||
      asString(target, "sessionId") ||
      asString(target, "session_id") ||
      asString(target, "sid") ||
      asString(data, "id") ||
      asString(data, "sessionId") ||
      asString(data, "sid");

    if (!sessionId) {
      throw new TelenowError("Failed to initiate WhatsApp pairing session.");
    }

    const qr =
      asString(target, "qr") ||
      asString(target, "qrCode") ||
      asString(target, "qr_code") ||
      asString(target, "qrcode") ||
      asString(data, "qr") ||
      asString(data, "qrCode") ||
      null;
    const status =
      asString(target, "status") ||
      asString(data, "status") ||
      (qr ? "qr_ready" : "created");

    return { sessionId, status, qr };
  }

  /**
   * Retrieves status and QR payload for an active pairing session.
   * Path: GET /api/orgs/{orgId}/whatsapp/sessions/{sessionId}
   */
  async getWhatsAppSession(
    sessionId: string,
    orgId?: string,
  ): Promise<{
    sessionId: string;
    status: string;
    qr?: string | null;
    phone?: string | null;
    channelId?: string | null;
  }> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());

    const json = await this.request(
      "GET",
      `/api/orgs/${targetOrgId}/whatsapp/sessions/${sessionId}`,
      undefined,
      undefined,
      { "X-Org-Id": targetOrgId },
    );
    const data = asObj(unwrapEnvelope(json)) ?? asObj(json);
    const target = asObj(readKey(data ?? {}, "session")) ?? data;

    if (!target && !data) {
      throw new TelenowError(`Failed to fetch WhatsApp session ${sessionId}.`);
    }

    const sid =
      asString(target, "id") ||
      asString(target, "sessionId") ||
      asString(target, "session_id") ||
      asString(target, "sid") ||
      sessionId;
    const qr =
      asString(target, "qr") ||
      asString(target, "qrCode") ||
      asString(target, "qr_code") ||
      asString(data, "qr") ||
      null;
    const status =
      asString(target, "status") ||
      asString(data, "status") ||
      (qr ? "qr_ready" : "created");
    const phone =
      extractWhatsAppPhoneNumber(target) ||
      extractWhatsAppPhoneNumber(data) ||
      asString(target, "phone") ||
      asString(target, "number") ||
      asString(target, "e164") ||
      asString(data, "phone") ||
      null;
    const channelId =
      asString(target, "channelId") ||
      asString(target, "channel_id") ||
      asString(data, "channelId") ||
      null;

    return { sessionId: sid, status, qr, phone, channelId };
  }

  /**
   * Deletes / cancels an active WhatsApp pairing session.
   * Path: DELETE /api/orgs/{orgId}/whatsapp/sessions/{sessionId}
   */
  async deleteWhatsAppSession(
    sessionId: string,
    orgId?: string,
  ): Promise<{ success: boolean }> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());

    try {
      await this.request(
        "DELETE",
        `/api/orgs/${targetOrgId}/whatsapp/sessions/${sessionId}`,
        undefined,
        undefined,
        { "X-Org-Id": targetOrgId },
      );
    } catch {
      // ignore
    }

    return { success: true };
  }

  /**
   * Disconnects and removes a WhatsApp channel via the Org API.
   * Path: DELETE /api/orgs/{orgId}/whatsapp-hub/channels/{channelId}
   */
  async deleteWhatsAppChannel(
    channelId: string,
    orgId?: string,
  ): Promise<{ success: boolean }> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());

    try {
      await this.request(
        "DELETE",
        `/api/orgs/${targetOrgId}/whatsapp-hub/channels/${channelId}`,
        undefined,
        undefined,
        { "X-Org-Id": targetOrgId },
      );
      return { success: true };
    } catch (err) {
      if (err instanceof TelenowError && err.status === 404) {
        // Fallback: check if it was a session-based channel
        try {
          await this.request(
            "DELETE",
            `/api/orgs/${targetOrgId}/whatsapp/sessions/${channelId}`,
            undefined,
            undefined,
            { "X-Org-Id": targetOrgId },
          );
          return { success: true };
        } catch {
          return { success: true };
        }
      }
      throw err;
    }
  }

  /**
   * Lists active connected WhatsApp channels in the organization inbox via the Org API.
   * Path: GET /api/orgs/{orgId}/whatsapp-hub/channels
   */
  async listWhatsAppChannels(orgId?: string): Promise<
    Array<{
      id: string;
      name: string;
      phone: string;
      status: string;
      qualityRating?: string;
    }>
  > {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const channelMap = new Map<
      string,
      {
        id: string;
        name: string;
        phone: string;
        status: string;
        qualityRating?: string;
      }
    >();

    try {
      const json = await this.request(
        "GET",
        `/api/orgs/${targetOrgId}/whatsapp-hub/channels`,
        undefined,
        undefined,
        { "X-Org-Id": targetOrgId },
      );
      const data = asObj(unwrapEnvelope(json)) ?? asObj(json);
      const rawList = Array.isArray(readKey(data ?? {}, "channels"))
        ? (readKey(data ?? {}, "channels") as Array<Record<string, unknown>>)
        : Array.isArray(data)
          ? (data as Array<Record<string, unknown>>)
          : Array.isArray(json)
            ? (json as Array<Record<string, unknown>>)
            : [];

      for (const item of rawList) {
        const id = String(
          readKey(item, "id") ??
            readKey(item, "channelId") ??
            readKey(item, "channel_id") ??
            "",
        );
        if (!id) continue;
        const phone =
          asString(item, "phone") ||
          asString(item, "number") ||
          asString(item, "e164") ||
          extractWhatsAppPhoneNumber(item);
        const rawName = String(
          readKey(item, "label") ??
            readKey(item, "name") ??
            readKey(item, "displayName") ??
            "",
        ).trim();
        const name = rawName || (phone ? `WhatsApp (${phone})` : "WhatsApp Channel");
        const status = String(readKey(item, "status") ?? "active");
        if (status === "deleted") continue;

        const qr =
          asString(item, "qualityRating") ??
          asString(item, "quality_rating") ??
          (status === "connected" ? "Connected" : undefined);

        const channelObj: {
          id: string;
          name: string;
          phone: string;
          status: string;
          qualityRating?: string;
        } = {
          id,
          name,
          phone,
          status,
        };
        if (qr) {
          channelObj.qualityRating = qr;
        }

        channelMap.set(id, channelObj);
      }
    } catch (err) {
      console.warn("[telenow] failed to fetch whatsapp-hub channels:", err);
    }

    return Array.from(channelMap.values());
  }

  /**
   * Uploads a file (PDF, document, image, video) to Telenow's WhatsApp channel
   * and returns the resulting mediaId for delivery via the Org API.
   * Path: POST /api/orgs/{orgId}/whatsapp-hub/channels/{channelId}/media
   */
  async uploadWhatsAppMedia(
    channelId: string,
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
    orgId?: string,
  ): Promise<{ mediaId: string; mime: string; filename: string }> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const form = new FormData();
    const blob = new Blob([new Uint8Array(fileBuffer)], {
      type: mimeType || "application/octet-stream",
    });
    form.append("file", blob, fileName);

    const json = await this.request(
      "POST",
      `/api/orgs/${targetOrgId}/whatsapp-hub/channels/${channelId}/media`,
      form,
      undefined,
      { "X-Org-Id": targetOrgId },
    );

    const data = asObj(unwrapEnvelope(json)) ?? asObj(json);
    const mediaId = asString(data, "mediaId") ?? asString(data, "id");
    if (!mediaId) {
      throw new TelenowError("Failed to upload WhatsApp media: no mediaId returned.");
    }

    return {
      mediaId,
      mime: asString(data, "mime") || mimeType,
      filename: asString(data, "filename") || fileName,
    };
  }

  /**
   * Sends a text message or media attachment over WhatsApp using the official Org API.
   * Path: POST /api/orgs/{orgId}/whatsapp-hub/channels/{channelId}/send
   *
   * Contract notes (from telenow.ai/docs/wa-text & wa-media):
   * - Destination phone is passed in `to` (E.164 string).
   * - Free-form text message MUST be passed in `body` (NOT `message` or `text`).
   * - Media attachment is passed in `mediaId` (with optional `caption`).
   * - Optional reply quoting is passed in `reply_to`.
   */
  async sendWhatsAppMessage(
    input: {
      channelId?: string | null | undefined;
      to: string;
      message?: string | null | undefined;
      mediaId?: string | null | undefined;
      caption?: string | null | undefined;
      replyTo?: string | null | undefined;
    },
    orgId?: string,
  ): Promise<{ wamid: string }> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    let channelId = input.channelId || undefined;

    // If channelId was not provided, auto-resolve the first active WhatsApp channel
    if (!channelId) {
      const channels = await this.listWhatsAppChannels(targetOrgId);
      if (channels.length > 0 && channels[0]?.id) {
        channelId = channels[0].id;
      }
    }

    if (!channelId) {
      throw new TelenowError(
        "No active WhatsApp channel is configured for your organization in Telenow. Please connect a WhatsApp channel in your Telenow workspace settings.",
      );
    }

    const normalizedTo = normalizeE164Phone(input.to);

    const payload: Record<string, unknown> = {
      to: normalizedTo,
    };

    if (input.mediaId?.trim()) {
      payload["mediaId"] = input.mediaId.trim();
      if (input.caption?.trim()) {
        payload["caption"] = input.caption.trim();
      }
    } else if (input.message?.trim()) {
      payload["body"] = input.message.trim();
    } else {
      throw new TelenowError("WhatsApp message must contain either text message or mediaId.");
    }

    if (input.replyTo?.trim()) {
      payload["reply_to"] = input.replyTo.trim();
    }

    const json = await this.request(
      "POST",
      `/api/orgs/${targetOrgId}/whatsapp-hub/channels/${channelId}/send`,
      payload,
      undefined,
      { "X-Org-Id": targetOrgId },
    );

    const data = asObj(unwrapEnvelope(json)) ?? asObj(json);
    const wamid = asString(data, "wamid") || asString(data, "id") || "wamid.success";
    return { wamid };
  }

  /**
   * Sends a pre-approved template message over WhatsApp via the Org API.
   * Path: POST /api/orgs/{orgId}/whatsapp-hub/channels/{channelId}/send-template
   */
  async sendWhatsAppTemplate(
    input: {
      channelId?: string | null | undefined;
      to: string;
      template: string;
      language?: string;
      variables?: string[];
      components?: Array<Record<string, unknown>>;
    },
    orgId?: string,
  ): Promise<{ wamid: string }> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    let channelId = input.channelId || undefined;

    if (!channelId) {
      const channels = await this.listWhatsAppChannels(targetOrgId);
      if (channels.length > 0 && channels[0]?.id) {
        channelId = channels[0].id;
      }
    }

    if (!channelId) {
      throw new TelenowError(
        "No active WhatsApp channel is configured for your organization in Telenow.",
      );
    }

    const normalizedTo = normalizeE164Phone(input.to);
    const payload: Record<string, unknown> = {
      to: normalizedTo,
      template: input.template.trim(),
      language: input.language?.trim() || "en_US",
    };

    if (input.components && input.components.length > 0) {
      payload["components"] = input.components;
    } else if (input.variables) {
      payload["variables"] = input.variables;
    }

    const json = await this.request(
      "POST",
      `/api/orgs/${targetOrgId}/whatsapp-hub/channels/${channelId}/send-template`,
      payload,
      undefined,
      { "X-Org-Id": targetOrgId },
    );

    const data = asObj(unwrapEnvelope(json)) ?? asObj(json);
    const wamid = asString(data, "wamid") || asString(data, "id") || "wamid.success";
    return { wamid };
  }

  /**
   * Lists approved templates for a WhatsApp channel via the Org API.
   * Path: GET /api/orgs/{orgId}/whatsapp-hub/channels/{channelId}/templates
   */
  async listWhatsAppTemplates(
    channelId: string,
    orgId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const targetOrgId = orgId ?? (await this.resolveOrgId());
    const json = await this.request(
      "GET",
      `/api/orgs/${targetOrgId}/whatsapp-hub/channels/${channelId}/templates`,
      undefined,
      undefined,
      { "X-Org-Id": targetOrgId },
    );
    const data = asObj(unwrapEnvelope(json)) ?? asObj(json);
    return Array.isArray(readKey(data, "templates"))
      ? (readKey(data, "templates") as Array<Record<string, unknown>>)
      : Array.isArray(data)
        ? (data as Array<Record<string, unknown>>)
        : [];
  }
}

// ---------------------------------------------------------------------------
// Organization helpers
// ---------------------------------------------------------------------------

/**
 * Returns a configured TelenowClient for an organization.
 * Throws TelenowNotConfiguredError if the organization has no Telenow API key.
 */
export async function getTelenowClientForOrg(orgId: string): Promise<{
  client: TelenowClient;
  telenowOrgId: string;
  org: OrgRow;
}> {
  const [org] = await db
    .select()
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  if (!org) {
    throw new TelenowError("Organisation not found.", 404);
  }

  if (!org.telenowApiKey || org.telenowApiKey.trim().length === 0) {
    throw new TelenowNotConfiguredError();
  }

  const plainApiKey = decryptSecret(org.telenowApiKey).trim();
  if (!plainApiKey) {
    throw new TelenowNotConfiguredError(
      "Telenow Voice AI API key could not be decrypted. Please update your key in Organisation Settings.",
    );
  }

  const client = new TelenowClient(plainApiKey);

  let telenowOrgId = org.telenowOrgId;
  if (!telenowOrgId) {
    telenowOrgId = await client.resolveOrgId();
    await db
      .update(orgs)
      .set({ telenowOrgId })
      .where(eq(orgs.id, org.id));
  }

  return { client, telenowOrgId, org };
}

/**
 * Checks whether an organization has configured a Telenow API key.
 */
export async function isOrgTelenowConfigured(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ telenowApiKey: orgs.telenowApiKey })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  return Boolean(row?.telenowApiKey && row.telenowApiKey.trim().length > 0);
}

/**
 * Validates a candidate Telenow API key against Telenow GET /api/v1/me.
 */
export async function validateTelenowApiKey(
  apiKey: string,
): Promise<{ valid: boolean; telenowOrgId: string | null; error?: string }> {
  try {
    const client = new TelenowClient(apiKey.trim());
    const telenowOrgId = await client.resolveOrgId();
    return { valid: true, telenowOrgId };
  } catch (err) {
    return {
      valid: false,
      telenowOrgId: null,
      error: (err as Error).message,
    };
  }
}

/**
 * Fetches available voices for an organization directly from Telenow.
 * Strictly requires an authenticated Telenow connection for the organization.
 * Throws TelenowNotConfiguredError (428) if no Telenow API key is configured.
 */
export async function getAvailableVoices(
  orgId?: string,
  provider = "elevenlabs",
): Promise<TelenowVoiceOption[]> {
  if (!orgId) {
    throw new TelenowNotConfiguredError(
      "Organisation context is required to fetch available voices.",
    );
  }

  const { client } = await getTelenowClientForOrg(orgId);
  return await client.listVoices(provider);
}