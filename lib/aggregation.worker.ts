/// <reference lib="webworker" />

import type { AggregateRequest, AggregateResponse } from './types';

/**
 * Off-thread aggregation for the heatmap.
 *
 * Of the four charts this is the one that can afford latency and the one whose
 * work is heaviest: it reduces the entire window to a series x time grid of
 * averages. The line, bar and scatter charts all need to track the pointer at
 * 60fps, so they stay on the main thread where the canvas context lives. The
 * heatmap does not - a heat grid that refreshes four times a second looks
 * identical to one that refreshes sixty times a second.
 *
 * So the split is not "put the slow thing in a worker", it is "put the slow
 * thing that tolerates latency in a worker". That is what keeps the main
 * thread's frame budget intact under load.
 */

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<AggregateRequest>) => {
  const { requestId, tMin, tMax, categoryMask, columns, series, count, timestamps, values, categories } =
    e.data;
  const started = performance.now();

  const n = series * columns;
  const sum = new Float64Array(n);
  /** Points per grid cell. Named to keep it distinct from the request's `count`. */
  const cellCount = new Uint32Array(n);
  const rowMin = new Float32Array(series).fill(Infinity);
  const rowMax = new Float32Array(series).fill(-Infinity);

  const invColWidth = columns / (tMax - tMin || 1);
  // The request's `count`, not `timestamps.length`: the arrays are
  // capacity-sized and reused, so everything past `count` is stale data left
  // over from an earlier request.
  const len = Math.min(count, timestamps.length);

  for (let i = 0; i < len; i++) {
    const t = timestamps[i];
    if (t < tMin || t >= tMax) continue;
    const c = categories[i];
    if ((categoryMask & (1 << c)) === 0) continue;

    let col = ((t - tMin) * invColWidth) | 0;
    if (col >= columns) col = columns - 1;
    else if (col < 0) col = 0;

    const idx = c * columns + col;
    sum[idx] += values[i];
    cellCount[idx]++;
  }

  const avg = new Float32Array(n);
  for (let s = 0; s < series; s++) {
    const base = s * columns;
    for (let col = 0; col < columns; col++) {
      const i = base + col;
      if (cellCount[i] === 0) continue;
      const a = sum[i] / cellCount[i];
      avg[i] = a;
      // Range per series, not global. The six signals differ by an order of
      // magnitude, so one shared colour scale would paint four of the rows a
      // uniform near-zero and show nothing.
      if (a < rowMin[s]) rowMin[s] = a;
      if (a > rowMax[s]) rowMax[s] = a;
    }
    if (rowMin[s] === Infinity) {
      rowMin[s] = 0;
      rowMax[s] = 1;
    }
  }

  const response: AggregateResponse = {
    requestId,
    columns,
    series,
    avg,
    count: cellCount,
    rowMin,
    rowMax,
    elapsed: performance.now() - started,
    // Hand the input buffers back so the sender can reuse them next round.
    // Transfer moved ownership here; without this return leg it would have to
    // allocate a fresh 2.6MB set for every request.
    timestamps,
    values,
    categories,
  };

  ctx.postMessage(response, [
    avg.buffer,
    cellCount.buffer,
    rowMin.buffer,
    rowMax.buffer,
    timestamps.buffer,
    values.buffer,
    categories.buffer,
  ]);
};
