/**
 * lib/analogyPrompts.ts — static analogy prompt templates + crash-narrative builder.
 * Owned by Phase 3 (Metaphor Generator Agent). No I/O, no side effects — pure prompt strings.
 *
 * Covers:
 *  - buildAnalogyPrompt()      → /api/analogy (ARCHITECTURE.md §2.2)
 *  - buildCrashPrompt()        → /api/crash-simulation (ARCHITECTURE.md §2.3)  [added Phase 3.5.1]
 *
 * Two flavours of theme are supported:
 *  - PRESET themes (restaurant | airport | hospital | city) carry a hand-authored ROLE_VOCAB map.
 *    Supplying the vocabulary explicitly is what keeps the metaphors sharp and consistent across
 *    the analogy panel and the crash narrative.
 *  - CUSTOM themes are free text the user typed. There is no vocabulary to hand them, so the
 *    prompt instructs the model to invent one and then stick to it for every component.
 *
 * Voice: punchy, not literary. One short sentence per component — the panel is a dashboard,
 * not an essay. "Vivid, not dry" is still the bar (BUILD_STRATEGY.md §3.1 & §3.5.1), but vivid
 * now means *dense*, not *long*.
 */

import type {
  ArchitectureNode,
  AnalogyType,
  AnalogyMappingEntry,
  PresetAnalogyType,
} from "./types";
import { isPresetAnalogyType } from "./types";

/* ------------------------------------------------------------------ *
 * Role → analogy vocabulary maps
 * Each map covers all 8 ArchitectureRole values so the prompt can
 * substitute them by name without a fallback.
 * ------------------------------------------------------------------ */

const ROLE_VOCAB: Record<PresetAnalogyType, Record<string, string>> = {
  restaurant: {
    frontend:  "the dining room and menus customers see and touch",
    api:       "the head waiter relaying orders between tables and the kitchen",
    database:  "the walk-in pantry storing every ingredient and recipe card",
    queue:     "the order ticket rail clipped above the pass where orders wait their turn",
    cache:     "the mise-en-place station with pre-prepped ingredients for instant use",
    worker:    "the line cook who executes tasks the head waiter hands off",
    config:    "the manager's recipe binder and shift-schedule board",
    unknown:   "a station whose exact role in the kitchen is unclear",
  },
  airport: {
    frontend:  "the departure terminal and gate screens passengers interact with",
    api:       "the air-traffic controller routing flights between terminals and runways",
    database:  "the central reservation and manifest registry for every flight and passenger",
    queue:     "the boarding queue and baggage-claim carousel where items wait in sequence",
    cache:     "the departure board cache refreshed every 30 seconds for fast lookups",
    worker:    "the ground crew executing tarmac jobs dispatched by the control tower",
    config:    "the operations manual and slot-allocation schedule pinned in the tower",
    unknown:   "a facility whose function in the airport layout hasn't been identified",
  },
  hospital: {
    frontend:  "the reception desk and patient-facing intake forms",
    api:       "the charge nurse routing requests between departments and specialists",
    database:  "the medical-records vault holding every patient history and test result",
    queue:     "the triage waiting area where cases are held in priority order",
    cache:     "the emergency-room crash cart stocked for immediate use without a supply run",
    worker:    "the orderly carrying out tasks assigned by the charge nurse",
    config:    "the hospital policy manual and duty-roster posted at the nurses' station",
    unknown:   "a department whose specialty within the hospital is not yet determined",
  },
  city: {
    frontend:  "the public plazas and storefronts residents walk through every day",
    api:       "the city's road network and traffic-signal grid directing flows between districts",
    database:  "the city hall archive storing land deeds, census records, and permits",
    queue:     "the permit-application office where requests are processed in filing order",
    cache:     "the neighbourhood bulletin board with this week's most-needed information",
    worker:    "a municipal crew executing maintenance tasks dispatched by the operations centre",
    config:    "the city charter and zoning ordinances that govern how every district operates",
    unknown:   "a district whose designated purpose on the city map hasn't been established",
  },
};

