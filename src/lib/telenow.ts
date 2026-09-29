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

  return {
    id,
    name: fullName,
    displayName,
    provider,
    gender,
    accent: accent ? accent.charAt(0).toUpperCase() + accent.slice(1) : undefined,
    language,
    description,
    previewUrl,
  };
}

export const FALLBACK_VOICES: TelenowVoiceOption[] = [
  {
    id: "EXAVITQu4vr4xnSDxMaL",
    name: "Sarah - Mature, Reassuring, Confident",
    displayName: "Sarah",
    provider: "elevenlabs",
    gender: "female",
    accent: "American",
    language: "en",
    description: "Mature, Reassuring, Confident",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3",
  },
  {
    id: "CwhRBWXzGAHq8TQ4Fs17",
    name: "Roger - Laid-Back, Casual, Resonant",
    displayName: "Roger",
    provider: "elevenlabs",
    gender: "male",
    accent: "American",
    language: "en",
    description: "Laid-Back, Casual, Resonant",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/CwhRBWXzGAHq8TQ4Fs17/58ee3ff5-f6f2-4628-93b8-e38eb31806b0.mp3",
  },
  {
    id: "FGY2WhTYpPnrIDTdsKH5",
    name: "Laura - Enthusiast, Quirky Attitude",
    displayName: "Laura",
    provider: "elevenlabs",
    gender: "female",
    accent: "American",
    language: "en",
    description: "Enthusiast, Quirky Attitude",
    previewUrl:
      "https://api.us.elevenlabs.io/v1/voices/FGY2WhTYpPnrIDTdsKH5/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJwcmVtYWRlIiwiZmlsZW5hbWUiOiI2NzM0MTc1OS1hZDA4LTQxYTUtYmU2ZS1kZTEyZmU0NDg2MTgubXAzIiwidGltZXN0YW1wIjoxNzkwNTkzMjAwMDAwMDAwfQ%3D%3D",
  },
  {
    id: "IKne3meq5aSn9XLyUdCD",
    name: "Charlie - Deep, Confident, Energetic",
    displayName: "Charlie",
    provider: "elevenlabs",
    gender: "male",
    accent: "Australian",
    language: "en",
    description: "Deep, Confident, Energetic",
    previewUrl:
      "https://api.us.elevenlabs.io/v1/voices/IKne3meq5aSn9XLyUdCD/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJwcmVtYWRlIiwiZmlsZW5hbWUiOiIxMDJkZTZmMi0yMmVkLTQzZTAtYTFmMS0xMTFmYTc1YzU0ODEubXAzIiwidGltZXN0YW1wIjoxNzkwNTkzMjAwMDAwMDAwfQ%3D%3D",
  },
  {
    id: "JBFqnCBsd6RMkjVDRZzb",
    name: "George - Warm, Captivating Storyteller",
    displayName: "George",
    provider: "elevenlabs",
    gender: "male",
    accent: "British",
    language: "en",
    description: "Warm, Captivating Storyteller",
    previewUrl:
      "https://api.us.elevenlabs.io/v1/voices/JBFqnCBsd6RMkjVDRZzb/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJwcmVtYWRlIiwiZmlsZW5hbWUiOiJlNjIwNmQxYS0wNzIxLTQ3ODctYWFmYi0wNmE2ZTcwNWNhYzUubXAzIiwidGltZXN0YW1wIjoxNzkwNTkzMjAwMDAwMDAwfQ%3D%3D",
  },
  {
    id: "N2lVS1w4EtoT3dr4eOWO",
    name: "Callum - Husky Trickster",
    displayName: "Callum",
    provider: "elevenlabs",
    gender: "male",
    accent: "American",
    language: "en",
    description: "Husky Trickster",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/N2lVS1w4EtoT3dr4eOWO/ac833bd8-ffda-4938-9ebc-b0f99ca25481.mp3",
  },
  {
    id: "SAz9YHcvj6GT2YYXdXww",
    name: "River - Relaxed, Neutral, Informative",
    displayName: "River",
    provider: "elevenlabs",
    gender: "neutral",
    accent: "American",
    language: "en",
    description: "Relaxed, Neutral, Informative",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/SAz9YHcvj6GT2YYXdXww/e6c95f0b-2227-491a-b3d7-2249240decb7.mp3",
  },
  {
    id: "SOYHLrjzK2X1ezoPC6cr",
    name: "Harry - Fierce Warrior",
    displayName: "Harry",
    provider: "elevenlabs",
    gender: "male",
    accent: "American",
    language: "en",
    description: "Fierce Warrior",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/SOYHLrjzK2X1ezoPC6cr/86d178f6-f4b6-4e0e-85be-3de19f490794.mp3",
  },
  {
    id: "TX3LPaxmHKxFdv7VOQHJ",
    name: "Liam - Energetic, Social Media Creator",
    displayName: "Liam",
    provider: "elevenlabs",
    gender: "male",
    accent: "American",
    language: "en",
    description: "Energetic, Social Media Creator",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3",
  },
  {
    id: "Xb7hH8MSUJpSbSDYk0k2",
    name: "Alice - Clear, Engaging Educator",
    displayName: "Alice",
    provider: "elevenlabs",
    gender: "female",
    accent: "British",
    language: "en",
    description: "Clear, Engaging Educator",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/d10f7534-11f6-41fe-a012-2de1e482d336.mp3",
  },
  {
    id: "XrExE9yKIg1WjnnlVkGX",
    name: "Matilda - Knowledgable, Professional",
    displayName: "Matilda",
    provider: "elevenlabs",
    gender: "female",
    accent: "American",
    language: "en",
    description: "Knowledgable, Professional",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3",
  },
  {
    id: "bIHbv24MWmeRgasZH58o",
    name: "Will - Relaxed Optimist",
    displayName: "Will",
    provider: "elevenlabs",
    gender: "male",
    accent: "American",
    language: "en",
    description: "Relaxed Optimist",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/bIHbv24MWmeRgasZH58o/8caf8f3d-ad29-4980-af41-53f20c72d7a4.mp3",
  },
  {
    id: "cgSgspJ2msm6clMCkdW9",
    name: "Jessica - Playful, Bright, Warm",
    displayName: "Jessica",
    provider: "elevenlabs",
    gender: "female",
    accent: "American",
    language: "en",
    description: "Playful, Bright, Warm",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/cgSgspJ2msm6clMCkdW9/56a97bf8-b69b-448f-846c-c3a11683d45a.mp3",
  },
  {
    id: "cjVigY5qzO86Huf0OWal",
    name: "Eric - Smooth, Trustworthy",
    displayName: "Eric",
    provider: "elevenlabs",
    gender: "male",
    accent: "American",
    language: "en",
    description: "Smooth, Trustworthy",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/cjVigY5qzO86Huf0OWal/d098fda0-6456-4030-b3d8-63aa048c9070.mp3",
  },
  {
    id: "hpp4J3VqNfWAUOO0d1Us",
    name: "Bella - Professional, Bright, Warm",
    displayName: "Bella",
    provider: "elevenlabs",
    gender: "female",
    accent: "American",
    language: "en",
    description: "Professional, Bright, Warm",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/hpp4J3VqNfWAUOO0d1Us/dab0f5ba-3aa4-48a8-9fad-f138fea1126d.mp3",
  },
  {
    id: "iP95p4xoKVk53GoZ742B",
    name: "Chris - Charming, Down-to-Earth",
    displayName: "Chris",
    provider: "elevenlabs",
    gender: "male",
    accent: "American",
    language: "en",
    description: "Charming, Down-to-Earth",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/iP95p4xoKVk53GoZ742B/3f4bde72-cc48-40dd-829f-57fbf906f4d7.mp3",
  },
  {
    id: "nPczCjzI2devNBz1zQrb",
    name: "Brian - Deep, Resonant and Comforting",
    displayName: "Brian",
    provider: "elevenlabs",
    gender: "male",
    accent: "American",
    language: "en",
    description: "Deep, Resonant and Comforting",
    previewUrl:
      "https://api.us.elevenlabs.io/v1/voices/nPczCjzI2devNBz1zQrb/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJwcmVtYWRlIiwiZmlsZW5hbWUiOiIyZGQzZTcyYy00ZmQzLTQyZjEtOTNlYS1hYmM1ZDRlNWFhMWQubXAzIiwidGltZXN0YW1wIjoxNzkwNTkzMjAwMDAwMDAwfQ%3D%3D",
  },
  {
    id: "onwK4e9ZLuTAKqWW03F9",
    name: "Daniel - Steady Broadcaster",
    displayName: "Daniel",
    provider: "elevenlabs",
    gender: "male",
    accent: "British",
    language: "en",
    description: "Steady Broadcaster",
    previewUrl:
      "https://api.us.elevenlabs.io/v1/voices/onwK4e9ZLuTAKqWW03F9/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiI3ZWVlMDIzNi0xYTcyLTRiODYtYjMwMy01ZGNhZGMwMDdiYTkubXAzIiwidGltZXN0YW1wIjoxNzkwNTkzMjAwMDAwMDAwfQ%3D%3D",
  },
  {
    id: "pFZP5JQG7iQjIQuC4Bku",
    name: "Lily - Velvety Actress",
    displayName: "Lily",
    provider: "elevenlabs",
    gender: "female",
    accent: "British",
    language: "en",
    description: "Velvety Actress",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/89b68b35-b3dd-4348-a84a-a3c13a3c2b30.mp3",
  },
  {
    id: "pNInz6obpgDQGcFmaJgB",
    name: "Adam - Dominant, Firm",
    displayName: "Adam",
    provider: "elevenlabs",
    gender: "male",
    accent: "American",
    language: "en",
    description: "Dominant, Firm",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/pNInz6obpgDQGcFmaJgB/d6905d7a-dd26-4187-bfff-1bd3a5ea7cac.mp3",
  },
  {
    id: "pqHfZKP75CvOlQylNhV4",
    name: "Bill - Wise, Mature, Balanced",
    displayName: "Bill",
    provider: "elevenlabs",
    gender: "male",
    accent: "American",
    language: "en",
    description: "Wise, Mature, Balanced",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/pqHfZKP75CvOlQylNhV4/d782b3ff-84ba-4029-848c-acf01285524d.mp3",
  },
];

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
      ...extraHeaders,
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

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

  /** Fetches available voices from Telenow, falling back to curated voices if unreachable. */
  async listVoices(provider = "elevenlabs"): Promise<TelenowVoiceOption[]> {
    try {
      const json = await this.request("GET", `/api/providers/tts/${provider}/voices`);
      const obj = asObj(json);
      const list = Array.isArray(obj?.["data"])
        ? (obj["data"] as Array<Record<string, unknown>>)
        : Array.isArray(json)
          ? (json as Array<Record<string, unknown>>)
          : [];
      if (list.length > 0) {
        return list.map((item) => parseVoice(item, provider));
      }
    } catch (err) {
      console.warn(`[telenow] listVoices(${provider}) failed, using fallback catalog:`, err);
    }
    return FALLBACK_VOICES;
  }

  /** Creates an agent inside this organization's Telenow workspace. */
  async createAgent(input: {
    name: string;
    systemPrompt: string;
    maxDurationSec: number;
    qaCriteria: TelenowQaCriterion[];
    courseId: string;
    ttsVoice?: string;
    ttsProvider?: string;
    opener?: string;
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
        ttsProvider: input.ttsProvider ?? VOICE_STACK.ttsProvider,
        ttsVoice: input.ttsVoice ?? VOICE_STACK.ttsVoice,
        sessionConfig: { maxDuration: input.maxDurationSec },
        telephonyConfig: {
          opener: input.opener ?? "Hi there! I am your practice coach. Are you ready to begin?"
        },
        postCallAnalysis: {
          enabled: true,
          qaCriteria: input.qaCriteria,
        },
        metadata: {
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
    startTimeLocal?: string;
    endTimeLocal?: string;
    fromNumberId?: string | null | undefined;
  }): Promise<string> {
    const campaignBody: Record<string, unknown> = {
      name: input.name.slice(0, 100),
      agentId: input.agentId,
      concurrency: CAMPAIGN_CONCURRENCY,
      startTimeLocal: input.startTimeLocal ?? CALL_WINDOW_START,
      endTimeLocal: input.endTimeLocal ?? CALL_WINDOW_END,
      timezone: input.timezone,
      source: input.source,
      start: true,
      targets: input.targets,
    };
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
 * Fetches available voices for an organization, falling back to curated ElevenLabs voices.
 */
export async function getAvailableVoices(
  orgId?: string,
  provider = "elevenlabs",
): Promise<TelenowVoiceOption[]> {
  if (orgId) {
    try {
      const { client } = await getTelenowClientForOrg(orgId);
      return await client.listVoices(provider);
    } catch {
      // Organization not configured or error; fall through to public check
    }
  }

  // Try public provider endpoint
  try {
    const res = await fetch(`https://api.telenow.ai/api/providers/tts/${provider}/voices`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
      if (Array.isArray(json?.data) && json.data.length > 0) {
        return json.data.map((item) => parseVoice(item, provider));
      }
    }
  } catch {
    // fallback
  }

  return FALLBACK_VOICES;
}