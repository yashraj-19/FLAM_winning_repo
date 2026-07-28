import type { Viewport } from './types';

/**
 * Size a canvas for the current display.
 *
 * Two different sizes are in play: the CSS box (what layout sees) and the
 * backing store (actual pixels). On a 2x display they differ by 2x, and if you
 * only set the CSS size the browser upscales a half-resolution bitmap - the
 * chart looks blurry. Setting width/height to cssSize * dpr and then scaling
 * the context by dpr lets all drawing code keep working in CSS pixels.
 *
 * Returns false when nothing changed, so callers can skip the reset - assigning
 * canvas.width clears the bitmap and resets the transform even if the value is
 * identical, which would throw away a frame for free.
 */
export function resizeCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
): boolean {
  // Cap DPR at 2. A 3x phone display would mean 9x the fill area for detail no
  // one can see on a scatter plot, and fill rate is the binding constraint.
  const scale = Math.min(dpr, 2);
  const w = Math.max(1, Math.round(cssWidth * scale));
  const h = Math.max(1, Math.round(cssHeight * scale));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return true;
}

export interface Plot {
  /** Drawable area in CSS pixels, excluding axis gutters. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Projection from data space to pixel space.
 *
 * Kept as plain numbers and multiplications rather than closures. This runs
 * once per point per frame - at 100k points that is 6 million calls a second,
 * and a closure per axis is measurably slower than inlined arithmetic.
 */
export function makeProjection(vp: Viewport, plot: Plot) {
  const tSpan = vp.tMax - vp.tMin || 1;
  const vSpan = vp.vMax - vp.vMin || 1;
  const xScale = plot.width / tSpan;
  const yScale = plot.height / vSpan;
  return {
    xScale,
    yScale,
    tMin: vp.tMin,
    vMin: vp.vMin,
    plotX: plot.x,
    plotBottom: plot.y + plot.height,
    toX(t: number) {
      return plot.x + (t - vp.tMin) * xScale;
    },
    toY(v: number) {
      return plot.y + plot.height - (v - vp.vMin) * yScale;
    },
    fromX(px: number) {
      return vp.tMin + (px - plot.x) / xScale;
    },
    fromY(py: number) {
      return vp.vMin + (plot.y + plot.height - py) / yScale;
    },
  };
}

export type Projection = ReturnType<typeof makeProjection>;

/**
 * Min/max level-of-detail downsampling.
 *
 * A 900px-wide chart cannot show more than 900 distinct x positions, so drawing
 * 100k points means ~110 of them land on each pixel column and 109 are wasted.
 * Naive every-Nth sampling is fast but drops spikes, which is the one thing you
 * actually need a telemetry chart to show.
 *
 * This walks each pixel column once and keeps only its min and max. The result
 * is at most 2 points per column, the envelope is pixel-identical to drawing
 * everything, and spikes survive because a spike *is* the column max.
 *
 * Writes into caller-owned output arrays. Returns the number of points written.
 */
export function downsampleMinMax(
  ts: Float64Array,
  val: Float32Array,
  cat: Uint8Array,
  segments: Array<{ start: number; length: number }>,
  tMin: number,
  tMax: number,
  categoryMask: number,
  columns: number,
  outX: Float64Array,
  outY: Float32Array,
): number {
  if (columns <= 0) return 0;
  const span = tMax - tMin || 1;
  const colWidth = span / columns;

  let out = 0;
  let curCol = -1;
  let minV = 0;
  let maxV = 0;
  let minT = 0;
  let maxT = 0;
  let has = false;

  const flush = () => {
    if (!has) return;
    // Emit in time order so a line chart's stroke does not zig-zag backwards.
    if (minT <= maxT) {
      outX[out] = minT;
      outY[out] = minV;
      out++;
      if (minT !== maxT || minV !== maxV) {
        outX[out] = maxT;
        outY[out] = maxV;
        out++;
      }
    } else {
      outX[out] = maxT;
      outY[out] = maxV;
      out++;
      outX[out] = minT;
      outY[out] = minV;
      out++;
    }
  };

  for (const seg of segments) {
    const end = seg.start + seg.length;
    for (let i = seg.start; i < end; i++) {
      const t = ts[i];
      if (t < tMin || t > tMax) continue;
      // Bitmask test instead of an array lookup or Set.has - one AND, no branch
      // misprediction, no allocation.
      if ((categoryMask & (1 << cat[i])) === 0) continue;

      const col = ((t - tMin) / colWidth) | 0;
      if (col !== curCol) {
        flush();
        // Guard against overflowing the output buffer near the last column.
        if (out + 2 > outX.length) return out;
        curCol = col;
        const v = val[i];
        minV = maxV = v;
        minT = maxT = t;
        has = true;
      } else {
        const v = val[i];
        if (v < minV) {
          minV = v;
          minT = t;
        } else if (v > maxV) {
          maxV = v;
          maxT = t;
        }
      }
    }
  }
  if (out + 2 <= outX.length) flush();
  return out;
}

/** Nice round axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, target = 6): number[] {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const span = max - min;
  const rawStep = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t);
  return ticks;
}

/** Compact axis label for a value. */
export function formatValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (a >= 100) return v.toFixed(0);
  return v.toFixed(1);
}

/** Time axis label, granularity chosen from the visible span. */
export function formatTime(ms: number, span: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  if (span < 60_000) return `${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0').slice(0, 1)}`;
  if (span < 3_600_000) return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
