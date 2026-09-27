/**
 * app/api/analyze/route.ts — POST /api/analyze (ARCHITECTURE.md §2.1).
 *
 * Pipeline: lib/github.ts (2.2, §1.2's 5 calls) → lib/repoSummary.ts (2.3, §1.3–§1.4 caps) →
 * one LLM call (§2.1 schema, including `verdict` — same prompt, same round trip) → lib/llm.ts
 * (§2.4 call contract) → schema validation → lib/mermaidSanitize.ts (2.4, §1's 8 steps) → response.
 *
 * Context boundary (BOB.md §3.3 / §4, RULES.md §3.1): the model receives the capped `RepoSummary`
 * object and nothing else. No raw tree, no file blobs, and no source file from the target repo is
 * read at any point in this route.
 *
 * Schema-validation policy — the two halves of the §2.1 payload fail differently, deliberately:
 *   - `mermaidCode` + `architecture` are the deliverable. Unusable output here is `parse_failed`.
 *   - `verdict` is optional enrichment. Anything wrong with it (absent, bad `friction`, non-string
 *     `reason`) degrades to `null` and the client renders no badge (§2.1). It must never turn an
 *     otherwise-valid diagram into an error.
 */

import { NextResponse } from "next/server";

import { fetchRepoData } from "@/lib/github";
import { callLlmForJson, truncateAtSentence } from "@/lib/llm";
import { sanitizeMermaid } from "@/lib/mermaidSanitize";
import { buildRepoSummary } from "@/lib/repoSummary";
import {
  ARCHITECTURE_ROLES,
  FRICTION_LEVELS,
  type AnalyzeResult,
  type ArchitectureNode,
  type ArchitectureRole,
  type ErrorCode,
  type FrictionLevel,
  type RepoSummary,
  type Verdict,
} from "@/lib/types";

/** lib/github.ts decodes base64 via `Buffer`, so this route cannot run on the Edge runtime. */
export const runtime = "nodejs";
/** Never cache an analysis — the response is a function of a repo that can change between calls. */
export const dynamic = "force-dynamic";

/** §2.1 — "capped at ~160 characters (one sentence)", applied at a sentence boundary via §2.3's rule. */
const VERDICT_REASON_CAP = 160;

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

function isFrictionLevel(value: unknown): value is FrictionLevel {
  return typeof value === "string" && FRICTION_LEVELS.indexOf(value as FrictionLevel) !== -1;
}

/* ------------------------------------------------------------------ *
 * §2.1 — LLM payload validation
 * ------------------------------------------------------------------ */

/**
 * Validates `architecture[]` leniently, one entry at a time.
 *
 * A node is dropped only when it is unusable (no id/label). An unrecognised `role` is coerced to
 * `"unknown"` rather than dropping the node: §2.1's own union contains `"unknown"`, and RULES.md §6
 * expects unknown-role nodes to reach the client so the crash narrative can hedge about them.
 * Dropping real architecture because the model picked an off-vocabulary word would lose structure
 * the repo genuinely has.
 */
function parseArchitecture(value: unknown, warnings: string[]): ArchitectureNode[] | null {
  if (!Array.isArray(value)) return null;

  const nodes: ArchitectureNode[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!isRecord(entry)) {
      warnings.push("architecture: dropped a non-object entry");
      continue;
    }

    const id = asNonEmptyString(entry.id);
    const label = asNonEmptyString(entry.label);
    if (id === null || label === null) {
      warnings.push("architecture: dropped an entry with no usable id/label");
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`architecture: dropped duplicate node id \`${id}\``);
      continue;
    }
    seen.add(id);

    let role: ArchitectureNode["role"] = "unknown";
    if (isArchitectureRole(entry.role)) {
      role = entry.role;
    } else {
      warnings.push(`architecture: node \`${id}\` had an off-vocabulary role — coerced to "unknown"`);
    }

    // `evidence` is required by §2.1 but is only ever display/diagnostic text here, so a missing one
    // is an empty string rather than a reason to discard the node.
    const evidence = typeof entry.evidence === "string" ? entry.evidence.trim() : "";
    if (evidence === "") warnings.push(`architecture: node \`${id}\` carried no evidence`);

    nodes.push({ id, label, role, evidence });
  }

  return nodes.length === 0 ? null : nodes;
}

/**
 * §2.1 — `verdict` is optional enrichment. Every failure mode returns `null` (no badge, no error),
 * never a `parse_failed` for the response it rode in on.
 */
