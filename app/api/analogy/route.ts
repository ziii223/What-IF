/**
 * app/api/analogy/route.ts — POST /api/analogy (ARCHITECTURE.md §2.2).
 *
 * No GitHub I/O. Receives the client's cached architecture[] + an analogyType, calls the LLM once
 * (§2.4 call contract), validates the response against §2.2's shape, and returns:
 *   { data: { analogyType, mapping[], summary, labelMappings[] } }
 *
 * Key invariant: labelMappings[] must contain exactly one entry per id in the request's
 * architecture[]. Missing ids fall back to the node's technical label on the client (§2.2), but
 * the prompt instructs the model to be exhaustive and the validator flags gaps as warnings.
 *
 * Schema-validation policy mirrors /api/analyze:
 *   - mapping[], summary, and labelMappings[] are the deliverable — any failure here is parse_failed.
 *   - Individual missing labelMappings entries are warnings only (the client falls back gracefully).
 */

import { NextResponse } from "next/server";

import { buildAnalogyPrompt } from "@/lib/analogyPrompts";
import { callLlmForJson } from "@/lib/llm";
import {
  type AnalogyMappingEntry,
  type AnalogyRequest,
  type AnalogyResult,
  type AnalogyType,
  type ArchitectureNode,
  type ArchitectureRole,
  type LabelMapping,
  type LlmErrorCode,
  ARCHITECTURE_ROLES,
  normalizeAnalogyType,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

interface ParsedRequest {
  architecture: ArchitectureNode[];
  analogyType: AnalogyType;
}

function parseRequest(body: unknown): ParsedRequest | null {
  if (!isRecord(body)) return null;

  // Preset or custom — either way the theme is free text reaching a prompt, so it goes through
  // the same normalizer (trim, collapse, strip, cap). null means nothing usable survived.
  const analogyType = normalizeAnalogyType(body.analogyType);
  if (analogyType === null) return null;

  if (!Array.isArray(body.architecture) || body.architecture.length === 0) return null;

  const nodes: ArchitectureNode[] = [];
  for (const entry of body.architecture) {
    if (!isRecord(entry)) return null;
    const id = asNonEmptyString(entry.id);
    const label = asNonEmptyString(entry.label);
    if (id === null || label === null) return null;

    const role: ArchitectureRole = isArchitectureRole(entry.role) ? entry.role : "unknown";
    const evidence = typeof entry.evidence === "string" ? entry.evidence.trim() : "";
    nodes.push({ id, label, role, evidence });
  }

  return { architecture: nodes, analogyType };
}

/* ------------------------------------------------------------------ *
 * §2.2 — LLM payload validation
 * ------------------------------------------------------------------ */

/**
 * Validates mapping[]. One entry per node is the ideal, but the validator is lenient: it drops
 * structurally invalid rows (missing componentLabel/analogyRole/explanation) rather than failing
 * the whole response. The deliverable is that at least one row came back clean.
 */
function parseMappingArray(value: unknown, warnings: string[]): AnalogyMappingEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const entries: AnalogyMappingEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) { warnings.push("mapping: dropped non-object row"); continue; }
    const componentLabel = asNonEmptyString(item.componentLabel);
    const analogyRole = asNonEmptyString(item.analogyRole);
    const explanation = asNonEmptyString(item.explanation);
    if (!componentLabel || !analogyRole || !explanation) {
      warnings.push("mapping: dropped row with missing field(s)");
      continue;
    }
    entries.push({ componentLabel, analogyRole, explanation });
  }
  return entries.length === 0 ? null : entries;
}

/**
 * Validates labelMappings[]. Missing entries for requested node ids are only warnings —
 * the client falls back to technical labels for those nodes (§2.2). Structural failures
 * (not an array, zero clean rows) are still a hard failure.
 */
function parseLabelMappings(
  value: unknown,
  requestedIds: string[],
  warnings: string[],
): LabelMapping[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const entries: LabelMapping[] = [];
  for (const item of value) {
    if (!isRecord(item)) { warnings.push("labelMappings: dropped non-object row"); continue; }
    const nodeId = asNonEmptyString(item.nodeId);
    const analogyLabel = asNonEmptyString(item.analogyLabel);
    if (!nodeId || !analogyLabel) {
      warnings.push("labelMappings: dropped row with missing nodeId/analogyLabel");
      continue;
    }
    entries.push({ nodeId, analogyLabel });
  }

  if (entries.length === 0) return null;

  // Warn for any node id the model omitted (client falls back, but log it).
  const returnedIds = new Set(entries.map((e) => e.nodeId));
  for (const id of requestedIds) {
    if (!returnedIds.has(id)) {
      warnings.push(`labelMappings: missing entry for node id "${id}" — client will fall back to technical label`);
    }
  }

  return entries;
}

interface AnalogyPayload {
  mapping: AnalogyMappingEntry[];
  summary: string;
  labelMappings: LabelMapping[];
}

/** Returns null when the deliverable is unusable. */
function parseAnalogyPayload(
  value: unknown,
  requestedIds: string[],
  warnings: string[],
): AnalogyPayload | null {
  if (!isRecord(value)) return null;

  const mapping = parseMappingArray(value.mapping, warnings);
  if (mapping === null) {
    warnings.push("payload: mapping was missing or had no usable rows");
    return null;
  }

  const summary = asNonEmptyString(value.summary);
  if (summary === null) {
    warnings.push("payload: summary was missing or empty");
    return null;
  }

  const labelMappings = parseLabelMappings(value.labelMappings, requestedIds, warnings);
  if (labelMappings === null) {
    warnings.push("payload: labelMappings was missing or had no usable rows");
    return null;
  }

  return { mapping, summary, labelMappings };
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

  const { architecture, analogyType }: AnalogyRequest = parsed;
  const requestedIds = architecture.map((n) => n.id);

  const { system, user } = buildAnalogyPrompt(architecture, analogyType);

  const llm = await callLlmForJson({ system, user });
  if (!llm.ok) return failure(llm.error, statusForLlm(llm.error));

  const warnings: string[] = [];
  const payload = parseAnalogyPayload(llm.data, requestedIds, warnings);

  if (payload === null) {
    for (const warning of warnings) console.warn(`[analogy] ${warning}`);
    return failure("parse_failed", statusForLlm("parse_failed"));
  }

  if (warnings.length > 0) {
    console.warn(`[analogy] ${warnings.join(" | ")}`);
  }

  const data: AnalogyResult = {
    analogyType,
    mapping: payload.mapping,
    summary: payload.summary,
    labelMappings: payload.labelMappings,
  };

  return NextResponse.json({ data }, { status: 200 });
}
