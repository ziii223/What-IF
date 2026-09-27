"use client";

/**
 * app/page.tsx
 * Root page — mounts RepoInputForm and AnalysisPanel, passes owner/repo down.
 * Sub-task 5.6b: replaces the placeholder stub with the full component tree.
 *
 * State here is intentionally minimal: just the submitted {owner, repo} pair that drives
 * AnalysisPanel. All analysis/analogy/crash state lives inside AnalysisPanel's useReducer
 * (ARCHITECTURE.md §4 — no prop-drilling past one level).
 *
 * Layout: two states, one component tree.
 *   · IDLE    — the hero fills the viewport and the repo input sits dead-centre. Nothing else
 *               is on screen, so there is no reason for it to live at the top.
 *   · SUBMITTED — the hero collapses to a compact banner (a length, not `auto`, so it animates)
 *               and the analysis panels rise in underneath.
 * isLoading is derived from the absence of a pending analysis: once owner+repo are set,
 * AnalysisPanel handles its own loading state. We track a separate `submittedKey` so that
 * re-submitting the same URL (or a new one) always triggers a fresh AnalysisPanel render.
 */

import { useState, useCallback } from "react";
import RepoInputForm from "@/components/RepoInputForm";
import AnalysisPanel from "@/components/AnalysisPanel";

interface Submission {
  owner: string;
  repo: string;
  /** Incremented on every submit so the same owner+repo can re-trigger (strict equality key). */
  key: number;
}

export default function Home() {
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = useCallback((owner: string, repo: string) => {
    setIsLoading(true);
    setSubmission((prev) => ({
      owner,
      repo,
      // Bump the key so React re-mounts AnalysisPanel on every submit, even if owner/repo are
      // the same as before — this clears all prior reducer state cleanly (PRD.md §5 rapid-submit).
      key: prev ? prev.key + 1 : 1,
    }));
  }, []);

  // AnalysisPanel calls this when /api/analyze settles (success or error) so the Analyze button
  // can re-enable. AnalysisPanel manages its own internal loading state; this flag only controls
  // RepoInputForm's disabled state during the initial fetch.
  const handleAnalysisDone = useCallback(() => {
    setIsLoading(false);
  }, []);

  const isIdle = submission === null;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Hero — centred while idle, compact once a repo has been submitted ── */}
      <section className={`nb-hero ${isIdle ? "" : "nb-hero--compact"}`}>
        <HeroBanner compact={!isIdle} />

        <div className="mx-auto w-full max-w-4xl">
          <RepoInputForm onSubmit={handleSubmit} isLoading={isLoading} />
        </div>
      </section>

      {/* ── Analysis panel — only rendered after first submit ── */}
      {submission !== null && (
        // Keyed on the submission so a re-submit re-mounts the subtree and replays the entry
        // animation, matching the fresh reducer state inside AnalysisPanel.
        <div key={submission.key} className="nb-rise">
          <AnalysisPanel
            owner={submission.owner}
            repo={submission.repo}
            onAnalysisDone={handleAnalysisDone}
          />
        </div>
      )}
    </div>
  );
}

// ─── Hero banner ────────────────────────────────────────────────────────────
// Massive yellow speech-bubble wordmark, then the pitch. Shrinks once results are on screen so it
// stays a banner rather than eating the top of the page.

/** The hook. One shout, three framings, and a dare. Idle state only. */
const HERO_HEADLINE =
  "WHAT IF YOUR REPO WAS A 24/7 CHEAP DINER, A CHAOTIC AIRPORT, OR AN ANIME BATTLE ARENA? PASTE IT & FIND OUT!";

function HeroBanner({ compact }: { compact: boolean }) {
  return (
    <div className="flex w-full flex-col items-center gap-4 text-center">
      {/* mb-4 clears the 22px speech-bubble tail so it never collides with the copy below. */}
      <div
        className={`nb-banner nb-bubble mb-4 ${
          compact ? "px-6 py-3" : "px-8 py-5 sm:px-12 sm:py-7"
        }`}
      >
        <h1
          className={`nb-wordmark ${
            compact ? "text-2xl sm:text-3xl" : "text-5xl sm:text-7xl"
          }`}
        >
          WHAT-IF
        </h1>
      </div>

      {/* The pitch is idle-only. Once a repo is submitted the headline has done its job — and
          while the analysis is running the vertical space belongs to the loading state. */}
      {!compact && (
        <p className="max-w-3xl text-sm font-black uppercase leading-tight text-[var(--ink)] sm:text-lg">
          {HERO_HEADLINE}
        </p>
      )}
    </div>
  );
}
