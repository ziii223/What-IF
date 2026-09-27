/**
 * lib/llm.ts — the shared LLM call contract (ARCHITECTURE.md §2.4).
 *
 * One implementation of the strip-fences → JSON.parse → single-retry sequence, used by all three
 * routes (/api/analyze, /api/analogy, /api/crash-simulation). §2.4 is explicit that the retry logic
 * must not exist in three copies; this module is that one copy.
 *
 * Uses DeepSeek's OpenAI-compatible API endpoint (https://api.deepseek.com) with model
 * deepseek-chat. Configuration comes from DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL.
 *
 * This module owns transport, text extraction and JSON parsing. It does NOT validate the parsed
 * value against a route's schema — that is per-route (the §2.1 payload and the §2.2 payload are
 * different shapes), and it must stay per-route because `verdict` is optional enrichment while
 * `mermaidCode` is not.
 */

import type { LlmErrorCode } from "./types";

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const API_KEY_ENV = "DEEPSEEK_API_KEY";
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const MODEL_ENV = "DEEPSEEK_MODEL";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";

/** Room for a 40-node flowchart plus architecture[] and verdict in one response. */
const MAX_TOKENS = 4096;
/** Generous relative to lib/github.ts's 10s — generation is the slow half of the pipeline. */
const LLM_TIMEOUT_MS = 45_000;

/* ------------------------------------------------------------------ *
 * §2.4 — prompt + parse scaffolding
 * ------------------------------------------------------------------ */

/** §2.4's mandated system instruction, appended by this module so no caller can forget it. */
const JSON_INSTRUCTION =
  "Return ONLY valid JSON matching this exact shape. No markdown fences, no prose before or after.";

/** §2.4's mandated retry system message. */
const RETRY_SYSTEM_SUFFIX =
  "Your last response was not valid JSON. Return ONLY the JSON object, nothing else.";

const LEADING_JSON_FENCE = /^```(?:json)?\s*\n?/;
const TRAILING_JSON_FENCE = /\n?```\s*$/;

/* ------------------------------------------------------------------ *
 * Result envelope
 * ------------------------------------------------------------------ */

export interface LlmOk<T> {
  ok: true;
  data: T;
}

export interface LlmErr {
  ok: false;
  error: LlmErrorCode;
}

/** Structurally compatible with `FetchResult` in lib/github.ts, so routes branch once. */
export type LlmResult<T> = LlmOk<T> | LlmErr;

export interface LlmJsonRequest {
  /** Route-specific instructions. The §2.4 JSON instruction is appended automatically. */
  system: string;
  /** The user turn — for all three routes, the capped digest/array actually being reasoned over. */
  user: string;
}

/* ------------------------------------------------------------------ *
 * Unknown-narrowing helpers (BOB.md §1: no `any`)
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeoutError(err: unknown): boolean {
  if (!isRecord(err)) return false;
  return err.name === "TimeoutError" || err.name === "AbortError";
}

/* ------------------------------------------------------------------ *
 * Endpoint resolution
 * ------------------------------------------------------------------ */

/**
 * DEEPSEEK_BASE_URL is conventionally host-only (https://api.deepseek.com), but accept the
 * /v1 suffix too so a custom proxy can be wired without code changes.
 */
function messagesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const root = trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
  return `${root}/v1/chat/completions`;
}

/* ------------------------------------------------------------------ *
 * Response text extraction (OpenAI-compatible chat completions shape)
 * ------------------------------------------------------------------ */

/**
 * Extracts the assistant message text from an OpenAI-compatible chat completions response.
 * Shape: { choices: [ { message: { role: "assistant", content: "..." } } ] }
 */
function extractText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content !== "string" || content.trim() === "") return null;
  return content.trim();
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

async function requestText(system: string, user: string): Promise<LlmResult<string>> {
  const apiKey = process.env[API_KEY_ENV];
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    console.error(`[llm] ${API_KEY_ENV} is not set — cannot call the model`);
    return { ok: false, error: "unknown" };
  }

  const endpoint = messagesEndpoint(process.env[BASE_URL_ENV] ?? DEFAULT_BASE_URL);
  const model = process.env[MODEL_ENV] ?? DEFAULT_MODEL;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: isTimeoutError(err) ? "timeout" : "unknown" };
  }

  if (!res.ok) {
    // Status + upstream body stay server-side; §2.1 forbids forwarding raw upstream errors.
    console.error(`[llm] HTTP ${res.status} from ${endpoint} (model ${model})`);
    return { ok: false, error: "unknown" };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    console.error("[llm] response body was not JSON");
    return { ok: false, error: "unknown" };
  }

  const text = extractText(body);
  if (text === null || text.trim() === "") {
    // A well-formed HTTP response carrying no usable answer is a failure to produce a diagram, not a
    // transport fault — `parse_failed` is the code the user-facing table describes for that.
    console.error("[llm] response contained no text block");
    return { ok: false, error: "parse_failed" };
  }

  return { ok: true, data: text };
}

/* ------------------------------------------------------------------ *
 * §2.4 — the shared entry point
 * ------------------------------------------------------------------ */

/** Strips model-added fences and parses. Kept exported so §1a's rebuild path can reuse it if needed. */
export function parseJsonLoose(text: string): LlmResult<unknown> {
  const stripped = text.replace(LEADING_JSON_FENCE, "").replace(TRAILING_JSON_FENCE, "").trim();
  try {
    return { ok: true, data: JSON.parse(stripped) };
  } catch {
    return { ok: false, error: "parse_failed" };
  }
}

/**
 * §2.4 in full: ask for JSON, and on a parse failure retry exactly once with the mandated system
 * message appended. A second failure is `parse_failed` — never a third attempt, never a guessed
 * extraction of a substring that merely looks like JSON.
 *
 * Returns the parsed value as `unknown`; validating it against §2.1/§2.2/§2.3 is the caller's job.
 */
export async function callLlmForJson(request: LlmJsonRequest): Promise<LlmResult<unknown>> {
  const system = `${request.system}\n\n${JSON_INSTRUCTION}`;

  const first = await requestText(system, request.user);
  if (!first.ok) return first;

  const parsed = parseJsonLoose(first.data);
  if (parsed.ok) return parsed;

  console.warn("[llm] first response was not valid JSON — retrying once (§2.4)");
  const retry = await requestText(`${system}\n\n${RETRY_SYSTEM_SUFFIX}`, request.user);
  if (!retry.ok) return retry;

  const reparsed = parseJsonLoose(retry.data);
  if (reparsed.ok) return reparsed;

  console.error("[llm] retry was also not valid JSON — parse_failed (§2.4)");
  return { ok: false, error: "parse_failed" };
}

/* ------------------------------------------------------------------ *
 * §2.1 / §2.3 — sentence-boundary truncation
 * ------------------------------------------------------------------ */

/**
 * Caps free text at `cap` characters by cutting at the last full sentence boundary before it, never
 * mid-sentence (§2.3's rule, which §2.1 explicitly reuses for `verdict.reason`).
 *
 * Falls back to the last word boundary when no sentence end falls inside the cap, so the result is
 * never a half-word either. Shared here rather than duplicated: §2.1 (verdict reason) and §2.3
 * (failureScenario) must cap identically.
 */
export function truncateAtSentence(text: string, cap: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return trimmed;

  const window = trimmed.slice(0, cap);
  for (let i = window.length - 1; i >= 0; i--) {
    const ch = window.charAt(i);
    if (ch === "." || ch === "!" || ch === "?") return window.slice(0, i + 1).trim();
  }

  const space = window.lastIndexOf(" ");
  return (space > 0 ? window.slice(0, space) : window).trim();
}
