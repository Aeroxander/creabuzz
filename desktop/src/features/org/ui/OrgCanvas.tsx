import * as React from "react";

import { Maximize2, Minus, Plus } from "lucide-react";

import { Button } from "@/shared/ui/button";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  CANVAS_DENSITY,
  ancestorPaths,
  clampCanvasZoom,
  fitCanvasView,
  layoutCanvas,
  type CanvasDensity,
  type CanvasView,
} from "../lib/canvasLayout";
import type { OrgTreeNode } from "../lib/tree";
import type { AgentLiveness } from "../lib/nodeLiveness";
import { OrgNodeCanvasCard } from "./OrgNodeCanvasCard";

type OrgCanvasProps = {
  roots: OrgTreeNode[];
  density: CanvasDensity;
  selectedDtag?: string;
  onSelect: (dtag: string) => void;
  /** Summary read by screen readers; the node list is the a11y source of truth. */
  summaryLabel: string;
  /** Agent-seat liveness keyed by lowercase seat pubkey (cards' status dots). */
  liveness: ReadonlyMap<string, AgentLiveness>;
  testId?: string;
};

const ZOOM_STEP = 1.2;
/** Trackpad pinch arrives as ctrl+wheel with small deltas — scale it finely. */
const PINCH_SCALE = 0.01;

/**
 * Pan/zoom org canvas (paperclip-ux-reference.md §2.2): absolute-positioned
 * node cards over an SVG elbow-edge layer, one translate+scale transform on
 * the card layer. Interactions port the reference: drag to pan (grab
 * cursor), wheel zoom toward the cursor, ctrl+wheel = trackpad pinch, fit to
 * screen, double-click background resets to the fitted view. Zoom clamps to
 * [MIN_ZOOM, MAX_ZOOM].
 *
 * Performance contract: panning updates ONE view state object per pointer
 * move — pure transform math, no layout recompute (layout is memoized per
 * tree+density), and cards are memoized so they skip re-render entirely.
 *
 * Accessibility: the canvas is structure decoration (`role="img"` summary +
 * aria-hidden card layer). The accessible source of truth is the node list
 * rendered next to it by OrgChart.
 */
