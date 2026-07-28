'use client';

import { memo } from 'react';
import { usePerformanceMonitor } from '@/hooks/usePerformanceMonitor';
import styles from './PerformanceMonitor.module.css';

/** Colour band for the FPS readout. Green at 55+, amber at 30+, red below. */
function fpsState(fps: number): 'good' | 'warn' | 'bad' {
  if (fps >= 55) return 'good';
  if (fps >= 30) return 'warn';
  return 'bad';
}

/**
 * Live instrumentation strip.
 *
 * Every number here is measured, not estimated. FPS comes from a rAF loop that
 * counts real frame callbacks, so it reports honestly even when the renderer is
 * idle. Render time is wall time around the draw calls. Heap is
 * performance.memory, which only Chromium exposes - it shows a dash elsewhere
 * rather than a fabricated zero.
 *
 * The whole strip re-renders 4 times a second. That is a deliberate ceiling: a
 * monitor that renders every frame competes with the thing it is measuring, and
 * digits changing 60 times a second cannot be read anyway.
 */
export const PerformanceMonitor = memo(function PerformanceMonitor() {
  const m = usePerformanceMonitor();

  return (
    <div className={styles.strip} role="status" aria-live="off" aria-label="Performance metrics">
      <div className={styles.metric} data-state={fpsState(m.fps)}>
        <span className={styles.value}>{m.fps}</span>
        <span className={styles.label}>fps</span>
      </div>

      <div className={styles.metric}>
        <span className={styles.value}>{m.renderTime.toFixed(1)}</span>
        <span className={styles.label}>ms draw</span>
      </div>

      <div className={styles.metric}>
        <span className={styles.value}>{m.dataProcessingTime.toFixed(1)}</span>
        <span className={styles.label}>ms process</span>
      </div>

      <div className={styles.metric}>
        <span className={styles.value}>{m.pointsTotal.toLocaleString()}</span>
        <span className={styles.label}>points held</span>
      </div>

      <div className={styles.metric}>
        <span className={styles.value}>{m.pointsDrawn.toLocaleString()}</span>
        <span className={styles.label}>points/frame</span>
      </div>

      <div className={styles.metric}>
        <span className={styles.value}>{m.memoryUsage > 0 ? `${m.memoryUsage}` : '—'}</span>
        <span className={styles.label}>MB heap</span>
      </div>

      <div className={styles.metric} data-state={m.droppedFrames > 6 ? 'warn' : undefined}>
        <span className={styles.value}>{m.droppedFrames}</span>
        <span className={styles.label}>dropped/s</span>
      </div>
    </div>
  );
});
