/**
 * lib/mermaidSanitize.ts — RULES.md §1, the 8-step mermaid sanitization protocol.
 *
 * Applied in the EXACT order given, before render AND before returning `mermaidCode` from
 * /api/analyze. §1a re-uses the same entry point for label morphing: a morphed string is rebuilt
 * and pushed through all 8 steps from scratch, never patched into live SVG.
 *
 * Deliberately dependency-free and DOM-free: the identical function runs in the analyze route
 * (Node) and in FlowchartView's render effect (browser), so it may not import `mermaid` — and it
 * must not, since sanitization has to happen before mermaid ever sees the string (defense in depth
 * with `securityLevel: "strict"` per ARCHITECTURE.md §5, not either/or).
 */

/* ------------------------------------------------------------------ *
 * Result shape
 * ------------------------------------------------------------------ */

export interface SanitizedDiagram {
  /** Ready for `mermaid.render(uniqueId, code)`. Nothing downstream may modify this string. */
  code: string;
  /** Non-fatal normalizations applied, in pipeline order. For dev logging only (§5 checklist). */
  warnings: string[];
}

export interface SanitizeRejected {
  ok: false;
  /** Always `parse_failed`: a §1 step 7/8 rejection is "could not read that repo's structure". */
  error: "parse_failed";
  /**
   * Internal diagnostic naming the step that rejected. Goes to the SERVER LOG only — §3's error
   * table is what the client sees, and raw sanitizer detail must never be forwarded (§2.1).
   */
  reason: string;
}

/**
 * Structurally compatible with `FetchErr` in lib/github.ts (the failure branch only adds `reason`),
 * so /api/analyze can handle all three lib stages the same way.
 */
export type SanitizeResult = { ok: true; data: SanitizedDiagram } | SanitizeRejected;

/* ------------------------------------------------------------------ *
 * §1 step 6 caps
 * ------------------------------------------------------------------ */

const MAX_NODES = 40;
const MAX_EDGES = 60;

/** Mermaid rejects an empty label; step 4 can empty one out (a label that was only punctuation). */
const EMPTY_LABEL = "unnamed";

/* ------------------------------------------------------------------ *
 * §1 step 1 / 3 patterns
 * ------------------------------------------------------------------ */

const LEADING_FENCE = /^```(?:mermaid)?\s*\n?/;
const TRAILING_FENCE = /\n?```\s*$/;
/** A fence preceded only by blank lines, so the position-0 anchors above cannot see it. */
const INDENTED_LEADING_FENCE = /^\s*```(?:mermaid)?[^\S\n]*\n?/;

const DECLARATION = /^(graph|flowchart)\s+(TD|TB|LR|RL|BT)/;
const DEFAULT_DECLARATION = "flowchart TD";

/* ------------------------------------------------------------------ *
 * §1 step 7 patterns — reject, never attempt to repair
 * ------------------------------------------------------------------ */

/**
 * `click` as a DIRECTIVE: line-leading word followed by whitespace, which is where mermaid requires
 * it. Anchoring to line start plus a required space is what keeps a legitimate label such as
 * `A[Click to start]` — or a node id that merely contains the word — from being rejected.
 */
const CLICK_DIRECTIVE = /^[ \t]*click[ \t]/m;
/** `%%{init: ...}%%` and every other `%%{...}%%` directive block (§5 fixes the theme in code). */
const DIRECTIVE_BLOCK = /%%\{/;
const HTML_INJECTION =
  /<\s*\/?\s*(?:script|iframe|object|embed|svg|img|a)\b|javascript:|data:text\/html|\bon(?:click|error|load|mouse\w*|focus|blur|submit|change|input|toggle)\s*=/i;

function findDangerous(text: string): string | null {
  if (CLICK_DIRECTIVE.test(text)) return "click directive present (§1 step 7 bans it outright)";
  if (DIRECTIVE_BLOCK.test(text)) return "%%{...} directive block present (§1 step 7)";
  if (HTML_INJECTION.test(text)) return "raw HTML/script injection attempt present (§1 step 7)";
  return null;
}

/* ------------------------------------------------------------------ *
 * §1 steps 4-5 — label text
 * ------------------------------------------------------------------ */

/** Characters step 4 neutralizes *inside* label text (the delimiters themselves are the scanner's). */
const RESERVED_IN_LABEL = /[[\](){}]/g;

function sanitizeLabelText(inner: string): string {
  const neutralized = inner
    .replace(RESERVED_IN_LABEL, " ") // step 4
    .replace(/"/g, "'") // step 4
    .replace(/`/g, ""); // step 4 — backticks stripped entirely, not replaced

  // step 5 — leading characters outside letters/digits/space/`-`/`_`/`.`/`/` are dropped.
  // Trimming first so the padding step 4 introduces cannot shield a leading `*` or `#` from the rule.
  return neutralized.trim().replace(/^[^A-Za-z0-9\-_./]+/, "").trim();
}

