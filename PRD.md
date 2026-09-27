# PRD.md — WHAT-IF & Analogy Explorer
> Positioning: "The PM-to-Dev Rosetta Stone"

## 1. Problem & Positioning
Product managers, founders, and other non-technical stakeholders sit in architecture conversations they can't independently verify — they rely on a developer's verbal summary and have no way to double-check it later. Developers, meanwhile, re-explain the same system in plain language every time a non-engineer asks "so what does this actually do."

WHAT-IF closes that gap: paste a public repo URL and get (a) a structural flowchart derived from real repo signals, and (b) the same structure retold as a vivid, non-technical narrative — switchable across analogy framings with zero re-fetch cost on switch. The diagram and the narrative are kept in lockstep (§2 items 9–10) so a PM and an engineer can point at the same diagram and mean the same thing.

**Primary persona:** a PM, founder, or other non-technical stakeholder who needs an accurate mental model of a system fast, without reading code.
**Secondary persona:** the developer who wants a shareable, always-current answer to "explain the architecture" that doesn't require a live meeting.

## 2. In scope (MVP — exhaustive list, build exactly this)
1. Paste a public GitHub repo URL → client-side regex validation before any network call.
2. Server fetches (all detail in ARCHITECTURE.md §1): repo metadata, file tree, `package.json`, `docker-compose.yml`, `README.md` — each optional except metadata + tree.
3. One LLM call converts the compact `RepoSummary` into `{ mermaidCode, architecture[] }` — strict JSON, schema in ARCHITECTURE.md §2.1.
4. Client renders the mermaid flowchart (dark theme, see RULES.md §2).
5. Default analogy ("restaurant") is generated in the SAME initial round-trip as the flowchart request is answered by the client — i.e., after `/api/analyze` returns `architecture[]`, the client immediately calls `/api/analogy` with `analogyType: "restaurant"` before showing the panel, so first paint already has both panels filled. This is NOT a second manual click.
6. Dropdown (Restaurant / Airport / Hospital / City Grid) → calls `/api/analogy` again with cached `architecture[]`, no GitHub re-fetch, no re-analysis of the repo.
7. Loading state (skeleton, not spinner-only) on both panels independently — flowchart can be ready while analogy is still loading, or vice versa.
8. Error states, each with a distinct user-facing message (exact copy in ARCHITECTURE.md §3).
9. **Repo-driven diagram, with the analogy on hover.** Every diagram node is one of the repository's own folders — its label is a path copied out of `RepoSummary.moduleFolders` (`src/components`, `api`, `lib/utils`), never an invented product or role name — so the panel reads as a map of *that* repo and a newcomer can find the code it names. The theme is layered over the diagram rather than baked into it: hovering any node raises a floating neo-brutalist tooltip showing that folder's role in the active theme (`ANALOGY: HEAD WAITER`). Switching themes re-derives the tooltip and the panel text; the diagram itself never changes after first render.
10. **"Simulate System Crash" interaction.** Clicking any rendered node opens a small inline card asking the model "what happens if this breaks?" and returns a 2–3 sentence, business-impact narrative written in the *currently active* analogy theme (e.g., a database node in Restaurant theme: "The kitchen pantry caught fire — the chef can't prepare anything until suppliers bring raw ingredients, and service grinds to a halt."). Reuses the cached `architecture[]` node plus the current theme's `mapping[]` entry for that node (for vocabulary consistency); no GitHub re-fetch, no re-analysis.
11. **Onboarding-friction verdict badge.** `/api/analyze`'s single existing LLM call (item 3 above) also returns a `verdict: { friction: "low" | "moderate" | "high", reason }` field, generated from the exact same `RepoSummary` input it already reasons over — this is the *same* round trip, not a new API call, not a new loading state. Rendered as a small badge (no new component file — lives inline at the top of `AnalysisPanel`, per design.md §5) the moment the flowchart itself appears. This is the single sentence that turns "here's a diagram" into "here's a judgment a PM can act on" — it's the concrete payoff of the "PM-to-Dev Rosetta Stone" positioning (§1).

## 3. Out of scope — explicitly excluded, do not build, do not propose adding mid-hackathon
- Auth, accounts, saved history across sessions (localStorage "recent 5" convenience list is allowed, is NOT "history" — no server persistence)
- Private repos, GitHub OAuth, any token input from the end user
- AST parsing, import graphs, call graphs, or reading actual source file contents beyond the 3 named configs
- Editing or exporting the mermaid diagram (no "download as PNG," no drag-to-rearrange)
- Any backend database
- GitLab/Bitbucket/self-hosted Git support
- Real-time collaboration, multi-user sessions, sharing links with server-side state

## 4. Input validation rules (client-side, before any request)
- Regex: `^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?(\.git)?\/?$`
- On match failure: inline red text under the input, "Enter a valid GitHub repo URL (e.g. github.com/owner/repo)." No API call fires.
- On match success: strip trailing `.git`, trailing `/`, and any `www.` before sending `owner` and `repo` (not the raw URL) to `/api/analyze`.

