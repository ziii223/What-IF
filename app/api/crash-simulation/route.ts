/**
 * app/api/crash-simulation/route.ts — POST /api/crash-simulation (ARCHITECTURE.md §2.3).
 *
 * No GitHub I/O. Receives the full ArchitectureNode for the clicked component plus the current
 * analogy state, calls the LLM once (§2.4 call contract), validates the single `failureScenario`
 * string, and returns:
 *   { data: { failureScenario: string } }
 *
 * `failureScenario` is server-truncated at 400 chars on the last full-sentence boundary (§2.3),
 * using the shared `truncateAtSentence()` helper from lib/llm.ts (avoids duplicating that logic).
 *
 * Error codes: "parse_failed" | "timeout" | "unknown" — no GitHub codes (§2.3, §2.2 parity).
 */

import { NextResponse } from "next/server";

import { buildCrashPrompt } from "@/lib/analogyPrompts";
import { callLlmForJson, truncateAtSentence } from "@/lib/llm";
import {
  ARCHITECTURE_ROLES,
  normalizeAnalogyType,
  type AnalogyMappingEntry,
  type ArchitectureNode,
  type ArchitectureRole,
  type CrashSimulationRequest,
  type CrashSimulationResult,
  type LlmErrorCode,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** §2.3: `failureScenario` is capped at 400 characters, sentence-boundary truncation. */
const FAILURE_SCENARIO_CAP = 400;

/* ------------------------------------------------------------------ *
 * Unknown-narrowing helpers (BOB.md §1: no `any`)
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isArchitectureRole(value: unknown): value is ArchitectureRole {
  return typeof value === "string" && ARCHITECTURE_ROLES.indexOf(value as ArchitectureRole) !== -1;
}

/* ------------------------------------------------------------------ *
 * Request validation
 * ------------------------------------------------------------------ */

function parseRequest(body: unknown): CrashSimulationRequest | null {
  if (!isRecord(body)) return null;

  // Validate `node` (full ArchitectureNode required — evidence grounds the narrative, §2.3).
  if (!isRecord(body.node)) return null;
  const node = body.node;

  const id = asNonEmptyString(node.id);
  const label = asNonEmptyString(node.label);
  if (id === null || label === null) return null;

  const role: ArchitectureRole = isArchitectureRole(node.role) ? node.role : "unknown";
  const evidence = typeof node.evidence === "string" ? node.evidence.trim() : "";

  const parsedNode: ArchitectureNode = { id, label, role, evidence };

  // Validate `analogyType` — preset or custom, same normalizer as /api/analogy (§2.3).
  const analogyType = normalizeAnalogyType(body.analogyType);
  if (analogyType === null) return null;

  // Validate `analogyMapping` — nullable per §2.3 (client sends null before first /api/analogy call).
  let analogyMapping: AnalogyMappingEntry | null = null;
  if (body.analogyMapping !== null && body.analogyMapping !== undefined) {
    if (!isRecord(body.analogyMapping)) return null;
    const componentLabel = asNonEmptyString(body.analogyMapping.componentLabel);
    const analogyRole = asNonEmptyString(body.analogyMapping.analogyRole);
    const explanation = asNonEmptyString(body.analogyMapping.explanation);
    if (!componentLabel || !analogyRole || !explanation) return null;
    analogyMapping = { componentLabel, analogyRole, explanation };
  }

  return {
    node: parsedNode,
    analogyType,
    analogyMapping,
  };
}

/* ------------------------------------------------------------------ *
 * §2.3 — LLM payload validation
 * ------------------------------------------------------------------ */

/**
 * Validates and extracts `failureScenario` from the LLM-parsed JSON.
 * This is the sole deliverable — if it's absent or empty the response is unusable.
 */
function parseCrashPayload(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return asNonEmptyString(value.failureScenario);
}

/* ------------------------------------------------------------------ *
 * Response helpers
 * ------------------------------------------------------------------ */

function failure(error: LlmErrorCode, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

function statusForLlm(error: LlmErrorCode): number {
  switch (error) {
    case "timeout": return 504;
    case "parse_failed": return 422;
    default: return 502;
  }
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("parse_failed", statusForLlm("parse_failed"));
  }

  const parsed = parseRequest(body);
  if (parsed === null) {
    return failure("parse_failed", statusForLlm("parse_failed"));
  }

  const { node, analogyType, analogyMapping }: CrashSimulationRequest = parsed;

  const { system, user } = buildCrashPrompt(node, analogyType, analogyMapping);

  const llm = await callLlmForJson({ system, user });
  if (!llm.ok) return failure(llm.error, statusForLlm(llm.error));

  const rawScenario = parseCrashPayload(llm.data);
  if (rawScenario === null) {
    console.warn("[crash-simulation] LLM response missing or empty failureScenario");
    return failure("parse_failed", statusForLlm("parse_failed"));
  }

  // §2.3: server-side truncation at 400-char cap, last full-sentence boundary (never mid-sentence).
  const failureScenario = truncateAtSentence(rawScenario, FAILURE_SCENARIO_CAP);

  const data: CrashSimulationResult = { failureScenario };
  return NextResponse.json({ data }, { status: 200 });
}
