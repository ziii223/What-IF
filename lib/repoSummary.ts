/**
 * lib/repoSummary.ts — RepoSummary assembly, truncation and size capping.
 * Source of truth: ARCHITECTURE.md §1.3 (config truncation) and §1.4 (hard size caps).
 *
 * This module is PURE: it takes the already-fetched raw data from lib/github.ts and returns a
 * RepoSummary. No network, no I/O, no LLM. That separation is what keeps the 4000-character
 * prompt budget auditable in one file (BOB.md §2).
 *
 * Context boundary (BOB.md §4 / RULES.md §3.1): the only inputs are the tree paths and the three
 * named config files. Nothing here may reach for a source file that lib/github.ts did not fetch.
 */

import type { FetchResult, RawRepoData } from "./github";
import type { RepoSummary } from "./types";

/* ------------------------------------------------------------------ *
 * §1.4 — hard caps
 * ------------------------------------------------------------------ */

const CAP = {
  moduleFolders: 24,
  /** Top N extensions by count. */
  fileCountByExt: 10,
  dependencies: 20,
  services: 15,
  readmeExcerpt: 800,
} as const;

/**
 * Deepest folder path `moduleFolders` may report, counted in segments below the repo root.
 * 3 covers the shapes that actually carry architecture — `src/components` (2), `packages/web/src`
 * (3) — without descending into per-component leaf directories, which are single files each and
 * would crowd the cap with noise.
 */
const MODULE_FOLDER_MAX_DEPTH = 3;

/** §1.4 — the serialized summary must be UNDER this, JSON punctuation included. */
const TOTAL_CAP = 4000;

/** §1.4 — targets used only by the degradation ladder, once the summary is already over TOTAL_CAP. */
const DEGRADED = {
  dependencies: 10,
  moduleFolders: 12,
} as const;

/**
 * §1.3 "strip badge-shield URLs". Deliberately a short list of hosts that exist only to serve
 * badges. `github.com` is NOT in the list: a normal repo link is indistinguishable from a GitHub
 * Actions badge on that host, and stripping it wholesale would delete real README content.
 */
const BADGE_URL =
  /https?:\/\/[^\s)"']*(?:shields\.io|badgen\.net|badge\.fury\.io|badges\.gitter\.im|coveralls\.io|codecov\.io|travis-ci\.(?:org|com)|circleci\.com|david-dm\.org|snyk\.io|sonarcloud\.io|codeclimate\.com|codacy\.com)[^\s)"']*/gi;

const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
/** The HTML spelling of the same construct; READMEs use both interchangeably. */
const HTML_IMAGE = /<img\b[^>]*>/gi;
/** Links left behind once their image child was removed — reduces to `[](...)`. */
const EMPTIED_LINK = /\[\s*\]\([^)]*\)/g;

/* ------------------------------------------------------------------ *
 * Unknown-narrowing helper (BOB.md §1: no `any`)
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  // Mirrors lib/github.ts's private guard; kept private here too so neither module widens its surface.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * §1.3 — package.json
 * ------------------------------------------------------------------ */

function dependencyNames(source: unknown, key: string): string[] {
  if (!isRecord(source)) return [];
  const block = source[key];
  if (!isRecord(block)) return [];
  return Object.keys(block);
}

/**
 * §1.3 — package names only (versions dropped), `dependencies` prioritized over `devDependencies`,
 * capped at 20 combined. A manifest that does not parse is treated as absent, never fatal.
 */
function extractDependencies(packageJson: string | null): string[] {
  if (packageJson === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    console.warn("[repoSummary] package.json did not parse as JSON — treating as absent (§1.3)");
    return [];
  }

  const ordered = [
    ...dependencyNames(parsed, "dependencies"),
    ...dependencyNames(parsed, "devDependencies"),
  ];

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of ordered) {
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
  }

  // §1.3 names no ordering, so each block keeps its package.json declaration order — the only
  // grouping signal the file itself carries — and the cap then takes the head of that list.
  return merged.slice(0, CAP.dependencies);
}