/* ------------------------------------------------------------------ *
 * Line scanner — the structural pass shared by steps 4, 5 and 6
 * ------------------------------------------------------------------ */

interface LineScan {
  /** The line with every label's inner text run through steps 4-5. */
  text: string;
  /** Node ids introduced on this line (used for step 6's distinct-node count). */
  ids: string[];
  /** Arrow operators on this line (step 6's edge count). */
  edges: number;
  subgraphOpens: number;
  subgraphCloses: number;
  emptiedLabel: boolean;
}

/** Mermaid id shape. `.` is included so repo-derived ids like `app.v2` count as ONE node. */
const ID_START = /[A-Za-z_]/;
const ID_BODY = /[\w.-]/;
/** Exactly the arrow operators RULES.md §3.3 permits, plus their dotted/equals forms. */
const ARROW = /^-{2,}|^-\.-+|^={2,}/;

/** Structural words that are not node ids, so step 6's node count stays truthful. */
const RESERVED_TOKENS = [
  "graph",
  "flowchart",
  "subgraph",
  "end",
  "direction",
  "TD",
  "TB",
  "LR",
  "RL",
  "BT",
  "classDef",
  "class",
  "style",
  "linkStyle",
];

const OPEN_TO_CLOSE: Record<string, string> = { "[": "]", "(": ")", "{": "}" };

/**
 * Walks one line, emitting it with label text sanitized. Labels are the only place steps 4-5 act;
 * their delimiters are re-emitted untouched so step 8 can still see the structural brackets.
 * `|...|` edge labels are treated as label text too (see the module's deviation notes).
 */
function scanLine(line: string): LineScan {
  const out: string[] = [];
  const ids: string[] = [];
  let edges = 0;
  let subgraphOpens = 0;
  let subgraphCloses = 0;
  let emptiedLabel = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    const isPipe = ch === "|";
    const close = isPipe ? "|" : OPEN_TO_CLOSE[ch];

    if (close !== undefined) {
      const end = line.indexOf(close, i + 1);
      const candidate = end === -1 ? line.slice(i + 1) : line.slice(i + 1, end);
      // An unclosed delimiter, OR a same-type delimiter nested inside the candidate label (mermaid
      // has no nested labels, so that means the opener was never a label), is emitted VERBATIM and
      // left to step 8. Step 4 must never be allowed to strip such a bracket: doing so reconciles
      // the counts and "repairs" a structural break — the exact silent-garbage path §1 step 8 bans.
      if (end === -1 || candidate.indexOf(ch) !== -1) {
        out.push(line.slice(i));
        break;
      }
      let inner = sanitizeLabelText(candidate);
      // An empty label is a mermaid syntax error, not a valid diagram — substitute a placeholder
      // rather than emit `A[]` and have mermaid throw later with a less useful message.
      if (inner === "" && !isPipe) {
        inner = EMPTY_LABEL;
        emptiedLabel = true;
      }
      out.push(ch + inner + close);
      i = end + 1;
      continue;
    }

    if (ID_START.test(ch)) {
      let j = i + 1;
      while (j < line.length && ID_BODY.test(line[j])) j++;
      const ident = line.slice(i, j);
      if (ident === "subgraph") subgraphOpens++;
      else if (ident === "end") subgraphCloses++;
      else if (RESERVED_TOKENS.indexOf(ident) === -1) ids.push(ident);
      out.push(ident);
      i = j;
      continue;
    }

    const arrow = ARROW.exec(line.slice(i));
    if (arrow !== null) {
      edges++;
      out.push(arrow[0]);
      i += arrow[0].length;
      continue;
    }

    out.push(ch);
    i++;
  }

  return { text: out.join(""), ids, edges, subgraphOpens, subgraphCloses, emptiedLabel };
}

