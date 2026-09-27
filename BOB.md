# BOB.md — Workspace Instructions
> Load once per session. Do not re-read after first load unless explicitly told "reload BOB.md." This file is the root context; PRD.md / ARCHITECTURE.md / RULES.md / AGENTS.md / BUILD_STRATEGY.md / design.md are loaded per-agent, not globally. `design.md` is read only by the UI/UX Builder Agent (Role 5) — see AGENTS.md.

## 0. Skill routing (`.bob/skills/` or `.claude/skills/`)
Skills are loaded per-agent-role, not globally, to keep context small. Verify against Bob's actual skill-loading docs before relying on auto-routing — if Bob doesn't support scoped skill assignment, apply these manually by naming the active skill at the top of each agent prompt instead.

| Skill (SKILL.md) | Purpose | Assigned to |
|---|---|---|
| `concise-output.SKILL.md` | No preamble, no restating the task, diff-only responses, 1–3 line status updates | ALL agents |
| `json-schema-enforcer.SKILL.md` | Validates LLM tool-output JSON against the schemas in ARCHITECTURE.md §2 before returning to client | Diagram Parsing Agent, Metaphor Generator Agent |
| `mermaid-sanitizer.SKILL.md` | Applies the sanitization protocol in RULES.md §1 to any mermaid string before it reaches the client | Diagram Parsing Agent |
| `ui-taste-checker.SKILL.md` | Enforces the theme tokens in RULES.md §2, flags any unsanctioned library import | UI/UX Builder Agent |
| `single-step-checkpoint.SKILL.md` | Enforces the one-micro-step-then-stop protocol in BUILD_STRATEGY.md | ALL agents (governs turn-taking, not output content) |

If a skill file is missing/not loading, the agent must say so explicitly ("skill X not found, proceeding without it") rather than silently skipping the behavior.

## 1. Stack (fixed — do not suggest alternatives, do not "helpfully" upgrade)
- **Framework:** Next.js 14.2.x, App Router only. No `pages/` directory ever exists in this repo.
- **Language:** TypeScript 5.x, `strict: true`, `noImplicitAny: true`. No `any` in new code — use `unknown` + narrowing.
- **Styling:** Tailwind CSS 3.x utility classes only. No CSS Modules, no styled-components, no separate `.css` files except `app/globals.css` (Tailwind directives + CSS custom properties for theme tokens only).
- **Diagrams:** `mermaid` npm package, client-rendered only (`"use client"` component, dynamic import with `ssr: false`).
- **State:** React `useState`/`useReducer` only. No Redux, Zustand, Jotai, React Query. No global state library — the app has exactly one data flow path (see ARCHITECTURE.md), it doesn't need one.
- **Data:** No database, no ORM, no auth, no cookies, no localStorage persistence of app data (localStorage is fine only for a "recently analyzed repos" convenience list, capped at 5 entries, explicitly optional).
- **Package manager:** npm (not pnpm/yarn) — avoid mixed lockfiles mid-hackathon.

## 2. Exact folder structure (create in this order, nothing extra)
```
app/
  layout.tsx
  page.tsx
  globals.css
  api/
    analyze/route.ts
    analogy/route.ts
    crash-simulation/route.ts
components/
  RepoInputForm.tsx
  AnalysisPanel.tsx
  FlowchartView.tsx
  CrashSimulationCard.tsx
  AnalogyPanel.tsx
  AnalogySelector.tsx
  ErrorBanner.tsx
lib/
  github.ts        // GitHub REST fetch helpers
  repoSummary.ts    // RepoSummary builder + truncation logic
  mermaidSanitize.ts
  analogyPrompts.ts // 4 static analogy templates + the crash-simulation prompt builder
  types.ts          // shared TS types (RepoSummary, ArchitectureNode, ApiResponse<T>)
```
No other top-level folders (no `utils/`, `helpers/`, `services/` — everything above has a designated home).

## 3. Token-saving guardrails
1. Never dump full file contents into chat to "explain" — reference `path:line`.
2. Edit files with targeted patches; full-file rewrite only for genuinely new files.
3. Never fetch full source files from the **target repo being analyzed**. Only: tree API (`recursive=1`), and the 3 named config files, each truncated (see ARCHITECTURE.md §1.3).
4. Cap every LLM prompt: `RepoSummary` object only, never raw tree/file blobs (see ARCHITECTURE.md §1.4 for exact size caps).
5. One agent/mode per task. No speculative mode-chaining "to double check."
6. No speculative scaffolding — build only what the current BUILD_STRATEGY.md phase requires. Do not pre-build phase N+1 components "while I'm here."
7. Every agent output ends with the handoff line defined in AGENTS.md — no exceptions, this is what keeps mode-switching cheap.

## 4. Context boundaries (hard rule, cross-references RULES.md §3)
No agent, in any mode, reads a raw source file from the **target GitHub repo** (the repo the user is analyzing) beyond the 3 named config files. This includes: no `.ts`/`.py`/`.java`/etc. source files, no lockfiles beyond parsing `package.json`'s `dependencies`/`devDependencies` keys, no test files, no CI configs. Violating this is treated as a bug, not a helpful extra — flag it in review if seen.

This project's OWN source code (the Next.js app being built) has no such restriction — agents read/write it normally per AGENTS.md role scoping.

## 5. Session hygiene
Screenshot Bob's task summary to `/bob_sessions/<NN>-<short-task-name>.png` after each completed BUILD_STRATEGY.md micro-step, not just at the 7 milestones (01, 02, 03, 04, 04b, 05, 06) — see BUILD_STRATEGY.md for the full checkpoint list.
