/**
 * Shared types for the dashboard.
 *
 * There are deliberately two representations of the same data here:
 *
 *   DataPoint   - the *logical* shape. One object per reading. Used at the edges
 *                 of the system: tooltips, table rows, the public API response.
 *   ColumnarData - the *physical* shape. Parallel arrays, one per field. Used
 *                 everywhere data is stored or drawn in bulk.
 *
 * The split matters. 100k DataPoint objects is 100k heap allocations the GC has
 * to trace on every collection; the same data as three typed arrays is three
 * allocations. Converting between them is cheap and only happens for the handful
 * of points a human actually looks at.
 */

export type ChartType = 'line' | 'bar' | 'scatter' | 'heatmap';

/** One reading. Only constructed for data that reaches the UI as an object. */
export interface DataPoint {
  timestamp: number;
  value: number;
  category: string;
  metadata?: Record<string, unknown>;
}

export interface ChartConfig {
  type: ChartType;
  dataKey: string;
  color: string;
  visible: boolean;
}

export interface PerformanceMetrics {
  /** Frames per second, averaged over a rolling window. */
  fps: number;
  /** JS heap in MB. Chromium only - undefined elsewhere, reported as 0. */
  memoryUsage: number;
  /** Time spent inside draw calls for the last frame, in ms. */
  renderTime: number;
  /** Time spent aggregating/filtering for the last update, in ms. */
  dataProcessingTime: number;
  /** Points submitted to the renderer on the last frame (post level-of-detail). */
  pointsDrawn: number;
  /** Points currently held in the ring buffer. */
  pointsTotal: number;
  /** Frames in the last second that exceeded the 16.67ms budget. */
  droppedFrames: number;
}

/**
 * The categories are fixed and interned as a Uint8 index rather than stored as
 * strings. A string per point would defeat the whole point of the typed-array
 * layout - every one is a separate heap object plus a pointer to chase.
 */
export const CATEGORIES = [
  'cpu',
  'memory',
  'network',
  'disk',
  'latency',
  'throughput',
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Index into CATEGORIES. This is what actually gets stored per point. */
export type CategoryId = number;

/**
 * Wire + storage format. Three parallel arrays where index i of each describes
 * the same reading. Serializes to roughly a third of the equivalent array of
 * objects, and unpacks straight into typed arrays with no per-point allocation.
 */
export interface ColumnarData {
  timestamps: number[];
  values: number[];
  categories: number[];
}

export type TimeBucket = 'raw' | '1min' | '5min' | '1hour';

export const TIME_BUCKETS: { id: TimeBucket; label: string; ms: number }[] = [
  { id: 'raw', label: 'Raw', ms: 0 },
  { id: '1min', label: '1 min', ms: 60_000 },
  { id: '5min', label: '5 min', ms: 300_000 },
  { id: '1hour', label: '1 hour', ms: 3_600_000 },
];

/** A viewport onto the data: which time span and value range are on screen. */
export interface Viewport {
  tMin: number;
  tMax: number;
  vMin: number;
  vMax: number;
}

/** Result of bucketing a series into fixed time windows. */
export interface AggregatedSeries {
  bucketStarts: Float64Array;
  min: Float32Array;
  max: Float32Array;
  avg: Float32Array;
  count: Uint32Array;
  length: number;
}

/** Message contract for the aggregation worker. */
export interface AggregateRequest {
  requestId: number;
  bucketMs: number;
  tMin: number;
  tMax: number;
  /** Bitmask of enabled category ids. */
  categoryMask: number;
  timestamps: Float64Array;
  values: Float32Array;
  categories: Uint8Array;
}

export interface AggregateResponse {
  requestId: number;
  bucketStarts: Float64Array;
  min: Float32Array;
  max: Float32Array;
  avg: Float32Array;
  count: Uint32Array;
  length: number;
  /** Wall time the worker spent on this request, in ms. */
  elapsed: number;
}
