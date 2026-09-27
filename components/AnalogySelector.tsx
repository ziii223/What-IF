"use client";

/**
 * components/AnalogySelector.tsx
 * Theme selector for the analogy panel (Sub-task 5.4) + custom theme input.
 *
 * Two ways to pick a theme:
 *   · Four preset buttons (restaurant | airport | hospital | city) — each has a hand-authored
 *     vocabulary map server-side, so these give the sharpest analogies.
 *   · A free-text field for anything else ("Star Wars", "Cooking Show", "90s Cartoon").
 *
 * Whatever the source, the value handed to onSelect is the same AnalogyType — the server treats
 * a custom theme exactly like a preset, except that the model has to invent its own vocabulary
 * for it (lib/analogyPrompts.ts).
 *
 * Custom input is normalized with the same normalizeAnalogyType() the API route uses, so the
 * button's enabled state and the server's acceptance rule can't drift apart.
 *
 * Disabled while no architecture is loaded or while a request is in-flight
 * (PRD.md §2 — "disabled until first analogy resolves").
 */

import { useState } from "react";
import type { AnalogyType, PresetAnalogyType } from "@/lib/types";
import {
  ANALOGY_TYPES,
  MAX_ANALOGY_TYPE_LENGTH,
  normalizeAnalogyType,
} from "@/lib/types";

interface AnalogySelectoreProps {
  selectedType: AnalogyType | null;
  onSelect: (type: AnalogyType) => void;
  /** Disable all controls while an analogy call is in-flight. */
  disabled: boolean;
}

const THEME_LABELS: Record<PresetAnalogyType, string> = {
  restaurant: "Restaurant",
  airport: "Airport",
  hospital: "Hospital",
  city: "City",
};

/** One pop colour per preset, so the active theme is identifiable at a glance. */
const THEME_COLORS: Record<PresetAnalogyType, string> = {
  restaurant: "var(--yellow)",
  airport: "var(--cyan)",
  hospital: "var(--pink)",
  city: "var(--lime)",
};

export default function AnalogySelector({
  selectedType,
  onSelect,
  disabled,
}: AnalogySelectoreProps) {
  const [custom, setCustom] = useState("");

  const normalizedCustom = normalizeAnalogyType(custom);
  const canGenerate = normalizedCustom !== null && !disabled;

  function handleCustomSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canGenerate || normalizedCustom === null) return;
    onSelect(normalizedCustom);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ── Preset themes ── */}
      <div
        className="flex flex-wrap justify-center gap-2"
        role="group"
        aria-label="Preset analogy themes"
      >
        {ANALOGY_TYPES.map((type) => {
          const isActive = type === selectedType;
          return (
            <button
              key={type}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(type)}
              aria-pressed={isActive}
              className="nb-btn-sm px-3 py-2 text-[0.7rem]"
              style={{
                // Active themes keep their pop fill even while other calls are in flight, so the
                // current selection is never ambiguous.
                background: isActive ? THEME_COLORS[type] : "var(--paper)",
                opacity: disabled && !isActive ? 0.45 : 1,
                boxShadow: disabled && !isActive ? "none" : undefined,
              }}
            >
              {THEME_LABELS[type]}
            </button>
          );
        })}
      </div>

      {/* ── Custom theme ── */}
      <form onSubmit={handleCustomSubmit} className="flex flex-col gap-2">
        <label
          htmlFor="custom-analogy-theme"
          className="text-[0.68rem] font-extrabold uppercase tracking-[0.12em] text-[var(--text-secondary)]"
        >
          Or type a custom theme
        </label>

        {/* Row geometry, on purpose:
            · Both controls carry the SAME explicit height (`h-11`). Left to `py-2` + their own
              line-heights, the input (text-xs) and the button (text-[0.7rem], uppercase) resolve
              to different heights — a few pixels apart, which is exactly the ragged look this row
              was called out for. A fixed height removes the font metrics from the equation.
            · `gap-3` rather than `gap-2`: each control's hard shadow is 5px of solid black, and a
              10px gutter would leave the input's shadow almost touching the button's border.
            · Stacked on mobile, side-by-side from `sm` up — the button stretches to full width when
              it wraps, so the pair stays symmetrical at both ends. */}
        <div className="flex flex-col gap-2.5 sm:flex-row sm:gap-3">
          <input
            id="custom-analogy-theme"
            type="text"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            disabled={disabled}
            maxLength={MAX_ANALOGY_TYPE_LENGTH}
            placeholder="Anime, Star Wars, Cooking Show…"
            autoComplete="off"
            className="nb-input h-11 w-full min-w-0 flex-1 px-3 text-xs font-bold"
          />
          <button
            type="submit"
            disabled={!canGenerate}
            className="nb-btn h-11 shrink-0 whitespace-nowrap bg-[var(--lime)] px-5 text-[0.7rem]"
          >
            Generate
          </button>
        </div>
      </form>
    </div>
  );
}
