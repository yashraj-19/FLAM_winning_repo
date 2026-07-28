'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEngine } from '@/components/providers/DataProvider';
import { resizeCanvas, type Plot } from '@/lib/canvasUtils';
import type { Viewport } from '@/lib/types';

export interface ChartFrame {
  ctx: CanvasRenderingContext2D;
  /** Drawable area in CSS pixels, gutters already subtracted. */
  plot: Plot;
  /** Full canvas size in CSS pixels. */
  width: number;
  height: number;
  viewport: Readonly<Viewport>;
  /** rAF timestamp for the current frame. */
  now: number;
}

export interface ChartRendererOptions {
  /** Axis gutters in CSS pixels. */
  padding?: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_PADDING = { top: 12, right: 12, bottom: 26, left: 46 };

/**
 * Wires a canvas element into the shared render loop.
 *
 * Every chart uses this. The important parts:
 *
 *  - The draw function is held in a ref and refreshed on each render, so the
 *    scheduler registration happens once per mount instead of once per render.
 *    Re-registering every render would churn the task list 60 times a second
 *    during a drag.
 *  - Sizing goes through ResizeObserver rather than a window resize listener,
 *    so a chart that changes size because a sibling collapsed still gets
 *    resized. Window resize would miss that entirely.
 *  - The effect returns a real cleanup that unregisters the task and disconnects
 *    the observer. This is the leak the naive rAF-in-useEffect pattern has.
 */
export function useChartRenderer(
  draw: (frame: ChartFrame) => void,
  options: ChartRendererOptions = {},
) {
  const { scheduler, viewport } = useEngine();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const padding = options.padding ?? DEFAULT_PADDING;
  const padRef = useRef(padding);
  padRef.current = padding;

  // Keep the latest draw closure without re-registering the task.
  const drawRef = useRef(draw);
  useLayoutEffect(() => {
    drawRef.current = draw;
  });

  // Track the measured size in a ref too: the draw callback runs outside React
  // and must not close over a stale `size` from the render it was created in.
  const sizeRef = useRef(size);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const w = Math.floor(width);
      const h = Math.floor(height);
      if (w === sizeRef.current.width && h === sizeRef.current.height) return;
      sizeRef.current = { width: w, height: h };
      setSize({ width: w, height: h });
      scheduler.invalidate();
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [scheduler]);

  useEffect(() => {
    const unregister = scheduler.register((now) => {
      const canvas = canvasRef.current;
      const { width, height } = sizeRef.current;
      if (!canvas || width === 0 || height === 0) return;

      resizeCanvas(canvas, width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // clearRect over fillRect: no blend, no colour state change, and it lets
      // the CSS background show through so the theme lives in one place.
      ctx.clearRect(0, 0, width, height);

      const p = padRef.current;
      const plot: Plot = {
        x: p.left,
        y: p.top,
        width: Math.max(0, width - p.left - p.right),
        height: Math.max(0, height - p.top - p.bottom),
      };
      if (plot.width <= 0 || plot.height <= 0) return;

      drawRef.current({ ctx, plot, width, height, viewport: viewport.current, now });
    });
    return unregister;
  }, [scheduler, viewport]);

  const plot: Plot = {
    x: padding.left,
    y: padding.top,
    width: Math.max(0, size.width - padding.left - padding.right),
    height: Math.max(0, size.height - padding.top - padding.bottom),
  };

  const invalidate = useCallback(() => scheduler.invalidate(), [scheduler]);

  return { canvasRef, containerRef, size, plot, invalidate };
}