/* ------------------------------------------------------------------ *
 * §1.3 — docker-compose.yml (regex only; no YAML parser dependency)
 * ------------------------------------------------------------------ */

/**
 * §1.3 — top-level `services:` block key names only, extracted by regex. The indentation rule and
 * the "stop at the next top-level key" boundary are exactly the ones the spec gives; a compose file
 * that uses 4-space indentation or a trailing comment after the service name will yield fewer names
 * than it has services, which is the accepted MVP trade-off (no yaml dependency).
 */
function extractServices(dockerCompose: string | null): string[] {
  if (dockerCompose === null) return [];

  const services: string[] = [];
  const seen = new Set<string>();
  let insideServices = false;

  for (const line of dockerCompose.split(/\r?\n/)) {
    if (/^services:\s*$/.test(line)) {
      insideServices = true;
      continue;
    }
    if (!insideServices) continue;
    // Any non-indented line is the next top-level key — the services block has ended.
    if (/^\S/.test(line)) break;

    const match = /^\s{2}([\w-]+):\s*$/.exec(line);
    if (match === null) continue;

    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    services.push(name);
    if (services.length >= CAP.services) break;
  }

  return services;
}

/* ------------------------------------------------------------------ *
 * §1.4 — tree-derived fields
 * ------------------------------------------------------------------ */

/**
 * §1.4 — the repo's own folders, depth 1 to MODULE_FOLDER_MAX_DEPTH, ranked by how many files sit
 * under each and capped at CAP.moduleFolders.
 *
 * Every ancestor prefix of a file counts that file: `src/components/Button.tsx` votes for both
 * `src` and `src/components`, so a folder's score is its whole subtree. Ranking by score rather
 * than alphabetically is what keeps the list useful once the cap bites — the shallow folders an
 * architecture is actually made of outrank the leaf directories, which is the opposite of what a
 * depth-1-only list gives you on a repo whose code all lives under `src/`.
 *
 * Deterministic by construction: ties break on path with the default comparator rather than
 * `localeCompare`, so a given tree yields byte-identical output on any server locale/ICU build.
 */
function extractModuleFolders(treePaths: string[]): string[] {
  /** Path → number of files beneath it. Read through `tally` to stay safe against inherited keys. */
  const counts: Record<string, number> = {};

  for (const path of treePaths) {
    const segments = path.split("/");
    // Segments that are followed by the filename — i.e. every folder prefix of this file.
    const depth = Math.min(segments.length - 1, MODULE_FOLDER_MAX_DEPTH);
    for (let level = 1; level <= depth; level++) {
      const folder = segments.slice(0, level).join("/");
      counts[folder] = tally(counts, folder) + 1;
    }
  }

  return Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, CAP.moduleFolders);
}

/** `null` for a root-level file (`README`) or a dotfile (`.gitignore`), which have no extension. */
function fileExtension(path: string): string | null {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  // `dot <= 0` covers "no dot" and a leading dot; the last case rejects a trailing dot.
  if (dot <= 0 || dot === basename.length - 1) return null;
  return basename.slice(dot + 1).toLowerCase();
}

/**
 * Own-key read. Necessary because plain bracketed reads see inherited members: a file ending in
 * `.constructor` would otherwise pick up `Object.prototype.constructor` and write a string into a
 * `Record<string, number>`, corrupting both the count and the tie-break sort below.
 */
function tally(counts: Record<string, number>, ext: string): number {
  return Object.prototype.hasOwnProperty.call(counts, ext) ? counts[ext] : 0;
}

/** §1.4 — top 10 extensions by count. Ties break on extension name so the result is deterministic. */
function countFileExtensions(treePaths: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of treePaths) {
    const ext = fileExtension(path);
    if (ext === null) continue;
    counts[ext] = tally(counts, ext) + 1;
  }

  const ranked = Object.keys(counts).sort(
    // Ties break on extension name so the same tree always yields the same key order.
    (a, b) => counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0),
  );

  const result: Record<string, number> = {};
  for (const ext of ranked.slice(0, CAP.fileCountByExt)) result[ext] = counts[ext];
  return result;
}

/* ------------------------------------------------------------------ *
 * §1.3 — README
 * ------------------------------------------------------------------ */

