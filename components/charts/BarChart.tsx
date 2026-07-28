'use client';

import { memo, useCallback, useRef } from 'react';
import { useControls, useEngine } from '@/components/providers/DataProvider';
import { ChartShell } from './ChartShell';
import { Legend } from './Legend';
import { MultiSeriesBinner, easeDomain } from '@/lib/binning';
import { SERIES_COLORS } from '@/lib/palette';
import { CATEGORIES, TIME_BUCKETS } from '@/lib/types';
import { perfSink } from '@/hooks/usePerformanceMonitor';
import type { ChartFrame } from '@/hooks/useChartRenderer';

/** Bars narrower than this are unreadable; below it, fall back to a fixed count. */
const MIN_BAR_GROUP_PX = 14;

/**
 * Stacked ingest volume per time bucket.
 *
 * This chart deliberately plots *counts*, not values. The six series have wildly
 * different natural ranges - throughput sits near 800 while disk sits near 20 -
 * so putting their values on one shared y axis would flatten four of them into
 * the baseline. The honest options are one axis per series (which means six
 * charts) or plotting a quantity they genuinely share. Counts are that
 * quantity, and they answer a real question for a telemetry feed: how much data
 * arrived, and from where.
 *
 * A second y axis would "solve" it and is the single most common way to lie with
 * a chart, so it is not on the table.
 */
export const BarChart = memo(function BarChart() {
  const { store } = useEngine();
  const { categoryMask, bucket } = useControls();

  const binnerRef = useRef<MultiSeriesBinner | null>(null);
  const yRef = useRef({ min: 0, max: 10 });
  /** Running stack height per column. Sized once to the binner's column cap. */
  const stackRef = useRef<Float32Array | null>(null);

  const draw = useCallback(
    ({ ctx, plot, viewport, frameId }: ChartFrame) => {
      const t0 = performance.now();
      const binner = (binnerRef.current ??= new MultiSeriesBinner(CATEGORIES.length, 512));

      // Column count comes from the selected aggregation period, so switching
      // 1min -> 1hour visibly re-buckets the chart rather than just relabelling it.
      const span = viewport.tMax - viewport.tMin;
      const bucketMs = TIME_BUCKETS.find((b) => b.id === bucket)?.ms ?? 0;
      const byBucket = bucketMs > 0 ? Math.ceil(span / bucketMs) : 0;
      const byWidth = Math.floor(plot.width / MIN_BAR_GROUP_PX);
      const columns = Math.max(1, Math.min(binner.maxColumns, byBucket > 0 ? Math.min(byBucket, byWidth) : byWidth));

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

      // Tallest stack in view sets the axis.
      let tallest = 1;
      for (let col = 0; col < columns; col++) {
        let total = 0;
        for (let c = 0; c < CATEGORIES.length; c++) {
          if ((categoryMask & (1 << c)) === 0) continue;
          total += binner.count(c, col);
        }
        if (total > tallest) tallest = total;
      }
      easeDomain(yRef.current, 0, tallest, 0.25);
      // Counts cannot be negative, so pin the floor rather than letting the
      // easing headroom push it below zero.
      yRef.current.min = 0;

      const processingMs = performance.now() - t0;

      const colWidth = plot.width / columns;
      // 2px of surface between bars so adjacent fills read as separate marks.
      const barWidth = Math.max(1, colWidth - 2);
      const scale = plot.height / (yRef.current.max || 1);

      ctx.save();
      ctx.beginPath();
      ctx.rect(plot.x, plot.y, plot.width, plot.height);
      ctx.clip();

      // Draw series-major rather than column-major: fillStyle changes are state
      // changes on the context, and doing one per series beats one per bar.
      const baseline = plot.y + plot.height;
      const stackTops = (stackRef.current ??= new Float32Array(binner.maxColumns));
      stackTops.fill(0, 0, columns);

      for (let c = 0; c < CATEGORIES.length; c++) {
        if ((categoryMask & (1 << c)) === 0) continue;
        ctx.fillStyle = SERIES_COLORS[c];
        for (let col = 0; col < columns; col++) {
          const n = binner.count(c, col);
          if (n === 0) continue;
          const h = n * scale;
          const x = plot.x + col * colWidth + 1;
          const y = baseline - stackTops[col] - h;
          ctx.fillRect(x, y, barWidth, h);
          stackTops[col] += h;
        }
      }

      ctx.restore();
      perfSink.report(frameId, binner.pointsConsidered, processingMs);
    },
    [store, categoryMask, bucket],
  );

  const label = TIME_BUCKETS.find((b) => b.id === bucket)?.label ?? 'Raw';

  return (
    <ChartShell
      title="Ingest volume"
      hint={`Points per bucket, stacked by series - ${label}`}
      draw={draw}
      yDomainRef={yRef}
      legend={<Legend />}
    />
  );
});
