'use client';

import { memo } from 'react';
import { useControls } from '@/components/providers/DataProvider';
import { FilterPanel } from '@/components/controls/FilterPanel';
import { PerformanceMonitor } from '@/components/ui/PerformanceMonitor';
import { DataTable } from '@/components/ui/DataTable';
import { LineChart } from '@/components/charts/LineChart';
import { BarChart } from '@/components/charts/BarChart';
import { ScatterPlot } from '@/components/charts/ScatterPlot';
import { Heatmap } from '@/components/charts/Heatmap';
import type { ChartType } from '@/lib/types';
import styles from './Dashboard.module.css';

const CHART_TOGGLES: { id: ChartType; label: string }[] = [
  { id: 'line', label: 'Line' },
  { id: 'scatter', label: 'Scatter' },
  { id: 'bar', label: 'Bar' },
  { id: 'heatmap', label: 'Heatmap' },
];

/**
 * Dashboard shell.
 *
 * Charts are mounted and unmounted rather than hidden with CSS. Unmounting runs
 * the cleanup in useChartRenderer, which unregisters the draw task from the
 * scheduler - so a hidden chart genuinely stops costing frame time instead of
 * quietly drawing into an invisible canvas. `display: none` would have kept the
 * task registered and the work running.
 */
export const Dashboard = memo(function Dashboard() {
  const { visibleCharts, toggleChart } = useControls();

  return (
    <div className={styles.shell}>
      <header className={styles.head}>
        <div>
          <h1 className={styles.h1}>Telemetry Dashboard</h1>
          <p className={styles.sub}>
            Six live signals · canvas rendering · Web Worker aggregation
          </p>
        </div>

        <div className={styles.toggles} role="group" aria-label="Visible charts">
          {CHART_TOGGLES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={styles.toggle}
              aria-pressed={visibleCharts[c.id]}
              onClick={() => toggleChart(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </header>

      <PerformanceMonitor />
      <FilterPanel />

      <div className={styles.grid}>
        {visibleCharts.line && <LineChart />}
        {visibleCharts.scatter && <ScatterPlot />}
        {visibleCharts.bar && <BarChart />}
        {visibleCharts.heatmap && <Heatmap />}
      </div>

      <DataTable />
    </div>
  );
});
