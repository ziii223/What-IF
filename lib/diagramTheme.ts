/**
 * lib/diagramTheme.ts — the neo-brutalist skin for the architecture diagram.
 *
 * Mermaid ships its own tasteful, soft-cornered, pastel theme, and no amount of `themeVariables`
 * can talk it out of that: there is no theme variable for `stroke-width`, none for a hard offset
 * shadow, and none for uppercase text. So the look is applied as real CSS instead, injected into
 * the rendered SVG by `injectDiagramTheme()`.
 *
 * ── Why the CSS is injected into the SVG string, not into the page ──────────────
 * The same markup feeds two canvases (the inline panel and the fullscreen overlay), and the
 * fullscreen one is a *clone* of the string. Putting the stylesheet inside the SVG means both are
 * skinned by construction — there is no second place to forget to update.
 *
 * ── Why every selector is scoped under `.flowchart` ─────────────────────────────
 * A `<style>` inside an *inline* SVG is NOT scoped to that SVG: browsers apply it to the whole
 * document. mermaid sets `class="flowchart"` on its root `<svg>` (rendering-util/setupViewPortForSVG
 * does `svg.attr("class", cssDiagram)`), so prefixing every rule with `.flowchart` confines the
 * whole sheet to the diagram. Nothing else on the page carries that class, so no rule here can
 * reach a button, a panel, or the header wordmark.
 *
 * ── Why the font-size is 13.5px when mermaid lays out at 15px ───────────────────
 * Node boxes are measured and sized by mermaid at `themeVariables.fontSize` BEFORE this sheet is
 * ever injected — and `text-transform: uppercase` does not re-run that measurement. Uppercase
 * glyphs run roughly 10-15% wider than the mixed case mermaid measured, so at 15px every label
 * would spill outside its own border. Rendering the text ~10% smaller (plus a touch of negative
 * tracking) cancels that growth almost exactly, and the extra `flowchart.padding` in
 * FlowchartView buys a few more pixels of slack on top. Bold + uppercase + tight tracking is the
 * chunky signage look anyway, so the compensation costs nothing visually.
 */

/**
 * The four block colours, cycled across the nodes in graph order. Tokens from app/globals.css.
 *
 * Four rather than five, and yellow is deliberately not among them. An even cycle keeps each
 * colour recurring at a steady rate instead of drifting, and dropping yellow leaves the nodes
 * reading as one high-contrast set against the white canvas rather than blending into the yellow
 * chrome the header and hero banner already own.
 */
const NODE_FILL_CYCLE = 4;

/**
 * Node palette, index 1..4 → `:nth-child(4n+k)`. Read from the app's `:root` custom properties:
 * this sheet is document-scoped, so the tokens resolve at paint time and the diagram's palette
 * stays the same single source of truth as the rest of the UI.
 *
 * White is load-bearing here, not a gap in the rotation: it is what gives the eye somewhere to
 * rest between the three saturated blocks. Its 3px border and hard shadow are what keep it from
 * reading as an unstyled box — the fill alone is never the whole style.
 */
const NODE_PALETTE = [
  "var(--cyan)", //  #38bdf8
  "var(--pink)", //  #f472b6
  "var(--lime)", //  #4ade80
  "var(--paper)", // #ffffff
] as const;

const PALETTE_RULES = NODE_PALETTE.map(
  (colour, i) => `.flowchart .node:nth-child(${NODE_FILL_CYCLE}n+${i + 1}) { --nb-node-fill: ${colour}; }`,
).join("\n");

