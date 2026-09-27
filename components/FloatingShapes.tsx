/**
 * components/FloatingShapes.tsx
 * Ambient landing-page decoration — slow-drifting neo-brutalist vector shapes plus cartoon
 * stickers (a burger, a plane, a coffee, a suitcase) that float behind the purple grid.
 *
 * Server component: pure SVG + CSS animation — no state, no effects, no client JS.
 *   · The layer is `pointer-events: none` and `aria-hidden`, so it can never intercept a click
 *     or reach a screen reader.
 *   · Motion lives in app/globals.css (`nb-drift-a|b|c`) and is switched off wholesale under
 *     `prefers-reduced-motion`, which leaves a static composition rather than a blank one.
 *   · Negative animation delays start each shape mid-cycle, so the layer is never in phase.
 */

/** Drift vectors — three, so adjacent shapes never travel in lockstep. */
type Drift = "a" | "b" | "c";

type ShapeKind =
  | "circle"
  | "square"
  | "triangle"
  | "donut"
  | "plus"
  | "star"
  | "burger"
  | "plane"
  | "coffee"
  | "suitcase";

interface FloatItem {
  kind: ShapeKind;
  /** Viewport-relative placement — percentages keep the framing stable at any window width. */
  left: string;
  top: string;
  /** Rendered box in px. */
  size: number;
  rotate: number;
  drift: Drift;
  /** Seconds. Long, so the movement reads as drift rather than motion. */
  duration: number;
  /** Seconds of negative delay — where in the cycle this shape starts. */
  delay: number;
  /** true → drawn on a white sticker plate; false → bare vector shape. */
  sticker: boolean;
}

/** Edge-biased placement: the composition frames the hero instead of sitting behind the copy. */
const ITEMS: readonly FloatItem[] = [
  { kind: "circle", left: "3%", top: "22%", size: 74, rotate: -12, drift: "a", duration: 38, delay: 0, sticker: false },
  { kind: "square", left: "88%", top: "14%", size: 58, rotate: 14, drift: "b", duration: 46, delay: 6, sticker: false },
  { kind: "triangle", left: "6%", top: "68%", size: 66, rotate: 8, drift: "c", duration: 52, delay: 12, sticker: false },
  { kind: "donut", left: "91%", top: "62%", size: 70, rotate: -6, drift: "a", duration: 42, delay: 3, sticker: false },
  { kind: "plus", left: "17%", top: "7%", size: 54, rotate: 20, drift: "b", duration: 48, delay: 9, sticker: false },
  { kind: "star", left: "77%", top: "80%", size: 62, rotate: -14, drift: "c", duration: 50, delay: 15, sticker: false },
  { kind: "burger", left: "2%", top: "43%", size: 84, rotate: -8, drift: "a", duration: 56, delay: 4, sticker: true },
  { kind: "plane", left: "85%", top: "35%", size: 92, rotate: 12, drift: "b", duration: 44, delay: 11, sticker: true },
  { kind: "coffee", left: "12%", top: "85%", size: 80, rotate: 10, drift: "c", duration: 54, delay: 7, sticker: true },
  { kind: "suitcase", left: "69%", top: "9%", size: 86, rotate: -10, drift: "a", duration: 58, delay: 2, sticker: true },
];

const INK = "#000000";

