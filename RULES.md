# RULES.md — Coding Standards, Sanitization & Anti-Hallucination

## §1. Mermaid Sanitization Protocol (`lib/mermaidSanitize.ts`) — apply in this exact order, every time, before render AND before returning `mermaidCode` from `/api/analyze`

1. **Strip code fences.** LLMs frequently wrap output in ```` ```mermaid ... ``` ```` despite instructions not to. Regex: `/^```(?:mermaid)?\s*\n?/` at start, `` /\n?```\s*$/ `` at end. Strip even if only one side is present.
2. **Strip leading/trailing whitespace and BOM characters.**
3. **Validate the diagram type declaration.** First non-empty line must match `/^(graph|flowchart)\s+(TD|TB|LR|RL|BT)/`. If not, prepend `flowchart TD\n` — never trust the LLM got the header right, always normalize.
4. **Escape/neutralize reserved characters inside node labels.** Node label text (inside `[...]`, `(...)`, `{...}`) must not itself contain unescaped `[`, `]`, `(`, `)`, `{`, `}`, `"`, or `` ` `` — these break mermaid parsing when they appear in labels generated from arbitrary repo/file names (e.g., a folder literally named `utils(legacy)`).
   - Replace any of `[ ] ( ) { }` found *inside* label text (not the label-delimiter characters themselves) with a space.
   - Replace `"` inside labels with `'`.
   - Strip backticks entirely.
