'use client';

import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import { useControls } from '@/components/providers/DataProvider';
import { ChartShell } from './ChartShell';
import { useAggregation } from '@/hooks/useAggregation';
import { rampColor } from '@/lib/palette';
import { CATEGORIES } from '@/lib/types';
import { perfSink } from '@/hooks/usePerformanceMonitor';
import type { ChartFrame } from '@/hooks/useChartRenderer';
import type { AggregateResponse } from '@/lib/types';

const COLUMNS = 72;

/**
 * Series x time heat grid, aggregated off the main thread.
 *
 * The grid itself is tiny to draw - six rows of seventy-two cells is 432
 * fillRects, nothing. The expensive part is reducing 200k raw points down to
 * those 432 averages, and that happens in a worker (see useAggregation).
 *
 * Magnitude is encoded with a single-hue light-to-dark ramp, normalised per row.
 * A rainbow ramp would imply the categories differ in kind rather than degree,
 * and per-row normalisation is required because throughput runs near 800 while
 * disk runs near 20 - one shared scale would render four of the six rows a flat,
 * uniform pale blue.
 */
export const Heatmap = memo(function Heatmap() {
  const { categoryMask } = useControls();
  const { result, elapsed } = useAggregation(COLUMNS);

  // The draw callback reads the newest grid through a ref so that a result
  // landing between frames does not need a React render to reach the canvas.
  // Written in a layout effect rather than during render - mutating a ref while
  // rendering is not safe under concurrent rendering, where a render can be
  // thrown away and replayed.
  const resultRef = useRef<AggregateResponse | null>(null);
  const elapsedRef = useRef(0);
  useLayoutEffect(() => {
    resultRef.current = result;
    elapsedRef.current = elapsed;
  }, [result, elapsed]);

  const yRef = useRef({ min: 0, max: CATEGORIES.length });

  const draw = useCallback(
    ({ ctx, plot, frameId }: ChartFrame) => {
      const grid = resultRef.current;
      if (!grid) return;

      const rows = CATEGORIES.length;
      const rowHeight = plot.height / rows;
      const colWidth = plot.width / grid.columns;

      let cells = 0;
      for (let s = 0; s < rows; s++) {
        if ((categoryMask & (1 << s)) === 0) continue;
        const lo = grid.rowMin[s];
        const hi = grid.rowMax[s];
        const range = hi - lo || 1;
        const y = plot.y + s * rowHeight;
        // 1px inset top and bottom so adjacent rows read as separate bands.
        const h = Math.max(1, rowHeight - 2);

        for (let col = 0; col < grid.columns; col++) {
          const i = s * grid.columns + col;
          if (grid.count[i] === 0) continue;
          ctx.fillStyle = rampColor((grid.avg[i] - lo) / range);
          ctx.fillRect(plot.x + col * colWidth, y + 1, Math.max(1, colWidth - 1), h);
          cells++;
        }
      }

      // The heavy work happened in the worker, so report its time rather than
      // the main thread's - that is the number that actually describes this chart.
      perfSink.report(frameId, cells, elapsedRef.current);
    },
    [categoryMask],
  );

  // No invalidate call here: useAggregation already pokes the scheduler when a
  // result lands, and firing a side effect from a render body would run it on
  // every render rather than every result.
  return (
    <ChartShell
      title="Load heat grid"
      hint={`Aggregated in a Web Worker - ${COLUMNS} buckets, normalized per series`}
      draw={draw}
      yDomainRef={yRef}
      yCategories={CATEGORIES}
      interactive={false}
    />
  );
});
