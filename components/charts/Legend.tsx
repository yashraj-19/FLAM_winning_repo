'use client';

import { memo } from 'react';
import { useControls } from '@/components/providers/DataProvider';
import { CATEGORIES } from '@/lib/types';
import { SERIES_COLORS, SHAPES } from '@/lib/palette';
import styles from './Legend.module.css';

/**
 * Series legend that doubles as the category filter.
 *
 * A legend is not optional here: with six series, colour alone carries identity
 * on the canvas, and the canvas has no text for a screen reader to find. These
 * buttons are the accessible name for each series, and toggling one is the
 * filter - one control instead of a legend plus a separate checkbox list.
 */
export const Legend = memo(function Legend({ showShapes = false }: { showShapes?: boolean }) {
  const { categoryMask, toggleCategory } = useControls();

  return (
    <div className={styles.legend} role="group" aria-label="Series filter">
      {CATEGORIES.map((name, i) => {
        const on = (categoryMask & (1 << i)) !== 0;
        return (
          <button
            key={name}
            type="button"
            className={styles.item}
            data-on={on}
            aria-pressed={on}
            onClick={() => toggleCategory(i)}
          >
            <span
              className={styles.swatch}
              style={{ background: on ? SERIES_COLORS[i] : 'transparent', borderColor: SERIES_COLORS[i] }}
            />
            <span className={styles.label}>{name}</span>
            {/* The scatter needs shape as a second channel, so name it here too. */}
            {showShapes && <span className={styles.shape}>{SHAPES[i]}</span>}
          </button>
        );
      })}
    </div>
  );
});
