# Telemetry Dashboard

A real-time data visualization dashboard that renders and updates a
high-frequency telemetry feed at 60fps. Four chart types, all drawn from
scratch on canvas — no charting library.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Canvas 2D + SVG ·
Web Worker · no runtime dependencies beyond React and Next.

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:3000/dashboard
```

Production:

```bash
npm run build
npm start
```

The dashboard is at `/dashboard`; `/` redirects there.

---

## What it does

Six synthetic server-telemetry signals (cpu, memory, network, disk, latency,
throughput) stream in at **10 batches per second**. The seed dataset is 10,000
points; the ring buffer holds up to **200,000** before it starts overwriting the
oldest.

| Chart | What it shows | How it renders |
|---|---|---|
| **Signal over time** | Line, one series per signal | Min/max envelope, 2 points per pixel column |
| **Distribution** | Scatter, normalized per series | Shape + colour dual encoding, LOD collapse under load |
| **Ingest volume** | Stacked bars, points per time bucket | Series-major fills, respects the 1min/5min/1hour selector |
| **Load heat grid** | Series × time heat grid | Aggregated in a **Web Worker**, single-hue ramp per row |

**Interactions** — drag to pan, scroll to zoom (anchored at the cursor), click a
legend entry to filter that series, preset time windows, aggregation period,
feed rate slider, pause, stress test, clear.

**Instrumentation** — a live strip across the top reports FPS, draw time,
processing time, points held, points drawn per frame, JS heap, and dropped
frames per second.

---

## Performance testing

Everything you need is in the UI. To reproduce the numbers in
[PERFORMANCE.md](./PERFORMANCE.md):

1. **Run the production build.** `npm run build && npm start`. Dev mode carries
   React's development checks and Strict Mode double-invocation — measuring it
   tells you nothing about shipped performance.
2. **Baseline.** Load `/dashboard`. The default feed is 6 points/tick. Watch the
   `fps` and `ms draw` readouts settle.
3. **Scale the load.** Drag the **Rate** slider up. Each step raises points per
   100ms tick; at 400 the buffer fills to 200k in about 50 seconds.
4. **Stress test.** Click **Stress test** — 2,000 points per tick, i.e. 20,000
   points/second. The ring buffer saturates in ~10 seconds and stays there.
5. **Memory.** Leave it running. The `MB heap` readout should plateau, not
   climb — the buffer is preallocated, so a full buffer *is* the steady state.
   Chrome DevTools → Performance → tick *Memory*, record a few minutes, and the
   JS heap line should be flat with small GC sawteeth, not a ramp.
6. **Interaction latency.** Drag the line chart while recording in DevTools →
   Performance. Pan and zoom do no React work at all, so there should be no long
   tasks and no component renders in the flame chart.

To watch the level-of-detail system engage, zoom out to the 15m window with the
stress test on: points drawn per frame stays roughly flat while points held
keeps climbing, because the renderer is bounded by pixel columns rather than by
data volume.

---

## Architecture

```
app/
  dashboard/page.tsx          Server Component — generates the seed dataset
  dashboard/layout.tsx        Route layout
  dashboard/loading.tsx       Streaming fallback
  dashboard/error.tsx         Route error boundary (Client Component)
  api/data/route.ts           Route handler — columnar dataset endpoint
components/
  Dashboard.tsx               Client shell, mounts/unmounts charts
  providers/DataProvider.tsx  Engine context + live feed + controls
  charts/ChartShell.tsx       Canvas + SVG chassis, pan/zoom, axes
  charts/{Line,Bar,Scatter,Heatmap}Chart   One draw function each
  charts/Legend.tsx           Series legend that doubles as the filter
  controls/                   Time range, aggregation, load controls
  ui/DataTable.tsx            Virtualized 200k-row table
  ui/PerformanceMonitor.tsx   Live metrics strip
hooks/
  useChartRenderer.ts         Canvas sizing, DPR, scheduler registration
  useDataStream.ts            useSyncExternalStore bridges to the store
  usePerformanceMonitor.ts    4Hz metric sampling
  useVirtualization.ts        Fixed-height windowed list
  useAggregation.ts           Worker driver, stale-response guarding
lib/
  dataStore.ts                Ring buffer over typed arrays
  binning.ts                  Single-pass series × column binner
  viewport.ts                 Camera, kept outside React
  performanceUtils.ts         Shared rAF scheduler, FPS clock
  canvasUtils.ts              Projection, DPR sizing, LOD downsampling
  dataGenerator.ts            Seeded synthetic telemetry
  aggregation.worker.ts       Off-thread heat grid reduction
  palette.ts                  Validated colour palette