/**
 * Role descriptions used when the theme has no hand-authored vocabulary (custom themes).
 * Kept deliberately plain so the model overwrites them with theme-specific language rather
 * than treating them as authoritative.
 */
const GENERIC_ROLE_DESC: Record<string, string> = {
  frontend:  "the surface users see and interact with",
  api:       "the layer routing requests between the surface and the core",
  database:  "the store holding the system's persistent state",
  queue:     "the buffer where work waits its turn",
  cache:     "the fast-access layer holding frequently needed data",
  worker:    "the background process executing deferred work",
  config:    "the settings governing how the system behaves",
  unknown:   "a component whose exact role is unclear",
};

/**
 * Looks up the vocabulary map for a theme. Custom themes have none — callers must handle null
 * rather than indexing ROLE_VOCAB directly, which would silently hand back `undefined` for any
 * key outside the preset union.
 */
export function vocabForTheme(
  analogyType: AnalogyType,
): Record<string, string> | null {
  return isPresetAnalogyType(analogyType) ? ROLE_VOCAB[analogyType] : null;
}

/** Role description for a theme, falling back to the generic wording for custom themes. */
function roleDescription(analogyType: AnalogyType, role: string): string {
  const vocab = vocabForTheme(analogyType);
  return vocab?.[role] ?? GENERIC_ROLE_DESC[role] ?? GENERIC_ROLE_DESC["unknown"];
}

/* ------------------------------------------------------------------ *
 * buildAnalogyPrompt
 * ------------------------------------------------------------------ */

/**
 * Builds the system + user prompt pair for /api/analogy (ARCHITECTURE.md §2.2).
 *
 * The model must return ONLY:
 * {
 *   "analogyType": "<type>",
 *   "mapping": [ { "componentLabel", "analogyRole", "explanation" } ],
 *   "summary": "<string>",
 *   "labelMappings": [ { "nodeId", "analogyLabel" } ]
 * }
 *
 * Exactly one labelMappings entry per node id — no more, no fewer.
 *
 * Brevity contract: summary is ONE short sentence (≤18 words); each `explanation` is ONE short
 * sentence (≤16 words). The panel renders one row per component, so a wordy explanation is a
 * row a reader skips.
 */
export function buildAnalogyPrompt(
  architecture: ArchitectureNode[],
  analogyType: AnalogyType,
): { system: string; user: string } {
  const vocab = vocabForTheme(analogyType);

  const vocabularySection = vocab
    ? `Role vocabulary for this theme:
${Object.entries(vocab)
  .map(([role, desc]) => `  - ${role}: ${desc}`)
  .join("\n")}`
    : `This is a CUSTOM theme chosen by the user — there is no pre-written vocabulary.
You must invent a consistent set of ${analogyType} roles for the eight architecture roles
(frontend, api, database, queue, cache, worker, config, unknown), then reuse those exact terms
for every component below. Consistency matters more than cleverness.`;

  const nodeList = architecture
    .map((n) => `  { "id": "${n.id}", "label": "${n.label}", "role": "${n.role}" }`)
    .join(",\n");

  const nodeIds = architecture.map((n) => `"${n.id}"`).join(", ");

  const system = `You translate software architecture into vivid ${analogyType} analogies \
for non-technical stakeholders. You write SHORT. Every field is one punchy sentence.

ANALOGY THEME: ${analogyType.toUpperCase()}
${vocabularySection}

RULES:
1. Return ONLY a single valid JSON object — no markdown fences, no prose before or after.
2. The JSON must match this exact shape:
{
  "analogyType": "${analogyType}",
  "mapping": [
    { "componentLabel": "<original label>", "analogyRole": "<3-6 word role in the ${analogyType}>", "explanation": "<ONE sentence, max 16 words>" }
  ],
  "summary": "<ONE sentence, max 18 words, the whole system as a single ${analogyType} image>",
  "labelMappings": [
    { "nodeId": "<id>", "analogyLabel": "<short, punchy ${analogyType}-themed label, ≤4 words>" }
  ]
}
3. "labelMappings" MUST contain exactly one entry for each of these node ids: ${nodeIds}. No extras, no omissions.
4. Keep every "explanation" to ONE sentence of at most 16 words. No preamble, no "This component...", \
no restating the component label, no second sentence. Cut every word that isn't load-bearing.
5. Keep "summary" to ONE sentence of at most 18 words. No lists, no "in conclusion", no restating each component.
6. "analogyRole" must be concrete and theme-specific (e.g. "head waiter", "triage nurse"), never a \
generic label like "component" or "service".
7. Stay in the ${analogyType} vocabulary throughout so the crash narrative can reuse the same terms.
8. "analogyLabel" is this theme's short name for a node — keep it to ≤4 words, memorable, and \
theme-appropriate. Do NOT use special characters [ ] ( ) { } " or backticks.`;

  const user = `Architecture nodes to map:
[
${nodeList}
]

Return the JSON object now.`;

  return { system, user };
}

