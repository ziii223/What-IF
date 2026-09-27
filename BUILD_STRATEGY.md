# BUILD_STRATEGY.md — Phased Micro-Steps & Checkpoint Protocol

## The single-step rule (non-negotiable, governs every phase below)
After completing **one** micro-step, the active agent must:
1. State exactly which file(s) changed (path only, not full contents).
2. State the verification performed (e.g. "ran `npm run build` — passed" or "curled the endpoint — got the expected 200 shape" or, if untested, say "untested" explicitly).
3. **STOP.** Do not proceed to the next micro-step in the same turn, even if it seems trivial or obviously next. Wait for explicit user confirmation ("continue", "yes", "next").

This applies even within a single phase — a phase is a *group* of micro-steps, not a single unit of work. The only exception: two micro-steps may be combined in one turn if they are both under 5 lines of code total AND the user has pre-approved batching for that phase.

---

## Phase 0 — Architect Plan (Role: Architect Agent)
- 0.1 Read BOB.md/PRD.md/ARCHITECTURE.md, output the confirmed phase list below (this file) back to the user for approval.
- **Checkpoint:** `/bob_sessions/01-plan-approved.png`

## Phase 1 — Scaffold (Role: Scaffold Agent)
- 1.1 `npx create-next-app` with the exact flags for TS + Tailwind + App Router (no `src/` dir — keep `app/` at root per BOB.md §2).
- 1.2 Replace default Tailwind config/theme with the tokens in RULES.md §2.
- 1.3 Build `app/layout.tsx` (header only) + `app/globals.css` (theme custom properties + Tailwind directives).
- 1.4 Verify: `npm run dev`, confirm themed blank page loads, no console errors.
- **Checkpoint:** `/bob_sessions/02-scaffold-running.png`

## Phase 2 — Ingestion API (Role: Diagram Parsing Agent)
- 2.1 `lib/types.ts` — define `RepoSummary`, `ArchitectureNode`, `ApiResponse<T>` exactly per ARCHITECTURE.md §2.1.
- 2.2 `lib/github.ts` — `parseRepoUrl()` + the 5-call sequence from ARCHITECTURE.md §1.2. Verify each call independently against a real public repo before wiring them together (don't write all 5 blind, then debug all 5 at once).
- 2.3 `lib/repoSummary.ts` — truncation/capping logic per ARCHITECTURE.md §1.3–§1.4. Verify total serialized size stays under 4000 chars on a large test repo (e.g. a monorepo with 500+ files).
- 2.4 `lib/mermaidSanitize.ts` — full 8-step protocol from RULES.md §1. Verify against at least 2 deliberately malformed inputs (unbalanced brackets, labels containing `()`) as well as 1 clean input.
- 2.5 `app/api/analyze/route.ts` — wire 2.2→2.3→LLM call (schema §2.1, **including the `verdict` field** — same prompt, same call, no separate request)→2.4→response. Verify end-to-end against one real repo, inspect the actual JSON returned against the schema field-by-field, including `verdict.friction` being exactly `low`/`moderate`/`high` and `reason` staying under the ~160-char cap.
- 2.6 Verify `verdict` defensive fallback: manually stub a response missing the `verdict` field entirely, and one with an invalid `friction` value — confirm the client treats both as `null` (no badge, no error) rather than failing the whole response. Also spot-check `verdict` across both demo repos (one should plausibly land `low`/`moderate`, the other — ideally the sparser one — `high`) to confirm the reasoning actually varies with input, not just returning the same friction level regardless of repo.
- **Checkpoint:** `/bob_sessions/03-analyze-api-working.png` (attach the real response body, with `verdict` visible in it)

## Phase 3 — Metaphor Engine (Role: Metaphor Generator Agent)
- 3.1 `lib/analogyPrompts.ts` — 4 static prompt templates (restaurant/airport/hospital/city), each mapping `ArchitectureNode.role` values to that analogy's vocabulary, and each instructed to produce vivid, specific, memorable phrasing rather than dry definitions — this same "vivid, not dry" bar applies to the crash-narrative prompt built in Phase 3.5 too.
- 3.2 `app/api/analogy/route.ts` — schema per ARCHITECTURE.md §2.2 **including `labelMappings`**, JSON-parse-with-retry per §2.4. Prompt must instruct the model to return exactly one `labelMappings` entry per input `architecture[]` node id — no more, no fewer.
- 3.3 Verify all 4 analogy types independently against the same cached `architecture[]` array from Phase 2's test repo — confirm output schema matches exactly across all 4 (including `labelMappings` covering every node id), not just the default.
- **Checkpoint:** `/bob_sessions/04-analogy-api-working.png`

## Phase 3.5 — Crash Simulation API (Role: Metaphor Generator Agent)
- 3.5.1 Extend `lib/analogyPrompts.ts` with a crash-narrative prompt builder, parameterized by `analogyType` and reusing that theme's established vocabulary (pass in the node's `mapping` entry from Phase 3 so the crash narrative doesn't contradict the analogy panel's existing framing for that component).
- 3.5.2 `app/api/crash-simulation/route.ts` — schema per ARCHITECTURE.md §2.3, JSON-parse-with-retry per §2.4, server-side truncation of `failureScenario` at the 400-char cap (full-sentence boundary, never mid-sentence).
- 3.5.3 Verify against at least 3 different node roles (e.g. frontend, database, queue) across at least 2 analogy themes — confirm tone stays consistent with that theme's §2.2 `mapping[]` vocabulary, and confirm a `role: "unknown"` node produces a hedged rather than invented narrative.
- **Checkpoint:** `/bob_sessions/04b-crash-api-working.png` (attach a real response body for at least one role/theme combination)

