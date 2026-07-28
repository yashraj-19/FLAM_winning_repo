'use client';

import { memo, useCallback } from 'react';
import { useControls, useEngine } from '@/components/providers/DataProvider';
import { useViewportVersion } from '@/hooks/useDataStream';
import { TIME_BUCKETS, type TimeBucket } from '@/lib/types';
import styles from './Controls.module.css';

const RANGES = [
  { label: '10s', ms: 10_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
  { label: '15m', ms: 900_000 },
];

/**
 * Time window presets and the aggregation period.
 *
 * Reads the live window through useViewportVersion, which is the *throttled*
 * viewport channel. This component only needs to know which preset is currently
 * active - a question whose answer changes when you click, not sixty times a
 * second while you drag - so subscribing to the raw channel would re-render it
 * throughout every pan for no visible benefit.
 */
export const TimeRangeSelector = memo(function TimeRangeSelector() {
  const { viewport, store } = useEngine();
  const { bucket, setBucket } = useControls();

  // Subscribing here is what keeps the active-preset highlight in sync when the
  // window changes by some route other than these buttons (a wheel zoom, say).
  useViewportVersion();

  const span = viewport.span;
  const following = viewport.isFollowing;

  const applyRange = useCallback(
    (ms: number) => {
      viewport.setSpan(ms, store.tMax || Date.now());
    },
    [viewport, store],
  );

  return (
    <>
      <div className={styles.group}>
        <span className={styles.groupLabel}>Window</span>
        <div className={styles.segmented} role="group" aria-label="Time window">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              className={styles.segment}
              // Tolerance rather than equality: a wheel zoom lands on arbitrary
              // spans, and exact float comparison would never light anything up.
              aria-pressed={Math.abs(span - r.ms) < r.ms * 0.02}
              onClick={() => applyRange(r.ms)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.group}>
        <button
          type="button"
          className={styles.button}
          data-active={following}
          aria-pressed={following}
          onClick={() => {
            if (!following) applyRange(span);
            else viewport.setFollowing(false);
          }}
          title="Keep the window pinned to the newest data"
        >
          {following ? 'Live' : 'Paused view'}
        </button>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Aggregate</span>
        <div className={styles.segmented} role="group" aria-label="Aggregation period">
          {TIME_BUCKETS.map((b) => (
            <button
              key={b.id}
              type="button"
              className={styles.segment}
              aria-pressed={bucket === b.id}
              onClick={() => setBucket(b.id as TimeBucket)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
});
