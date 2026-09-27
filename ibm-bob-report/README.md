# IBM Bob Report — SUBMISSION EVIDENCE

> **TODO before final submission: drop your exported IBM Bob task session screenshots and log files into this folder.**
>
> This folder is currently a placeholder. It must not be empty at submission time — the lablab.ai
> judging criteria include proof of IBM Bob usage, and this is where that proof is expected to live.

## What goes here

| Item | Format | Naming convention |
|---|---|---|
| Bob task session screenshots | `.png` / `.jpg` | `whatif_task<NN>_<short-task-name>_summary.png` |
| Exported Bob task logs | `.md` / `.txt` / `.json` | `whatif_task<NN>_<short-task-name>_log.md` |
| Any exported Bob session transcript | `.md` | `whatif_session_<date>.md` |

That pattern matches the 20 screenshots already collected in this folder, which run
`whatif_task01_…` through `whatif_task20_…` — **keep the same `whatif_task<NN>_` prefix and
numbering for anything you add here** so a judge can follow the build sequence in order.

## What must NOT go here

- `.env.local`, API keys, IBM Cloud API keys, or any watsonx credential. Ever.
  `.bobignore` and `.gitignore` both block these paths — if you find one staged, unstage it
  and rotate the key.
- Raw video renders or other large binaries. Use `.mp4`-free evidence; link out to the hosted
  demo video instead.

## Suggested contents for the final pass

1. **One screenshot per completed build phase** — the 20 sessions already here cover scaffolding,
   the crash API, the metaphor agent, the Phase 4 render/label-morph/node-click work, and Phase 5.
   Export the matching Bob task logs alongside them.
2. **The three headline sessions the submission statement claims** (see the IBM Bob Usage section
   of the root [`README.md`](../README.md)):
   - repository parsing — `lib/github.ts`, `lib/repoSummary.ts`, `lib/mermaidSanitize.ts`, `/api/analyze`
   - analogy mapping — `lib/analogyPrompts.ts`, the four themes, `/api/analogy`
   - crash diagnostics — `/api/crash-simulation`, `components/CrashSimulationCard.tsx`
3. **A one-paragraph summary at the top of this file** describing what Bob was asked to do,
   what it produced, and which files it touched — written after the evidence is in place.

## Tracking

- [ ] Screenshots for all completed build phases copied in
- [ ] Matching Bob task logs exported for the three headline sessions
- [ ] Summary paragraph written at the top of this file
- [ ] `git status` re-checked — no `.env*`, no credentials, nothing large staged
