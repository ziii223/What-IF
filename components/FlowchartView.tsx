"use client";

/**
 * components/FlowchartView.tsx
 * The Architecture panel: mermaid render + an interactive pan/zoom canvas + fullscreen inspect.
 *
 * Rendering contract (unchanged — ARCHITECTURE.md §5, RULES.md §1):
 *   · Every mermaid string goes through sanitizeMermaid() before mermaid.render().
 *   · A fresh uniqueId per render — mermaid errors on ID reuse across re-renders.
 *   · On failure the last good SVG stays on screen (RULES.md §1a: never blank the canvas).
 *
 * Interaction contract:
 *   · Wheel/scroll zooms about the cursor; click-and-drag pans.
 *   · Both canvases open at 1:1 (100%) — the diagram is never pre-scaled, so node text is crisp on
 *     first paint. Zooming OUT is manual, and the diagram's own layout is kept tight (see the
 *     mermaid spacing config) so 1:1 framing does not leave a field of empty canvas.
 *   · A drag that happens to end over a node must not fire that node's crash simulation, so
 *     clicks landing within CLICK_SUPPRESS_MS of a completed drag are swallowed.
 *   · FULLSCREEN / INSPECT opens a full-viewport overlay with its own independent view state,
 *     so panning around in fullscreen never disturbs the framing of the inline panel.
 *
 * Node click handling stays at the DOM layer (RULES.md §1b) — never via mermaid `click`
 * directives, and never by loosening securityLevel away from "strict".
 *
 * Hover contract (UX pivot — the diagram no longer morphs its labels):
 *   · Nodes are labelled with the repository's real folder paths, so the active analogy theme is
 *     not visible in the diagram itself. Hovering a node raises a floating tooltip that carries
 *     that folder's role in the theme ("ANALOGY: HEAD WAITER").
 *   · The tooltip is bound at the same DOM layer as the click handler and positioned from the
 *     cursor, not from the node's box: a node can be a tall rectangle at 3× zoom, and anchoring to
 *     the cursor keeps the tooltip where the user is actually pointing.
 *   · It is portalled to <body> and `position: fixed`. The canvas viewport is `overflow: hidden`
 *     and its content is CSS-transformed, so an in-flow tooltip would be clipped at the canvas edge
 *     and scaled by the zoom transform.
 *   · Purely a hover affordance — the same mapping is rendered as static text by AnalogyPanel, so
 *     nothing here is the sole carrier of information.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";
import { sanitizeMermaid } from "@/lib/mermaidSanitize";
import { injectDiagramTheme } from "@/lib/diagramTheme";
import OrbsLoader from "@/components/OrbsLoader";
import type { ArchitectureNode } from "@/lib/types";

/* ── Zoom / pan constants ─────────────────────────────────────────────── */

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
/** Smaller = slower zoom per wheel notch. */
const WHEEL_INTENSITY = 0.0015;
/** Multiplier applied by the +/- buttons. */
const ZOOM_STEP = 1.25;
/** Pointer travel (px) beyond which a pointerdown→up counts as a drag, not a click. */
const DRAG_THRESHOLD = 4;
/** Window (ms) after a drag during which clicks are ignored. */
const CLICK_SUPPRESS_MS = 250;
/** Breathing room (px) left around the drawing when fitting it to the viewport. */
const FIT_PADDING = 28;

const SVG_NS_SEPARATOR = /[\s,]+/;

/* ── Hover tooltip ────────────────────────────────────────────────────── */

/** Gap (px) between the cursor and the tooltip's near edge. */
const TOOLTIP_GAP = 14;
/**
 * Half the tooltip's widest expected width. The tooltip is centred on the cursor, so it can
 * overhang by half its width on either side; this is the margin kept clear of the window edges.
 */
