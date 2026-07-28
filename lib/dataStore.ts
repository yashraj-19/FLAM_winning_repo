import { CATEGORIES, type ColumnarData, type DataPoint } from './types';

/**
 * Fixed-capacity ring buffer over three parallel typed arrays.
 *
 * This is the single most important file in the project, so it is worth being
 * explicit about why it looks like this.
 *
 * The feed pushes ~10 points every 100ms and runs for hours. The obvious
 * implementation - an array of objects with `.slice()` or `.shift()` to cap the
 * length - allocates one object per point and reallocates the backing array on
 * every tick. Over an hour that is millions of short-lived objects, which shows
 * up as sawtooth heap growth and GC pauses that blow the 16.67ms frame budget.
 *
 * Here the buffers are allocated exactly once, at construction. Writing a point
 * is three indexed stores into pre-allocated memory. Steady-state allocation is
 * zero, so "memory growth < 1MB/hour" holds by construction rather than by
 * hoping the GC keeps up. When the buffer is full the oldest point is
 * overwritten in place - that is the sliding window, and it costs nothing.
 */
export class TimeSeriesStore {
  readonly capacity: number;

  private ts: Float64Array;
  private val: Float32Array;
  private cat: Uint8Array;

  /** Index the next write lands on. */
  private head = 0;
  private _count = 0;

  /** Bumped on every write. Cheap integer, no allocation. */
  private _version = 0;

  /**
   * Reused by segments(). It is called by every chart on every frame, and
   * returning a fresh array of fresh objects each time would be ~1000
   * allocations a second for a value that is discarded immediately.
   * The returned array is only valid until the next segments() call.
   */
  private segA = { start: 0, length: 0 };
  private segB = { start: 0, length: 0 };
  private segScratch: Array<{ start: number; length: number }> = [];

  private dataListeners = new Set<() => void>();
  private statsListeners = new Set<() => void>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(capacity = 200_000) {
    this.capacity = capacity;
    // Float64 for timestamps: epoch millis exceed Float32's 24-bit integer
    // precision, so Float32 would quantise them into ~minute-wide steps.
    this.ts = new Float64Array(capacity);
    // Float32 for values: half the bytes, and the extra precision is invisible
    // once a value is rounded to a pixel.
    this.val = new Float32Array(capacity);
    this.cat = new Uint8Array(capacity);
  }

  get count(): number {
    return this._count;
  }

  get version(): number {
    return this._version;
  }

  /**
   * Raw backing arrays, exposed individually rather than bundled in an object.
   *
   * A `get raw()` returning `{ts, val, cat}` would allocate a fresh object on
   * every access - four charts x 60fps is 240 throwaway objects a second, in
   * the one file that claims to allocate nothing per frame.
   */
  get timestamps(): Float64Array {
    return this.ts;
  }

  get values(): Float32Array {
    return this.val;
  }

  get categories(): Uint8Array {
    return this.cat;
  }

  push(timestamp: number, value: number, category: number): void {
    const i = this.head;
    this.ts[i] = timestamp;
    this.val[i] = value;
    this.cat[i] = category;
    this.head = (i + 1) % this.capacity;
    if (this._count < this.capacity) this._count++;
    this._version++;
  }

  /**
   * Bulk insert. Splits the write into at most two contiguous runs so the hot
   * path is `set()` on a subarray rather than a modulo per element.
   */
  pushBatch(timestamps: ArrayLike<number>, values: ArrayLike<number>, categories: ArrayLike<number>): void {
    const n = timestamps.length;
    if (n === 0) return;

    // A batch larger than capacity can only leave its tail behind.
    if (n >= this.capacity) {
      const off = n - this.capacity;
      for (let i = 0; i < this.capacity; i++) {
        this.ts[i] = timestamps[off + i];
        this.val[i] = values[off + i];
        this.cat[i] = categories[off + i];
      }
      this.head = 0;
      this._count = this.capacity;
      this._version++;
      this.notifyData();
      return;
    }

    const first = Math.min(n, this.capacity - this.head);
    for (let i = 0; i < first; i++) {
      const d = this.head + i;
      this.ts[d] = timestamps[i];
      this.val[d] = values[i];
      this.cat[d] = categories[i];
    }
    for (let i = first; i < n; i++) {
      const d = i - first;
      this.ts[d] = timestamps[i];
      this.val[d] = values[i];
      this.cat[d] = categories[i];
    }

    this.head = (this.head + n) % this.capacity;
    this._count = Math.min(this._count + n, this.capacity);
    this._version++;
    this.notifyData();
  }

