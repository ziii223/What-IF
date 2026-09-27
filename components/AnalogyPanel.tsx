"use client";

/**
 * components/AnalogyPanel.tsx
 * Displays the analogy mapping rows and summary text (Sub-task 5.4).
 *
 * Receives the current AnalogyState from AnalysisPanel (no fetch here — data flows down,
 * dispatch flows up via callbacks per ARCHITECTURE.md §4 / "no prop-drilling past one level").
 *
 * Visual language (neo-brutalist):
 *   · Summary sits on a yellow block — it is the one line a reader should take away.
 *   · Each component is a white card: 3px black border, 4px hard black shadow, a numbered
 *     black tab, a bold uppercase header, and exactly one sentence of body copy.
 *   · Body text stays sentence case — it is meant to be read, not scanned as signage.
 */

import type { AnalogyState, AnalogyResult } from "@/lib/types";

interface AnalogyPanelProps {
  analogyState: AnalogyState;
}

export default function AnalogyPanel({ analogyState }: AnalogyPanelProps) {
  const { status, data } = analogyState;

  // Idle — nothing to show yet (first analyze hasn't completed).
  if (status === "idle") {
    return null;
  }

  // Loading — solid blocks pulsing, same geometry as the real content.
  if (status === "loading") {
    return <AnalogyLoadingSkeleton />;
  }

  // Error — scoped to this panel (analogy errors are recoverable by picking another theme, so
  // they stay here rather than escalating to the page-level ErrorBanner).
  if (status === "error") {
    // Stale data is better than a blank panel — the user can retry by picking another theme.
    if (data !== null) {
      return <AnalogyContent data={data} stale />;
    }
    return (
      <div
        role="alert"
        className="nb-block nb-shadow-sm border-[var(--red)] px-3 py-3 text-sm font-bold text-[var(--red)]"
      >
        Couldn't load an analogy for that theme. Try another, or retry.
      </div>
    );
  }

  // Success — render the mapping.
  if (data !== null) {
    return <AnalogyContent data={data} stale={false} />;
  }

  return null;
}

// ─── Content ─────────────────────────────────────────────────────────────────

function AnalogyContent({
  data,
  stale,
}: {
  data: AnalogyResult;
  stale: boolean;
}) {
  return (
    <div className="flex flex-col gap-3" style={{ opacity: stale ? 0.65 : 1 }}>
      {/* Summary — the takeaway line, on its own yellow block. */}
      <div
        className="nb-block nb-shadow-md border-[var(--ink)] px-3 py-2.5"
        style={{ background: "var(--yellow-soft)" }}
      >
        <p className="nb-label mb-1">In one line</p>
        <p className="text-sm font-bold leading-snug text-[var(--ink)]">
          {data.summary}
        </p>
      </div>

      {/* One card per component. Tight stack: these six are a list to scan, not six destinations,
          so the gap is a separation cue and nothing more. */}
      <div className="flex flex-col gap-2">
        {data.mapping.map((entry, idx) => (
          <MappingRow
            key={`${entry.componentLabel}-${idx}`}
            index={idx + 1}
            componentLabel={entry.componentLabel}
            analogyRole={entry.analogyRole}
            explanation={entry.explanation}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Mapping row ──────────────────────────────────────────────────────────────

function MappingRow({
  index,
  componentLabel,
  analogyRole,
  explanation,
}: {
  index: number;
  componentLabel: string;
  analogyRole: string;
  explanation: string;
}) {
  return (
    <div className="nb-block nb-shadow-md flex items-start gap-2.5 px-3 py-2">
      {/* Numbered black tab — decorative, so it is hidden from assistive tech. */}
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center border-[3px] border-[var(--ink)] bg-[var(--ink)] text-[0.65rem] font-black tabular-nums text-white"
      >
        {index}
      </span>

      <div className="min-w-0 flex-1">
        {/* Component → analogy role */}
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[0.72rem] font-black uppercase tracking-[0.06em] text-[var(--ink)]">
            {componentLabel}
          </span>
          <span aria-hidden="true" className="font-black text-[var(--ink)]">
            &rarr;
          </span>
          <span className="nb-chip bg-[var(--cyan)] !px-2 !py-0.5 !text-[0.65rem]">
            {analogyRole}
          </span>
        </div>

        {/* Explanation — sentence case, one sentence. */}
        <p className="text-[0.82rem] font-medium leading-snug text-[var(--text-secondary)]">
          {explanation}
        </p>
      </div>
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
// Same block geometry as the real content so the panel doesn't jump when data lands.

function AnalogyLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <div
        className="skeleton-pulse nb-block h-[4.5rem]"
        style={{ background: "var(--yellow-soft)" }}
      />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="skeleton-pulse nb-block h-[4rem]"
          style={{ background: "var(--paper)" }}
        />
      ))}
    </div>
  );
}
