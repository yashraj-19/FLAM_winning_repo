'use client';

import { memo, useCallback, useRef } from 'react';
import { useControls, useEngine } from '@/components/providers/DataProvider';
import { ChartShell } from './ChartShell';
import { Legend } from './Legend';
import { MultiSeriesBinner, easeDomain } from '@/lib/binning';
import { makeProjection } from '@/lib/canvasUtils';
import { SERIES_COLORS } from '@/lib/palette';
import { CATEGORIES } from '@/lib/types';
import { perfSink } from '@/hooks/usePerformanceMonitor';
import type { ChartFrame } from '@/hooks/useChartRenderer';

/**
 * Multi-series line chart with min/max level-of-detail.
 *
 * The chart never draws more than two points per pixel column, no matter how
 * much data is in the window. A 900px plot showing 200k points would otherwise
 * try to stroke 200k line segments into 900 columns - 99.5% of that work lands
 * on a pixel that is already lit.
 *
 * Keeping *both* the min and the max of each column, rather than sampling every
 * Nth point, is what preserves spikes. A one-frame latency spike is a single
 * sample; every-Nth sampling has a 1-in-N chance of showing it, while the
 * min/max envelope shows it always, because a spike is by definition the
 * column's extreme.
 */
export const LineChart = memo(function LineChart() {
  const { store } = useEngine();
  const { categoryMask } = useControls();

  // One binner per chart instance, allocated on first draw and reused forever.
  const binnerRef = useRef<MultiSeriesBinner | null>(null);
  const yRef = useRef({ min: 0, max: 100 });

  const draw = useCallback(
    ({ ctx, plot, viewport, frameId }: ChartFrame) => {
      const t0 = performance.now();
      const binner = (binnerRef.current ??= new MultiSeriesBinner(CATEGORIES.length, 4096));

      const columns = Math.max(1, Math.min(binner.maxColumns, Math.floor(plot.width)));
      binner.ingest(
        store.timestamps,
        store.values,
        store.categories,
        store.segments(),
        viewport.tMin,
        viewport.tMax,
        categoryMask,
        columns,
      );

      easeDomain(yRef.current, binner.globalMin, binner.globalMax);
      const proj = makeProjection(
        { tMin: viewport.tMin, tMax: viewport.tMax, vMin: yRef.current.min, vMax: yRef.current.max },
        plot,
      );

      const processingMs = performance.now() - t0;

      // Clip so a fast pan cannot smear strokes into the axis gutter.
      ctx.save();
      ctx.beginPath();
      ctx.rect(plot.x, plot.y, plot.width, plot.height);
      ctx.clip();

      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';

      const colWidth = plot.width / columns;

      for (let c = 0; c < CATEGORIES.length; c++) {
        if ((categoryMask & (1 << c)) === 0) continue;

        // One beginPath/stroke per series, not per segment. Each stroke() is a
        // separate rasterisation pass, so batching the whole series into one
        // path is the difference between 6 passes a frame and thousands.
        ctx.beginPath();
        ctx.strokeStyle = SERIES_COLORS[c];

        let started = false;
        for (let col = 0; col < columns; col++) {
          if (binner.count(c, col) === 0) continue;
          const x = plot.x + col * colWidth + colWidth * 0.5;
          const yHigh = proj.toY(binner.max(c, col));
          const yLow = proj.toY(binner.min(c, col));

          if (!started) {
            ctx.moveTo(x, yHigh);
            started = true;
          } else {
            ctx.lineTo(x, yHigh);
          }
          // Drop to the column minimum before moving on. This vertical stroke is
          // what turns a sampled line into an envelope that shows the spread
          // inside the column.
          if (yLow !== yHigh) ctx.lineTo(x, yLow);
        }
        ctx.stroke();
      }

      ctx.restore();
      perfSink.report(frameId, binner.pointsConsidered, processingMs);
    },
    [store, categoryMask],
  );

  return (
    <ChartShell
      title="Signal over time"
      hint="Drag to pan, scroll to zoom. Min/max envelope per pixel column."
      draw={draw}
      yDomainRef={yRef}
      legend={<Legend />}
    />
  );
});