## Phase 4 — Mermaid Viewer (Role: UI/UX Builder Agent, split from full UI wiring intentionally — get the trickiest render surface working in isolation first)
- 4.1 `components/FlowchartView.tsx` — mermaid init (ARCHITECTURE.md §5 config, unchanged — the diagram's own SVG rendering is out of scope for the brutalist treatment per design.md §7), render effect, skeleton/error states. The **container** around the diagram gets the border/shadow treatment from design.md §5; the mermaid init block itself is not touched.
- 4.2 Verify by hardcoding a known-good sanitized mermaid string as a prop (no API wiring yet) — confirm it renders with correct dark theme.
- 4.3 Verify render failure path by hardcoding a deliberately invalid string — confirm ErrorBanner path fires, app doesn't crash.
- 4.4 Verify label-morph re-render in isolation: hardcode a "before" (technical labels) and an "after" (swapped labels) sanitized mermaid string as two props/states, trigger the swap, confirm the diagram re-renders cleanly with a fresh `uniqueId` and no leftover DOM from the prior render (ARCHITECTURE.md §5.1).
- 4.5 Verify node click binding in isolation: hardcode a rendered SVG, attach the `addEventListener`-based click handler (ARCHITECTURE.md §5.2), confirm clicking a node fires with the correct node id and that no mermaid `click` directive is involved anywhere in the pipeline.
- **Checkpoint:** none separate — folds into Phase 5's checkpoint, but do not skip the isolated verification in 4.2–4.5 before moving to Phase 5.

## Phase 5 — Integrated UI (Role: UI/UX Builder Agent)
- 5.0 Apply `design.md`'s tokens/treatment (border-strong outlines, hard shadows, `border-radius: 0`, typography weight/case rules) as each component below is built — not as a separate polish pass at the end. Verify against `design.md`'s per-component checklist (§9) as you go, not all at once in Phase 6.
- 5.1 `components/RepoInputForm.tsx` — input + regex validation (PRD.md §4) + submit button state.
- 5.2 `components/AnalysisPanel.tsx` — reducer with the 9 actions from ARCHITECTURE.md §4, wire `/api/analyze` call, including storing `verdict` in state on `ANALYZE_SUCCESS` (no new action needed — it rides the existing action's payload). Render the inline `VerdictBadge` block (design.md §5) directly above the two-column grid, null-safe. (The 3 `CRASH_SIM_*` actions can be stubbed as unused until 5.6b if that's a cleaner sequencing — but the reducer shape should account for all 9 from the start so 5.6b is additive, not a reducer rewrite.)
- 5.3 Wire the auto-fired default-analogy call (PRD.md §2.5) immediately after analyze success.
- 5.4 `components/AnalogyPanel.tsx` + `AnalogySelector.tsx` — dropdown wiring to `/api/analogy` on change.
- 5.5 `components/ErrorBanner.tsx` — wire all 6 error codes from ARCHITECTURE.md §3 to their exact messages.
- 5.6a ~~Wire label morphing: on `ANALOGY_SUCCESS`, rebuild the mermaid string using `labelMappings` … and re-render `FlowchartView`.~~ **Retired** — the diagram now shows the repo's own folder paths and is never rewritten; the theme is surfaced as a hover tooltip on each node instead (ARCHITECTURE.md §5.1, PRD.md §2 item 9). Verify by switching themes on a real analyzed repo and confirming the hover tooltip's role changes on every node while the diagram itself does not re-render.
- 5.6b `components/CrashSimulationCard.tsx` + node click wiring in `FlowchartView` (ARCHITECTURE.md §5.2, §4) → `app/api/crash-simulation`. Verify: click a node, confirm a scoped loading state (not the whole panel), confirm the result reflects the currently active analogy theme, confirm clicking a second node while the first is pending shows the second node's result when it resolves (last-click-wins per PRD.md §6).
- 5.7 Full end-to-end manual test: 2 real repos, all 4 analogies (confirming the hover tooltip's role updates each time, without the diagram re-rendering), at least 3 node clicks across different roles (crash simulation), at least 2 deliberate error triggers (bad URL, nonexistent repo).
- **Checkpoint:** `/bob_sessions/05-full-ui-wired.png`

## Phase 6 — Review (Role: Review Agent)
- 6.1 Run `/review` scoped to files changed since Phase 1 (git diff), not full repo.
- 6.2 Apply only flagged issues, one fix per micro-step if fixes are non-trivial; batch only trivial lint-style fixes.
- 6.3 Re-run the Phase 5.7 end-to-end test after fixes to confirm nothing regressed.
- **Checkpoint:** `/bob_sessions/06-review-clean.png`

## Phase 7 — Buffer (no dedicated agent — human-driven)
- Fix anything Phase 6 surfaced but didn't auto-fix.
- Re-confirm the 2 demo repos still work end-to-end after any manual patching.

---

## Deviation protocol
If an agent believes a micro-step should be skipped, merged, or reordered, it must say so explicitly and wait for confirmation — it does not silently reorder the plan even if it seems more "efficient" in the moment. Efficiency gains from reordering are rarely worth the loss of a clean, auditable checkpoint trail on a 24-hour clock.
