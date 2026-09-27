# ARCHITECTURE.md

## §1. GitHub Ingestion Spec

### 1.1 URL parsing (server-side, `lib/github.ts`, `parseRepoUrl()`)
Client sends `{ owner, repo }` already split (per PRD.md §4), but the server re-validates defensively:
```ts
function parseRepoUrl(owner: string, repo: string): { owner: string; repo: string } | null {
  const safe = /^[\w.-]+$/;
  if (!safe.test(owner) || !safe.test(repo)) return null;
  return { owner, repo: repo.replace(/\.git$/, "") };
}
```
If null → return `{ error: "invalid_url" }`, HTTP 400, before any GitHub call.

### 1.2 Endpoint call order (exact sequence, `lib/github.ts`)
1. `GET https://api.github.com/repos/{owner}/{repo}`
   - Purpose: existence check + `default_branch` field (handles `main` vs `master` vs anything else — never assume, always read this field).
   - 404 → `{ error: "not_found" }`, stop pipeline, do not attempt subsequent calls.
   - 403 with `X-RateLimit-Remaining: 0` header → `{ error: "rate_limited" }`, stop pipeline.
   - 200 → extract `default_branch`, `language`, `stargazers_count`, `description`.
2. `GET https://api.github.com/repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1`
   - `truncated: true` in response → note this in RepoSummary, do not error.
   - Filter response `tree[]` to `type === "blob"`, extract `path` only (discard `sha`, `size`, `url` fields — not needed downstream, don't forward them to the LLM).
3. `GET https://api.github.com/repos/{owner}/{repo}/contents/package.json` — try/catch, on any non-200 treat as absent (not an error state).
4. `GET https://api.github.com/repos/{owner}/{repo}/contents/docker-compose.yml` — same pattern. Also try `docker-compose.yaml` as fallback if `.yml` 404s.
5. `GET https://api.github.com/repos/{owner}/{repo}/contents/README.md` — same pattern. Also try `readme.md`, `README.MD` as case-fallback only if exact match 404s (GitHub Contents API is case-sensitive on some setups).

All contents-API responses come back `base64`-encoded in a `content` field — decode with `Buffer.from(content, "base64").toString("utf-8")` before use.

### 1.3 Config file truncation (applied before RepoSummary assembly)
- `package.json`: parse as JSON; if parse fails, treat as absent (log, don't throw). Extract only `dependencies` and `devDependencies` keys (the package names, not versions) — cap at 20 combined, prioritizing `dependencies` over `devDependencies` if over cap.
- `docker-compose.yml`: do NOT full-YAML-parse for MVP (avoid adding a yaml parser dependency). Regex-extract top-level `services:` block key names (lines matching `^\s{2}[\w-]+:\s*$` under the `services:` line). Cap at 15.
- `README.md`: strip markdown image syntax (`![...](...)`), strip badge-shield URLs, take first 800 characters of remaining text.

### 1.4 Size caps into the LLM prompt (hard limits, enforced in `lib/repoSummary.ts`)
| Field | Cap |
|---|---|
| `moduleFolders` | 24 entries — source folder paths, depth 1–3, ranked by descendant file count (ties alphabetical) |
| `fileCountByExt` | top 10 extensions by count |
| `dependencies` | 20 package names |
| `services` | 15 service names |
| `readmeExcerpt` | 800 chars |
| Total serialized `RepoSummary` JSON | must be under 4000 characters — if over, drop `readmeExcerpt` first, then trim `dependencies` to 10, then `moduleFolders` to 12, in that order, before erroring |

`moduleFolders` is the field the diagram's node labels come from (§2.1), so it is ranked by how much code sits under each path rather than sorted alphabetically: a repo whose source all lives under `src/` must still surface `src/components` and `src/api`, and a depth-1-only list would show it a single node.

## §2. API Contracts

### 2.1 `POST /api/analyze`
**Request:**
```json
{ "owner": "string", "repo": "string" }
```
**Success response (200):**
```json
{
  "data": {
    "repoSummary": {
      "name": "string",
      "description": "string | null",
      "language": "string | null",
      "moduleFolders": ["string"],
      "fileCountByExt": { "ts": 42, "json": 5 },
      "hasDocker": true,
      "services": ["string"],
      "dependencies": ["string"],
      "readmeExcerpt": "string | null",
      "truncated": false
    },
    "mermaidCode": "string",
    "architecture": [
      {
        "id": "string",
        "label": "string",
        "role": "frontend | api | database | queue | cache | worker | config | unknown",
        "evidence": "string"
      }
    ],
    "verdict": { "friction": "low" | "moderate" | "high", "reason": "string" } | null
  }
}
```
**The diagram is the repository's own structure.** Each `architecture[].label` is a folder path copied character-for-character out of that repo's `moduleFolders` (`src/components`, `api`, `lib/utils`) — never an invented product or role name like `API Gateway`. `id` is that same path made identifier-safe (`src/components` → `src_components`), and `label` must match the text drawn in `mermaidCode` for the same node, because every per-folder annotation in the UI (hover tooltip, crash narrative) joins on it. The prompt states this as the call's most important rule; grounding is what makes the diagram recognisable to someone who knows the repo.

`verdict` is generated by the **same** LLM call as `mermaidCode`/`architecture` — one prompt, one round trip, no additional latency and no separate loading state. `reason` is capped at ~160 characters (one sentence, enforced the same way `failureScenario` is capped in §2.3) — it's a badge caption, not a paragraph. The prompt must ground `reason` only in fields already present in the `RepoSummary` this same call already received (missing README, undocumented services, high proportion of `role: "unknown"` nodes, etc.) — never invent a friction cause the input doesn't support (RULES.md §3).

`verdict` is treated as **optional enrichment, not a required field**: if it's absent from the parsed response, or `friction` isn't exactly one of `low`/`moderate`/`high`, the client sets it to `null` and simply doesn't render the badge — this must never turn an otherwise-valid `mermaidCode`/`architecture` response into a `parse_failed` error. The diagram is the deliverable; the verdict is a bonus on top of it.

**Error response (any non-200):**
```json
{ "error": "invalid_url" | "not_found" | "rate_limited" | "parse_failed" | "timeout" | "unknown" }
```
Client maps each `error` code to exactly one user-facing string (table in §3). Never forward raw GitHub or LLM error bodies to the client.

### 2.2 `POST /api/analogy`
**Request:**
```json
{
  "architecture": [ /* ArchitectureNode[], same shape as above, passed back from client cache */ ],
  "analogyType": "restaurant" | "airport" | "hospital" | "city"
}
```
**Success response (200):**
```json
{
  "data": {
    "analogyType": "restaurant",
    "mapping": [ { "componentLabel": "string", "analogyRole": "string", "explanation": "string" } ],
    "summary": "string",
    "labelMappings": [ { "nodeId": "string", "analogyLabel": "string" } ]
  }
}
```
`mapping[].componentLabel` is joined to `architecture[].label` (the repo folder path) to attach a role to a diagram node for the hover tooltip (PRD.md §2 item 9, ARCHITECTURE.md §5.1).

`labelMappings` must contain exactly one entry per `id` in the `architecture[]` array sent in the request. **Nothing in the UI consumes it today** — it is the retained half of the retired label-morphing feature (§5.1), kept in the contract so a label-swapping mode can be reinstated without another API change. Because it is unused, `analogyLabel` never reaches a diagram string and the mermaid sanitization pipeline (RULES.md §1) has no path to it.

**Error response:** same `{ error: string }` shape, codes limited to `"parse_failed" | "timeout" | "unknown"` (no GitHub-related errors possible here — this route never touches GitHub).

### 2.3 `POST /api/crash-simulation`
Powers the "Simulate System Crash" interaction (PRD.md §2 item 10). Fired on node click; never touches GitHub; reuses the client's already-cached `architecture[]` and the current analogy state, exactly like `/api/analogy`.

**Request:**
```json
{
  "node": { "id": "string", "label": "string", "role": "frontend | api | database | queue | cache | worker | config | unknown", "evidence": "string" },
  "analogyType": "restaurant" | "airport" | "hospital" | "city",
  "analogyMapping": { "componentLabel": "string", "analogyRole": "string", "explanation": "string" } | null
}
```
- `node` is the full `ArchitectureNode` (not just an id/label pair) so the model has real grounding — `evidence` in particular keeps it from inventing a relationship the repo doesn't support (RULES.md §3).
- `analogyMapping` is the matching entry from the *current* theme's `mapping[]` for this node, when one exists (it always will once the first `/api/analogy` call has resolved). Passing it keeps the crash narrative's vocabulary consistent with what's already on screen — without it, the model could pick a different metaphor for "database" than the one the analogy panel already established.

**Success response (200):**
```json
{
  "data": {
    "failureScenario": "string"
  }
}
```
`failureScenario` is capped at 400 characters (2–3 sentences) — enforced server-side by truncating at the last full sentence boundary before the cap, not mid-sentence. This is a small, fast card, not a second analogy panel.

**Error response:** same `{ error: string }` shape as `/api/analogy` — `"parse_failed" | "timeout" | "unknown"` only.

### 2.4 LLM call contract (all three routes)
- System prompt instructs: "Return ONLY valid JSON matching this exact shape. No markdown fences, no prose before or after."
- Server wraps the raw LLM text response: strip any leading/trailing ```` ``` ```` fences defensively even though instructed not to send them (models sometimes do anyway), then `JSON.parse`.
- On parse failure: one retry with an appended system message: "Your last response was not valid JSON. Return ONLY the JSON object, nothing else." If retry also fails → `{ error: "parse_failed" }`.
- Applies identically to `/api/analyze` (§2.1), `/api/analogy` (§2.2), and `/api/crash-simulation` (§2.3) — one shared implementation (e.g. a `callLlmForJson()` helper in `lib/`), not three copies of the same retry logic.

## §3. Error-to-message mapping (client-side constant, `lib/types.ts` or a dedicated `errorMessages.ts`)
| `error` code | User-facing message |
|---|---|
| `invalid_url` | "That doesn't look like a valid GitHub repo URL." |
| `not_found` | "Repo not found — check the URL or make sure it's public." |
| `rate_limited` | "GitHub rate limit hit — wait a minute and try again." |
| `parse_failed` | "Something went wrong reading that repo's structure. Try again." |
| `timeout` | "That took too long — the repo might be very large. Try again." |
| `unknown` | "Something went wrong. Try again." |

## §4. Component hierarchy
```
app/page.tsx
├── RepoInputForm            (client; owns URL string + validation state)
├── AnalysisPanel            (client; owns { status, repoSummary, architecture, mermaidCode, verdict, analogyState, crashState })
│   ├── VerdictBadge         (inline, no separate component file — a small block rendered directly in AnalysisPanel's header area, above the two-column grid; null-safe, renders nothing if verdict is null; see design.md §5)
│   ├── FlowchartView        (renders mermaidCode; see §5; emits onNodeClick(nodeId))
│   │   └── CrashSimulationCard  (conditional inline card, positioned near the clicked node; own loading/error state — see below)
│   └── AnalogyPanel
│       ├── AnalogySelector  (dropdown; disabled until first analogy resolves)
│       └── AnalogyText      (renders mapping[] + summary)
└── ErrorBanner              (conditional; renders mapped message from §3)
```
State lives in `AnalysisPanel` via `useReducer` with actions: `SUBMIT`, `ANALYZE_SUCCESS`, `ANALYZE_ERROR`, `ANALOGY_LOADING`, `ANALOGY_SUCCESS`, `ANALOGY_ERROR`, `CRASH_SIM_REQUEST` (payload: nodeId — also the no-op guard: ignored if `crashState.pendingNodeId === nodeId`), `CRASH_SIM_SUCCESS`, `CRASH_SIM_ERROR`. No prop-drilling past one level; no context provider needed at this scale.

`CrashSimulationCard` is a hand-rolled inline overlay (per RULES.md §2 — no modal/portal library), not a full-screen dialog: `--bg-elevated` panel with the border/shadow treatment in RULES.md §2 / design.md §5 (`2px var(--border-strong)` + the static hard-edged accent shadow, since this is a directly-clicked element), max `200ms` opacity/transform transition, dismissible by clicking elsewhere or clicking the same node again. `crashState.pendingNodeId` tracks the most-recently-clicked node; a response for a stale node id is discarded (last click wins, per PRD.md §6).

## §5. Diagram engine (mermaid.js) — exact config
- Import: `import mermaid from "mermaid"` inside a `"use client"` component, initialized once via `useEffect` on mount, not on every render.
- Init config:
```ts
mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  themeVariables: {
    background: "#0a0a0a",
    primaryColor: "#1a1a1a",
    primaryTextColor: "#e5e5e5",
    primaryBorderColor: "#333333",
    lineColor: "#555555",
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
  },
  securityLevel: "strict",
  flowchart: { curve: "basis", htmlLabels: false }
});
```
- Render call: `mermaid.render(uniqueId, sanitizedCode)` → returns `{ svg }` → inject via `dangerouslySetInnerHTML` ONLY after sanitization (RULES.md §1) — `securityLevel: "strict"` plus sanitization is defense-in-depth, not either/or.
- `uniqueId` must be regenerated per render call (e.g. `flowchart-${Date.now()}`) — mermaid errors on ID reuse across re-renders.
- On render throw (invalid syntax survived sanitization): catch, show ErrorBanner with `parse_failed`-style message, log the raw mermaid string to console for debugging (dev only, strip in prod build).
- State handling: `FlowchartView` takes `mermaidCode: string | null` prop — `null` shows skeleton, string triggers the render effect, render failure sets local error state independent of the parent's error state (a bad diagram shouldn't kill the whole panel's retry path).

### 5.1 The analogy lives over the diagram, not in it
The diagram renders the repo's folder paths and is **never rewritten** after `/api/analyze`. The former Dynamic Diagram Label Morphing — rebuilding the mermaid string with `labelMappings[].analogyLabel` on every analogy success — is retired: nodes named `Waiter` and `Pantry` stop being a map of the repository, which is the whole value of the panel.

Two consequences worth stating explicitly, because both were tempting shortcuts:
- No code path may reach into the rendered SVG and patch text nodes. That would bypass the balanced-bracket/structural checks in RULES.md §1 step 8 and reintroduce the exact injection surface `securityLevel: "strict"` + sanitization exist to close. Retiring the morph removes the pressure to do this; it does not license it.
- `ANALOGY_SUCCESS` therefore touches only `analogyState`. `mermaidCode` is set once, by `ANALYZE_SUCCESS`, and is immutable for the life of an analysis.

Instead, the theme is layered *over* the diagram. `AnalysisPanel` derives `{ [nodeId]: analogyRole }` from the active theme's `mapping[]` (joined to a node by `componentLabel` → `label`, exact match first, then a trimmed/case-folded match to absorb LLM drift) and passes it to `FlowchartView`, which shows it in a hover tooltip anchored to the cursor. The tooltip is portalled to `<body>` and `position: fixed`, because the canvas viewport clips its overflow and its content carries the zoom transform. A node with no mapping entry renders the tooltip in a "not yet mapped" state rather than nothing, so the interaction is uniform across every node.

`labelMappings` remains part of the `/api/analogy` contract (§2.2) and is still validated; nothing in the UI consumes it today.

### 5.2 Node click handling (crash simulation)
Mermaid's own `click` directive is a banned construct (RULES.md §1 step 7) because it lets untrusted LLM output define click behavior. Node clicks for "Simulate System Crash" are wired at the **React/DOM layer instead, after** the sanitized SVG is injected: `FlowchartView` queries the rendered SVG for its node group elements (mermaid emits a stable, predictable `id` per node group derived from the node id used in the diagram source) and attaches a plain `addEventListener("click", ...)` per node in a `useEffect` that re-runs after each render. Hover (`mouseenter`/`mousemove`/`mouseleave`, driving the §5.1 tooltip) is bound in that same pass, per node group rather than delegated from the viewport — the tooltip's identity *is* the node, so delegation would mean hit-testing every pointer move. This is first-party event wiring on already-sanitized DOM — a different trust boundary than the mermaid-syntax-level `click` directive RULES.md §1 rejects.

## §6. Data flow (full round trip)
```
[RepoInputForm] --{owner,repo}--> [/api/analyze]
   --GitHub REST (§1.2)--> [raw tree + configs]
   --truncate/build (§1.3-1.4)--> [RepoSummary]
   --RepoSummary--> [LLM call, schema §2.1]
   <--{mermaidCode, architecture, verdict}--   (verdict rides the same call — no extra round trip)
[AnalysisPanel] caches architecture[] in reducer state; FlowchartView renders the repo-path-labelled mermaidCode as-is and never rewrites it
   --auto-fire, analogyType="restaurant"--> [/api/analogy]
   --architecture[]--> [LLM call, schema §2.2]
   <--{mapping, summary, labelMappings}--
[AnalysisPanel] derives {nodeId → analogyRole} from mapping[] → AnalogyPanel text + hover tooltip (§5.1). The diagram itself does not change.

[Dropdown change] --architecture[] (from cache) + new analogyType--> [/api/analogy] (repeat, no GitHub call)
   <--{mapping, summary, labelMappings}-- --> panel + tooltip re-derive; diagram untouched

[Node click] --{node, analogyType, analogyMapping} (all from cache)--> [/api/crash-simulation]
   --> [LLM call, schema §2.3, shared contract §2.4]
   <--{failureScenario}--
[CrashSimulationCard] renders scoped to clicked node, no GitHub call, no full-panel loading state
```
