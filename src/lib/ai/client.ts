/**
 * LLM client wiring.
 *
 * Provider: OpenAI-compatible chat completions (OpenAI, OpenRouter, Azure,
 * local endpoints) via the official `openai` SDK. Configure with:
 *
 *   LLM_PROVIDER=openai
 *   OPENAI_API_KEY=...
 *   OPENAI_BASE_URL=https://openrouter.ai/api/v1   (optional; defaults to OpenAI)
 *   OPENAI_MODEL=...                                (optional; defaults to gpt-4o-mini)
 *
 * When LLM_PROVIDER !== "openai" or no API key is set, `aiEnabled` is false and
 * all AI features no-op gracefully (see lib/ai/prompts.ts).
 */

import OpenAI from "openai";

const PROVIDER = process.env["LLM_PROVIDER"] ?? "";
const API_KEY = process.env["OPENAI_API_KEY"] ?? "";
const BASE_URL = process.env["OPENAI_BASE_URL"] ?? undefined;
export const DEFAULT_MODEL = "gpt-4o-mini";
export const AI_MODEL = process.env["OPENAI_MODEL"] ?? DEFAULT_MODEL;

export const aiEnabled = PROVIDER === "openai" && API_KEY.length > 0;

let client: OpenAI | null = null;

export function getAiClient(): OpenAI | null {
  if (!aiEnabled) return null;
  if (client) return client;
  client = new OpenAI({
    apiKey: API_KEY,
    baseURL: BASE_URL,
    maxRetries: 2,
  });
  return client;
}