export default function FloatingShapes() {
  return (
    <div
      className="nb-float-layer"
      aria-hidden="true"
      // The four geometry declarations are intentionally inline as well as in the stylesheet.
      // They are what keeps this layer out of document flow and pinned to the viewport; if the
      // layer ever falls back to `static`, every shape stacks down the left edge of the page.
      // Duplicating them here means the layout cannot break that way again.
      style={{ position: "fixed", inset: 0, overflow: "hidden", pointerEvents: "none" }}
    >
      {ITEMS.map((item) => (
        <div
          key={item.kind}
          className="nb-float"
          style={{ left: item.left, top: item.top, width: `${item.size}px`, height: `${item.size}px`, animationName: `nb-drift-${item.drift}`, animationDuration: `${item.duration}s`, animationDelay: `-${item.delay}s` }}
        >
          {/* Rotation lives on this inner element so cancelling the drift animation
              (prefers-reduced-motion) leaves the shape tilted, not axis-aligned. */}
          <div style={{ height: "100%", width: "100%", transform: `rotate(${item.rotate}deg)` }}>
            {item.sticker ? (
              <div className="nb-sticker" style={{ padding: "15%" }}>
                <Shape kind={item.kind} />
              </div>
            ) : (
              <Shape kind={item.kind} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Shape library ──────────────────────────────────────────────────────────
// Every glyph is drawn in a 100×100 box with a 6-unit black outline — thick enough that the
// brutalist edge survives being scaled down to a 54px drift element.

function Shape({ kind }: { kind: ShapeKind }) {
  switch (kind) {
    /* ── Abstract shapes ───────────────────────────────────────────────── */
    case "circle":
      return (
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <circle cx="50" cy="50" r="44" fill="#38bdf8" stroke={INK} strokeWidth="6" />
        </svg>
      );

    case "square":
      return (
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <rect x="8" y="8" width="84" height="84" fill="#f472b6" stroke={INK} strokeWidth="6" />
        </svg>
      );

    case "triangle":
      return (
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <polygon points="50,6 94,90 6,90" fill="#facc15" stroke={INK} strokeWidth="6" />
        </svg>
      );

    case "donut":
      // Hole filled with the page purple, so it reads as a hole and not a white disc.
      return (
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <circle cx="50" cy="50" r="45" fill="#4ade80" stroke={INK} strokeWidth="6" />
          <circle cx="50" cy="50" r="18" fill="#a855f7" stroke={INK} strokeWidth="6" />
        </svg>
      );

    case "plus":
      // Black plate under a colour inlay — the cheapest way to outline a two-stroke cross.
      return (
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <path d="M50 6 V94 M6 50 H94" fill="none" stroke={INK} strokeWidth="26" />
          <path d="M50 14 V86 M14 50 H86" fill="none" stroke="#38bdf8" strokeWidth="12" />
        </svg>
      );

    case "star":
      return (
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <polygon
            points="50,4 61.2,34.6 93.7,35.8 68.1,55.9 77,87.2 50,69 23,87.2 31.9,55.9 6.3,35.8 38.8,34.6"
            fill="#facc15"
            stroke={INK}
            strokeWidth="6"
          />
        </svg>
      );

    /* ── Cartoon stickers ──────────────────────────────────────────────── */
    case "burger":
      return (
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <path d="M10 46 a40 32 0 0 1 80 0 Z" fill="#f59e0b" stroke={INK} strokeWidth="6" />
          <circle cx="36" cy="32" r="3" fill="#ffffff" />
          <circle cx="50" cy="26" r="3" fill="#ffffff" />
          <circle cx="64" cy="32" r="3" fill="#ffffff" />
          <rect x="8" y="46" width="84" height="12" fill="#4ade80" stroke={INK} strokeWidth="6" />
          <rect x="6" y="58" width="88" height="15" fill="#7c2d12" stroke={INK} strokeWidth="6" />
          <rect x="12" y="73" width="76" height="18" fill="#f59e0b" stroke={INK} strokeWidth="6" />
        </svg>
      );

    case "plane":
      return (
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <path
            d="M50 6 L58 38 L94 56 L94 66 L58 56 L56 76 L70 88 L70 94 L50 88 L30 94 L30 88 L44 76 L42 56 L6 66 L6 56 L42 38 Z"
            fill="#38bdf8"
            stroke={INK}
            strokeWidth="5"
          />
          <rect x="44" y="18" width="12" height="14" fill="#ffffff" stroke={INK} strokeWidth="4" />
        </svg>
      );

    case "coffee":
      return (
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <path d="M34 20 q6 -6 0 -12 M52 20 q6 -6 0 -12" fill="none" stroke={INK} strokeWidth="5" />
          <path d="M68 38 h8 a12 12 0 0 1 0 24 h-8" fill="none" stroke={INK} strokeWidth="6" />
          <path
            d="M20 26 h48 v44 a14 14 0 0 1 -14 14 h-20 a14 14 0 0 1 -14 -14 Z"
            fill="#ffffff"
            stroke={INK}
            strokeWidth="6"
          />
          <rect x="27" y="34" width="34" height="10" fill="#7c2d12" stroke={INK} strokeWidth="4" />
        </svg>
      );

    case "suitcase":
      return (
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <path d="M36 34 v-12 h28 v12" fill="none" stroke={INK} strokeWidth="6" />
          <rect x="10" y="34" width="80" height="52" fill="#f472b6" stroke={INK} strokeWidth="6" />
          <rect x="26" y="34" width="8" height="52" fill="#a855f7" stroke={INK} strokeWidth="4" />
          <rect x="66" y="34" width="8" height="52" fill="#a855f7" stroke={INK} strokeWidth="4" />
          <rect x="44" y="52" width="12" height="10" fill="#facc15" stroke={INK} strokeWidth="4" />
        </svg>
      );
  }
}
