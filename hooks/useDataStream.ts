'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { useEngine } from '@/components/providers/DataProvider';

/**
 * Subscribes React to the data store's *throttled* channel.
 *
 * useSyncExternalStore is the right primitive here rather than a `useState` +
 * `useEffect` pair: the store is an external mutable source, and this is the
 * API React provides for reading one without tearing during concurrent renders.
 *
 * The snapshot is a plain number. Returning an object would allocate a new
 * reference on every call, React would see the identity change every time it
 * checked, and the component would re-render forever.
 */
export function useDataVersion(): number {
  const { store } = useEngine();

  const subscribe = useCallback(
    (onChange: () => void) => store.subscribeStats(onChange),
    [store],
  );

  return useSyncExternalStore(
    subscribe,
    () => store.version,
    // Server snapshot: the store is empty during SSR, and returning a constant
    // keeps the server and first client render in agreement so hydration is clean.
    () => 0,
  );
}

/** Point count and time bounds, refreshed at the store's throttled rate. */
export function useStreamStats() {
  const { store } = useEngine();
  useDataVersion();
  return {
    count: store.count,
    capacity: store.capacity,
    tMin: store.tMin,
    tMax: store.tMax,
  };
}

/**
 * Subscribes React to viewport changes, also throttled.
 *
 * Used by the SVG axis layer. During a drag the canvas updates every frame
 * while the labels update every ~60ms; at drag speeds the difference is not
 * perceptible, and it keeps 60fps panning entirely free of React work.
 */
export function useViewportVersion(): number {
  const { viewport } = useEngine();

  const subscribe = useCallback(
    (onChange: () => void) => viewport.subscribeThrottled(onChange),
    [viewport],
  );

  // The snapshot has to change whenever the window moves, so derive a number
  // from the bounds themselves rather than keeping a separate counter.
  const getSnapshot = useCallback(() => {
    const v = viewport.current;
    return v.tMin * 31 + v.tMax * 17 + v.vMin * 7 + v.vMax;
  }, [viewport]);

  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