function stripReadmeDecorations(readme: string): string {
  return readme
    .replace(MARKDOWN_IMAGE, " ")
    .replace(HTML_IMAGE, " ")
    .replace(BADGE_URL, " ")
    .replace(EMPTIED_LINK, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * §1.3 — first 800 characters after image/badge stripping.
 * Returns null when no README was fetched, and also when one was fetched but had no prose left
 * after stripping (a badge-only README): an empty string would be a meaningless prompt field.
 */
function buildReadmeExcerpt(readme: string | null): string | null {
  if (readme === null) return null;
  const stripped = stripReadmeDecorations(readme);
  if (stripped.length === 0) return null;
  return stripped.slice(0, CAP.readmeExcerpt);
}

/* ------------------------------------------------------------------ *
 * §1.4 — total size budget
 * ------------------------------------------------------------------ */

function serializedLength(summary: RepoSummary): number {
  return JSON.stringify(summary).length;
}

/**
 * §1.4 — if the serialized summary is not under 4000 characters, degrade in the ONE order the spec
 * fixes: drop `readmeExcerpt`, then trim `dependencies` to 10, then `moduleFolders` to 12. Only
 * after all three still leave it over budget does this fail.
 * The applied step is logged server-side; §2.1's field list is closed, so no schema field reports it.
 */
function enforceTotalBudget(summary: RepoSummary): RepoSummary | null {
  if (serializedLength(summary) < TOTAL_CAP) return summary;

  const ladder: Array<[string, (s: RepoSummary) => RepoSummary]> = [
    ["readmeExcerpt → null", (s) => ({ ...s, readmeExcerpt: null })],
    [
      `dependencies → ${DEGRADED.dependencies}`,
      (s) => ({ ...s, dependencies: s.dependencies.slice(0, DEGRADED.dependencies) }),
    ],
    [
      `moduleFolders → ${DEGRADED.moduleFolders}`,
      (s) => ({ ...s, moduleFolders: s.moduleFolders.slice(0, DEGRADED.moduleFolders) }),
    ],
  ];

  let current = summary;
  for (const [label, apply] of ladder) {
    current = apply(current);
    if (serializedLength(current) < TOTAL_CAP) {
      console.warn(`[repoSummary] over ${TOTAL_CAP} chars — applied degradation: ${label}`);
      return current;
    }
  }

  console.error(
    `[repoSummary] still ${serializedLength(current)} chars after every degradation — failing (§1.4)`,
  );
  return null;
}

/* ------------------------------------------------------------------ *
 * §1.3–§1.4 — assembly
 * ------------------------------------------------------------------ */

/**
 * Builds the capped, LLM-ready digest from the raw 5-call payload.
 * Synchronous and pure: the same RawRepoData always yields the same RepoSummary.
 *
 * Uses the shared internal `FetchResult` envelope so the /api/analyze route (2.5) can treat both
 * stage errors identically. The only error reachable here is `parse_failed` — the summary could not
 * be brought under the §1.4 budget, which is a failure to read the repo's structure, not a fetch fault.
 */
export function buildRepoSummary(raw: RawRepoData): FetchResult<RepoSummary> {
  const summary: RepoSummary = {
    name: raw.meta.repo,
    description: raw.meta.description,
    language: raw.meta.language,
    moduleFolders: extractModuleFolders(raw.treePaths),
    fileCountByExt: countFileExtensions(raw.treePaths),
    // §1.3 reads docker-compose as the pipeline's only Docker signal; a bare Dockerfile is not fetched.
    hasDocker: raw.configs.dockerCompose !== null,
    services: extractServices(raw.configs.dockerCompose),
    dependencies: extractDependencies(raw.configs.packageJson),
    readmeExcerpt: buildReadmeExcerpt(raw.configs.readme),
    // §1.2 step 2's own `truncated` flag, passed through — NOT a marker for the §1.4 degradation.
    truncated: raw.treeTruncated,
  };

  const sized = enforceTotalBudget(summary);
  if (sized === null) return { ok: false, error: "parse_failed" };
  return { ok: true, data: sized };
}
