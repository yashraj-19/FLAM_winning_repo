'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { TimeSeriesStore } from '@/lib/dataStore';
import { ViewportStore } from '@/lib/viewport';
import { RenderScheduler, FrameClock } from '@/lib/performanceUtils';
import { FeedState, generateTick } from '@/lib/dataGenerator';
import { CATEGORIES, type ChartType, type ColumnarData, type TimeBucket } from '@/lib/types';

/** Upper bound on points per tick, and therefore the size of the scratch arrays. */
const MAX_POINTS_PER_TICK = 2_000;
const DEFAULT_SPAN_MS = 60_000;

/**
 * Long-lived engine objects.
 *
 * This context value is created once and never replaced, so every consumer of
 * it is immune to re-render-by-context. All the mutable, high-frequency state
 * lives *inside* these objects rather than in React, which is the whole trick:
 * data can arrive at 10Hz and the camera can move at 60Hz without React
 * rendering at all.
 */
export interface Engine {
  store: TimeSeriesStore;
  viewport: ViewportStore;
  scheduler: RenderScheduler;
  clock: FrameClock;
}

/** Low-frequency state that genuinely belongs in React. */
export interface Controls {
  categoryMask: number;
  toggleCategory: (id: number) => void;
  bucket: TimeBucket;
  setBucket: (b: TimeBucket) => void;
  visibleCharts: Record<ChartType, boolean>;
  toggleChart: (t: ChartType) => void;
  pointsPerTick: number;
  setPointsPerTick: (n: number) => void;
  running: boolean;
  setRunning: (r: boolean) => void;
  stressTest: boolean;
  setStressTest: (s: boolean) => void;
  clearData: () => void;
}

const EngineContext = createContext<Engine | null>(null);
const ControlsContext = createContext<Controls | null>(null);

export function useEngine(): Engine {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error('useEngine must be used inside <DataProvider>');
  return ctx;
}

export function useControls(): Controls {
  const ctx = useContext(ControlsContext);
  if (!ctx) throw new Error('useControls must be used inside <DataProvider>');
  return ctx;
}

const ALL_CATEGORIES = (1 << CATEGORIES.length) - 1;

