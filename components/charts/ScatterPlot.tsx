'use client';

import { memo, useCallback, useRef } from 'react';
import { useControls, useEngine } from '@/components/providers/DataProvider';
import { ChartShell } from './ChartShell';
import { Legend } from './Legend';
import { SERIES_COLORS } from '@/lib/palette';
import { CATEGORIES } from '@/lib/types';
import { perfSink } from '@/hooks/usePerformanceMonitor';
import type { ChartFrame } from '@/hooks/useChartRenderer';

/** Per-series cap on plotted marks. Beyond this the plot is solid ink anyway. */
const MAX_PER_SERIES = 12_000;
/** Above this many total marks, shapes collapse to 2px squares. */
const SHAPE_BUDGET = 6_000;

/**
 * Scatter plot with shape as a second identity channel.
 *
 * The palette validator passes these six hues on the *adjacent* pairlist but
 * fails them on *all pairs* - magenta and aqua sit at deltaE 1.6 under
 * deuteranopia, which is indistinguishable. A scatter has no adjacency to lean
 * on: any two series can land next to each other. Rather than cut the series
 * list to three, each category gets its own marker shape, so identity survives
 * without colour.
 *
 * Under load the shapes collapse to 2px squares. That is a deliberate
 * level-of-detail step, not a shortcut: at six thousand overlapping marks the
 * shape is already unreadable, while `fillRect` costs a fraction of a path.
 * Detail that cannot be perceived is detail worth dropping.
 */
export const ScatterPlot = memo(function ScatterPlot() {
  const { store } = useEngine();
  const { categoryMask } = useControls();

  // Per-series scratch buffers, allocated once. Filling these in one pass and
  // then drawing series-by-series means fillStyle changes six times a frame
  // instead of once per point.
  const bufRef = useRef<{
    xs: Float32Array[];
    ys: Float32Array[];
    counts: Uint32Array;
    mins: Float32Array;
    maxs: Float32Array;
  } | null>(null);
  const yRef = useRef({ min: 0, max: 100 });

  const draw = useCallback(
    ({ ctx, plot, viewport, frameId }: ChartFrame) => {
      const t0 = performance.now();

      const bufs = (bufRef.current ??= {
        xs: Array.from({ length: CATEGORIES.length }, () => new Float32Array(MAX_PER_SERIES)),
        ys: Array.from({ length: CATEGORIES.length }, () => new Float32Array(MAX_PER_SERIES)),
        counts: new Uint32Array(CATEGORIES.length),
        mins: new Float32Array(CATEGORIES.length),
        maxs: new Float32Array(CATEGORIES.length),
      });

      const ts = store.timestamps;
      const val = store.values;
      const cat = store.categories;
      const { tMin, tMax } = viewport;
      const span = tMax - tMin || 1;

      const { counts, mins, maxs } = bufs;
      counts.fill(0);
      mins.fill(Infinity);
      maxs.fill(-Infinity);

      // Stride sampling keeps the pass bounded when the window holds far more
      // points than any series buffer can take. Unlike the line chart there is
      // no envelope to preserve here - overlapping marks carry no extra
      // information - so uniform decimation is the honest choice.
      const stride = Math.max(1, Math.floor(store.count / (MAX_PER_SERIES * CATEGORIES.length)));

      let considered = 0;
      for (const seg of store.segments()) {
        const end = seg.start + seg.length;
        for (let i = seg.start; i < end; i += stride) {
          const t = ts[i];
          if (t < tMin || t > tMax) continue;
          const c = cat[i];
          if ((categoryMask & (1 << c)) === 0) continue;
          const n = counts[c];
          if (n >= MAX_PER_SERIES) continue;

          const v = val[i];
          bufs.xs[c][n] = plot.x + ((t - tMin) / span) * plot.width;
          bufs.ys[c][n] = v; // normalised in the draw pass below
          counts[c] = n + 1;
          if (v < mins[c]) mins[c] = v;
          if (v > maxs[c]) maxs[c] = v;
          considered++;
        }
      }

      const processingMs = performance.now() - t0;

      let total = 0;
      for (let c = 0; c < CATEGORIES.length; c++) total += counts[c];
      const useShapes = total <= SHAPE_BUDGET;

      ctx.save();
      ctx.beginPath();
      ctx.rect(plot.x, plot.y, plot.width, plot.height);
      ctx.clip();

      const bottom = plot.y + plot.height;

      for (let c = 0; c < CATEGORIES.length; c++) {
        const n = counts[c];
        if (n === 0) continue;

        // Normalise each series to its own visible range. The six signals span
        // an order of magnitude; on one shared axis, four of them would be a
        // flat line along the bottom edge.
        const lo = mins[c];
        const range = maxs[c] - lo || 1;
        const xs = bufs.xs[c];
        const ys = bufs.ys[c];

        ctx.fillStyle = SERIES_COLORS[c];
        ctx.strokeStyle = SERIES_COLORS[c];

        if (!useShapes) {
          for (let i = 0; i < n; i++) {
            const y = bottom - ((ys[i] - lo) / range) * plot.height;
            ctx.fillRect(xs[i] - 1, y - 1, 2, 2);
          }
          continue;
        }

        ctx.lineWidth = 1.25;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = xs[i];
          const y = bottom - ((ys[i] - lo) / range) * plot.height;
          addShape(ctx, c, x, y, 3);
        }
        // Shapes 0-3 are closed areas, 4-5 are strokes. Batching each series
        // into a single path means one rasterisation pass per series.
        if (c < 4) ctx.fill();
        else ctx.stroke();
      }

      ctx.restore();

      // The y axis is a percentage because every series is normalised to itself.
      yRef.current.min = 0;
      yRef.current.max = 100;

      perfSink.report(frameId, considered, processingMs);
    },
    [store, categoryMask],
  );

  return (
    <ChartShell
      title="Distribution"
      hint="Normalized per series. Shape encodes category alongside color."
      draw={draw}
      yDomainRef={yRef}
      legend={<Legend showShapes />}
    />
  );
});

/**
 * Append one marker to the current path.
 *
 * Deliberately does not call beginPath/fill itself - the caller batches a whole
 * series into one path. Six shapes, matching SHAPES in the palette module.
 */
function addShape(ctx: CanvasRenderingContext2D, shape: number, x: number, y: number, r: number): void {
  switch (shape) {
    case 0: // circle
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
      break;
    case 1: // square
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    case 2: // triangle
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
      break;
    case 3: // diamond
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    case 4: // plus
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r);
      ctx.lineTo(x, y + r);
      break;
    default: // cross
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      break;
  }
}
