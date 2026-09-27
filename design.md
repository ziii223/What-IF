# design.md — Visual & Interaction Design (Neo-Brutalism, Minimal)

## §0. How this file fits with the rest of the project
This file is the detailed visual/UX layer for the ~7 components in BOB.md §2. It does **not** replace `RULES.md` §2 — it's additive to it, and reuses every token/constraint already fixed there (dark palette, single accent, no gradients, no blur, system font stack, `useReducer`-only state). If anything below ever reads as contradicting `RULES.md` §2, `RULES.md` §2 wins and this file needs a fix, not the other way around.

**One small amendment was made to `RULES.md` §2 to make this file possible:** the old line *"a subtle 1px `--border` divider is the only allowed visual separator"* is replaced with a bold 2px `--border-strong` outline + a single static hard-edged box-shadow (§2 below). Everything else in `RULES.md` §2 — colors, no gradients, no blur, no animation libraries, single accent, system font — is unchanged.

**UX beats UI, always.** Every rule below exists to make the diagram/analogy/crash-sim flow feel immediate and legible, never to add decoration for its own sake. If a brutalist flourish would slow down or confuse the core flow (PRD.md §5), cut the flourish, not the flow.

## §1. Design philosophy, in one paragraph
Raw and honest, not loud. Neo-brutalism here means: visible structure (every block is bordered, nothing implies depth with a soft shadow or blur), no rounded corners, no decoration that doesn't also communicate state, and typography that does the "attitude" work instead of a second color or a second font. The bar for every element: does this border/shadow/weight change help the user understand what's clickable, what's loading, or what just changed? If not, it's cut — this keeps the look simple to build and fast to demo, which matters more than maximalism on a 48-hour clock.