/* ------------------------------------------------------------------ *
 * buildCrashPrompt  (Phase 3.5.1)
 * ------------------------------------------------------------------ */

/**
 * Builds the system + user prompt pair for /api/crash-simulation (ARCHITECTURE.md §2.3).
 *
 * The model must return ONLY:
 * { "failureScenario": "<string ≤400 chars, 2-3 sentences>" }
 *
 * Narrative must:
 *  - Stay in the active analogy theme's vocabulary
 *  - Reason only from node.evidence and analogyMapping (RULES.md §3.6)
 *  - Hedge (not invent) for role "unknown"
 */
export function buildCrashPrompt(
  node: ArchitectureNode,
  analogyType: AnalogyType,
  analogyMapping: AnalogyMappingEntry | null,
): { system: string; user: string } {
  const roleDesc = roleDescription(analogyType, node.role);

  const mappingContext = analogyMapping
    ? `In the ${analogyType} analogy, this component is: "${analogyMapping.analogyRole}". \
Context: ${analogyMapping.explanation}`
    : `This component's analogy role has not yet been established — keep your narrative general.`;

  const unknownHedge =
    node.role === "unknown"
      ? `\nIMPORTANT: This component's role is inferred/uncertain. Hedge your narrative — \
use phrases like "likely", "probably", or "may" rather than asserting specific system relationships.`
      : "";

  const system = `You are a master storyteller explaining software failures to non-technical \
stakeholders using the ${analogyType.toUpperCase()} analogy.

ANALOGY THEME: ${analogyType.toUpperCase()}
Component's role in this theme: ${roleDesc}
${mappingContext}${unknownHedge}

RULES:
1. Return ONLY a single valid JSON object: { "failureScenario": "<narrative>" }
2. No markdown fences, no prose before or after.
3. The narrative must be 2-3 sentences, vivid, and written entirely in ${analogyType} metaphor vocabulary.
4. Reason ONLY from the component's "evidence" field and its analogy role stated above. \
   Do NOT assert or invent any upstream/downstream dependencies, system relationships, or \
   failure cascades that are not explicitly described in that evidence — not even plausible ones.
5. Focus on business impact — what does a non-technical stakeholder lose or experience?
6. Keep the total character count under 400 characters (the server will truncate at a sentence boundary if over).`;

  // Sanitize string fields before embedding in the prompt — a label or evidence string
  // containing a literal `"` would break the prompt's own JSON-like formatting.
  const safeLabel    = node.label.replace(/"/g, "'");
  const safeEvidence = node.evidence.replace(/"/g, "'");

  const user = `Component that failed:
- id: "${node.id}"
- label: "${safeLabel}"
- role: "${node.role}"
- evidence: "${safeEvidence}"

Write the failure scenario narrative in the ${analogyType} analogy theme now.`;

  return { system, user };
}