export const DIAGRAM_THEME_CSS = `
/* ── Node bodies ─────────────────────────────────────────────────────────────
   One custom property carries the node's colour, so the fill rule below can be written once
   instead of once per shape type. Custom properties inherit, so a value set on the <g class="node">
   reaches whichever shape element mermaid chose to draw inside it (rect, polygon, circle, ellipse
   or path).

   The bare \`.node\` rule is the FALLBACK for any node the rotation below does not reach, so it is
   white rather than a pop colour: an unreached node then reads as a deliberate white block, where
   a colour here would just look like the cycle had gone wrong. */
.flowchart .node { --nb-node-fill: var(--paper); }
${PALETTE_RULES}

.flowchart .node rect,
.flowchart .node polygon,
.flowchart .node circle,
.flowchart .node ellipse,
.flowchart .node path {
  fill: var(--nb-node-fill) !important;
  stroke: #000 !important;
  stroke-width: 3px !important;
}

/* The hard offset shadow, on the node GROUP rather than its shape: this way the label text is
   silhouetted by the same shadow as the box, which is what makes the block read as one sticker
   rather than a box with floating text on it. */
.flowchart .node {
  filter: drop-shadow(4px 4px 0px #000) !important;
}

/* ── Edges ───────────────────────────────────────────────────────────────────
   Mermaid wraps each edge in a \`.edgePath\` group, and classes the path itself \`flowchart-link\`. */
.flowchart .edgePath path,
.flowchart .flowchart-link {
  stroke: #000 !important;
  stroke-width: 3px !important;
  fill: none !important;
}

/* Arrowheads live in <marker> defs — solid black, so they match the 3px strokes landing on them. */
.flowchart marker path,
.flowchart marker circle,
.flowchart marker polygon {
  fill: #000 !important;
  stroke: #000 !important;
}

/* ── Edge labels ─────────────────────────────────────────────────────────────
   Both spellings are covered on purpose: with \`htmlLabels: false\` mermaid draws edge labels as
   <text> over a background <rect>, but some mermaid paths still emit a foreignObject, and the two
   need different properties (CSS box properties vs. SVG presentation attributes). */
.flowchart .edgeLabel rect {
  fill: var(--paper) !important;
  stroke: #000 !important;
  stroke-width: 3px !important;
}

.flowchart .edgeLabel foreignObject > div {
  background: var(--paper) !important;
  border: 3px solid #000 !important;
  box-shadow: 3px 3px 0 #000 !important;
  padding: 0 3px !important;
}

/* ── Subgraph clusters ───────────────────────────────────────────────────── */
.flowchart .cluster rect {
  fill: var(--paper) !important;
  stroke: #000 !important;
  stroke-width: 3px !important;
  filter: drop-shadow(5px 5px 0px #000) !important;
}

/* ── Typography ──────────────────────────────────────────────────────────────
   Declared in px, not em: <text> and <tspan> both match this rule, and an em value would compound
   through the tspan to 81% of the intended size.

   font-size is the uppercase width compensation described in the module header — change it only
   alongside \`themeVariables.fontSize\` in FlowchartView, or labels will start overflowing. */
.flowchart text,
.flowchart tspan,
.flowchart foreignObject div,
.flowchart foreignObject span {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
  font-weight: 800 !important;
  font-size: 13.5px !important;
  letter-spacing: -0.02em !important;
  text-transform: uppercase !important;
  fill: #000 !important;
  /* Node labels are an HTML subtree inside <foreignObject>, where \`fill\` does nothing — \`color\`
     is what actually paints them. Mermaid happens to set the right value today, but this skin
     should not depend on its stylesheet still being there. */
  color: #000 !important;
  /* Mermaid outlines some labels; an outline on a chunky face just muddies it. */
  stroke: none !important;
}

/* Cluster titles carry even more weight than node labels — they are the section headers. */
.flowchart .cluster text,
.flowchart .cluster foreignObject div {
  font-weight: 900 !important;
  letter-spacing: 0.02em !important;
}
`;

/** Locates mermaid's root `<svg …>` element. */
const SVG_OPEN_TAG = /<svg\b/i;

/**
 * Index just past the `>` that closes an opening tag, skipping over quoted attribute values.
 *
 * A plain `[^>]*>` regex is not good enough here: `>` is legal inside an attribute value, so a tag
 * like `<svg data-note="a > b">` would match up to the wrong `>`. Mermaid's own root tag does not
 * carry one today, but injecting in the middle of an attribute would emit broken markup — a much
 * worse failure than not styling at all.
 *
 * Returns -1 when the tag is never closed.
 */
function findTagEnd(markup: string, from: number): number {
  let quote: string | null = null;

  for (let i = from; i < markup.length; i++) {
    const ch = markup[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
  }

  return -1;
}

/**
 * Returns `svg` with the neo-brutalist stylesheet inserted as the first child of the root element.
 *
 * Appending a second `<style>` (rather than editing mermaid's own) leaves mermaid's generated
 * stylesheet intact and lets ours win on `!important` — mermaid's rules are plain declarations, so
 * there is no specificity fight to lose.
 *
 * Fails open: markup with no root `<svg>` tag, or one that never closes, is returned untouched —
 * an unstyled diagram still renders, which beats blank (RULES.md §1a).
 */
export function injectDiagramTheme(svg: string): string {
  const open = SVG_OPEN_TAG.exec(svg);
  if (open === null) return svg;

  const insertAt = findTagEnd(svg, open.index + open[0].length);
  if (insertAt === -1) return svg;

  const sheet = `<style>${DIAGRAM_THEME_CSS}</style>`;
  return svg.slice(0, insertAt) + sheet + svg.slice(insertAt);
}