/* ------------------------------------------------------------------ *
 * §1 step 8 — balance check
 * ------------------------------------------------------------------ */

/**
 * Equal open/close counts per bracket family, exactly as §1 step 8 specifies (a count check, not a
 * LIFO depth check). Step 4 has already replaced every bracket INSIDE label text with a space, so
 * anything counted here is structural.
 */
function isBalanced(text: string): boolean {
  const count = (ch: string) => text.split(ch).length - 1;
  return (
    count("[") === count("]") && count("(") === count(")") && count("{") === count("}")
  );
}

/* ------------------------------------------------------------------ *
 * §1 — the pipeline
 * ------------------------------------------------------------------ */

/**
 * Runs `raw` through all 8 steps. Returns the sanitized definition, or a rejection — it never
 * partially repairs structural syntax (§1 step 8's explicit instruction).
 */
export function sanitizeMermaid(raw: string): SanitizeResult {
  const warnings: string[] = [];

  // step 7 first, against the RAW input: a `click` directive or injection attempt must be rejected
  // outright, and must not be able to escape by sitting past step 6's truncation point.
  const rawDanger = findDangerous(raw);
  if (rawDanger !== null) {
    console.error(`[mermaidSanitize] rejected (step 7, raw): ${rawDanger}`);
    return { ok: false, error: "parse_failed", reason: rawDanger };
  }

  // step 1 — code fences, either or both sides (§1: strip even if only one is present).
  let text = raw.replace(LEADING_FENCE, "").replace(TRAILING_FENCE, "");
  if (INDENTED_LEADING_FENCE.test(text)) {
    text = text.replace(INDENTED_LEADING_FENCE, "");
    warnings.push("step 1: stripped a code fence that was preceded by blank lines");
  }

  // Step 2 - strip whitespace and BOM. The BOM is written as an escape, never as a literal
  // byte: an invisible character in source survives neither an editor round-trip nor review.
  text = text.replace(/\uFEFF/g, "").trim();

  // step 3 — normalize the declaration. Never trust the model to have emitted a usable header.
  const lines = text.split(/\r?\n/);
  let firstNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      firstNonEmpty = i;
      break;
    }
  }
  if (firstNonEmpty === -1) {
    console.error("[mermaidSanitize] rejected: no diagram content after step 2");
    return { ok: false, error: "parse_failed", reason: "empty diagram after fence/BOM stripping" };
  }
  if (!DECLARATION.test(lines[firstNonEmpty].trim())) {
    lines.splice(firstNonEmpty, 0, DEFAULT_DECLARATION);
    warnings.push(`step 3: first line was not a graph/flowchart declaration — prepended \`${DEFAULT_DECLARATION}\``);
  }

  // steps 4, 5 and 6 — one pass: label text sanitized, node/edge budget enforced.
  const kept: string[] = [];
  const seenIds = new Set<string>(); // membership only, never iterated (ES5 target)
  let edges = 0;
  let subgraphDepth = 0;
  let truncated = false;

  for (const line of lines) {
    const scan = scanLine(line);
    let addedNodes = 0;
    for (const id of scan.ids) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      addedNodes++;
    }
    if (scan.emptiedLabel) warnings.push("step 5: a label emptied out — substituted a placeholder");

    if (seenIds.size > MAX_NODES || edges + scan.edges > MAX_EDGES) {
      truncated = true;
      warnings.push(
        `step 6: ${seenIds.size} nodes / ${edges + scan.edges} edges exceeds the ${MAX_NODES}/${MAX_EDGES} cap — truncated at a line boundary`,
      );
      break;
    }

    edges += scan.edges;
    if (scan.subgraphOpens > 0) subgraphDepth += scan.subgraphOpens;
    if (scan.subgraphCloses > 0) subgraphDepth = Math.max(0, subgraphDepth - scan.subgraphCloses);
    kept.push(scan.text);
  }

  // Truncating can leave a `subgraph` without its `end`, which is not valid mermaid. §1 step 6
  // requires completing valid syntax at the cut, so close any block left open.
  if (truncated && subgraphDepth > 0) {
    for (let i = 0; i < subgraphDepth; i++) kept.push("end");
    warnings.push(`step 6: closed ${subgraphDepth} subgraph block(s) left open by the truncation`);
  }

  let code = kept.join("\n");

  // step 7 again, against the assembled output — cheap defense in depth for §1a's re-entry path.
  const outDanger = findDangerous(code);
  if (outDanger !== null) {
    console.error(`[mermaidSanitize] rejected (step 7, sanitized): ${outDanger}`);
    return { ok: false, error: "parse_failed", reason: outDanger };
  }

  // step 8 — structural balance, or reject. No auto-repair.
  if (!isBalanced(code)) {
    const reason = `unbalanced brackets after step 4 (\`[\`×${code.split("[").length - 1}/\`]\`×${code.split("]").length - 1}, \`(\`×${code.split("(").length - 1}/\`)\`×${code.split(")").length - 1}, \`{\`×${code.split("{").length - 1}/\`}\`×${code.split("}").length - 1})`;
    console.error(`[mermaidSanitize] rejected (step 8): ${reason}`);
    return { ok: false, error: "parse_failed", reason };
  }

  return { ok: true, data: { code, warnings } };
}