```

**The one idea that matters:** high-frequency state lives outside React. The
ring buffer, the viewport and the frame scheduler are plain objects. React
renders the chrome; it is not in the frame loop. Data arriving at 10Hz and a
camera moving at 60Hz produce **zero** React renders. See
[PERFORMANCE.md](./PERFORMANCE.md) for why, and for what that costs.

---

## Next.js optimizations used

- **Server Component seed data.** `app/dashboard/page.tsx` is async and
  generates the 10,000-point dataset server-side.
- **Static generation of a "live" route.** The seed uses timestamps relative to
  zero and a fixed PRNG seed, so it contains no wall-clock value and prerenders
  at build time. The client rebases those offsets onto its own clock, so a
  cached payload still reads as "the last minute" for every visitor. `next build`
  reports `/dashboard` as `○ (Static)`.
- **Columnar RSC payload.** Three parallel arrays instead of 10,000 objects —
  roughly a third of the serialized bytes, and it unpacks straight into typed
  arrays with no intermediate garbage.
- **Route handler** at `/api/data` with query validation and immutable cache
  headers, deliberately dynamic so its query string is actually honoured.
- **`loading.tsx` / `error.tsx`** boundaries on the dashboard segment.
- **Client Components scoped tightly** — only the interactive subtree is
  `'use client'`; the route shell stays server-rendered.
- **Worker as its own chunk** via `new URL(..., import.meta.url)`, so
  aggregation code never enters the main bundle.
- **No `next/font`.** The template's Google Fonts import was removed; the system
  sans costs zero bytes and zero build-time network calls.

Result: **202 KB of gzipped JS** across all chunks, against a 500 KB budget.

---

## Browser compatibility

| Browser | Status |
|---|---|
| Chrome / Edge 111+ | Fully supported, including the heap readout |
| Firefox 121+ | Fully supported; `MB heap` shows `—` |
| Safari 16.4+ | Fully supported; `MB heap` shows `—` |

`performance.memory` is Chromium-only. Rather than fabricate a number, the
monitor shows an em dash where the browser does not expose it.

Everything else is baseline: Canvas 2D, `ResizeObserver`, Pointer Events, Web
Workers, transferable `ArrayBuffer`, `useSyncExternalStore`. There is no
`OffscreenCanvas` dependency — it is listed as a future step, not a requirement.

**Responsive:** the chart grid is `auto-fit` with a `420px` floor, so it goes
two-up on desktop and one-up on tablet and phone without a device breakpoint.
Pointer events cover mouse, trackpad, pen and touch through one code path.

---

## Accessibility notes

- The legend is a real button group and is the accessible name for each series —
  the canvas has no text for a screen reader to find, so identity never rests on
  the pixels alone.
- The scatter carries **shape as well as colour**, because the palette clears
  colour-blindness thresholds on adjacent pairs but not on all pairs at six
  series (see `lib/palette.ts` for the measured numbers).
- Axis labels, gridlines and the crosshair are real SVG text and lines, so they
  stay crisp when zoomed and are exposed to assistive tech.
- Every control is keyboard reachable with a visible focus ring, and
  `prefers-reduced-motion` is honoured.

---

## Known limitations

- **Y-axis autoscaling is per chart, not per series.** The line chart shares one
  axis across visible series. Because the six signals differ by an order of
  magnitude, enabling all of them compresses the smaller ones. The filter is the
  intended remedy; the scatter and heatmap normalize per series instead.
- **No dual-axis mode**, deliberately. Two y-scales on one plot is the most
  common way to mislead with a chart. Two scales means two charts.
- **The bar chart plots counts, not values**, for the same reason — counts are
  the one quantity all six series genuinely share.
- **Aggregation runs over the full window, not incrementally.** At 200k points
  the worker takes a few ms per pass; an incremental design would be needed for
  a much larger buffer.
- **The heat grid refreshes at ~4.5Hz**, bounded by the worker round trip. It is
  the one surface that is not frame-synchronous — which is exactly the trade
  that keeps the main thread free.
- **Tooltips show a crosshair but not per-point values.** Hit-testing an
  individual point at 200k density needs a spatial index; noted as next work
  rather than half-built.

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server with Turbopack |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