const TOOLTIP_EDGE_INSET = 120;
/** Cursor height (px) below which the tooltip flips to sit *under* the cursor instead of over it. */
const TOOLTIP_FLIP_BELOW_Y = 64;
/** Shown while a theme has no mapping entry for the hovered node (still loading, or unmatched). */
const TOOLTIP_UNMAPPED = "not yet mapped";

interface FlowchartViewProps {
  mermaidCode: string | null;
  architecture: ArchitectureNode[];
  /**
   * `{ [nodeId]: analogyRole }` for the currently-active theme — the tooltip's payload.
   * Empty while no analogy has resolved, and missing keys for any node the theme did not map.
   */
  analogyRoles: Record<string, string>;
  onNodeClick: (nodeId: string) => void;
}

interface View {
  x: number;
  y: number;
  k: number;
}

/** Where the tooltip is anchored, in viewport coordinates, with the flip already resolved. */
interface HoverState {
  nodeId: string;
  x: number;
  y: number;
  /** True when the tooltip sits below the cursor (it would have overflowed the window above it). */
  flip: boolean;
}

/**
 * Own-key read. A node id of `constructor` would otherwise pick up `Object.prototype.constructor`
 * and render a function as the tooltip's text.
 */
function roleFor(roles: Record<string, string>, nodeId: string): string | null {
  return Object.prototype.hasOwnProperty.call(roles, nodeId) ? roles[nodeId] : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ─── FlowchartView ───────────────────────────────────────────────────────────

export default function FlowchartView({
  mermaidCode,
  architecture: _architecture,
  analogyRoles,
  onNodeClick,
}: FlowchartViewProps) {
  /**
   * The rendered SVG markup. Held as state (rather than written straight into the DOM) because
   * two canvases consume it: the inline panel and the fullscreen overlay. Keeping the last good
   * value here is also what makes the RULES.md §1a fallback work — a failed re-render simply
   * leaves this untouched, so the previous diagram stays on screen.
   */
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
  /** The uniqueId the current SVG was rendered under — needed to recover node ids from the DOM. */
  const [renderId, setRenderId] = useState<string>("");
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Initialize mermaid exactly once on mount — ARCHITECTURE.md §5.
  // Light "base" theme: yellow node blocks with hard black borders on a white canvas, so the
  // diagram reads as part of the neo-brutalist page instead of a dark inset from another app.
  //
  // These variables are only the FLOOR, not the finished look. `themeVariables` has no knob for a
  // border width, an offset shadow or uppercase text, so the real skin is the stylesheet injected
  // by injectDiagramTheme() — see lib/diagramTheme.ts. What is set here is deliberately kept in
  // step with it (same palette, same flat black borders) so that if the injected sheet ever failed
  // to land, the diagram would still be black-on-bright rather than mermaid's default pastel.
  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      themeVariables: {
        background: "#ffffff",
        primaryColor: "#facc15",
        primaryTextColor: "#000000",
        primaryBorderColor: "#000000",
        secondaryColor: "#38bdf8",
        tertiaryColor: "#f472b6",
        lineColor: "#000000",
        textColor: "#000000",
        nodeBorder: "#000000",
        clusterBkg: "#ffffff",
        clusterBorder: "#000000",
        edgeLabelBackground: "#ffffff",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        // Doubles as mermaid's text-measurement size — see the note on font-size in
        // lib/diagramTheme.ts before changing it.
        fontSize: "15px",
      },
      securityLevel: "strict",
      flowchart: {
        curve: "basis",
        htmlLabels: false,
        // Tight ranks and nodes: at 1:1 the diagram should read as one connected structure rather
        // than a handful of boxes a scroll apart. `diagramPadding` trims mermaid's own outer margin
        // — kept at 10 so the 4-5px hard shadows on the outermost nodes and clusters stay inside
        // the viewBox instead of being clipped by it.
        nodeSpacing: 30,
        rankSpacing: 38,
        // Label padding inside each node. Wider than a text-only diagram wants, for three reasons:
        // the 3px border eats into the box, it buys the slack that the uppercase transform in the
        // injected stylesheet needs (it widens every label without mermaid re-measuring), and it is
        // what makes a node read as a punched-out block rather than a label with a border on it.
        padding: 16,
        diagramPadding: 10,
        // Emit real px width/height instead of width:100% — the canvas pins the SVG to its natural
        // size anyway, and this makes that size correct from the very first paint.
        useMaxWidth: false,
      },
    });
  }, []);

  // Render effect — fires on every mermaidCode change — ARCHITECTURE.md §5, RULES.md §1.
  useEffect(() => {
    if (mermaidCode === null) return;

    const result = sanitizeMermaid(mermaidCode);
    if (!result.ok) {
      // RULES.md §1a — leave svgMarkup alone so the last good diagram stays rendered.
      setRenderError("Diagram could not be rendered: the structure was not valid.");
      return;
    }

    // Collision-proof unique id: same-millisecond rapid re-renders get distinct ids via the
    // random suffix — mermaid errors on ID reuse across re-renders (ARCHITECTURE.md §5).
    const uniqueId = `flowchart-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    let cancelled = false;

    mermaid
      .render(uniqueId, result.data.code)
      .then(({ svg }) => {
        if (cancelled) return;
        setRenderId(uniqueId);
        // Skinned here, once, on the string — not inside MermaidCanvas. Both canvases (inline and
        // fullscreen) render this same markup, so injecting at the single point the SVG is produced
        // is what keeps them identical. This touches only mermaid's OUTPUT; the sanitized source
        // string handed to render() above is still passed through untouched (RULES.md §1).
        setSvgMarkup(injectDiagramTheme(svg));
        setRenderError(null);
      })
      .catch((err: unknown) => {
        if (process.env.NODE_ENV === "development") {
          console.error("[FlowchartView] mermaid.render() threw:", err);
          console.error("[FlowchartView] raw mermaid string:\n", mermaidCode);
        }
        if (cancelled) return;
        // RULES.md §1a — last good diagram remains on screen.
        setRenderError("Diagram could not be rendered: the syntax was not accepted.");
      });

    return () => {
      cancelled = true;
    };
  }, [mermaidCode]);

  // Escape closes the overlay, and the page behind it must not scroll.
  useEffect(() => {
    if (!isFullscreen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isFullscreen]);

  const closeFullscreen = useCallback(() => setIsFullscreen(false), []);
  const openFullscreen = useCallback(() => setIsFullscreen(true), []);

  return (
    <div className="nb-panel flex flex-col gap-4 p-4">
      {/* ── Panel header — title centred on the panel's axis, matching the Analogy panel.
          Three columns (`1fr auto 1fr`) rather than justify-between: the equal outer tracks keep
          the chip dead-centre on the panel axis no matter how wide the inspect button is, where a
          space-between row would push it off-centre by half the button's width. ── */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        {/* Empty left track — exists only to mirror the button's track and hold the chip centred. */}
        <span aria-hidden="true" />
        <span className="nb-chip bg-[var(--cyan)]">Architecture</span>

        {/* Square icon button — the expand-corners glyph, drawn rather than typed so it renders
            identically on every platform. */}
        <button
          type="button"
          onClick={openFullscreen}
          disabled={svgMarkup === null}
          aria-label="Open diagram fullscreen"
          title="Fullscreen"
          className="nb-btn-sm flex h-9 w-9 shrink-0 items-center justify-center justify-self-end p-0"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="square"
          >
            <path d="M3 9V3h6" />
            <path d="M15 3h6v6" />
            <path d="M21 15v6h-6" />
            <path d="M9 21H3v-6" />
          </svg>
        </button>
      </div>

      {/* ── Canvas, skeleton, or hard failure ── */}
      {svgMarkup === null ? (
        renderError === null ? (
          /* Idle canvas: same box, same size as the diagram will be, holding the orbs. The box
             does not change geometry when the SVG lands, so nothing on the page jumps. */
          <div className="nb-block nb-grid nb-canvas flex w-full items-center justify-center">
            <OrbsLoader label="Rendering your repo…" />
          </div>
        ) : (
          <div
            role="alert"
            className="nb-block border-[var(--red)] px-4 py-3 text-sm font-bold text-[var(--red)] shadow-[3px_3px_0_var(--red)]"
          >
            {renderError}
          </div>
        )
      ) : (
        <>
          <MermaidCanvas
            svg={svgMarkup}
            renderId={renderId}
            analogyRoles={analogyRoles}
            onNodeClick={onNodeClick}
            variant="panel"
          />
          {renderError !== null && (
            <p
              role="status"
              className="nb-block border-[var(--red)] px-3 py-2 text-xs font-bold text-[var(--red)]"
            >
              {renderError} Showing the last diagram that rendered.
            </p>
          )}
        </>
      )}

      {/* ── Fullscreen inspect overlay — full viewport, own view state ── */}
      {isFullscreen && svgMarkup !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Architecture diagram — fullscreen inspection"
          className="nb-grid fixed inset-0 z-50 flex flex-col gap-3 p-3 sm:p-5"
          style={{ background: "var(--purple)" }}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="nb-chip bg-[var(--yellow)]">
                Architecture — inspect
              </span>
              <span className="hidden text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[var(--ink)] sm:inline">
                Esc to close
              </span>
            </div>
            {/* autoFocus puts the keyboard straight on the exit control when the overlay opens. */}
            <button
              type="button"
              onClick={closeFullscreen}
              autoFocus
              className="nb-btn bg-[var(--pink)] px-4 py-2 text-xs"
            >
              Close
            </button>
          </div>

          <div className="nb-panel flex min-h-0 flex-1 flex-col overflow-hidden p-3">
            <MermaidCanvas
              svg={svgMarkup}
              renderId={renderId}
              analogyRoles={analogyRoles}
              onNodeClick={onNodeClick}
              variant="fullscreen"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MermaidCanvas ───────────────────────────────────────────────────────────
//
// Owns one rendered SVG: injection, node-click binding, and an independent pan/zoom view.
// Two instances exist at most (inline + fullscreen), each with its own view state, so framing
// one never moves the other. DOM queries are scoped to this instance's own host element, which
// is what keeps the duplicate-id overlap between the two copies harmless.

interface MermaidCanvasProps {
  svg: string;
  renderId: string;
  analogyRoles: Record<string, string>;
  onNodeClick: (nodeId: string) => void;
  variant: "panel" | "fullscreen";
}

function MermaidCanvas({
  svg,
  renderId,
  analogyRoles,
  onNodeClick,
  variant,
}: MermaidCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [isPanning, setIsPanning] = useState(false);
  /** The node currently under the cursor, or null. Drives the analogy tooltip. */
  const [hover, setHover] = useState<HoverState | null>(null);

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  // Timestamp of the last completed drag — clicks arriving just after it are swallowed.
  const lastDragEndRef = useRef(0);

  // Stable ref so the click-binding effect always reads the latest callback without re-running.
  const onNodeClickRef = useRef(onNodeClick);
  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
  });

  /** True once this canvas has been framed for the SVG currently on screen. */
  const framedRef = useRef(false);

  /**
   * Frames the drawing at 1:1 — never scaled. A drawing bigger than the viewport is anchored at the
   * top-left with a small margin (first rank visible, panning meaningful); a smaller one is centred.
   *
   * Returns false when there is nothing to measure yet. That guard is the fix for the blank
   * fullscreen overlay: a canvas that has not been laid out reports 0×0, and framing against those
   * numbers parks the content thousands of pixels off-screen — an empty modal.
   */
  const resetView = useCallback((): boolean => {
    const viewport = viewportRef.current;
    const host = contentRef.current;
    if (!viewport || !host) return false;

    const viewWidth = viewport.clientWidth;
    const viewHeight = viewport.clientHeight;
    if (viewWidth === 0 || viewHeight === 0) return false;

    const svgEl = host.querySelector("svg");
    const size = svgEl === null ? null : readNaturalSize(svgEl);
    const width = size === null ? 0 : size.width;
    const height = size === null ? 0 : size.height;

    setView({
      k: 1,
      x: width < viewWidth ? Math.round((viewWidth - width) / 2) : FIT_PADDING,
      y: height < viewHeight ? Math.round((viewHeight - height) / 2) : FIT_PADDING,
    });
    return true;
  }, []);

  /**
   * Late-layout safety net. The fullscreen overlay's canvas can mount in a frame where its flex
   * box still has no height, in which case resetView() above declines to frame. This re-frames the
   * moment real dimensions exist — and only then, so it can never fight a deliberate pan/zoom.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const observer = new ResizeObserver(() => {
      if (framedRef.current) return;
      framedRef.current = resetView();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [resetView]);

  // Inject + bind. Runs on every new SVG and on mount of either canvas instance.
  useEffect(() => {
    const host = contentRef.current;
    if (!host) return;

    host.innerHTML = svg;

    // Mermaid emits width="100%" plus a max-width, which makes the drawing's size depend on its
    // container — unusable as a pan/zoom surface. Pin it to the viewBox so the content has a
    // fixed natural size and the CSS transform is the only thing that scales it.
    const svgEl = host.querySelector("svg");
    if (svgEl) {
      const size = readNaturalSize(svgEl);
      if (size !== null) {
        svgEl.setAttribute("width", String(size.width));
        svgEl.setAttribute("height", String(size.height));
      }
      svgEl.style.maxWidth = "none";
      svgEl.style.display = "block";
    }

    // Frame the freshly injected SVG. If the box has no size yet, framedRef stays false and the
    // ResizeObserver above picks it up on the first frame that does.
    framedRef.current = resetView();

    // A new drawing invalidates whichever node was hovered — its <g> is about to be replaced.
    setHover(null);

    // ── Node click binding — ARCHITECTURE.md §5.2, RULES.md §1b ──────────────────────────
    // Mermaid assigns each node group an id of the form:
    //   "{uniqueId}-flowchart-{nodeId}-{counter}"
    // (source: FlowDB.lookUpDomId — `${diagramId}-${MERMAID_DOM_ID_PREFIX}${id}-${vertexCounter}`)
    // We query every <g> under the known prefix, strip that prefix and the trailing "-{digits}"
    // counter to recover the canonical nodeId — the same id used in the diagram source and in
    // ArchitectureNode[].
    const prefix = `${renderId}-flowchart-`;
    const nodeGroups = host.querySelectorAll<SVGGElement>(`g[id^="${prefix}"]`);
    const listeners: Array<{ el: Element; type: string; handler: EventListener }> = [];

    nodeGroups.forEach((el) => {
      const rawId = el.getAttribute("id") ?? "";
      const nodeId = rawId.slice(prefix.length).replace(/-\d+$/, "");
      if (!nodeId) return;

      // Visual affordance — cursor:pointer so users know these are clickable.
      el.style.cursor = "pointer";

      const onClick = () => {
        // A pan that ended on top of a node is not a click on that node.
        if (Date.now() - lastDragEndRef.current < CLICK_SUPPRESS_MS) return;
        onNodeClickRef.current(nodeId);
      };

      // ── Hover → analogy tooltip ───────────────────────────────────────────────────────
      // `mouseenter`/`mousemove`/`mouseleave` are bound per node group rather than delegated from
      // the viewport, because the tooltip's identity IS the node: delegation would mean hit-testing
      // every move to find which <g> is under the cursor.
      const onHover = (event: Event) => {
        const e = event as MouseEvent;
        // Panning is not hovering — a drag across six nodes must not flash six tooltips.
        if (dragRef.current !== null) return;

        // Flip below the cursor when there is no room above it, and keep the centred box (which
        // overhangs by half its width) inside the window on both sides.
        const flip = e.clientY < TOOLTIP_FLIP_BELOW_Y;
        const x = Math.min(
          Math.max(e.clientX, TOOLTIP_EDGE_INSET),
          Math.max(TOOLTIP_EDGE_INSET, window.innerWidth - TOOLTIP_EDGE_INSET),
        );
        const y = flip ? e.clientY + TOOLTIP_GAP : e.clientY - TOOLTIP_GAP;

        // Returning the identical object for an unchanged position keeps a mousemove flood from
        // re-rendering the tooltip every frame.
        setHover((current) =>
          current !== null &&
          current.nodeId === nodeId &&
          current.x === x &&
          current.y === y &&
          current.flip === flip
            ? current
            : { nodeId, x, y, flip },
        );
      };

      const onLeave = () => {
        // Guarded on nodeId so a leave that lands after the pointer already entered a neighbour
        // does not clear the neighbour's tooltip.
        setHover((current) => (current !== null && current.nodeId === nodeId ? null : current));
      };

      (el as SVGElement).addEventListener("click", onClick as EventListener);
      el.addEventListener("mouseenter", onHover);
      el.addEventListener("mousemove", onHover);
      el.addEventListener("mouseleave", onLeave);

      listeners.push({ el, type: "click", handler: onClick as EventListener });
      listeners.push({ el, type: "mouseenter", handler: onHover });
      listeners.push({ el, type: "mousemove", handler: onHover });
      listeners.push({ el, type: "mouseleave", handler: onLeave });
    });

    return () => {
      listeners.forEach(({ el, type, handler }) => el.removeEventListener(type, handler));
      host.innerHTML = "";
    };
  }, [svg, renderId, resetView]);

  // Wheel zoom. Registered natively because React's onWheel is passive — preventDefault() there
  // would be ignored and the page would scroll while the diagram zoomed.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();

      const rect = viewport.getBoundingClientRect();
      const pointerX = e.clientX - rect.left;
      const pointerY = e.clientY - rect.top;

      setView((current) => {
        const k = clamp(
          current.k * Math.exp(-e.deltaY * WHEEL_INTENSITY),
          MIN_SCALE,
          MAX_SCALE,
        );
        if (k === current.k) return current;

        // Keep the point under the cursor pinned while the scale changes.
        const ratio = k / current.k;
        return {
          k,
          x: pointerX - (pointerX - current.x) * ratio,
          y: pointerY - (pointerY - current.y) * ratio,
        };
      });
    };

    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  /** Zooms about the centre of the viewport — used by the +/- controls. */
  const zoomBy = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const centreX = viewport.clientWidth / 2;
    const centreY = viewport.clientHeight / 2;

    setView((current) => {
      const k = clamp(current.k * factor, MIN_SCALE, MAX_SCALE);
      if (k === current.k) return current;
      const ratio = k / current.k;
      return {
        k,
        x: centreX - (centreX - current.x) * ratio,
        y: centreY - (centreY - current.y) * ratio,
      };
    });
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // A pan is starting — drop the tooltip rather than leave it stranded over a moving diagram.
      // The hover listener's own dragRef guard (above) stops it coming back mid-drag.
      setHover(null);
      // Deliberately NOT capturing the pointer here. Capturing on pointerdown makes the browser
      // retarget the follow-up `click` to this container, which would silently kill every mermaid
      // node click. Capture is taken later, once we know this gesture is a drag (below).
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: view.x,
        originY: view.y,
        moved: false,
      };
      setIsPanning(true);
    },
    [view.x, view.y],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD) return;
      // The gesture is now definitively a pan — safe to capture, because the click that follows
      // is one we want to suppress anyway.
      drag.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }

    setView((current) => ({ ...current, x: drag.originX + dx, y: drag.originY + dy }));
  }, []);

  // Single source of truth for ending a drag: a window-level listener catches releases that land
  // outside the viewport (which happens whenever the pointer was never captured).
  useEffect(() => {
    const endDrag = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setIsPanning(false);
      if (drag.moved) lastDragEndRef.current = Date.now();
    };

    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, []);

  const isFullscreenVariant = variant === "fullscreen";

  return (
    <div className={`flex flex-col gap-2 ${isFullscreenVariant ? "h-full min-h-0" : ""}`}>
      <div
        ref={viewportRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        className={`nb-block nb-grid relative w-full touch-none overflow-hidden ${
          isFullscreenVariant ? "min-h-0 flex-1" : "nb-canvas"
        }`}
        style={{ cursor: isPanning ? "grabbing" : "grab" }}
      >
        <div
          ref={contentRef}
          className="nb-no-select absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        />
      </div>

      {/* ── Analogy tooltip — see the hover contract in the module header ── */}
      {hover !== null && (
        <AnalogyTooltip
          x={hover.x}
          y={hover.y}
          flip={hover.flip}
          role={roleFor(analogyRoles, hover.nodeId)}
        />
      )}

      {/* ── View controls ── */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          disabled={view.k <= MIN_SCALE}
          aria-label="Zoom out"
          className="nb-btn-sm px-2.5 py-1 text-xs"
        >
          &minus;
        </button>
        <span className="nb-chip bg-[var(--yellow-soft)] tabular-nums">
          {Math.round(view.k * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={view.k >= MAX_SCALE}
          aria-label="Zoom in"
          className="nb-btn-sm px-2.5 py-1 text-xs"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => resetView()}
          className="nb-btn-sm px-2.5 py-1 text-xs"
        >
          Reset view
        </button>
      </div>
    </div>
  );
}

// ─── AnalogyTooltip ──────────────────────────────────────────────────────────
//
// The theme's role for one folder, floating just above the cursor while that node is hovered.
//
// Portalled to <body> rather than rendered in place: the canvas clips its own overflow and both
// ancestors between here and the page root (`.nb-panel`, the grid cell) sit inside stacking
// contexts, so an in-place tooltip would be cut off at the canvas edge and, in the fullscreen
// overlay, buried under it. `zIndex: 60` clears the overlay's `z-50`.
//
// `pointer-events: none` is load-bearing — a tooltip that can be hit steals the `mouseleave` from
// the node beneath it and flickers.

function AnalogyTooltip({
  x,
  y,
  flip,
  role,
}: {
  x: number;
  y: number;
  flip: boolean;
  role: string | null;
}) {
  return createPortal(
    <div
      role="tooltip"
      style={{
        position: "fixed",
        top: y,
        left: x,
        // Centred on the cursor, and lifted clear of it unless there was no room above.
        transform: flip ? "translate(-50%, 0)" : "translate(-50%, -100%)",
        background: "var(--yellow)",
        zIndex: 60,
      }}
      className="pointer-events-none whitespace-nowrap border-[3px] border-black px-3 py-1.5 text-[0.72rem] font-black uppercase leading-none tracking-[0.08em] text-black shadow-[4px_4px_0px_#000]"
    >
      ANALOGY: {role ?? TOOLTIP_UNMAPPED}
    </div>,
    document.body,
  );
}

/**
 * Natural (viewBox) size of a rendered mermaid SVG.
 * Falls back to getBBox() when the viewBox is absent — wrapped in try/catch because getBBox
 * throws on elements the browser considers un-rendered.
 */
function readNaturalSize(svgEl: SVGSVGElement): { width: number; height: number } | null {
  const viewBox = svgEl.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.split(SVG_NS_SEPARATOR).map(Number);
    const width = parts[2];
    const height = parts[3];
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  try {
    const bounds = svgEl.getBBox();
    if (bounds.width > 0 && bounds.height > 0) {
      return { width: bounds.width, height: bounds.height };
    }
  } catch {
    // getBBox is unavailable for un-rendered nodes — fall through to null.
  }

  return null;
}
