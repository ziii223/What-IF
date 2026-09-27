"use client";

/**
 * components/RepoInputForm.tsx
 * URL input, client-side validation, and submit — Sub-task 5.1 / 5.6b.
 *
 * PRD.md §4  — regex validation before any network call; strips .git/trailing-slash/www.
 * PRD.md §5  — button disabled until valid + non-empty; disabled while in-flight.
 *
 * Styling (neo-brutalist):
 *   · input  — 3px black border, hard 5px shadow, black-on-white; focus flips to yellow fill
 *              with a cyan ring, invalid flips to a red-tinted fill with a red ring. No glow.
 *   · button — cyan block, 3px black border, hard shadow, uppercase bold; press translates
 *              (2px, 2px) and drops the shadow so the corner appears pinned.
 *   · RULES.md §2 — border-radius: 0 everywhere; no animation library; transform/opacity only.
 */

import { useState } from "react";

/** PRD.md §4 — the single regex that gates all network calls. */
const GITHUB_URL_REGEX =
  /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?(\.git)?\/?$/;

/** PRD.md §4 — sub-folder URL check (github.com/owner/repo/tree/...). */
const SUBFOLDER_REGEX = /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/.+/;

interface RepoInputFormProps {
  /** Called with already-validated, stripped owner+repo when the form submits. */
  onSubmit: (owner: string, repo: string) => void;
  /** True while the parent's /api/analyze call is in-flight — disables the button (PRD.md §5). */
  isLoading: boolean;
}

export default function RepoInputForm({ onSubmit, isLoading }: RepoInputFormProps) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  // Derive validation state inline — no separate useEffect.
  const trimmed = value.trim();
  const isSubfolder = SUBFOLDER_REGEX.test(trimmed) && !GITHUB_URL_REGEX.test(trimmed);
  const isValid = GITHUB_URL_REGEX.test(trimmed);
  const canSubmit = isValid && !isLoading;

  const validationMessage = !isValid && touched
    ? isSubfolder
      ? "Point to the repo root, not a subfolder."
      : "Enter a valid GitHub repo URL (e.g. github.com/owner/repo)."
    : null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    // PRD.md §4 — strip trailing .git, trailing /, any www. prefix before parsing.
    const cleaned = trimmed
      .replace(/\.git\/?$/, "")
      .replace(/\/$/, "");

    // Parse owner/repo from cleaned URL.
    // Expected shape after cleaning: https://github.com/owner/repo
    const match = cleaned.match(
      /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/,
    );
    if (!match) return;

    onSubmit(match[1], match[2]);
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex w-full flex-col gap-3">
      {/* ── Status chip ──
          There is deliberately no visible field label: the input's own border, shadow and
          placeholder say everything a label would, and the chip is the only text that carries
          information the placeholder can't (validity, right now). The input keeps its
          `aria-label`, so nothing is lost for assistive tech. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {isValid ? (
          <span className="nb-chip bg-[var(--lime)]">URL looks good</span>
        ) : (
          <span className="nb-chip bg-[var(--yellow-soft)]">Public repos only</span>
        )}
      </div>

      {/* ── Input + submit ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <input
          id="repo-url"
          type="url"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (!touched && e.target.value.length > 0) setTouched(true);
          }}
          onBlur={() => setTouched(true)}
          placeholder="https://github.com/owner/repo"
          aria-label="GitHub repository URL"
          aria-describedby={validationMessage ? "url-error" : undefined}
          aria-invalid={validationMessage !== null}
          autoComplete="off"
          spellCheck={false}
          className="nb-input w-full flex-1 px-4 py-3 text-sm sm:text-base"
        />

        {/* The waiting label is longer than the idle one, so the button is never allowed to wrap —
            it would otherwise grow to two lines and shove the input down mid-fetch. */}
        <button
          type="submit"
          disabled={!canSubmit}
          aria-label="Analyze repository"
          className="nb-btn shrink-0 whitespace-nowrap bg-[var(--cyan)] px-6 py-3 text-sm"
        >
          {isLoading ? "YOUR JOB IS TO WAIT" : "Analyze"}
        </button>
      </div>

      {/* ── Inline validation message — PRD.md §4 ── */}
      {validationMessage && (
        <span
          id="url-error"
          role="alert"
          className="self-start border-[3px] border-[var(--red)] bg-white px-3 py-2 text-xs font-extrabold uppercase tracking-wide text-[var(--red)] shadow-[3px_3px_0_var(--red)]"
        >
          {validationMessage}
        </span>
      )}
    </form>
  );
}