export function DataProvider({
  initialData,
  children,
  capacity = 200_000,
}: {
  initialData: ColumnarData;
  children: ReactNode;
  capacity?: number;
}) {
  /**
   * Lazy initialiser, not `new TimeSeriesStore()` in the body. The body runs on
   * every render; allocating a 200k-point buffer each time would be a 3.2MB
   * allocation per render. This runs exactly once.
   */
  const [engine] = useState<Engine>(() => {
    const store = new TimeSeriesStore(capacity);

    /**
     * The seed timestamps are intentionally relative to zero so the route can be
     * rendered deterministically during SSR and hydration. Only after the client
     * mounts do we rebase the window onto the local clock.
     */
    const seedTs = new Float64Array(initialData.timestamps.length);
    for (let i = 0; i < seedTs.length; i++) seedTs[i] = initialData.timestamps[i];
    store.pushBatch(seedTs, initialData.values, initialData.categories);

    const now = store.tMax || 0;
    const viewport = new ViewportStore(
      { tMin: now - DEFAULT_SPAN_MS, tMax: now, vMin: 0, vMax: 100 },
      DEFAULT_SPAN_MS,
    );

    return { store, viewport, scheduler: new RenderScheduler(), clock: new FrameClock() };
  });

  useEffect(() => {
    if (initialData.timestamps.length === 0) return;

    const { store, viewport } = engine;
    const latestSeed = initialData.timestamps.at(-1) ?? 0;
    const offset = Date.now() - latestSeed;
    if (!Number.isFinite(offset) || offset === 0) return;

    const rebased = new Float64Array(initialData.timestamps.length);
    for (let i = 0; i < rebased.length; i++) rebased[i] = initialData.timestamps[i] + offset;
    store.clear();
    store.pushBatch(rebased, initialData.values, initialData.categories);
    viewport.setSpan(DEFAULT_SPAN_MS, store.tMax || Date.now());
  }, [engine, initialData]);

  const [categoryMask, setCategoryMask] = useState(ALL_CATEGORIES);
  const [bucket, setBucket] = useState<TimeBucket>('raw');
  const [visibleCharts, setVisibleCharts] = useState<Record<ChartType, boolean>>({
    line: true,
    bar: true,
    scatter: true,
    heatmap: true,
  });
  // Explicit <number>: CATEGORIES is `as const`, so its `.length` is the literal
  // type 6 and inference would lock the setter to only ever accept 6.
  const [pointsPerTick, setPointsPerTick] = useState<number>(CATEGORIES.length);
  const [running, setRunning] = useState(true);
  const [stressTest, setStressTest] = useState(false);

  /**
   * The feed reads its rate from a ref, not from the closure.
   *
   * If the interval callback closed over `pointsPerTick` directly, changing the
   * rate would have to tear down and recreate the interval. Reading through a
   * ref means the effect below depends only on `running`, so the timer survives
   * every slider move.
   */
  const rateRef = useRef(pointsPerTick);
  rateRef.current = stressTest ? MAX_POINTS_PER_TICK : pointsPerTick;

  // Start the render loop and the FPS clock for the life of the dashboard.
  useEffect(() => {
    const { scheduler, clock } = engine;
    scheduler.start();
    clock.start();
    return () => {
      scheduler.stop();
      clock.stop();
    };
  }, [engine]);

  // Redraw whenever data lands or the camera moves.
  useEffect(() => {
    const { store, viewport, scheduler } = engine;
    const invalidate = () => scheduler.invalidate();
    const offData = store.subscribeData(invalidate);
    const offView = viewport.subscribe(invalidate);
    return () => {
      offData();
      offView();
    };
  }, [engine]);

  // The live feed.
  useEffect(() => {
    if (!running) return;
    const { store, viewport } = engine;

    const feed = new FeedState(Date.now() & 0xffff);
    // Scratch buffers allocated once and reused every tick. Allocating three
    // arrays per tick would be 30 throwaway allocations a second, forever.
    const ts = new Float64Array(MAX_POINTS_PER_TICK);
    const val = new Float32Array(MAX_POINTS_PER_TICK);
    const cat = new Uint8Array(MAX_POINTS_PER_TICK);

    const id = setInterval(() => {
      const now = Date.now();
      const n = generateTick(feed, now, rateRef.current, ts, val, cat);
      // subarray, not slice: a view onto the scratch buffer, zero copy.
      store.pushBatch(ts.subarray(0, n), val.subarray(0, n), cat.subarray(0, n));
      viewport.followTo(now);
      // A parked window can be outrun by the ring buffer; pull it back to the
      // data that still exists rather than let it point at overwritten slots.
      viewport.clampToData(store.tMin, store.tMax);
    }, 100);

    return () => clearInterval(id);
  }, [engine, running]);

  // Tear down timers and listeners when the dashboard unmounts.
  useEffect(() => {
    const { store, viewport } = engine;
    return () => {
      store.dispose();
      viewport.dispose();
    };
  }, [engine]);

  const controls = useMemo<Controls>(
    () => ({
      categoryMask,
      toggleCategory: (id) => setCategoryMask((m) => m ^ (1 << id)),
      bucket,
      setBucket,
      visibleCharts,
      toggleChart: (t) => setVisibleCharts((v) => ({ ...v, [t]: !v[t] })),
      pointsPerTick,
      setPointsPerTick,
      running,
      setRunning,
      stressTest,
      setStressTest,
      clearData: () => engine.store.clear(),
    }),
    [categoryMask, bucket, visibleCharts, pointsPerTick, running, stressTest, engine],
  );

  return (
    <EngineContext.Provider value={engine}>
      <ControlsContext.Provider value={controls}>{children}</ControlsContext.Provider>
    </EngineContext.Provider>
  );
}
