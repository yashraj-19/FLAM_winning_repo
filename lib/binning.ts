import { CATEGORIES } from './types';

/**
 * Bins every visible point into a (series x pixel-column) grid in a single pass.
 *
 * The naive version of this runs the downsampler once per series, which means
 * six full sweeps over the ring buffer per frame. At 200k points that is 1.2M
 * iterations for a frame that only needs 200k, and it does not get better with
 * more series.
 *
 * Here one pass fills a flat grid indexed `series * columns + column`, holding
 * min, max and a running sum per cell. Three charts then read that same grid:
 *
 *   line    - min/max per column, drawn as a vertical envelope segment
 *   bar     - avg per column
 *   heatmap - avg per (series, column), which *is* the heatmap
 *
 * So a chart costs one sweep regardless of how many series it shows, instead of
 * one sweep per series. Charts keep their own binner because they want different
 * column resolutions - the line chart bins to pixel columns, the bar chart to
 * about forty - but within a chart the cost no longer scales with series count.
 *
 * All grids are allocated once at construction and refilled with `.fill()`,
 * which is a memset rather than an allocation.
 */
export class MultiSeriesBinner {
  readonly series: number;
  readonly maxColumns: number;

  private minV: Float32Array;
  private maxV: Float32Array;
  private sumV: Float64Array;
  private cnt: Uint32Array;
  /** Timestamp of the min and max sample in each cell, for time-accurate lines. */
  private minT: Float64Array;
  private maxT: Float64Array;

  columns = 0;
  tMin = 0;
  tMax = 0;

  /** Value range across every populated cell, for axis autoscaling. */
  globalMin = 0;
  globalMax = 1;
  /** Number of raw points that fell inside the window and passed the filter. */
  pointsConsidered = 0;

  constructor(series = CATEGORIES.length, maxColumns = 4096) {
    this.series = series;
    this.maxColumns = maxColumns;
    const n = series * maxColumns;
    this.minV = new Float32Array(n);
    this.maxV = new Float32Array(n);
    this.sumV = new Float64Array(n);
    this.cnt = new Uint32Array(n);
    this.minT = new Float64Array(n);
    this.maxT = new Float64Array(n);
  }

  private reset(columns: number, tMin: number, tMax: number): void {
    this.columns = Math.min(columns, this.maxColumns);
    this.tMin = tMin;
    this.tMax = tMax;
    const n = this.series * this.columns;
    // Only clear the region actually in use. Clearing the full 4096-column grid
    // when the chart is 300px wide would be 13x the necessary work.
    this.cnt.fill(0, 0, n);
    this.sumV.fill(0, 0, n);
    this.globalMin = Infinity;
    this.globalMax = -Infinity;
    this.pointsConsidered = 0;
  }

  /** One pass over the live window. */
  ingest(
    ts: Float64Array,
    val: Float32Array,
    cat: Uint8Array,
    segments: Array<{ start: number; length: number }>,
    tMin: number,
    tMax: number,
    categoryMask: number,
    columns: number,
  ): void {
    this.reset(columns, tMin, tMax);
    const cols = this.columns;
    if (cols <= 0) return;

    // Multiply by the reciprocal instead of dividing per point. A divide is
    // several times the latency of a multiply and this runs 200k times a frame.
    const invColWidth = cols / (tMax - tMin || 1);

    let gMin = Infinity;
    let gMax = -Infinity;
    let considered = 0;

    for (const seg of segments) {
      const end = seg.start + seg.length;
      for (let i = seg.start; i < end; i++) {
        const t = ts[i];
        if (t < tMin || t >= tMax) continue;
        const c = cat[i];
        if ((categoryMask & (1 << c)) === 0) continue;

        let col = ((t - tMin) * invColWidth) | 0;
        if (col >= cols) col = cols - 1;

        const idx = c * cols + col;
        const v = val[i];

        if (this.cnt[idx] === 0) {
          this.minV[idx] = v;
          this.maxV[idx] = v;
          this.minT[idx] = t;
          this.maxT[idx] = t;
        } else {
          if (v < this.minV[idx]) {
            this.minV[idx] = v;
            this.minT[idx] = t;
          } else if (v > this.maxV[idx]) {
            this.maxV[idx] = v;
            this.maxT[idx] = t;
          }
        }
        this.cnt[idx]++;
        this.sumV[idx] += v;

        if (v < gMin) gMin = v;
        if (v > gMax) gMax = v;
        considered++;
      }
    }

    this.pointsConsidered = considered;
    if (considered === 0) {
      this.globalMin = 0;
      this.globalMax = 1;
    } else {
      this.globalMin = gMin;
      this.globalMax = gMax;
    }
  }

  index(series: number, column: number): number {
    return series * this.columns + column;
  }

  count(series: number, column: number): number {
    return this.cnt[series * this.columns + column];
  }

  min(series: number, column: number): number {
    return this.minV[series * this.columns + column];
  }

  max(series: number, column: number): number {
    return this.maxV[series * this.columns + column];
  }

  avg(series: number, column: number): number {
    const i = series * this.columns + column;
    const c = this.cnt[i];
    return c === 0 ? 0 : this.sumV[i] / c;
  }

  minTime(series: number, column: number): number {
    return this.minT[series * this.columns + column];
  }

  maxTime(series: number, column: number): number {
    return this.maxT[series * this.columns + column];
  }

  /** Range across one series only - used when charts scale per series. */
  seriesRange(series: number): { min: number; max: number; populated: number } {
    let min = Infinity;
    let max = -Infinity;
    let populated = 0;
    const base = series * this.columns;
    for (let col = 0; col < this.columns; col++) {
      const i = base + col;
      if (this.cnt[i] === 0) continue;
      populated++;
      if (this.minV[i] < min) min = this.minV[i];
      if (this.maxV[i] > max) max = this.maxV[i];
    }
    return populated === 0 ? { min: 0, max: 1, populated: 0 } : { min, max, populated };
  }
}

/**
 * Ease a y-axis toward a target range.
 *
 * Snapping the axis to the exact min/max of the visible data makes the chart
 * jitter on every frame, because a live feed changes those bounds constantly and
 * the whole plot shifts to compensate. Easing 15% of the way per frame keeps the
 * axis responsive while making the movement read as smooth rather than nervous.
 */
export function easeDomain(
  current: { min: number; max: number },
  targetMin: number,
  targetMax: number,
  factor = 0.15,
): void {
  if (!isFinite(targetMin) || !isFinite(targetMax)) return;
  // 8% headroom so peaks do not sit flush against the top edge.
  const pad = (targetMax - targetMin) * 0.08 || 1;
  const lo = targetMin - pad;
  const hi = targetMax + pad;
  if (!isFinite(current.min) || !isFinite(current.max) || current.max <= current.min) {
    current.min = lo;
    current.max = hi;
    return;
  }
  current.min += (lo - current.min) * factor;
  current.max += (hi - current.max) * factor;
}
