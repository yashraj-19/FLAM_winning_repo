'use client';

import { memo, useMemo } from 'react';
import { useEngine } from '@/components/providers/DataProvider';
import { useDataVersion } from '@/hooks/useDataStream';
import { useVirtualization } from '@/hooks/useVirtualization';
import { SERIES_COLORS } from '@/lib/palette';
import { CATEGORIES } from '@/lib/types';
import styles from './DataTable.module.css';

const ROW_HEIGHT = 26;

function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Virtualised view of the raw feed, newest first.
 *
 * The store holds up to 200k rows. Rendering those as DOM would be 200k
 * elements, each carrying layout and style state - the tab would be unusable
 * long before it finished. Instead the scroll container is padded to the full
 * height so the scrollbar reflects the real dataset, and only the ~30 rows
 * actually on screen are mounted.
 *
 * Rows are only materialised as objects at this point - the slice the user can
 * see. Everywhere else the data stays in typed arrays.
 */
export const DataTable = memo(function DataTable() {
  const { store } = useEngine();

  // Throttled subscription: the table refreshes 4 times a second rather than
  // with every batch. Faster than that and the rows are a blur anyway.
  useDataVersion();

  const total = store.count;
  const { scrollRef, onScroll, window: win } = useVirtualization({
    itemCount: total,
    itemHeight: ROW_HEIGHT,
  });

  const rows = useMemo(() => {
    const n = win.endIndex - win.startIndex;
    if (n <= 0) return [];
    // Newest-first display over an oldest-first store: take the mirrored
    // chronological slice, then reverse just those rows.
    const offset = Math.max(0, total - win.endIndex);
    return store.toPoints(offset, n).reverse();
  }, [store, total, win.startIndex, win.endIndex]);

  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <h3 className={styles.title}>Raw feed</h3>
        <span className={styles.count}>
          {total.toLocaleString()} rows · {win.endIndex - win.startIndex} mounted
        </span>
      </header>

      <div className={styles.headRow} aria-hidden="true">
        <span>Time</span>
        <span>Series</span>
        <span className={styles.numeric}>Value</span>
      </div>

      <div className={styles.scroll} ref={scrollRef} onScroll={onScroll} tabIndex={0} role="region" aria-label="Raw data rows">
        {/* Spacer element carries the full scroll height so the scrollbar is
            proportional to the whole dataset, not the mounted slice. */}
        <div style={{ height: win.totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${win.offsetY}px)` }}>
            {rows.map((row, i) => {
              const catIndex = CATEGORIES.indexOf(row.category as (typeof CATEGORIES)[number]);
              return (
                <div className={styles.row} style={{ height: ROW_HEIGHT }} key={win.startIndex + i}>
                  <span className={styles.time}>{formatClock(row.timestamp)}</span>
                  <span className={styles.series}>
                    <span
                      className={styles.dot}
                      style={{ background: SERIES_COLORS[catIndex] ?? 'var(--muted)' }}
                    />
                    {row.category}
                  </span>
                  <span className={styles.numeric}>{row.value.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        </div>

        {total === 0 && <p className={styles.empty}>No data yet. Resume the feed to start streaming.</p>}
      </div>
    </section>
  );
});