  /**
   * The buffer wraps at most once, so the live data is always one or two
   * contiguous runs. Returning them lets callers use plain `for` loops over
   * dense memory instead of `(start + i) % capacity` on every point - the
   * modulo is a real cost at 100k points x 60fps.
   *
   * Runs are returned oldest-first.
   */
  segments(): Array<{ start: number; length: number }> {
    const out = this.segScratch;
    out.length = 0;
    if (this._count === 0) return out;
    const start = (this.head - this._count + this.capacity) % this.capacity;
    const first = Math.min(this._count, this.capacity - start);
    this.segA.start = start;
    this.segA.length = first;
    out.push(this.segA);
    if (first < this._count) {
      this.segB.start = 0;
      this.segB.length = this._count - first;
      out.push(this.segB);
    }
    return out;
  }

  /** Oldest timestamp currently held, or 0 when empty. */
  get tMin(): number {
    if (this._count === 0) return 0;
    const start = (this.head - this._count + this.capacity) % this.capacity;
    return this.ts[start];
  }

  /** Newest timestamp currently held, or 0 when empty. */
  get tMax(): number {
    if (this._count === 0) return 0;
    return this.ts[(this.head - 1 + this.capacity) % this.capacity];
  }

  /**
   * Copy the live window into caller-owned dense arrays.
   *
   * A copy is unavoidable: the buffers handed to the worker are *transferred*,
   * and we cannot give away the memory the render loop is reading from.
   *
   * What is avoidable is allocating that copy every time. The first version
   * returned three fresh arrays per call; at a full buffer and a 220ms cadence
   * that is 2.6MB of garbage roughly five times a second - about 12MB/s, in the
   * one module that claims not to allocate. Now the caller owns the buffers and
   * ping-pongs them with the worker, so this is a memcpy into memory that
   * already exists.
   *
   * Destination arrays must be at least `capacity` long. Returns points written.
   */
  snapshotInto(timestamps: Float64Array, values: Float32Array, categories: Uint8Array): number {
    let off = 0;
    for (const { start, length } of this.segments()) {
      timestamps.set(this.ts.subarray(start, start + length), off);
      values.set(this.val.subarray(start, start + length), off);
      categories.set(this.cat.subarray(start, start + length), off);
      off += length;
    }
    return off;
  }

  /** Materialise a slice as objects. Only for the table and tooltips. */
  toPoints(offset: number, limit: number): DataPoint[] {
    const out: DataPoint[] = [];
    const n = Math.min(limit, Math.max(0, this._count - offset));
    if (n <= 0) return out;
    const start = (this.head - this._count + this.capacity) % this.capacity;
    for (let i = 0; i < n; i++) {
      const idx = (start + offset + i) % this.capacity;
      out.push({
        timestamp: this.ts[idx],
        value: this.val[idx],
        category: CATEGORIES[this.cat[idx]] ?? 'unknown',
      });
    }
    return out;
  }

  load(data: ColumnarData): void {
    this.pushBatch(data.timestamps, data.values, data.categories);
  }

  clear(): void {
    this.head = 0;
    this._count = 0;
    this._version++;
    this.notifyData();
  }

  /**
   * Two notification channels, deliberately separate.
   *
   * `subscribeData` fires on every batch. The render scheduler uses it to set a
   * dirty flag - no React involved.
   *
   * `subscribeStats` fires on a timer, at most every 250ms. React chrome (the
   * counters, the table) subscribes here. Without this split, a 10Hz feed
   * would drive 10 React renders per second for the entire component tree,
   * which is exactly the trap this dashboard is built to avoid.
   */
  subscribeData(fn: () => void): () => void {
    this.dataListeners.add(fn);
    return () => this.dataListeners.delete(fn);
  }

  subscribeStats(fn: () => void): () => void {
    this.statsListeners.add(fn);
    if (!this.statsTimer) {
      this.statsTimer = setInterval(() => {
        for (const l of this.statsListeners) l();
      }, 250);
    }
    return () => {
      this.statsListeners.delete(fn);
      if (this.statsListeners.size === 0 && this.statsTimer) {
        clearInterval(this.statsTimer);
        this.statsTimer = null;
      }
    };
  }

  private notifyData(): void {
    for (const l of this.dataListeners) l();
  }

  /** Release the interval. Called from the provider's effect cleanup. */
  dispose(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.dataListeners.clear();
    this.statsListeners.clear();
  }
}
