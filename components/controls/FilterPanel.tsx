'use client';

import { memo, useTransition } from 'react';
import { useControls } from '@/components/providers/DataProvider';
import { TimeRangeSelector } from './TimeRangeSelector';
import styles from './Controls.module.css';

/**
 * Load controls: feed rate, pause, stress test, clear.
 *
 * The rate slider is wrapped in useTransition. Dragging it fires a change per
 * pointer move, and each one re-renders the chart tree; marking those updates
 * as transitions lets React interrupt an in-progress render when the next value
 * arrives instead of finishing work that is already stale. The slider thumb
 * itself stays on the urgent path, so the control never feels laggy even while
 * the charts are catching up.
 */
export const FilterPanel = memo(function FilterPanel() {
  const {
    pointsPerTick,
    setPointsPerTick,
    running,
    setRunning,
    stressTest,
    setStressTest,
    clearData,
  } = useControls();

  const [isPending, startTransition] = useTransition();

  return (
    <div className={styles.panel}>
      <TimeRangeSelector />

      <div className={styles.spacer} />

      <div className={styles.group}>
        <span className={styles.groupLabel}>Rate</span>
        <input
          className={styles.slider}
          type="range"
          min={1}
          max={400}
          step={1}
          value={pointsPerTick}
          disabled={stressTest}
          aria-label="Points generated per 100ms tick"
          onChange={(e) => {
            const v = Number(e.target.value);
            startTransition(() => setPointsPerTick(v));
          }}
        />
        <span className={styles.readout} aria-live="off">
          {stressTest ? '2000' : pointsPerTick}/tick
        </span>
      </div>

      <div className={styles.group}>
        <button
          type="button"
          className={styles.button}
          onClick={() => setRunning(!running)}
          aria-pressed={running}
          data-active={running}
        >
          {running ? 'Pause feed' : 'Resume feed'}
        </button>

        <button
          type="button"
          className={styles.button}
          onClick={() => setStressTest(!stressTest)}
          aria-pressed={stressTest}
          data-active={stressTest}
          title="20,000 points per second"
        >
          Stress test
        </button>

        <button type="button" className={styles.button} data-danger="true" onClick={clearData}>
          Clear
        </button>
      </div>

      {/* Transition state is surfaced rather than hidden: it is the honest
          signal that the render is behind the input, and it costs one span. */}
      {isPending && <span className={styles.readout}>updating…</span>}
    </div>
  );
});