5. **Strip non-alphanumeric leading characters from labels** (defends against labels starting with `-`, `*`, `#` etc. being misread as mermaid directives). Allow: letters, digits, spaces, `-`, `_`, `.`, `/`.
6. **Cap total node count at 40 and total edge count at 60.** If the LLM output exceeds this (unlikely given RepoSummary's own caps, but defend anyway), truncate remaining lines and log — do not silently render a cut-off diagram without at least completing valid syntax (i.e., truncate at a full line boundary, never mid-line).
7. **Reject known-dangerous constructs outright** (return `parse_failed` instead of attempting to sanitize): **any** `click` directive at all — regardless of target (JS URL, callback name, or otherwise) — plus `%%{init:` blocks with anything other than the exact theme config from ARCHITECTURE.md §5, and any raw HTML/script injection attempts even under `securityLevel: strict`. There is no legitimate use of `click` in this app's diagrams — node interactivity is handled entirely at the DOM layer, never via mermaid syntax (§1b).
8. **Final check:** run the sanitized string through a lightweight balanced-bracket check (equal open/close counts for `[]`, `()`, `{}` at the structural level, i.e., excluding what step 4 already stripped from inside labels). If unbalanced, return `parse_failed` rather than attempting further auto-repair — auto-repairing structural syntax is how silent garbage diagrams happen.

### §1a. Diagram immutability after render
The diagram is the repository's own structure (node labels are folder paths from `RepoSummary.moduleFolders`), and it is rendered **once** per analysis. `labelMappings[].analogyLabel` from `/api/analogy` is LLM output and is **untrusted exactly like the original mermaid generation** — no exception because it's "just labels" — so the guaranteed-safe answer is that it never reaches a diagram string at all:
- **Never** patch text directly inside an already-rendered SVG DOM node. That bypasses step 8's balanced-bracket check and reintroduces the injection surface `securityLevel: "strict"` + sanitization exist to close.
- **Never** splice `labelMappings[].analogyLabel` (or any other analogy-derived string) into the mermaid definition. The label-morphing feature that did so is retired (ARCHITECTURE.md §5.1); the theme is layered *over* the diagram as a hover tooltip instead, which touches no SVG text.
- If a future change reinstates label swapping, it must rebuild the full definition and run **all 8 steps above from scratch** with a fresh `uniqueId`, and fall back to the unmorphed string on any failure — never blank the diagram or raise a page-level error over a metaphor label that failed to render.
- By the same rule, a missing or unmatched analogy mapping must never break the diagram: the tooltip degrades to a "not yet mapped" state and the graph renders exactly as it would have otherwise. A metaphor failing is not equivalent to the underlying analysis failing.

### §1b. Node Click Handling — not a `click` directive
Step 7 above already bans mermaid `click` directives in LLM-generated diagram syntax. The "Simulate System Crash" feature's node-click interactivity must **not** be implemented by asking the LLM to emit `click` syntax, or by loosening `securityLevel` from `"strict"`. It is implemented entirely at the application layer: `addEventListener` calls attached in React to the already-sanitized, already-rendered SVG's node groups (see ARCHITECTURE.md §5.2). If an agent proposes routing crash-simulation triggers through mermaid's own click syntax, reject it — that's the exact construct §1 step 7 exists to keep out.

## §2. UI Non-Negotiables & Anti-Patterns
> Detailed visual/interaction spec (neo-brutalist direction) lives in **`design.md`** — read it alongside this section. `design.md` is additive to everything below; where the two ever seem to disagree, this section's tokens win and `design.md` should be treated as needing a fix, not the other way around.

### Theme tokens (define once in `app/globals.css` as CSS custom properties, reference everywhere via Tailwind `bg-[var(--bg)]` etc. — do not hardcode hex values in components)
```css
:root {
  --bg: #0a0a0a;
  --bg-elevated: #141414;
  --border: #262626;
  --border-strong: #404040;  /* neo-brutalist block border — see design.md §2 */
  --text-primary: #e5e5e5;
  --text-secondary: #a3a3a3;
  --accent: #3b82f6;      /* single accent — do not add a second accent color */
  --error: #ef4444;
}
```
- **Exactly one accent color** (`--accent`). No gradient accents, no rainbow theming "for polish."
- **No frosted glass / `backdrop-filter: blur()` anywhere.** No `bg-white/10 backdrop-blur` patterns — flat, opaque panels only (`--bg-elevated`).
- **No decorative gradients.** Solid backgrounds only.
- **Borders & depth (amended for neo-brutalism, design.md §2–§3):** every panel/interactive element gets a `2px solid var(--border-strong)` outline, `border-radius: 0` everywhere (no rounded corners, no exceptions), plus one **static, hard-edged (zero-blur) box-shadow** — `box-shadow: 4px 4px 0 var(--accent)` on interactive elements only (buttons, the active dropdown, a clickable diagram node's affordance), nothing on purely static text/content panels beyond the border. A static box-shadow is a style property, not a motion effect, so it does not fall under the animation/transition rule below — do not add blur, spread, or a second shadow layer, and do not use a soft/blurred shadow anywhere.
- **No animation libraries** (no Framer Motion, no GSAP). CSS `transition` on `opacity`/`transform` only, max `200ms` — this covers all interactive state changes (hover, press, open/close, dropdown, morph). The one exception: a single shared `@keyframes skeleton-pulse` (opacity between two fixed values, ~1.2s ease-in-out infinite) for skeleton loaders only, defined once and reused everywhere a skeleton appears — never a shimmer/gradient sweep (that would violate "no decorative gradients" above). Wrap it in `@media (prefers-reduced-motion: reduce) { animation: none; }`.
- **No icon libraries beyond one** — if icons are needed, pick exactly one (e.g. `lucide-react`) and do not mix icon sets. Prefer no icons at all where a bold text label does the same job — consistent with the "raw, honest" brutalist direction in `design.md` §1.
- **No unsanctioned component libraries** (no shadcn, no MUI, no Chakra) — hand-roll the ~7 components in BOB.md §2 with Tailwind directly. This is a deliberate scope constraint, not an oversight — pulling in a component library costs more setup time than it saves for 7 components (including `CrashSimulationCard`, which is a plain conditional div, not a modal library's `<Dialog>`).
- **Typography:** system font stack only (`ui-sans-serif, system-ui, sans-serif`), no Google Fonts import (avoids an external network dependency + FOUC risk during a live demo). The brutalist look comes from weight/spacing/case (design.md §4), never from a second typeface.
- **Layout:** two-column flex/grid at `md:` breakpoint and above, stacked single-column below it. No sidebar, no nav bar beyond a single-line header with the app name.
- **CrashSimulationCard:** hand-rolled inline overlay using the same `--bg-elevated` / `--border-strong` tokens and hard-shadow treatment as every other panel — not a third visual style, not a JS modal/portal library (no react-modal, no headlessui dialog). Max `200ms` opacity/transform transition on open, same as everything else in this section. Dismiss on outside click or re-click of the same node; no dimmed full-page backdrop (that would be the first `backdrop-filter`/scrim in the app and breaks the "flat, opaque panels only" rule above).

### Anti-patterns to actively reject if an agent proposes them
- Adding Redux/Zustand "for scalability" — there are 6 state fields total, this is decisively unnecessary.
- Adding a CSS-in-JS library alongside Tailwind — pick one styling approach, it's already picked.
- "Improving" the mermaid theme with custom SVG post-processing — the themeVariables config in ARCHITECTURE.md §5 is the full extent of theming.
- Persisting analysis results to any backend "in case we add accounts later" — out of scope per PRD.md §3, don't build for a future that isn't this hackathon.

## §3. Context Boundaries (Anti-Hallucination — Execution Layer)
1. **Never read a full source file from the target repo being analyzed** — tree + 3 named configs only, per ARCHITECTURE.md §1. This is a hard boundary, not a suggestion; it exists to bound both token cost and hallucination surface (an LLM asked to summarize 40 raw source files is far more likely to invent relationships than one given a clean, capped `RepoSummary`).
2. **Never invent a GitHub API field or endpoint.** If a field's exact name/shape is uncertain, say so and confirm against the actual fetched response (log it, inspect it) before writing code that assumes its shape.
3. **Never fabricate mermaid syntax not covered by §1 above** — stick to `graph`/`flowchart` declarations, `A[Label]` / `A(Label)` / `A{Label}` nodes, `-->` edges, and `subgraph...end` blocks. No `classDef`, no `click`, no exotic mermaid v10+ features not explicitly tested to render under `securityLevel: strict`.
4. **Never claim a file was created/edited/tested without it actually happening.** If a tool call errors, state the error verbatim (or its message) — do not narrate success over a failure.
5. **No new dependencies outside BOB.md §1's fixed list without a one-line ask-first** ("adding `X` because `Y` — proceed?") and explicit confirmation before installing.
6. **Crash-simulation narratives reason only from the node's own `evidence` field and its role** — the prompt must not let the model invent upstream/downstream relationships or dependencies that aren't present in `architecture[]`. A vivid analogy is fine; a fabricated system relationship is not, even dressed up as a metaphor. For `role: "unknown"` nodes, the prompt must explicitly tell the model the role is inferred/uncertain so the narrative hedges rather than asserting specifics.
7. **The `verdict` field's `reason` must cite only signals already present in the `RepoSummary` that same call received** (missing README, undocumented services, a high proportion of `unknown`-role nodes, etc.) — never a claim about the actual codebase beyond what that capped summary supports. Validate `friction` is exactly `"low" | "moderate" | "high"` before rendering the badge; treat any other value (or a missing field) as `null` and skip the badge silently — same defensive-fallback principle as `labelMappings` (RULES.md §1a / ARCHITECTURE.md §2.2): an optional enrichment field failing must never fail the primary response it rode in on.

## §4. Token-Saving Output Format
- Code changes: unified diff / targeted patch, never full-file reprint unless the file is genuinely new.
- Status updates: 1–3 lines, e.g. "Added `/api/analyze`. Tested against `octocat/Hello-World` — 200 OK, valid mermaid." No "Here's what I did:" headers, no restating the request back.
- Bug fix explanations: one sentence for the bug, one sentence for the fix. No essay-length root-cause narration unless explicitly asked "explain in depth."
- Skip pleasantries entirely in agent-mode output — this isn't a conversational reply, it's a build log.

## §5. Self-Verification Checklist (run before reporting "done" on any micro-step)
- [ ] Did the code actually build/run? If untested, say "untested" explicitly — never imply verification that didn't happen.
- [ ] Does every import resolve to a package actually present in `package.json`?
- [ ] Does every referenced GitHub API field exist in an actual fetched response you inspected (not assumed from memory of the API)?
- [ ] Has the mermaid output been run through the full §1 sanitization pipeline, not just eyeballed?
- [ ] Does the API response match the exact schema in ARCHITECTURE.md §2 — field names, types, and nesting, not just "roughly the same shape"?
