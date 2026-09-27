"use client";

/**
 * components/AnalysisPanel.tsx
 * Central state orchestration container for the analysis flow (ARCHITECTURE.md §4, Phase 5).
 * Owns the 9-action useReducer (ARCHITECTURE.md §4), renders the two-column layout shell
 * (design.md §5, RULES.md §2), and integrates FlowchartView in the left panel.
 *
 * Sub-task 5.2: /api/analyze wiring, ErrorBanner (VerdictBadge removed — see below).
 * Sub-task 5.3: Auto-fired default analogy call on ANALYZE_SUCCESS (PRD.md §2.5).
 * AnalogyPanel (5.4) and CrashSimulationCard (5.6b) are additive — not in scope here.
 *
 * UX pivot — the diagram no longer morphs. Sub-task 5.6a used to rewrite every node label with the
 * theme's `labelMappings[].analogyLabel` on ANALOGY_SUCCESS. The diagram is now the repository's
 * own structure (node labels are real folder paths from `RepoSummary.moduleFolders`), and the theme
 * is surfaced *over* it instead of *in* it: this component derives a node-id → analogy-role lookup
 * and hands it to FlowchartView, which shows it in a hover tooltip. `labelMappings` is still
 * returned and validated by /api/analogy (ARCHITECTURE.md §2.2) — it is simply no longer applied to
 * the diagram.
 */

import { useReducer, useEffect, useRef, useCallback, useMemo } from "react";
import FlowchartView from "@/components/FlowchartView";
import AnalogyPanel from "@/components/AnalogyPanel";
import AnalogySelector from "@/components/AnalogySelector";
import CrashSimulationCard from "@/components/CrashSimulationCard";
import type {
  AnalysisState,
  AnalysisAction,
  AnalogyType,
  ErrorCode,
  ArchitectureNode,
  AnalogyMappingEntry,
  AnalyzeResponse,
  AnalogyResponse,
  CrashSimulationResponse,
} from "@/lib/types";
import { INITIAL_ANALYSIS_STATE, ERROR_MESSAGES, DEFAULT_ANALOGY_TYPE } from "@/lib/types";

// ─── Node → analogy-role lookup ───────────────────────────────────────────────
//
// Drives the hover tooltip on the diagram (components/FlowchartView.tsx).
//
// `mapping[]` is keyed by `componentLabel` (ARCHITECTURE.md §2.2), and a node's label IS its repo
// folder path — so the join is label → label. It is done in two passes on purpose: the exact match
// handles the normal case, and a normalized match (trimmed, case-folded) absorbs the whitespace and
// casing drift an LLM reliably introduces. Anything still unmatched simply gets no tooltip entry,
// which the tooltip renders as "not yet mapped" rather than a blank — a missing mapping must never
// take the diagram down (RULES.md §3).
//
// Labels are unique per node by construction: /api/analyze returns exactly one architecture[] entry
// per diagram node, and parseArchitecture drops duplicates.

function mappingRoleFor(
  node: ArchitectureNode,
  mapping: AnalogyMappingEntry[],
): string | null {
  const exact = mapping.find((m) => m.componentLabel === node.label);
  if (exact !== undefined) return exact.analogyRole;

  const wanted = node.label.trim().toLowerCase();
  const normalized = mapping.find((m) => m.componentLabel.trim().toLowerCase() === wanted);
  return normalized === undefined ? null : normalized.analogyRole;
}

/**
 * Builds `{ [nodeId]: analogyRole }` for the currently-active theme.
 * Returns an empty object while no analogy has resolved, which is the tooltip's "pending" state.
 */
function buildAnalogyRoles(
  architecture: ArchitectureNode[],
  mapping: AnalogyMappingEntry[] | null,
): Record<string, string> {
  const roles: Record<string, string> = {};
  if (mapping === null) return roles;

  for (const node of architecture) {
    const role = mappingRoleFor(node, mapping);
    if (role !== null) roles[node.id] = role;
  }
  return roles;
}

// ─── Reducer ────────────────────────────────────────────────────────────────