function parseVerdict(value: unknown): Verdict | null {
  if (!isRecord(value)) return null;
  if (!isFrictionLevel(value.friction)) return null;

  const capped = truncateAtSentence(typeof value.reason === "string" ? value.reason : "", VERDICT_REASON_CAP);
  if (capped === "") return null;

  return { friction: value.friction, reason: capped };
}

interface AnalyzePayload {
  mermaidCode: string;
  architecture: ArchitectureNode[];
  verdict: Verdict | null;
}

/** Returns null when the deliverable half of the payload is unusable. */
function parseAnalyzePayload(value: unknown, warnings: string[]): AnalyzePayload | null {
  if (!isRecord(value)) return null;

  const mermaidCode = asNonEmptyString(value.mermaidCode);
  if (mermaidCode === null) {
    warnings.push("payload: mermaidCode was missing or empty");
    return null;
  }

  const architecture = parseArchitecture(value.architecture, warnings);
  if (architecture === null) {
    warnings.push("payload: architecture was missing, not an array, or had no usable nodes");
    return null;
  }

  // Deliberately tolerant: an absent verdict is a normal, expected outcome (§2.1).
  return { mermaidCode, architecture, verdict: parseVerdict(value.verdict) };
}

/** Success and failure per §2.1; `ApiFailure` carries no `data` key at all. */
function failure(error: ErrorCode, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

/** §1.1 fixes `invalid_url` → 400. The rest are conventional and only ever read for their `error`. */
function statusFor(error: ErrorCode): number {
  switch (error) {
    case "invalid_url":
      return 400;
    case "not_found":
      return 404;
    case "rate_limited":
      return 429;
    case "timeout":
      return 504;
    case "parse_failed":
      return 422;
    default:
      return 502;
  }
}

/* ------------------------------------------------------------------ *
 * Prompt assembly (§2.1 schema)
 * ------------------------------------------------------------------ */

/**
 * The mermaid constraints restate what lib/mermaidSanitize.ts enforces. That is intentional, not
 * redundancy: the sanitizer is the gate, the prompt is the attempt to never need it. Every rule here
 * that the model follows is a diagram that renders instead of one that comes back `parse_failed`.
 */
const SYSTEM_PROMPT = [
  "You are a software-architecture analyst. You are given a capped digest of a public GitHub",
  "repository and must return a mermaid flowchart of its architecture, the architecture as data,",
  "and a short onboarding-friction verdict.",
  "",
  "Grounding (non-negotiable):",
  "- Reason ONLY from the digest you are given. Never invent files, services, dependencies, or",
  "  relationships the digest does not support.",
  "- Every node's `evidence` must point at a real signal from the digest: a folder name, a",
  "  dependency, a service, a language, a README phrase.",
  "- If a component's role is not clear from the digest, use the role \"unknown\" rather than guessing.",
  "",
  "Node labels — the single most important rule:",
  "- The diagram is a MAP OF THIS REPOSITORY, not a generic architecture sketch. Every node label",
  "  MUST be one of the paths listed in the digest's `moduleFolders`, copied character-for-character.",
  "  Those entries are the repo's real folders at depth 1-3 (e.g. `src`, `src/components`, `api`,",
  "  `lib/utils`, `packages/web/src`).",
  "- NEVER label a node with an invented product name, a vendor name, or an abstract role",
  "  (\"API Gateway\", \"Auth Service\", \"Database Layer\"). If a path is not in `moduleFolders`,",
  "  it does not exist in this repo and must not appear as a node.",
  "- Prefer the folders that hold real code over asset, documentation, fixture and test folders",
  "  when the digest gives you both. Aim for the 4-12 folders a newcomer must understand.",
  "- A node `id` is that same folder path made identifier-safe: replace every `/`, `.` and `-`",
  "  with `_`, and prefix a leading digit with `n`. `src/components` becomes `src_components`.",
  "",
  "Mermaid rules:",
  "- Begin with exactly `flowchart TD` or `graph TD`. (TD, TB, LR, RL and BT are all acceptable.)",
  "- Node syntax is limited to `id[Label]`, `id(Label)` and `id{Label}`. Arrows are `-->` only.",
  "- `subgraph name[Title]` ... `end` blocks are allowed. Grouping related folders under a",
  "  subgraph titled with their shared parent path is encouraged.",
  "- Node ids must be unique and made only of letters, digits and underscores.",
  "- Label text must NOT contain any of these characters: [ ] ( ) { } \" `. A `/` is fine and",
  "  expected — folder paths are the labels.",
  "- Do NOT use `click`, `classDef`, `class`, `style`, `linkStyle`, `%%{...}%%` directives, or any",
  "  HTML tag. These are rejected outright.",
  "- Use between 3 and 40 nodes, and at most 60 arrows.",
  "",
  "architecture[] rules:",
  "- Return exactly one entry per node that appears in `mermaidCode`.",
  "- Each entry's `id` MUST be character-for-character the same as that node's id in the diagram.",
  "- Each entry's `label` MUST be the repo folder path itself (`src/components`), not a display",
  "  name for it. This array is what the UI keys its per-folder annotations off, so the label has",
  "  to be the same string that appears in the diagram.",
  "- `role` must be exactly one of: frontend, api, database, queue, cache, worker, config, unknown.",
  "",
  "verdict rules:",
  "- `friction` must be exactly \"low\", \"moderate\" or \"high\".",
  "- `reason` is ONE sentence, at most 160 characters, and may cite only signals present in the",
  "  digest you were given (for example: no README, no dependency manifest, services declared but",
  "  undocumented, or many nodes whose role could only be inferred).",
  "- Never state a fact about the codebase that the digest does not show.",
  "- If the digest does not support a judgement, set `verdict` to null.",
].join("\n");

const JSON_SHAPE = [
  "{",
  '  "mermaidCode": "flowchart TD\\n  src_components[src/components] --> src_api[src/api]",',
  '  "architecture": [',
  '    { "id": "src_components", "label": "src/components", "role": "frontend", "evidence": "src/components/ in tree; 24 files" }',
  "  ],",
  '  "verdict": { "friction": "moderate", "reason": "Services are declared but undocumented." }',
  "}",
].join("\n");

function buildUserPrompt(summary: RepoSummary): string {
  const lines = [
    "Repository digest (this is the complete input — nothing else was sent to you):",
    "",
    JSON.stringify(summary, null, 2),
    "",
  ];

  // PRD.md §6 — a repo with no config files at all must be inferred from structure alone, and the
  // prompt has to say so explicitly rather than leaving the model to notice the absent fields.
  const hasAnyConfig =
    summary.dependencies.length > 0 || summary.services.length > 0 || summary.readmeExcerpt !== null;
  if (!hasAnyConfig) {
    lines.push(
      "No package manifest, no docker-compose services and no README were found for this repo.",
      "Infer the architecture from file and folder structure alone, and say so in the evidence fields.",
      "",
    );
  }

  lines.push("Return ONLY a single JSON object with exactly these three keys:", "", JSON_SHAPE);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("invalid_url", statusFor("invalid_url"));
  }

  // §1.1 — the client sends `{ owner, repo }` pre-split and the server re-validates. A missing or
  // non-string field is the same class of bad input as an unsafe one, so both are `invalid_url`.
  const owner = isRecord(body) ? asNonEmptyString(body.owner) : null;
  const repo = isRecord(body) ? asNonEmptyString(body.repo) : null;
  if (owner === null || repo === null) {
    return failure("invalid_url", statusFor("invalid_url"));
  }

  // 2.2 — §1.2's 5-call sequence. `invalid_url` is returned here before any network I/O.
  const raw = await fetchRepoData(owner, repo);
  if (!raw.ok) return failure(raw.error, statusFor(raw.error));

  // 2.3 — §1.3 truncation and §1.4 size caps.
  const summary = buildRepoSummary(raw.data);
  if (!summary.ok) return failure(summary.error, statusFor(summary.error));

  // §2.1 — one call, one round trip, `verdict` rides along (§2.4's call contract).
  const llm = await callLlmForJson({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(summary.data),
  });
  if (!llm.ok) return failure(llm.error, statusFor(llm.error));

  const warnings: string[] = [];
  const payload = parseAnalyzePayload(llm.data, warnings);

  // 2.4 — §1's 8 steps, on the way out, before the string can reach a client.
  const sanitized = payload === null ? null : sanitizeMermaid(payload.mermaidCode);

  if (payload === null || sanitized === null || !sanitized.ok) {
    if (sanitized !== null && !sanitized.ok) {
      // The sanitizer's own diagnostic names the step and is for this log only (BOB.md §3.1).
      console.error(`[analyze] mermaid rejected by sanitizer: ${sanitized.reason}`);
    }
    for (const warning of warnings) console.warn(`[analyze] ${warning}`);
    return failure("parse_failed", statusFor("parse_failed"));
  }

  if (warnings.length > 0) {
    // Never surfaced to the client — §2.1's payload shape has no warnings field.
    console.warn(`[analyze] ${warnings.join(" | ")}`);
  }

  const data: AnalyzeResult = {
    repoSummary: summary.data,
    mermaidCode: sanitized.data.code,
    architecture: payload.architecture,
    verdict: payload.verdict,
  };

  return NextResponse.json({ data }, { status: 200 });
}
