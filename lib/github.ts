/**
 * lib/github.ts — GitHub REST ingestion (ARCHITECTURE.md §1.1–§1.2).
 *
 * Scope boundary: this module only FETCHES and decodes. It performs no truncation and no capping —
 * §1.3 (config truncation) and §1.4 (size caps) are owned by lib/repoSummary.ts, so that the size
 * budget lives in one place and the raw-vs-capped distinction stays legible.
 *
 * Context boundary (BOB.md §4 / RULES.md §3.1): the only files this module may ever request from the
 * target repo are tree (recursive=1) and the three named config files below. No source files, ever.
 */

import type { ErrorCode } from "./types";

const GITHUB_API = "https://api.github.com";
/** Per-request ceiling so a hung call can't hold the whole /api/analyze route open (§2.1 "timeout"). */
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "what-if-analogy-engine";

/* ------------------------------------------------------------------ *
 * Result envelope — internal to lib/, not the client-facing ApiResponse<T>
 * ------------------------------------------------------------------ */

export type FetchOk<T> = { ok: true; data: T };
export type FetchErr = { ok: false; error: ErrorCode };
export type FetchResult<T> = FetchOk<T> | FetchErr;

/* ------------------------------------------------------------------ *
 * §1.1 — URL parsing
 * ------------------------------------------------------------------ */

function isSafeSegment(value: string): boolean {
  // `[\w.-]+` per §1.1, minus values that are only dots — those would be normalised away by the
  // URL parser and turn `owner: ".."` into a request against a different path than intended.
  return /^[\w.-]+$/.test(value) && /[^.]/.test(value);
}

/**
 * §1.1 — the client sends `{ owner, repo }` pre-split, the server re-validates defensively.
 * Returns null on anything unsafe; the route turns that into `{ error: "invalid_url" }` (HTTP 400)
 * before any GitHub call is made.
 */
export function parseRepoUrl(
  owner: string,
  repo: string,
): { owner: string; repo: string } | null {
  const safe = /^[\w.-]+$/;
  if (!safe.test(owner) || !safe.test(repo)) return null;
  const stripped = repo.replace(/\.git$/, "").replace(/\.+$/, "");
  // `"repo.git"` strips clean; `"repo."` and `".git"` must not survive as an empty/dotted name.
  if (!isSafeSegment(owner) || !isSafeSegment(stripped)) return null;
  return { owner, repo: stripped };
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

interface RawResponse {
  status: number;
  rateLimitRemaining: string | null;
  body: unknown;
}

function isTimeoutError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("name" in err)) return false;
  const name = (err as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Single GET against api.github.com. Maps transport failures onto the §2.1 error codes. */
async function githubGet(path: string): Promise<FetchResult<RawResponse>> {
  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Never serve a stale tree — the requested value is the whole point of this call (§1.2).
      cache: "no-store",
    });

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON body (proxy error page etc.) — the status code still decides the outcome.
      body = null;
    }

    return {
      ok: true,
      data: {
        status: res.status,
        rateLimitRemaining: res.headers.get("X-RateLimit-Remaining"),
        body,
      },
    };
  } catch (err) {
    return { ok: false, error: isTimeoutError(err) ? "timeout" : "unknown" };
  }
}

/** §1.2 step 1 — 404 is `not_found`, 403 at zero remaining is `rate_limited`, everything else `unknown`. */
function classifyStatus(status: number, rateLimitRemaining: string | null): ErrorCode {
  if (status === 404) return "not_found";
  if (status === 403 && rateLimitRemaining === "0") return "rate_limited";
  return "unknown";
}

/* ------------------------------------------------------------------ *
 * Unknown-narrowing helpers (BOB.md §1: no `any`)
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readNumber(source: unknown, key: string): number | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(source: unknown, key: string): boolean | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

function readArray(source: unknown, key: string): unknown[] {
  if (!isRecord(source)) return [];
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

/* ------------------------------------------------------------------ *
 * §1.2 step 1 — repo metadata
 * ------------------------------------------------------------------ */