## §2. Tokens (extends `RULES.md` §2 — same `:root` block, two additions)
```css
:root {
  /* ...existing --bg, --bg-elevated, --border, --text-primary, --text-secondary, --accent, --error... */
  --border-strong: #404040;   /* the one border weight used everywhere below */
  --shadow-offset: 4px;       /* used only as a literal value in box-shadow, not its own var in most engines — keep as a comment/reference, hardcode 4px in the declarations below */
}
```
- **Border width:** `2px solid var(--border-strong)` on every panel and every interactive element. No exceptions, no thinner "quiet" borders anywhere — consistency is what reads as intentional rather than sloppy.
- **Border radius:** `0` everywhere, no exceptions. This is the cheapest, highest-leverage brutalist signal and costs nothing to implement (it's a global reset, not a per-component decision).
- **Shadow:** exactly one shadow style, applied only to elements the user can click or that hold focus: `box-shadow: 4px 4px 0 var(--accent);`. Zero blur, zero spread — a hard offset block, not a soft drop shadow. Static content panels (the diagram container, the analogy text panel) get the border only, no shadow — reserve the shadow for "this does something."

## §3. Spacing & structure
- Use Tailwind's default spacing scale as-is — no custom spacing scale. One less thing to design or get wrong under time pressure.
- Every top-level panel (`RepoInputForm`, the diagram container, `AnalogyPanel`, `ErrorBanner`) is a distinct bordered block with consistent internal padding (Tailwind `p-4` or `p-6`, pick one and use it everywhere — don't vary padding per panel). Blocks sit with a visible gap between them (`gap-4`/`gap-6`), never touching edge-to-edge — the gap plus each block's own border is what reads as "brutalist grid" rather than one continuous card.

## §4. Typography (still the system font stack — no new typeface, per `RULES.md` §2)
- **Headings / section labels** (panel titles like "Architecture", "Analogy", the app name in the header): `font-weight: 800–900`, `text-transform: uppercase`, `letter-spacing: 0.02em`. This is the only place brutalism shows up in type — everything else stays normal weight/case for readability.
- **Body text** (analogy explanations, crash-simulation narrative, README-derived summary): normal weight, normal case, generous line-height (`leading-relaxed`) — this content is meant to be *read*, not postured at. Don't uppercase or bold-weight paragraph text; it becomes harder to read and works against "UX over UI."
- **Buttons / interactive labels** ("Analyze", dropdown options, "Simulate Crash"): `font-weight: 700`, uppercase, matches the heading treatment so the user's eye reads "bordered + bold + uppercase" as one consistent "this is clickable" signal across the whole app.

## §5. Component-by-component treatment
- **`RepoInputForm`:** input field — `2px solid var(--border-strong)`, `border-radius: 0`, no shadow (it's not "clickable" in the same sense, it's a text field — a shadow here would dilute the signal that shadow = actionable). On `:focus`, swap border color to `var(--accent)` (still 2px, no glow/outline-blur) — this is the field's only state change. **Analyze button** — filled `var(--accent)` background, `2px solid var(--border-strong)`, the hard shadow from §2, uppercase bold label. Disabled state: drop the shadow entirely and reduce opacity to ~0.5 (reuses the existing opacity-transition allowance in `RULES.md` §2) — a disabled button should visibly stop looking clickable, not just get a `cursor: not-allowed`.
- **Diagram container (`FlowchartView`'s wrapper, not the SVG itself):** `2px solid var(--border-strong)` panel, no shadow (static content). The mermaid diagram's own rendering config (dark theme, node colors) is untouched — see §7 below for why.
- **`AnalogyPanel` + `AnalogySelector`:** panel gets the same static bordered treatment as the diagram container. The dropdown (native `<select>`, no component library per `RULES.md` §2) gets the full interactive treatment: border, shadow, uppercase label text for the currently-selected option. Use a plain text character (`▾`) for the dropdown affordance instead of an icon — keeps the "no icon library" constraint trivially satisfied and matches the raw/text-first brutalist voice.
- **`CrashSimulationCard`:** per the `RULES.md` §2 amendment, same `--bg-elevated`/`--border-strong`/hard-shadow treatment as every other panel — it's the one component the user directly summoned by clicking, so it's allowed the shadow even though it's mostly text, to visually mark it as "spawned by your click" rather than baseline content.
- **`ErrorBanner`:** `2px solid var(--error)` (the one place a non-accent border color is allowed, since it's a distinct semantic state, not a second "accent"), background stays `var(--bg-elevated)` (never a solid red fill — that would read as more alarming than PRD.md's calm, keep-editing-the-input error philosophy warrants). No shadow — an error isn't "clickable," it's informational.
- **`VerdictBadge`** (PRD.md §2 item 11): a small inline pill/block at the top of `AnalysisPanel`, `2px solid var(--border-strong)`, `border-radius: 0`, uppercase bold `friction` label + normal-weight `reason` text beside it — no shadow (informational, not clickable, same reasoning as `ErrorBanner`). Border color communicates severity **without adding a new token**: `low` → `var(--accent)`, `moderate` → `var(--border-strong)` (the neutral default, i.e. no special color), `high` → `var(--error)`. Renders nothing at all when `verdict` is `null` (PRD.md §6) — no empty placeholder box, no skeleton for it specifically (it either arrives with the diagram or it doesn't show up).

## §6. Interaction & motion (all within `RULES.md` §2's existing "opacity/transform only, max 200ms" rule)
- **Button/dropdown press feedback:** on `:active`, `transform: translate(4px, 4px)` — since the static shadow is already offset by exactly `4px 4px`, moving the element that distance visually "tucks" it into its own shadow, reading as a physical press. The shadow's `box-shadow` value itself never transitions or changes — only `transform` does, which stays fully compliant with the existing transition rule. Revert on release, same 200ms.
- **Hover feedback (non-touch only):** a barely-there `transform: translate(-1px, -1px)` on hover for buttons/dropdown — the element lifts slightly off its shadow before the press tucks it back in. Skip this for anything without a corresponding `:active` state (don't hover-animate static panels).
- **Skeleton loaders:** solid `var(--bg-elevated)` blocks with a `2px var(--border-strong)` outline (matching every other panel — a loading block should already look like the panel it's about to become, not like a different visual style). Motion: the one shared `@keyframes skeleton-pulse` exception carved out in `RULES.md` §2 (opacity pulse only, no shimmer/gradient sweep, respects `prefers-reduced-motion`).
- **Diagram label morphing (PRD.md §2 item 9):** no new transition needed beyond what ARCHITECTURE.md §5.1 already specifies (full re-render on theme switch) — don't add a fade/crossfade on top of the re-render, it adds complexity for a swap that already reads as instant.
- **Node click → crash card (PRD.md §2 item 10):** the card's own appearance uses the existing `opacity`/`transform` 200ms rule (e.g. `opacity 0→1` + `translateY(4px)→0`) — nothing brutalism-specific here beyond the border/shadow treatment in §5.

## §7. What this file deliberately does NOT touch
- **The mermaid diagram's own rendering** (node fills, stroke colors, line style inside the SVG) stays exactly as fixed in `ARCHITECTURE.md` §5's `mermaid.initialize()` config. Re-theming mermaid's internal SVG output to look "brutalist" would mean fighting the library's own styling API under time pressure for a cosmetic win inside a part of the screen the user is reading, not clicking chrome around. The **container** around the diagram gets the full brutalist treatment (§5); the diagram's contents don't need to.
- **No new fonts, no new icon library, no new color beyond `--border-strong`.** Every rule above reuses a token or mechanism `RULES.md` §2 already permits.

## §8. Accessibility (cheap additions, no conflict with anything above)
- `:focus-visible` on every interactive element gets a visible `2px solid var(--accent)` outline offset by 2px (`outline-offset: 2px`) — distinct from the default border so keyboard users always see where focus is, even on elements that already have a border.
- Wrap the skeleton-pulse keyframe in `@media (prefers-reduced-motion: reduce) { animation: none; }` (already noted in `RULES.md` §2's amendment) — the hover/press `transform` micro-interactions in §6 should degrade gracefully too (they're small enough that removing them entirely under reduced-motion is fine — no need for a separate reduced-motion variant of each).

## §9. Per-component definition of done (check before calling a component "styled")
- [ ] `border-radius: 0` — no rounded corners anywhere, including on the native `<select>` (some browsers round it by default; explicitly reset it).
- [ ] Border is `2px solid var(--border-strong)` (or `var(--error)` for `ErrorBanner` only, or `var(--accent)` on focus/active states) — never the old 1px hairline.
- [ ] Shadow (`4px 4px 0 var(--accent)`, zero blur) present only on genuinely interactive elements — not on static text panels.
- [ ] Heading/label text is uppercase + bold per §4; body/paragraph text is not.
- [ ] Any motion used is `opacity`/`transform` only, ≤200ms (or the one shared skeleton-pulse keyframe), and respects `prefers-reduced-motion`.
- [ ] No new dependency, font, or icon was added to make this component's brutalist treatment work.
