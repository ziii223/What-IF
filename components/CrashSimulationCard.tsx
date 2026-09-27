"use client";

/**
 * components/CrashSimulationCard.tsx
 * Displays crash-simulation results for the most-recently-clicked architecture node.
 * Sub-task 5.5 (5.6b per BUILD_STRATEGY.md naming): renders crashState from AnalysisPanel.
 *
 * Visual language: a yellow header bar carrying the node identity, over a white body holding the
 * narrative. The whole card gets a hard 5px black shadow — it exists only because the user
 * clicked a node, so it is allowed to sit visually proud of the page.
 *
 * ARCHITECTURE.md §4 — last-click-wins: resultNodeId tracks which node's result is shown.
 */

import OrbsLoader from "@/components/OrbsLoader";
import type { CrashState, ArchitectureNode } from "@/lib/types";

interface CrashSimulationCardProps {
  crashState: CrashState;
  /** Full architecture[] — used to look up the node label for the card header. */
  architecture: ArchitectureNode[];
}

export default function CrashSimulationCard({
  crashState,
  architecture,
}: CrashSimulationCardProps) {
  const { status, pendingNodeId, resultNodeId, result } = crashState;

  // Nothing to show until a node has been clicked.
  if (status === "idle" || (pendingNodeId === null && resultNodeId === null)) {
    return null;
  }

  // Resolve the node label for the active node id (whichever is most recent).
  const activeNodeId = pendingNodeId ?? resultNodeId;
  const activeNode = architecture.find((n) => n.id === activeNodeId);
  const nodeLabel = activeNode?.label ?? activeNodeId ?? "Node";

  return (
    <div aria-live="polite" className="nb-block nb-rise nb-shadow flex flex-col">
      {/* ── Header bar — what failed ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-[var(--ink)] bg-[var(--yellow)] px-4 py-2">
        <span className="nb-label">Crash simulation</span>
        <span className="text-[0.72rem] font-black uppercase tracking-[0.08em] text-[var(--ink)]">
          {nodeLabel}
        </span>
      </div>

      <div className="flex flex-col p-4">
        {/* Loading state — same orbs as the diagram canvas, so every wait on the page looks the
            same. The card reserves enough height for the narrative that it does not jump when
            the text lands. */}
        {status === "loading" && (
          <div className="flex min-h-[5rem] items-center justify-center">
            <OrbsLoader label="Simulating the crash…" />
          </div>
        )}

        {/* Error state — scoped to the card; re-clicking the node is the retry. */}
        {status === "error" && (
          <p
            role="alert"
            className="nb-block nb-shadow-sm border-[var(--red)] px-3 py-2 text-sm font-bold text-[var(--red)]"
          >
            Couldn't simulate a crash for this node. Try clicking it again.
          </p>
        )}

        {/* Success state — the narrative. */}
        {status === "success" && result !== null && (
          <p className="text-[0.9rem] font-medium leading-relaxed text-[var(--ink)]">
            {result.failureScenario}
          </p>
        )}
      </div>
    </div>
  );
}