function analysisReducer(state: AnalysisState, action: AnalysisAction): AnalysisState {
  switch (action.type) {
    case "SUBMIT":
      return {
        ...INITIAL_ANALYSIS_STATE,
        status: "loading",
      };

    case "ANALYZE_SUCCESS":
      return {
        ...state,
        status: "success",
        error: null,
        repoSummary: action.payload.repoSummary,
        architecture: action.payload.architecture,
        // Both mermaidCode and technicalMermaidCode point to the same original string on fresh
        // analysis — technicalMermaidCode stays frozen here as the morphing baseline (§5.1).
        mermaidCode: action.payload.mermaidCode,
        technicalMermaidCode: action.payload.mermaidCode,
        verdict: action.payload.verdict,
      };

    case "ANALYZE_ERROR":
      return {
        ...state,
        status: "error",
        error: action.payload.error,
      };

    case "ANALOGY_LOADING":
      return {
        ...state,
        analogyState: {
          ...state.analogyState,
          status: "loading",
          type: action.payload.analogyType,
        },
      };

    case "ANALOGY_SUCCESS":
      // The diagram is deliberately untouched. Analogy success now changes only the analogy panel
      // and the hover tooltip (derived in the component body from `analogyState.data`) — the
      // mermaid string keeps showing the repo's own folder paths for the life of the analysis.
      return {
        ...state,
        analogyState: {
          status: "success",
          type: action.payload.data.analogyType,
          data: action.payload.data,
        },
      };

    case "ANALOGY_ERROR":
      return {
        ...state,
        analogyState: {
          ...state.analogyState,
          status: "error",
        },
      };

    // CRASH_SIM_* — no-op guard: ignored if pendingNodeId already matches (ARCHITECTURE.md §4).
    case "CRASH_SIM_REQUEST": {
      const { nodeId } = action.payload;
      if (state.crashState.pendingNodeId === nodeId) return state;
      return {
        ...state,
        crashState: {
          ...state.crashState,
          status: "loading",
          pendingNodeId: nodeId,
        },
      };
    }

    case "CRASH_SIM_SUCCESS": {
      const { nodeId, data } = action.payload;
      // Discard stale responses — last click wins (PRD.md §6).
      if (state.crashState.pendingNodeId !== nodeId) return state;
      return {
        ...state,
        crashState: {
          status: "success",
          pendingNodeId: nodeId,
          resultNodeId: nodeId,
          result: data,
        },
      };
    }

    case "CRASH_SIM_ERROR": {
      const { nodeId } = action.payload;
      if (state.crashState.pendingNodeId !== nodeId) return state;
      return {
        ...state,
        crashState: {
          ...state.crashState,
          status: "error",
        },
      };
    }

    default:
      return state;
  }
}

// ─── VerdictBadge — REMOVED ───────────────────────────────────────────────
//
// The "N friction — <reason>" banner that used to sit above the results is gone from the UI. On a
// sparse repo its reason is the longest, loudest sentence on the page ("No package manifest, no
// docker-compose services and no README were found for this repo."), and it read as a failure
// notice for what PRD.md §58 defines as a perfectly valid input.
//
// The data is deliberately still there: `verdict` is parsed, validated and stored on AnalysisState
// exactly as before (lib/types.ts, app/api/analyze/route.ts), so restoring the badge is a render
// change and nothing else.

// ─── ErrorBanner ─────────────────────────────────────────────────────────
// Red-bordered white card with a hard red shadow — loud enough to stop a scroll.