/* ------------------------------------------------------------------ *
 * Deviation notes — the "see the module's deviation notes" references above
 * ------------------------------------------------------------------ */

/**
 * Deliberate departures from a literal reading of RULES.md §1. Each is load-bearing; none is an
 * oversight, and each is covered by the micro-step 2.4 harness.
 *
 * 1. `|edge labels|` are sanitized as label text. §1 step 4 names only `[...]`, `(...)` and `{...}`,
 *    but an edge label is the same untrusted-model-text-inside-a-delimiter case and gets the same
 *    treatment rather than a second, weaker code path.
 *
 * 2. A line with an unclosed opener — or a same-type delimiter nested inside a candidate label — is
 *    emitted VERBATIM and handed to step 8, never sanitized. Neutralizing a bracket there would
 *    reconcile the counts and "repair" a structural break into something that merely looks balanced,
 *    which is the silent-garbage outcome step 8 exists to prevent.
 *
 * 3. Step 7's `click` pattern is anchored to line start plus whitespace (mermaid's own requirement for
 *    a directive) instead of matching the bare word anywhere. Without the anchor a legitimate label
 *    such as `A[Click to start]` would fail the entire analysis.
 *
 * 4. Step 7 runs against the RAW input BEFORE step 6's truncation, so a `click` sitting past the
 *    node/edge cap cannot escape rejection by being cut off.
 *
 * KNOWN RESIDUAL GAP — step 8 is a balanced-COUNT check, exactly as §1 specifies, not a parser. Two
 * constructs have matching counts and so pass it without being valid mermaid:
 *   - same-type nesting with even counts: `A[a[b]c]`
 *   - a label opened on one line and closed on a later line: `A[foo\nbar]`
 * Both are left accepted rather than auto-repaired, per §1 step 8's explicit instruction. The
 * backstop is ARCHITECTURE.md §5: `mermaid.render()` throws, FlowchartView catches it and surfaces the
 * `parse_failed` message. Adding a stricter syntactic parse here would mean this module and mermaid
 * each holding a slightly different copy of the grammar.
 *
 * NOT BANNED BY §1, passed through unchanged: `classDef`, `class`, `style` and `linkStyle` are counted
 * as non-node tokens (so they cannot inflate step 6's node budget) but are not rejected — step 7
 * enumerates `click`, `%%{...}%%` and HTML/script as the reject-worthy constructs. RULES.md §3.3 keeps
 * the *generator* from emitting them; stripping them here would be a §1 addition, not a fix.
 *
 * The step 7 HTML pattern list is deliberately targeted (`script`/`iframe`/`svg`/`img`/`a`/..., a
 * `javascript:` scheme, `on*=` handler attributes) rather than "any `<` or `>`" — a legitimate
 * repo-derived label like `A[a < b]` must not fail the whole analysis. `htmlLabels: false` plus
 * `securityLevel: "strict"` (ARCHITECTURE.md §5) is the second layer that renders such text inert.
 */
