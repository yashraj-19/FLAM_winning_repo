'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useEngine } from '@/components/providers/DataProvider';
import { useChartRenderer, type ChartFrame } from '@/hooks/useChartRenderer';
import { formatTime, formatValue, niceTicks } from '@/lib/canvasUtils';
import { CHROME } from '@/lib/palette';
import styles from './ChartShell.module.css';

export interface YDomain {
  min: number;
  max: number;
}

export interface ChartShellProps {
  title: string;
  hint?: string;
  /** Canvas draw callback. Runs inside the shared rAF loop. */
  draw: (frame: ChartFrame) => void;
  /**
   * Live y-domain, written by the draw callback each frame. Read on a slow
   * timer to label the axis - the callback cannot call setState 60 times a
   * second.
   */
  yDomainRef: React.RefObject<YDomain>;
  /** Category names for the y axis, when the chart is categorical (heatmap). */
  yCategories?: readonly string[];
  /** Enable drag-to-pan and wheel-to-zoom. */
  interactive?: boolean;
  legend?: ReactNode;
  onHover?: (t: number | null, v: number | null) => void;
  children?: ReactNode;
}

const PADDING = { top: 10, right: 14, bottom: 24, left: 52 };

/**
 * Shared chassis for every chart: canvas underneath, SVG on top.
 *
 * This is the "Canvas + SVG hybrid" split. The rule used to decide which layer
 * something belongs on is *cardinality*:
 *
 *   Canvas - anything whose count scales with the dataset. Points, lines, bars,
 *            heatmap cells. Ten thousand of these as DOM nodes would be ten
 *            thousand layout boxes; as canvas draws they are just fill calls.
 *
 *   SVG    - anything whose count is fixed and small. Six axis labels, a dozen
 *            gridlines, one crosshair, one tooltip. These get real text nodes,
 *            so they stay crisp at any zoom, are selectable, and are readable by
 *            a screen reader - none of which canvas text gives you.
 *
 * The SVG layer re-renders at roughly 7Hz, the canvas at 60. Axis numbers that
 * update faster than that are unreadable anyway, and it keeps React entirely out
 * of the frame loop.
 */