## 5. Core user flow (happy path)
1. Land on page. Input empty, "Analyze" button disabled until non-empty + valid.
2. User pastes URL, clicks Analyze.
3. Both panels show skeleton loaders immediately.
4. `/api/analyze` resolves → flowchart panel renders the repo's folder structure — nodes labelled with real paths (§2 item 9) — and the friction verdict badge (§2 item 11) renders at the same instant since it's part of the same response — no separate load, no separate skeleton; client fires `/api/analogy` (restaurant) in parallel with nothing blocking — analogy panel still shows skeleton until this resolves. Hovering any node in the meantime shows the tooltip in its "not yet mapped" state.
5. `/api/analogy` resolves → analogy panel renders, dropdown becomes interactive, and every node's hover tooltip now carries the restaurant theme's role for that folder. The diagram itself does not re-render — this is an annotation arriving, not a second load.
6. User changes dropdown → analogy panel shows a lightweight inline loading state (not full skeleton — the diagram is untouched and its node positions stay static) → new text renders and the tooltips re-derive to the new theme. Target: perceived as "instant" (single LLM call, no GitHub round-trip).
7. User clicks any node in the diagram → a small inline card ("Simulate Crash") appears near the node, shows its own lightweight loading state, and calls `/api/crash-simulation` (§2 item 10). Result renders in the active analogy theme. Clicking a different node while one is pending is allowed — the card always reflects the most-recently-clicked node.
8. Error at any step → ErrorBanner (or, for a crash-simulation failure, an inline error *within the card only*) replaces the relevant content, input stays editable, "Analyze" re-enabled, no full-page crash.

## 6. Edge cases (must be handled, not just happy path)
- Repo with no `package.json`, no `docker-compose.yml`, no `README.md` → RepoSummary still built from tree alone; LLM prompt explicitly told "no config files found, infer only from file/folder structure."
- Monorepo with 500+ files → tree truncated per ARCHITECTURE.md §1.4 cap; summary notes "truncated, showing top N."
- Default branch is `master` not `main` → resolved via repo metadata call, not assumed (see ARCHITECTURE.md §1.2).
- User pastes a URL to a specific file/subfolder (`github.com/owner/repo/tree/main/src`) → PRD says: reject as invalid for MVP, error message "Point to the repo root, not a subfolder."
- Rapid double-submit (user clicks Analyze twice) → button disabled during in-flight request, second click no-ops.
- The active theme's `mapping[]` has no entry for a hovered node (the model skipped it, or its `componentLabel` drifted from the node's label) → the tooltip still appears, reading `ANALOGY: NOT YET MAPPED`. A missing annotation is never a blank tooltip, a broken hover, or an error state.
- The model labels a node with something that is not a folder path (an invented name like `API Gateway`) → the diagram still renders; the node simply never matches a `mapping[]` row and shows the "not yet mapped" tooltip. The prompt's grounding rule (§2 item 9) is the fix, not a client-side repair — the client never rewrites model output into a plausible-looking path.
- Rapid repeat clicks on the *same* node while a crash-simulation request is already in flight → no-op, do not fire a duplicate request.
- Crash simulation requested for a node whose `role` is `"unknown"` → still generate a narrative, but the prompt tells the model the role is inferred/uncertain so it hedges rather than inventing specifics.
- Repo with almost no signal (no README, no `package.json`, no `docker-compose.yml`, tiny tree) → verdict is still generated (likely `"high"` friction, reason naming the missing documentation itself) — an information-poor repo is a valid, expected input, not an error state.
- `verdict` is missing from the LLM response, or `friction` isn't exactly one of `low`/`moderate`/`high` → treat as `null` and simply don't render the badge; **never** let a malformed optional field fail the whole `/api/analyze` response when `mermaidCode`/`architecture[]` parsed fine. The badge is an enrichment, not a requirement.

## 7. Success criteria for demo
- Works live on 2 real repos (one simple, one with docker-compose) in under 10s each including both API calls.
- Analogy switching feels instant (target: under 2s, single LLM call).
- Zero console errors during the recorded demo take.
- All 4 error states demonstrable on request (keep one deliberately broken URL ready as backup if judges ask).
- Switching analogy themes visibly re-labels every diagram node within the same perceived load as the analogy text (no separate spinner just for the diagram).
- Clicking a node returns a crash-simulation narrative in under 2s (single LLM call, scoped loading state on the card only).
- Demo script explicitly shows a non-technical stakeholder framing: "point at the diagram, ask what happens if X breaks" — this is the moment the pitch should land on.
- The friction verdict badge appears at the same moment as the flowchart (same response, same round trip) — confirm on both demo repos that it never introduces a visible extra delay or a third loading state.
