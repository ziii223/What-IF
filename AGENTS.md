# AGENTS.md — Subagent Roles, Skill Routing & Task Allocation (Bob Agent Mode)

Run one agent/mode at a time — no parallel agents. This project's scope doesn't justify the merge-conflict and coordination cost parallelism adds, and it only burns Bobcoins on rework. Each role below maps to one BUILD_STRATEGY.md phase (see that file for micro-step-level detail).

## Role 1 — Architect Agent (Bob "Plan" mode)
- **Reads:** `BOB.md`, `PRD.md`, `ARCHITECTURE.md` only. Never opens `components/` or `lib/` source.
- **Active skills:** `concise-output.SKILL.md`, `single-step-checkpoint.SKILL.md`.
- **Output:** the next phase's micro-step list from BUILD_STRATEGY.md, confirmed against current repo state (what already exists vs. what's next) — not a full re-derivation of the whole plan each time.
- **Context boundary:** never reads the target-repo-being-analyzed at all — this agent only plans this project's own build.
- **Checkpoint:** `/bob_sessions/01-plan-approved.png` after first plan approval; re-invoked (not re-screenshotted) at the start of each new phase per BUILD_STRATEGY.md.

## Role 2 — Scaffold Agent (Bob "Code" mode)
- **Reads:** `BOB.md` §1–§2 (stack + folder structure) only.
- **Active skills:** `concise-output.SKILL.md`, `single-step-checkpoint.SKILL.md`.
- **Scope:** Next.js init, Tailwind config, `app/globals.css` theme tokens (RULES.md §2), base `layout.tsx`/`page.tsx` shell. No business logic, no API routes, no data fetching.
- **Output:** runnable empty-shell app (`npm run dev` serves a themed blank page with header).
- **Checkpoint:** `/bob_sessions/02-scaffold-running.png`.

## Role 3 — Diagram Parsing Agent (Bob "Code" mode, "Advanced"/MCP mode only for the live GitHub fetch step specifically)
- **Reads:** `ARCHITECTURE.md` §1–§2.1, §5–§6; `RULES.md` §1 (sanitization), §3 (context boundaries), §5 (self-verify checklist).
- **Active skills:** `concise-output.SKILL.md`, `json-schema-enforcer.SKILL.md`, `mermaid-sanitizer.SKILL.md`, `single-step-checkpoint.SKILL.md`.
- **Scope:** `lib/github.ts`, `lib/repoSummary.ts`, `lib/mermaidSanitize.ts`, `app/api/analyze/route.ts`. Does NOT touch any file under `components/`.
- **Context boundary:** for the target repo being analyzed, fetches ONLY per ARCHITECTURE.md §1.2 — tree + 3 named configs. Never opens any other file from that repo, ever, regardless of how "quick a peek" would seem to help.
- **Checkpoint:** `/bob_sessions/03-analyze-api-working.png` — must show an actual successful response body (curl/Postman/test script output), not just "route created."

## Role 4 — Metaphor Generator Agent (Bob "Code" mode)
- **Reads:** `ARCHITECTURE.md` §2.2–§2.4; `RULES.md` §3, §5.
- **Active skills:** `concise-output.SKILL.md`, `json-schema-enforcer.SKILL.md`, `single-step-checkpoint.SKILL.md`.
- **Scope:** `lib/analogyPrompts.ts` (4 static analogy templates: restaurant/airport/hospital/city, plus the crash-narrative prompt builder), `app/api/analogy/route.ts`, `app/api/crash-simulation/route.ts` (BUILD_STRATEGY.md Phase 3 + Phase 3.5 — same agent owns both, they're the same "no-GitHub, architecture[]-in / JSON-out" shape).
- **Context boundary:** never touches GitHub-fetch code or the target repo at all — input is exclusively the already-built `architecture[]` array (and, for crash simulation, one node from it plus its analogy mapping) passed from the client.
- **Checkpoint:** `/bob_sessions/04-analogy-api-working.png`, then `/bob_sessions/04b-crash-api-working.png` after Phase 3.5.

## Role 5 — UI/UX Builder Agent (Bob "Code" mode)
- **Reads:** `BOB.md` §2; `ARCHITECTURE.md` §4–§5; `RULES.md` §2 (theme non-negotiables); `design.md` in full (neo-brutalist visual/interaction spec — additive to `RULES.md` §2, never overriding it; see `design.md` §0).
- **Active skills:** `concise-output.SKILL.md`, `ui-taste-checker.SKILL.md`, `single-step-checkpoint.SKILL.md`.
- **Scope:** all seven `components/*.tsx` files (including `CrashSimulationCard.tsx`), wiring all three API routes into `AnalysisPanel`'s reducer (9-action list in ARCHITECTURE.md §4).
- **Context boundary:** does not modify `lib/` or `app/api/` route logic — consumes their contracts as given in ARCHITECTURE.md §2, does not redefine them.
- **Checkpoint:** `/bob_sessions/05-full-ui-wired.png`.

## Role 6 — Review Agent (Bob `/review`)
- **Reads:** only files changed since the last checkpoint (git diff scope) — never a full-repo re-scan.
- **Active skills:** `concise-output.SKILL.md`.
- **Scope:** apply only flagged issues from `/review` output. No opportunistic refactors "while in here."
- **Checkpoint:** `/bob_sessions/06-review-clean.png`.

## Global context boundary (applies to every role above)
No agent, in any mode, reads raw source files from the **target GitHub repo being analyzed** beyond the exact 3 named config files in ARCHITECTURE.md §1. This boundary exists independent of role — it is not something the Diagram Parsing Agent alone respects, it's a project-wide constraint any mode must honor even if a user prompt seems to invite "just take a quick look at the main file."

## Handoff protocol
Every agent's final output line, no exceptions:
```
DONE: <one-line summary of what changed>
VERIFIED: <what was actually tested, or "untested">
NEXT: <next agent/role name>
```
This is what keeps mode-switching decisions cheap — the next agent (or the human) reads one line instead of re-deriving state from a long narrative.