function ErrorBanner({ error }: { error: ErrorCode }) {
  const message = ERROR_MESSAGES[error];
  return (
    <div
      role="alert"
      className="nb-block nb-shadow-md border-[var(--red)] px-4 py-3 text-sm font-bold text-[var(--red)]"
    >
      {message}
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────

interface AnalysisPanelProps {
  /** GitHub owner — passed from page.tsx after form submission. */
  owner: string;
  /** GitHub repo name — passed from page.tsx after form submission. */
  repo: string;
  /**
   * Called once when /api/analyze settles (success OR error) so page.tsx can re-enable the
   * Analyze button. AnalysisPanel owns its own internal loading state; this callback is only
   * the signal that the initial fetch has completed.
   */
  onAnalysisDone?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AnalysisPanel({ owner, repo, onAnalysisDone }: AnalysisPanelProps) {
  const [state, dispatch] = useReducer(analysisReducer, INITIAL_ANALYSIS_STATE);

  // Stable ref so the analogy effect can abort an in-flight request when a new analysis fires.
  const analogyAbortRef = useRef<AbortController | null>(null);

  // Fire /api/analyze as soon as owner+repo are received (i.e., on each new submission).
  // SUBMIT resets state to loading before the fetch begins.
  // onAnalysisDoneRef — stable ref so the effect dependency array doesn't include the callback
  // (it would fire on every render if the parent doesn't memoize it perfectly).
  const onAnalysisDoneRef = useRef(onAnalysisDone);
  useEffect(() => {
    onAnalysisDoneRef.current = onAnalysisDone;
  });

  useEffect(() => {
    if (!owner || !repo) return;

    // Cancel any in-flight analogy call from a prior analysis before resetting state.
    analogyAbortRef.current?.abort();

    let cancelled = false;

    dispatch({ type: "SUBMIT" });

    (async () => {
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, repo }),
        });

        const json: AnalyzeResponse = await res.json();

        if (cancelled) return;

        if (json.error) {
          // Narrow to ErrorCode — the server only ever sends known codes (ARCHITECTURE.md §3).
          dispatch({ type: "ANALYZE_ERROR", payload: { error: json.error } });
          onAnalysisDoneRef.current?.();
          return;
        }

        dispatch({
          type: "ANALYZE_SUCCESS",
          payload: {
            repoSummary: json.data.repoSummary,
            architecture: json.data.architecture,
            mermaidCode: json.data.mermaidCode,
            verdict: json.data.verdict,
          },
        });
        onAnalysisDoneRef.current?.();
      } catch {
        if (!cancelled) {
          dispatch({ type: "ANALYZE_ERROR", payload: { error: "unknown" } });
          onAnalysisDoneRef.current?.();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  // Auto-fire default analogy (PRD.md §2.5) whenever a fresh architecture[] arrives.
  // Keyed on state.architecture reference: only fires when ANALYZE_SUCCESS sets a new array.
  // The AbortController guards against stale responses on rapid re-analysis.
  useEffect(() => {
    if (state.architecture.length === 0) return;

    // Abort the previous request if still in flight.
    analogyAbortRef.current?.abort();
    const controller = new AbortController();
    analogyAbortRef.current = controller;

    dispatch({ type: "ANALOGY_LOADING", payload: { analogyType: DEFAULT_ANALOGY_TYPE } });

    (async () => {
      try {
        const res = await fetch("/api/analogy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            architecture: state.architecture,
            analogyType: DEFAULT_ANALOGY_TYPE,
          }),
          signal: controller.signal,
        });

        const json: AnalogyResponse = await res.json();

        if (controller.signal.aborted) return;

        if (json.error) {
          dispatch({ type: "ANALOGY_ERROR", payload: { error: json.error } });
          return;
        }

        dispatch({ type: "ANALOGY_SUCCESS", payload: { data: json.data } });
      } catch (err) {
        // AbortError is expected on rapid re-analysis — not a user-visible failure.
        if (err instanceof Error && err.name === "AbortError") return;
        if (!controller.signal.aborted) {
          dispatch({ type: "ANALOGY_ERROR", payload: { error: "unknown" } });
        }
      }
    })();

    return () => {
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.architecture]);

  // ── Theme selection (Sub-task 5.4) ──────────────────────────────────────────
  // On selection: abort any in-flight analogy call, dispatch ANALOGY_LOADING, POST /api/analogy.
  const handleThemeSelect = useCallback(
    (analogyType: AnalogyType) => {
      // No-op if the selected theme is already the active one and not in error state.
      if (
        analogyType === state.analogyState.type &&
        state.analogyState.status !== "error"
      )
        return;

      // Abort the previous request if still in flight.
      analogyAbortRef.current?.abort();
      const controller = new AbortController();
      analogyAbortRef.current = controller;

      dispatch({ type: "ANALOGY_LOADING", payload: { analogyType } });

      (async () => {
        try {
          const res = await fetch("/api/analogy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              architecture: state.architecture,
              analogyType,
            }),
            signal: controller.signal,
          });

          const json: AnalogyResponse = await res.json();

          if (controller.signal.aborted) return;

          if (json.error) {
            dispatch({ type: "ANALOGY_ERROR", payload: { error: json.error } });
            return;
          }

          dispatch({ type: "ANALOGY_SUCCESS", payload: { data: json.data } });
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") return;
          if (!controller.signal.aborted) {
            dispatch({ type: "ANALOGY_ERROR", payload: { error: "unknown" } });
          }
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.architecture, state.analogyState.type, state.analogyState.status],
  );

  // Stable ref for abort controller — cancels in-flight crash-sim fetch on last-click-wins
  // (PRD.md §6: clicking a new node while previous request is pending → discard previous result).
  const crashSimAbortRef = useRef<AbortController | null>(null);

  // handleNodeClick — ARCHITECTURE.md §4, §5.2, PRD.md §6 last-click-wins
  const handleNodeClick = useCallback(
    (nodeId: string) => {
      // No-op guard: clicking the same node that's already pending is ignored (ARCHITECTURE.md §4).
      if (state.crashState.pendingNodeId === nodeId) return;

      // Abort any in-flight crash-sim request so stale responses are never surfaced.
      crashSimAbortRef.current?.abort();
      const controller = new AbortController();
      crashSimAbortRef.current = controller;

      dispatch({ type: "CRASH_SIM_REQUEST", payload: { nodeId } });

      // Resolve the full ArchitectureNode for this id — ARCHITECTURE.md §2.3 requires full node.
      const node = state.architecture.find((n) => n.id === nodeId);
      if (!node) return;

      // Resolve the current analogy mapping entry for this node (current theme's mapping[]).
      const analogyMapping =
        state.analogyState.data?.mapping.find(
          (m) => m.componentLabel === node.label,
        ) ?? null;

      const analogyType = state.analogyState.type ?? "restaurant";

      (async () => {
        try {
          const res = await fetch("/api/crash-simulation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ node, analogyType, analogyMapping }),
            signal: controller.signal,
          });

          const json: CrashSimulationResponse = await res.json();

          if (controller.signal.aborted) return;

          if (json.error) {
            dispatch({ type: "CRASH_SIM_ERROR", payload: { nodeId, error: json.error } });
            return;
          }

          dispatch({ type: "CRASH_SIM_SUCCESS", payload: { nodeId, data: json.data } });
        } catch (err) {
          // AbortError is expected when a newer click cancels this one — not a user-visible error.
          if (err instanceof Error && err.name === "AbortError") return;
          if (!controller.signal.aborted) {
            dispatch({ type: "CRASH_SIM_ERROR", payload: { nodeId, error: "unknown" } });
          }
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.architecture, state.analogyState.data, state.analogyState.type, state.crashState.pendingNodeId],
  );

  // Node id → analogy role, for the diagram's hover tooltip. Recomputed only when the theme's
  // mapping or the architecture actually changes, so a pan/zoom or a crash-sim click never rebuilds it.
  // Must stay above the `status === "idle"` early return below — it is a hook.
  const analogyRoles = useMemo(
    () => buildAnalogyRoles(state.architecture, state.analogyState.data?.mapping ?? null),
    [state.architecture, state.analogyState.data],
  );

  // Only render the panel once an analyze call has been submitted.
  if (state.status === "idle") return null;

  return (
    <div className="flex flex-col gap-6">
      {/* ── ErrorBanner — shown when status is "error" (design.md §5, ARCHITECTURE.md §3) ── */}
      {state.status === "error" && state.error !== null && (
        <ErrorBanner error={state.error} />
      )}

      {state.status !== "error" && (
        <>
          {/* ── Two columns: architecture LEFT, analogy RIGHT (design.md §5, RULES.md §2) ──
              Collapses to one column below `md` — a half-width diagram on a phone would be
              unreadable, so that breakpoint is a floor, not a preference.

              `items-start` is load-bearing: a grid stretches its items to the row height by
              default, so the shorter panel (the diagram, whose canvas is a fixed clamp) would be
              dragged down to the taller analogy list's height and pad itself out with a field of
              empty white below its zoom controls. Each panel now ends where its own content ends. */}
          <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
            {/* Left panel — FlowchartView renders its own bordered panel, header and inspect
                button. Its title chip sits top-left, where the header row already puts it. */}
            <FlowchartView
              mermaidCode={state.mermaidCode}
              architecture={state.architecture}
              analogyRoles={analogyRoles}
              onNodeClick={handleNodeClick}
            />

            {/* Right panel — AnalogyPanel + AnalogySelector (Sub-task 5.4) */}
            <div className="nb-panel flex flex-col gap-4 p-4">
              {/* Panel header — the ANALOGY title is centred on the panel's axis, with the
                  active/pending theme stacked under it so the current selection stays visible
                  while a new analogy is still in flight. */}
              <div className="flex flex-col items-center gap-1.5 text-center">
                <span className="nb-chip bg-[var(--pink)]">Analogy</span>
                {state.analogyState.type !== null && (
                  <span className="text-[0.68rem] font-extrabold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
                    {state.analogyState.type}
                  </span>
                )}
              </div>

              {/* Theme selector — disabled until first analogy resolves (PRD.md §2.5) */}
              <AnalogySelector
                selectedType={state.analogyState.type}
                onSelect={handleThemeSelect}
                disabled={
                  state.status !== "success" ||
                  state.analogyState.status === "loading"
                }
              />

              {/* Analogy content / skeleton / error */}
              <AnalogyPanel analogyState={state.analogyState} />
            </div>
          </div>

          {/* ── Crash simulation — directly under the grid, conditional on a node click ──
              The node it describes is in the LEFT column above it, so it stays full width: the
              narrative is a paragraph, and a paragraph in a half-width column reads worse. */}
          {/* design.md §5: --bg-elevated, --border-strong, hard accent shadow (user-clicked element). */}
          {/* ARCHITECTURE.md §4: last-click-wins; stale results discarded in reducer. */}
          <CrashSimulationCard
            crashState={state.crashState}
            architecture={state.architecture}
          />
        </>
      )}
    </div>
  );
}