export interface RepoMeta {
  owner: string;
  repo: string;
  description: string | null;
  language: string | null;
  /**
   * Fetched per §1.2 step 1. NOTE: `RepoSummary` (§2.1) has no star field and §1.4 caps none, so this
   * currently goes no further than the fetch layer — kept here only because §1.2 names it explicitly.
   */
  stargazersCount: number;
  /** Never assume `main` or `master` — always read this field (§1.2). */
  defaultBranch: string;
}

/** §1.2 step 1. A failure here stops the pipeline — no subsequent call may be attempted. */
export async function fetchRepoMeta(
  owner: string,
  repo: string,
): Promise<FetchResult<RepoMeta>> {
  const res = await githubGet(`/repos/${owner}/${repo}`);
  if (!res.ok) return res;

  const { status, rateLimitRemaining, body } = res.data;
  if (status !== 200) {
    return { ok: false, error: classifyStatus(status, rateLimitRemaining) };
  }

  const defaultBranch = readString(body, "default_branch");
  // A 200 with no readable branch would make every downstream call unresolvable — treat as unknown.
  if (defaultBranch === null) return { ok: false, error: "unknown" };

  return {
    ok: true,
    data: {
      owner,
      repo,
      description: readString(body, "description"),
      language: readString(body, "language"),
      stargazersCount: readNumber(body, "stargazers_count") ?? 0,
      defaultBranch,
    },
  };
}

/* ------------------------------------------------------------------ *
 * §1.2 step 2 — recursive tree
 * ------------------------------------------------------------------ */

/* ── Source-only filter ───────────────────────────────────────────────────
 * The tree is the pipeline's only view of a repo's shape, so every path that survives here is a
 * path the model will reason about. Build output, dependency trees, agent/IDE config and lockfiles
 * are therefore dropped at the traversal boundary rather than being counted downstream — they add
 * no architectural signal, and a `.github` or `node_modules` entry reads to the model as a real
 * top-level folder of the app.
 *
 * The rule is deliberately blunt: a path is kept only when EVERY one of its segments is a plain,
 * non-dotted name and none is a known junk directory.
 */

/** Directories that hold dependencies, build output or tooling output — never app source. */
const IGNORED_DIRS = new Set<string>([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "web_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "obj",
  "bin",
  "tmp",
  "temp",
  "__pycache__",
  "venv",
  "test-results",
  "playwright-report",
  "storybook-static",
  "__MACOSX",
]);

/** Lockfiles: generated, enormous, and structurally meaningless. Compared lower-cased. */
const IGNORED_FILES = new Set<string>([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "gemfile.lock",
  "packages.lock.json",
  "go.sum",
]);

/** Generated artifacts — minified bundles, sourcemaps, recorded snapshots. */
const IGNORED_SUFFIXES: readonly string[] = [".min.js", ".min.css", ".map", ".snap", ".lock"];

/**
 * True when a path is real application source.
 *
 * Note what the leading-dot rule buys: `.gitignore`, `.env`, and the whole family of agent and IDE
 * config trees — `.github`, `.agents`, `.claude`, `.codex`, `.devin`, `.vscode`, `.idea` — are all
 * excluded by one condition, with no list to keep in sync as new tools appear.
 */
export function isSourcePath(path: string): boolean {
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment.startsWith(".")) return false;
    if (IGNORED_DIRS.has(segment.toLowerCase())) return false;
  }

  const basename = segments[segments.length - 1].toLowerCase();
  if (IGNORED_FILES.has(basename)) return false;
  for (const suffix of IGNORED_SUFFIXES) {
    if (basename.endsWith(suffix)) return false;
  }

  return true;
}

export interface TreePaths {
  /**
   * Source-only blob paths (see `isSourcePath`) — `sha`/`size`/`url` are discarded here and never
   * forwarded downstream.
   */
  paths: string[];
  /** `truncated: true` is noted, not an error (§1.2 step 2). */
  truncated: boolean;
}

