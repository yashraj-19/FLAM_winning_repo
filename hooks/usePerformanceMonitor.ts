'use client';

import { useEffect, useState } from 'react';
import { useEngine } from '@/components/providers/DataProvider';
import { readHeapMB } from '@/lib/performanceUtils';
import type { PerformanceMetrics } from '@/lib/types';

const EMPTY: PerformanceMetrics = {
  fps: 0,
  memoryUsage: 0,
  renderTime: 0,
  dataProcessingTime: 0,
  pointsDrawn: 0,
  pointsTotal: 0,
  droppedFrames: 0,
};

/**
 * Mutable sink the render path writes into.
 *
 * The draw callbacks run 60 times a second and need somewhere to report how
 * many points they submitted. Routing that through React state would mean a
 * setState per frame - the monitor would itself become the bottleneck it exists
 * to measure. So the hot path writes to a plain object and the hook samples it
 * on a timer.
 */
export const perfSink = {
  pointsDrawn: 0,
  dataProcessingTime: 0,
};

/**
 * Samples engine metrics at 4Hz.
 *
 * 4Hz is a readability choice as much as a performance one: numbers that update
 * 60 times a second are unreadable, and a counter that re-renders at 60fps
 * competes with the charts for the same frame budget.
 */
export function usePerformanceMonitor(intervalMs = 250): PerformanceMetrics {
  const { store, scheduler, clock } = useEngine();
  const [metrics, setMetrics] = useState<PerformanceMetrics>(EMPTY);

  useEffect(() => {
    const id = setInterval(() => {
      setMetrics({
        fps: clock.fps,
        memoryUsage: readHeapMB(),
        renderTime: Math.round(scheduler.lastRenderTime * 100) / 100,
        dataProcessingTime: Math.round(perfSink.dataProcessingTime * 100) / 100,
        pointsDrawn: perfSink.pointsDrawn,
        pointsTotal: store.count,
        droppedFrames: clock.droppedFrames,
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [store, scheduler, clock, intervalMs]);

  return metrics;
}
