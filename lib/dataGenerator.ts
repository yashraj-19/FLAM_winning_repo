import { CATEGORIES, type ColumnarData } from './types';

/**
 * Synthetic server-telemetry feed.
 *
 * "Realistic" here means the series has structure a chart can actually show:
 * a daily sine baseline, a bounded random walk, and occasional spikes. Pure
 * white noise looks identical at every zoom level, which makes zoom, LOD
 * downsampling and aggregation impossible to evaluate by eye.
 */

const NUM_CATEGORIES = CATEGORIES.length;

/** Per-category shape: baseline level, drift, noise, spike odds. */
const PROFILES = [
  { base: 45, amp: 25, noise: 6, spike: 0.004, spikeSize: 40 }, // cpu
  { base: 62, amp: 12, noise: 3, spike: 0.001, spikeSize: 25 }, // memory
  { base: 30, amp: 28, noise: 10, spike: 0.008, spikeSize: 55 }, // network
  { base: 20, amp: 10, noise: 4, spike: 0.002, spikeSize: 30 }, // disk
  { base: 120, amp: 60, noise: 18, spike: 0.012, spikeSize: 180 }, // latency
  { base: 800, amp: 300, noise: 60, spike: 0.003, spikeSize: 400 }, // throughput
];

/** Deterministic PRNG so the server-rendered seed matches on reload. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random-walk state, one per category, carried across ticks. */
export class FeedState {
  private walk: Float32Array;
  private rand: () => number;

  constructor(seed = 1337) {
    this.walk = new Float32Array(NUM_CATEGORIES);
    this.rand = mulberry32(seed);
  }

  /** Value for `category` at `t`. Advances that category's walk by one step. */
  sample(category: number, t: number): number {
    const p = PROFILES[category];
    const r = this.rand;

    // Bounded walk: pull toward zero so it cannot drift off-scale over hours.
    this.walk[category] = this.walk[category] * 0.97 + (r() - 0.5) * p.noise;

    // Two periods so the shape stays interesting at more than one zoom level.
    const slow = Math.sin(t / 600_000) * p.amp;
    const fast = Math.sin(t / 37_000) * p.amp * 0.25;

    let v = p.base + slow + fast + this.walk[category];
    if (r() < p.spike) v += p.spikeSize * (0.5 + r());

    return v < 0 ? 0 : v;
  }
}

/**
 * Seed dataset, generated on the server.
 *
 * Returns columnar arrays rather than DataPoint objects. At 10k points the
 * object form serialises to roughly 1.1MB of RSC payload; columnar is about a
 * third of that and unpacks straight into the ring buffer's typed arrays with
 * no intermediate objects to allocate and discard.
 */
export function generateInitialDataset(
  count = 10_000,
  endTime = Date.now(),
  intervalMs = 100,
): ColumnarData {
  const state = new FeedState();
  const timestamps = new Array<number>(count);
  const values = new Array<number>(count);
  const categories = new Array<number>(count);

  const perTick = NUM_CATEGORIES;
  const ticks = Math.ceil(count / perTick);
  const startTime = endTime - ticks * intervalMs;

  let i = 0;
  for (let tick = 0; tick < ticks && i < count; tick++) {
    const t = startTime + tick * intervalMs;
    for (let c = 0; c < perTick && i < count; c++, i++) {
      timestamps[i] = t;
      values[i] = Math.round(state.sample(c, t) * 100) / 100;
      categories[i] = c;
    }
  }

  return { timestamps, values, categories };
}

/**
 * One live tick. Writes into caller-owned scratch arrays instead of returning
 * new ones - the feed runs 10x a second forever, so allocating three arrays per
 * tick would be 30 throwaway allocations a second for no reason.
 *
 * Returns how many slots were filled.
 */
export function generateTick(
  state: FeedState,
  now: number,
  pointsPerTick: number,
  outTs: Float64Array,
  outVal: Float32Array,
  outCat: Uint8Array,
): number {
  const n = Math.min(pointsPerTick, outTs.length);
  for (let i = 0; i < n; i++) {
    const c = i % NUM_CATEGORIES;
    outTs[i] = now;
    outVal[i] = state.sample(c, now);
    outCat[i] = c;
  }
  return n;
}
