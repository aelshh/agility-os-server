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
  llmModel: process.env["TELENOW_LLM_MODEL"] ?? "gpt-4o-mini",
  sttProvider: process.env["TELENOW_STT_PROVIDER"] ?? "deepgram",
  ttsProvider: process.env["TELENOW_TTS_PROVIDER"] ?? "elevenlabs",
  ttsVoice: process.env["TELENOW_TTS_VOICE"] ?? "EXAVITQu4vr4xnSDxMaL",
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

// ---------------------------------------------------------------------------
// TelenowClient
// ---------------------------------------------------------------------------

export type TelenowQaCriterion = {
  key: string;
  description: string;
};

export type TelenowCampaignTarget = {
  id: string;
  phone: string;
  variables: Record<string, string>;
};

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
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    let res: Response;
    try {
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
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

  /** Creates an agent inside this organization's Telenow workspace. */
  async createAgent(input: {
    name: string;
    systemPrompt: string;
    maxDurationSec: number;
    qaCriteria: TelenowQaCriterion[];
    courseId: string;
  }): Promise<string> {
    const json = await this.request(
      "POST",
      "/api/agents",
      {
        name: input.name.slice(0, 100),
        systemPrompt: input.systemPrompt,
        llmProvider: VOICE_STACK.llmProvider,
        llmModel: VOICE_STACK.llmModel,
        sttProvider: VOICE_STACK.sttProvider,
        ttsProvider: VOICE_STACK.ttsProvider,
        ttsVoice: VOICE_STACK.ttsVoice,
        sessionConfig: { maxDuration: input.maxDurationSec },
        metadata: {
          postCallAnalysis: {
            enabled: true,
            qaCriteria: input.qaCriteria,
          },
          agilityos: { courseId: input.courseId },
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
  }): Promise<string> {
    const json = await this.request(
      "POST",
      "/api/v1/campaigns",
      {
        name: input.name.slice(0, 100),
        agentId: input.agentId,
        concurrency: CAMPAIGN_CONCURRENCY,
        startTimeLocal: CALL_WINDOW_START,
        endTimeLocal: CALL_WINDOW_END,
        timezone: input.timezone,
        source: input.source,
        start: true,
        targets: input.targets,
      },
      `campaign-${input.name}`,
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
        includeTranscript: false,
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