export async function fetchTreePaths(
  owner: string,
  repo: string,
  ref: string,
): Promise<FetchResult<TreePaths>> {
  // A branch name may legitimately contain `/`; encode it so the ref isn't split across path segments.
  const res = await githubGet(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
  if (!res.ok) return res;

  const { status, rateLimitRemaining, body } = res.data;
  if (status !== 200) {
    return { ok: false, error: classifyStatus(status, rateLimitRemaining) };
  }

  const paths: string[] = [];
  for (const entry of readArray(body, "tree")) {
    const type = readString(entry, "type");
    const path = readString(entry, "path");
    // Source-only: junk folders, agent/IDE config and generated files never enter the pipeline.
    if (type === "blob" && path !== null && isSourcePath(path)) paths.push(path);
  }

  return { ok: true, data: { paths, truncated: readBoolean(body, "truncated") === true } };
}

/* ------------------------------------------------------------------ *
 * §1.2 steps 3–5 — contents API
 * ------------------------------------------------------------------ */

/**
 * Decoded UTF-8 text, or null when the file is absent/unreadable.
 * §1.2 steps 3–5: any non-200 is "absent", not an error state — so transport failures collapse to
 * null here too, since a missing optional config must never fail the whole analysis.
 */
async function fetchContentFile(
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  const res = await githubGet(`/repos/${owner}/${repo}/contents/${path}`);
  if (!res.ok) return null;

  const { status, body } = res.data;
  if (status !== 200) return null;
  // Contents API returns an array when the path resolves to a directory.
  if (Array.isArray(body)) return null;

  const content = readString(body, "content");
  const encoding = readString(body, "encoding");
  // Files over ~1MB come back with `encoding: "none"` and an empty `content` — treat as absent.
  if (content === null || encoding !== "base64") return null;

  return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf-8");
}

/** Tries each candidate in order and returns the first that resolves (§1.2 case/extension fallbacks). */
export async function fetchFirstAvailableFile(
  owner: string,
  repo: string,
  candidates: readonly string[],
): Promise<string | null> {
  for (const path of candidates) {
    const content = await fetchContentFile(owner, repo, path);
    if (content !== null) return content;
  }
  return null;
}

/** §1.2 case-fallback lists, exact-match spelling first. */
export const CONFIG_PATHS = {
  packageJson: ["package.json"],
  dockerCompose: ["docker-compose.yml", "docker-compose.yaml"],
  readme: ["README.md", "readme.md", "README.MD"],
} as const;

/* ------------------------------------------------------------------ *
 * §1.2 — full pipeline
 * ------------------------------------------------------------------ */

export interface RawConfigFiles {
  /** Raw decoded text; §1.3 truncation happens in lib/repoSummary.ts. null = absent. */
  packageJson: string | null;
  dockerCompose: string | null;
  readme: string | null;
}

export interface RawRepoData {
  meta: RepoMeta;
  treePaths: string[];
  treeTruncated: boolean;
  configs: RawConfigFiles;
}

/** The 5-call sequence from §1.2, in order. Callers get `invalid_url` before any network I/O. */
export async function fetchRepoData(
  owner: string,
  repo: string,
): Promise<FetchResult<RawRepoData>> {
  const parsed = parseRepoUrl(owner, repo);
  if (parsed === null) return { ok: false, error: "invalid_url" };

  // Call 1 — existence + default_branch. Failure here stops the pipeline (§1.2).
  const meta = await fetchRepoMeta(parsed.owner, parsed.repo);
  if (!meta.ok) return meta;

  // Call 2 — tree. Failure here is fatal too: without paths there is no RepoSummary to build.
  const tree = await fetchTreePaths(
    parsed.owner,
    parsed.repo,
    meta.data.defaultBranch,
  );
  if (!tree.ok) return tree;

  // Calls 3–5 — independent config fetches, none of which can fail the pipeline (§1.2 steps 3–5).
  const [packageJson, dockerCompose, readme] = await Promise.all([
    fetchFirstAvailableFile(parsed.owner, parsed.repo, CONFIG_PATHS.packageJson),
    fetchFirstAvailableFile(parsed.owner, parsed.repo, CONFIG_PATHS.dockerCompose),
    fetchFirstAvailableFile(parsed.owner, parsed.repo, CONFIG_PATHS.readme),
  ]);

  return {
    ok: true,
    data: {
      meta: meta.data,
      treePaths: tree.data.paths,
      treeTruncated: tree.data.truncated,
      configs: { packageJson, dockerCompose, readme },
    },
  };
}