export function OrgCanvas({
  roots,
  density,
  selectedDtag,
  onSelect,
  summaryLabel,
  liveness,
  testId = "org-canvas-viewport",
}: OrgCanvasProps) {
  const metrics = CANVAS_DENSITY[density];
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [view, setView] = React.useState<CanvasView>({ x: 0, y: 0, zoom: 1 });
  const [dragging, setDragging] = React.useState(false);
  const dragStart = React.useRef<{
    px: number;
    py: number;
    vx: number;
    vy: number;
  } | null>(null);

  const layout = React.useMemo(
    () => layoutCanvas(roots, density),
    [roots, density],
  );
  const ancestorLabelByDtag = React.useMemo(
    () => ancestorPaths(roots),
    [roots],
  );

  const fitToScreen = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const fitted = fitCanvasView(
      container.clientWidth,
      container.clientHeight,
      layout.bounds,
    );
    if (fitted) setView(fitted);
  }, [layout.bounds]);

  // Fit once per layout change (tree or density), not per pan/zoom. A
  // ResizeObserver retries the fit when the container was too small at
  // mount (0-sized flex children) — the fence is only burned by a fit that
  // actually applied.
  const boundsKey = `${layout.bounds.width}x${layout.bounds.height}`;
  const fittedBoundsRef = React.useRef("");
  React.useEffect(() => {
    if (fittedBoundsRef.current === boundsKey) return;
    if (!containerRef.current) return;
    const fitted = fitCanvasView(
      containerRef.current.clientWidth,
      containerRef.current.clientHeight,
      layout.bounds,
    );
    if (!fitted) return;
    fittedBoundsRef.current = boundsKey;
    setView(fitted);
  }, [boundsKey, layout.bounds]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (fittedBoundsRef.current === boundsKey) return;
      const fitted = fitCanvasView(
        container.clientWidth,
        container.clientHeight,
        layout.bounds,
      );
      if (fitted) {
        fittedBoundsRef.current = boundsKey;
        setView(fitted);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [boundsKey, layout.bounds]);

  // Zoom toward the pointer. A native non-passive listener is required:
  // React attaches wheel handlers passively, so preventDefault() would warn
  // and the page would scroll behind the canvas.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      setView((current) => {
        const factor = event.ctrlKey
          ? Math.exp(-event.deltaY * PINCH_SCALE)
          : event.deltaY < 0
            ? ZOOM_STEP
            : 1 / ZOOM_STEP;
        const zoom = clampCanvasZoom(current.zoom * factor);
        const scale = zoom / current.zoom;
        return {
          zoom,
          x: mouseX - scale * (mouseX - current.x),
          y: mouseY - scale * (mouseY - current.y),
        };
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = React.useCallback((factor: number) => {
    const container = containerRef.current;
    if (!container) return;
    const centerX = container.clientWidth / 2;
    const centerY = container.clientHeight / 2;
    setView((current) => {
      const zoom = clampCanvasZoom(current.zoom * factor);
      const scale = zoom / current.zoom;
      return {
        zoom,
        x: centerX - scale * (centerX - current.x),
        y: centerY - scale * (centerY - current.y),
      };
    });
  }, []);

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      // Drags start on the background only — cards own their clicks.
      if (target.closest("[data-org-card]") || target.closest("button")) {
        return;
      }
      dragStart.current = {
        px: event.clientX,
        py: event.clientY,
        vx: view.x,
        vy: view.y,
      };
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [view.x, view.y],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStart.current;
      if (!start) return;
      // One state object per move: a single transform update, no relayout.
      setView((current) => ({
        ...current,
        x: start.vx + (event.clientX - start.px),
        y: start.vy + (event.clientY - start.py),
      }));
    },
    [],
  );

  const endDrag = React.useCallback(() => {
    dragStart.current = null;
    setDragging(false);
  }, []);

  return (
    <div
      className="relative h-96 w-full select-none overflow-hidden rounded-lg border bg-muted/20"
      data-testid={testId}
      ref={containerRef}
      style={{
        cursor: dragging ? "grabbing" : "grab",
        overscrollBehavior: "contain",
        touchAction: "none",
      }}
    >
      <div
        aria-label={summaryLabel}
        className="absolute inset-0"
        onDoubleClick={fitToScreen}
        onPointerCancel={endDrag}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        role="img"
      >
        {/* Edge layer: elbow paths under the cards. */}
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <g transform={`translate(${view.x}, ${view.y}) scale(${view.zoom})`}>
            {layout.edges.map((edge) => (
              <path
                d={edge.path}
                fill="none"
                key={edge.dtag}
                stroke="hsl(var(--border))"
                strokeWidth={1.5}
              />
            ))}
          </g>
        </svg>
        {/* Card layer: the single transformed surface. Hidden from AT — the
            node list beside the canvas carries the accessible tree. */}
        <div
          aria-hidden="true"
          className="absolute inset-0"
          data-testid="org-canvas-card-layer"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {layout.nodes.map((placed) => (
            <OrgNodeCanvasCard
              ancestorLabel={ancestorLabelByDtag.get(placed.dtag) ?? ""}
              compact={density === "compact"}
              key={placed.dtag}
              liveness={liveness}
              metrics={metrics}
              onSelect={onSelect}
              placed={placed}
              selected={placed.dtag === selectedDtag}
            />
          ))}
        </div>
      </div>
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1.5">
        <Button
          aria-label="Zoom in"
          className="size-9 rounded border border-border bg-background p-0 transition-colors hover:bg-accent sm:size-7"
          onClick={() => zoomBy(ZOOM_STEP)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus aria-hidden="true" className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
        </Button>
        <Button
          aria-label="Zoom out"
          className="size-9 rounded border border-border bg-background p-0 transition-colors hover:bg-accent sm:size-7"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Minus aria-hidden="true" className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
        </Button>
        <Button
          aria-label="Fit chart to screen"
          className="size-9 rounded border border-border bg-background p-0 transition-colors hover:bg-accent sm:size-7"
          onClick={fitToScreen}
          size="sm"
          title={`Zoom ${Math.round((view.zoom / MAX_ZOOM) * 100) / 10}× (limits ${MIN_ZOOM}–${MAX_ZOOM})`}
          type="button"
          variant="outline"
        >
          <Maximize2 aria-hidden="true" className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
        </Button>
      </div>
    </div>
  );
}