export function ChartShell({
  title,
  hint,
  draw,
  yDomainRef,
  yCategories,
  interactive = true,
  legend,
  onHover,
  children,
}: ChartShellProps) {
  const { viewport, scheduler } = useEngine();
  const { canvasRef, containerRef, size, plot } = useChartRenderer(draw, { padding: PADDING });

  // Axis state, refreshed on a timer rather than per frame.
  const [axis, setAxis] = useState({ tMin: 0, tMax: 0, yMin: 0, yMax: 1 });
  useEffect(() => {
    const id = setInterval(() => {
      const vp = viewport.current;
      const y = yDomainRef.current ?? { min: 0, max: 1 };
      setAxis((prev) => {
        // Skip the state update when nothing moved enough to change a label.
        const same =
          Math.abs(prev.tMin - vp.tMin) < 1 &&
          Math.abs(prev.tMax - vp.tMax) < 1 &&
          Math.abs(prev.yMin - y.min) < 0.01 &&
          Math.abs(prev.yMax - y.max) < 0.01;
        return same ? prev : { tMin: vp.tMin, tMax: vp.tMax, yMin: y.min, yMax: y.max };
      });
    }, 140);
    return () => clearInterval(id);
  }, [viewport, yDomainRef]);

  // --- interaction -------------------------------------------------------
  const dragRef = useRef<{ x: number; pointerId: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!interactive) return;
      // Pointer capture keeps the drag alive when the cursor leaves the chart,
      // which is exactly what you want when flicking the timeline sideways.
      (e.target as Element).setPointerCapture?.(e.pointerId);
      dragRef.current = { x: e.clientX, pointerId: e.pointerId };
    },
    [interactive],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      const drag = dragRef.current;
      if (drag) {
        const dx = e.clientX - drag.x;
        drag.x = e.clientX;
        viewport.panByPixels(dx, plot.width);
      }

      if (px >= plot.x && px <= plot.x + plot.width && py >= plot.y && py <= plot.y + plot.height) {
        setCursor({ x: px, y: py });
        if (onHover) {
          const ratio = (px - plot.x) / (plot.width || 1);
          const vp = viewport.current;
          const yd = yDomainRef.current ?? { min: 0, max: 1 };
          const vRatio = 1 - (py - plot.y) / (plot.height || 1);
          onHover(vp.tMin + ratio * (vp.tMax - vp.tMin), yd.min + vRatio * (yd.max - yd.min));
        }
      } else {
        setCursor(null);
        onHover?.(null, null);
      }
    },
    [viewport, plot.width, plot.x, plot.y, plot.height, onHover, yDomainRef],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onPointerLeave = useCallback(() => {
    dragRef.current = null;
    setCursor(null);
    onHover?.(null, null);
  }, [onHover]);

  // Wheel zoom is attached manually because React's onWheel is passive, and a
  // passive listener cannot preventDefault - the page would scroll while zooming.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !interactive) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      viewport.zoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, plot.x, plot.width);
      scheduler.invalidate();
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [containerRef, interactive, viewport, scheduler, plot.x, plot.width]);

  // --- axis geometry -----------------------------------------------------
  const span = axis.tMax - axis.tMin;
  const xTicks = span > 0 ? niceTicks(axis.tMin, axis.tMax, Math.max(2, Math.floor(plot.width / 110))) : [];
  const yTicks = yCategories
    ? yCategories.map((_, i) => i)
    : niceTicks(axis.yMin, axis.yMax, Math.max(2, Math.floor(plot.height / 40)));

  const toX = (t: number) => plot.x + ((t - axis.tMin) / (span || 1)) * plot.width;
  const toY = (v: number) =>
    plot.y + plot.height - ((v - axis.yMin) / (axis.yMax - axis.yMin || 1)) * plot.height;
  const toCatY = (i: number) =>
    plot.y + ((i + 0.5) / (yCategories?.length || 1)) * plot.height;

  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <div>
          <h3 className={styles.title}>{title}</h3>
          {hint && <p className={styles.hint}>{hint}</p>}
        </div>
        {legend}
      </header>

      <div
        ref={containerRef}
        className={styles.plotArea}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={onPointerLeave}
        style={{ cursor: interactive ? (dragRef.current ? 'grabbing' : 'grab') : 'default' }}
      >
        <canvas ref={canvasRef} className={styles.canvas} />

        <svg
          className={styles.overlay}
          width={size.width}
          height={size.height}
          aria-hidden="true"
          focusable="false"
        >
          {/* Gridlines and axis text. Fixed count, so they belong in the DOM. */}
          <g>
            {!yCategories &&
              yTicks.map((t) => (
                <g key={`y${t}`}>
                  <line
                    x1={plot.x}
                    x2={plot.x + plot.width}
                    y1={toY(t)}
                    y2={toY(t)}
                    stroke={CHROME.grid}
                    strokeWidth={1}
                    shapeRendering="crispEdges"
                  />
                  <text x={plot.x - 8} y={toY(t)} className={styles.axisLabel} textAnchor="end" dominantBaseline="middle">
                    {formatValue(t)}
                  </text>
                </g>
              ))}

            {yCategories &&
              yCategories.map((label, i) => (
                <text
                  key={label}
                  x={plot.x - 8}
                  y={toCatY(i)}
                  className={styles.axisLabel}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {label}
                </text>
              ))}

            {xTicks.map((t) => (
              <text
                key={`x${t}`}
                x={toX(t)}
                y={plot.y + plot.height + 16}
                className={styles.axisLabel}
                textAnchor="middle"
              >
                {formatTime(t, span)}
              </text>
            ))}

            <line
              x1={plot.x}
              x2={plot.x + plot.width}
              y1={plot.y + plot.height}
              y2={plot.y + plot.height}
              stroke={CHROME.axis}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          </g>

          {cursor && (
            <line
              x1={cursor.x}
              x2={cursor.x}
              y1={plot.y}
              y2={plot.y + plot.height}
              stroke={CHROME.muted}
              strokeWidth={1}
              strokeDasharray="3 3"
              shapeRendering="crispEdges"
            />
          )}
        </svg>

        {children}
      </div>
    </section>
  );
}
