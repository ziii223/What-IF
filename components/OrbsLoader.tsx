/**
 * components/OrbsLoader.tsx
 * The loading indicator for any box that is waiting on the server — currently the diagram canvas
 * and the crash-simulation card.
 *
 * A row of hard-bordered circles in the pop palette, bouncing out of phase (motion and colours
 * live in app/globals.css under `.nb-orbs` / `.nb-orb`). No state, no effects, no client JS, and
 * no third-party spinner: the same 3px outline and hard offset shadow as every button, so it
 * belongs to this page rather than floating over it.
 *
 * `role="status"` + the caption is what actually announces the state — the orbs themselves are
 * `aria-hidden`, since a screen reader has nothing to gain from six decorative circles.
 */

interface OrbsLoaderProps {
  /** Sentence shown under the orbs. Keep it short — it sits inside a bordered box. */
  label?: string;
}

export default function OrbsLoader({ label = "Working on it…" }: OrbsLoaderProps) {
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-5">
      {/* Six spans — the palette cycles over six via :nth-child, so the count is load-bearing. */}
      <div className="nb-orbs" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className="nb-orb" />
        ))}
      </div>

      <span className="nb-label">{label}</span>
    </div>
  );
}
