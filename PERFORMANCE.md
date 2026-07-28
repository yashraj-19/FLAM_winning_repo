# Performance

How this dashboard holds 60fps while data arrives ten times a second, where the
bottlenecks actually were, and what it cost.

---

## 1. The central decision

**High-frequency state is not React state.**

Three things change fast in this app:

| What | Rate | Where it lives |
|---|---|---|
| Incoming data | 10 Hz (up to 20,000 pts/s) | `TimeSeriesStore` — plain object, typed arrays |
| Camera (pan/zoom) | up to 240 Hz on a trackpad | `ViewportStore` — plain object |
| Frame loop | 60 Hz | `RenderScheduler` — plain object |

None of them is `useState`. If the feed drove React state, every batch would
re-render the tree ten times a second; if the viewport did, every pointer move
during a drag would too. The canvas draw callbacks read these objects directly
inside `requestAnimationFrame`, so **panning, zooming and data arrival produce
exactly zero React renders.**

React still runs — for the legend, the controls, the axis labels, the table. It
runs at 4–7 Hz, on a throttled channel, because that is the rate a human can
read.

Both stores expose two notification channels for exactly this reason
(`dataStore.ts:186`, `viewport.ts:139`):

```ts
subscribeData(fn)   // fires on every batch  -> scheduler.invalidate()
subscribeStats(fn)  // fires at most 4Hz     -> React chrome
```

**The cost:** state that React cannot see, so React DevTools shows an idle tree
while the screen is busy. Debugging the renderer means the Performance panel and
the on-screen metrics strip, not the Profiler. That is the trade, and it is why
the metrics strip exists.

---

## 2. Benchmark results

> Reproduce with `npm run build && npm start`, then follow the procedure in
> [README § Performance testing](./README.md#performance-testing). Dev-mode
> numbers are meaningless — Strict Mode double-invokes effects and React ships
> its development build.

**Environment:** Windows 11, Chromium-based browser. _(CPU/RAM to be filled in —
re-run on the review machine; these are the developer's numbers, not a claim
about yours.)_

All four charts visible, all six series enabled, 1m window unless noted.

| Scenario | Points held | Points/frame | FPS | ms draw | ms process | Heap | Dropped/s |
|---|---|---|---|---|---|---|---|
| Live, 6 pts/tick | 11,032 | 168 | **60** | 0.2 | 0.1 | 60.8 MB | 0 |
| Live, 262 pts/tick, 15m window | 175,592 | 1,056 | **60** | 1.4 | 1.4 | 60.9 MB | 0 |
| Buffer saturated, 262 pts/tick | 200,000 (full) | — | **60** | 2.2 | 2.6 | 61.8 MB | 0 |

**What these numbers show.**

*Frame time does not track dataset size.* Points held rose 16× (11k → 175k) while
draw time rose 7× (0.2 → 1.4ms) and points actually drawn rose 6× (168 → 1,056).
Both are bounded by pixel columns, not by data. At 2.2ms of draw against a
16.67ms budget, the renderer is using **13% of a frame** with a full buffer.

*Zero dropped frames at every load*, including a saturated 200k buffer.

*Heap moved 60.8 → 61.8 MB — 1 MB — while stored points grew 18×.* That is the
preallocated ring buffer doing its job: the 2.6MB of typed arrays is committed at
construction, so filling it is not an allocation event. A per-point-object design
would have allocated roughly 190,000 objects over the same span.

> **The 200k row's points/frame is recorded as `—` on purpose.** That measurement
> was taken while the viewport had been parked outside the retained window (see
> §3.7), so the renderer legitimately had nothing in range and reported 0. The
> bug is fixed; the row needs re-measuring rather than a number invented to fill
> the gap.

Still to measure: the 2,000 pts/tick stress mode, and a multi-hour soak for the
memory-growth-per-hour figure.

### Memory, which is exact rather than measured

The ring buffer is allocated once at construction and never grows:

```
200,000 slots ×  8 bytes  (Float64Array — timestamps)  = 1,600,000
200,000 slots ×  4 bytes  (Float32Array — values)      =   800,000
200,000 slots ×  1 byte   (Uint8Array   — categories)  =   200,000
                                                   total ≈ 2.6 MB
```

That is the **ceiling, not the current usage**. Once the buffer is full the
oldest point is overwritten in place; steady-state allocation for the data path
is zero bytes per tick.

This is why the "memory growth < 1MB/hour" target is met by construction rather
than by hoping the GC keeps up. The naive alternative — an array of objects with
`.slice()` to cap the length — allocates one object per point and a new backing
array per tick: roughly 72,000 objects a minute at the default rate, several
million an hour, all of them garbage.

**Scratch buffers are preallocated too**, for the same reason: the feed's tick
arrays (`DataProvider.tsx`), the binner grids (`binning.ts`), the scatter's
per-series arrays and the bar chart's stack accumulator. An early version
allocated a `Float32Array` per frame in `BarChart` and three small typed arrays
per frame in `ScatterPlot` — about 240 throwaway allocations a second between
them. Both were hoisted into refs.

---

## 3. Where the time actually went

Profiling the first working version surfaced these, in order of severity.

### 3.1 One rAF loop, not four

The pattern in most canvas-in-React examples:

```ts
useEffect(() => {
  const animate = () => { render(); requestAnimationFrame(animate); };
  animate();
}, [data]);          // no cancelAnimationFrame in the cleanup
```

Two defects. There is no `cancelAnimationFrame`, so **every effect re-run starts
a second loop and the old one never stops** — after ten renders you have ten
loops drawing the same canvas. And with four charts you get four independent
loops competing inside one 16.67ms budget.

`RenderScheduler` (`performanceUtils.ts`) is a single rAF loop for the entire
page. Charts register a draw function and get an unregister back. It is also
**dirty-flagged**: when nothing has changed the loop parks itself and requeues
only on `invalidate()`, so an idle dashboard uses no CPU instead of burning 60
wasted frames a second.

### 3.2 The renderer is bounded by pixels, not by data

A 900px-wide chart cannot show more than 900 distinct x positions. Drawing
200,000 points into it means ~220 land on each pixel column and 219 are wasted
work.

`downsampleMinMax` / `MultiSeriesBinner` keep **only the min and max of each
pixel column** — at most 2 points per column, so the line chart draws ~1,800
points whether the buffer holds 10,000 or 200,000. Frame time stops scaling with
dataset size.

Min/max rather than every-Nth sampling is the important part. Every-Nth is
cheaper but drops spikes, and a spike is the one thing a telemetry chart exists
to show. A spike is by definition its column's extreme, so the envelope catches
it every time.

### 3.3 One pass over the data, not one per series

The first binner ran once per series — six full sweeps of the ring buffer per
chart per frame. `MultiSeriesBinner` fills a flat `series × column` grid in a
single pass (`binning.ts:60`). Cost stopped scaling with series count.

Inside that loop: `invColWidth` is a precomputed reciprocal so the hot path
multiplies instead of divides, the category filter is a bitmask test
(`mask & (1 << c)`) rather than a `Set.has` or an array lookup, and the ring
buffer is walked as **one or two contiguous runs** rather than with `(start + i)
% capacity` per point.

### 3.4 Canvas state changes are not free

`fillStyle` and `strokeStyle` assignments are context state changes, and each
`stroke()`/`fill()` is its own rasterisation pass. Drawing column-major means one
style change per bar; drawing **series-major** means one per series.

The bar chart, the scatter and the line chart all batch a whole series into a
single path and issue one draw call for it — 6 passes per frame instead of
thousands.

### 3.5 Level of detail applies to shape, too

The scatter encodes category as both colour and marker shape. Above ~6,000
visible marks it collapses every shape to a 2px `fillRect`. This is not a
shortcut: at that density the shapes overlap into solid ink and cannot be read
anyway, while `fillRect` costs a fraction of a path. **Detail that cannot be
perceived is detail worth dropping.**

### 3.6 A click is not a pan

Found by looking at a screenshot of a saturated buffer: every chart blank,
`points/frame` at 0, FPS still a healthy 60.

`panByPixels` set `following = false` unconditionally — including when `dx === 0`.
A plain click on a chart therefore dropped out of live mode while changing
nothing visible. The window then froze in place, and because retention is
bounded by rate (200k points at 2,600/s is about **76 seconds**), the ring buffer
soon lapped past it. Every point fell outside `[tMin, tMax]`, the binner skipped
all of them, and four charts went silently empty.

Three changes, because one would not have been enough:

1. `panByPixels` ignores zero-distance drags — a click no longer means "pan".
2. `ViewportStore.clampToData` slides a parked window back to the nearest edge of
   what is still retained, preserving its span.
3. `ChartShell` renders an explicit empty state that distinguishes *no data* from
   *window outside retained data*, with a **Jump to live** button.

The third matters most. The first two make the failure rare; the third makes it
legible when it happens. An empty chart that says nothing reads as a crash.

### 3.7 Pointer events fire faster than frames

`pointermove` runs above display refresh on many trackpads. `rafThrottle`
(`performanceUtils.ts`) collapses a burst into one call per frame, and
`useVirtualization` does the same for `scroll`.

---

## 4. React optimization techniques

**`useSyncExternalStore`** (`useDataStream.ts`) is the correct primitive for
reading an external mutable source without tearing under concurrent rendering.
The snapshot returns a **number**, not an object — returning a fresh object would
change identity on every call and re-render forever.

**Context split.** `EngineContext` holds the long-lived objects and its value is
created once and never replaced, so consumers are immune to re-render-by-context.
`ControlsContext` holds the genuinely low-frequency state. One context for both
would push camera changes through every consumer.

**Lazy state initialiser.** `useState(() => new TimeSeriesStore(capacity))`, not
`useState(new TimeSeriesStore(capacity))`. The second form allocates a 2.6MB
buffer on *every render* and throws it away.

**Refs for values the frame loop reads.** The draw callback, the measured size,
and the feed rate all live in refs. `rateRef` in particular means the feed's
`setInterval` depends only on `running`, so moving the rate slider does not tear
down and recreate the timer.

**`React.memo`** on every chart, the legend, the controls, the table and the
monitor — they sit under a context whose controls object changes when any single
control changes.

**`useCallback`** on every draw function and event handler that crosses a memo
boundary.

**`useTransition`** on the rate slider (`FilterPanel.tsx`). Dragging it fires a
change per pointer move; marking those as transitions lets React abandon an
in-progress render when a newer value arrives instead of finishing stale work.
The slider thumb stays on the urgent path, so the control never feels laggy.
`isPending` is surfaced in the UI rather than hidden — it is the honest signal
that render is behind input.

**`useLayoutEffect` for ref writes** driven by props (`Heatmap.tsx`). Mutating a
ref during render is unsafe under concurrent rendering, where a render can be
discarded and replayed.

**Unmount, don't hide.** Toggling a chart off unmounts it, which runs the
cleanup in `useChartRenderer` and unregisters its scheduler task. `display: none`
would leave the task registered and the work running into an invisible canvas.

---

## 5. Next.js features and bundling

**Server / Client split.** `app/dashboard/page.tsx` is a Server Component that
generates the 10,000-point seed. Only the interactive subtree is `'use client'`.

**Static generation of a live route.** The seed uses timestamps relative to zero
and a fixed PRNG seed — no wall-clock value anywhere — so the route prerenders at
build time and the client rebases the offsets onto its own clock. `next build`
reports `/dashboard` as `○ (Static)`. Calling `Date.now()` in the page would have
forced it dynamic and put dataset generation on every request's critical path.

**Columnar RSC payload.** 10,000 `{timestamp, value, category}` objects
serialize to ~1.1MB; three parallel arrays are about a third of that, and they
unpack straight into typed arrays with no intermediate objects.

**Route handler.** `/api/data` validates `count`, returns 400 on garbage, and
sets `Cache-Control: immutable`. It is deliberately **not** `force-static` —
that was the first version and it was wrong: prerendering happens at build time
where there is no query string, so every response came back with the default
count and `?count=3` was silently ignored. Caching belongs at the CDN, keyed by
full URL.

**Worker chunking.** `new URL('../lib/aggregation.worker.ts', import.meta.url)`
is the form the bundler recognises, so the worker is emitted as its own chunk
rather than inlined into the main bundle.

**Font removed.** The template imported Geist from Google Fonts — a build-time
network fetch and ~40KB of woff2 on a page graded partly on bundle size. System
sans renders this UI identically for zero bytes.

**Measured bundle:** 202 KB gzipped across all chunks, against a 500 KB budget.

```
70.9 KB   framework
50.5 KB   next runtime
39.5 KB   app shell
13.8 KB   dashboard route
11.5 KB   shared
 6.1 KB   worker chunk
```

---

## 6. Canvas + React integration

The rule for what goes on which layer is **cardinality**:

| Layer | Holds | Why |
|---|---|---|
| **Canvas** | Anything whose count scales with the dataset — points, lines, bars, cells | 200k DOM nodes is 200k layout boxes; as canvas draws they are just fill calls |
| **SVG** | Anything with a fixed small count — axis labels, gridlines, crosshair | Real text nodes: crisp at any zoom, selectable, reachable by a screen reader |

`useChartRenderer` is the whole bridge, and it does four things:

1. **Holds the draw function in a ref**, refreshed each render, so scheduler
   registration happens once per *mount* rather than once per *render*.
2. **Sizes via `ResizeObserver`**, not `window.resize` — a chart that changes
   size because a sibling collapsed still gets resized.
3. **Handles devicePixelRatio.** Backing store is `cssSize × dpr` with the
   context scaled by `dpr`, so draw code stays in CSS pixels and nothing is
   blurry. DPR is capped at 2 — a 3x display means 9x the fill area for detail
   nobody can see, and fill rate is the binding constraint.
4. **Returns a real cleanup** that unregisters the task and disconnects the
   observer. This is precisely the leak the naive pattern has.

`resizeCanvas` returns early when dimensions are unchanged, because assigning
`canvas.width` clears the bitmap and resets the transform *even when the value is
identical* — that would throw away a frame for nothing.

Charts also `ctx.save()` / `clip()` to the plot rect so a fast pan cannot smear
strokes into the axis gutter.

---

## 7. Worker strategy

The heat grid is the only chart aggregated off-thread, and the reason is not
"it's the slowest" — it is **the slowest thing that tolerates latency**.

Line, bar and scatter track the pointer and must respond within a frame, so they
stay on the main thread where the canvas context lives. The heat grid reduces
the entire window to 6 × 72 averages; refreshed at 4.5Hz it looks identical to
60Hz. So it goes to the worker and the main thread keeps its budget.

Two things the driver (`useAggregation.ts`) has to get right:

- **Stale responses.** Requests are async and the window keeps moving, so a slow
  reply can land after a newer one. Every request carries a monotonic id and
  anything older than the newest accepted id is dropped. Without it, panning
  quickly makes the heatmap jump backwards.
- **Back-pressure.** A new window is only sent once the worker has answered the
  previous one. Posting on a fixed timer regardless would queue work faster than
  it drains under load, and the grid would fall further behind the longer it ran.

Buffers are **transferred**, not cloned — a structured clone of a 200k-point
window would itself cost several ms on the main thread, defeating the point.

---

## 8. Scaling strategy

**Server vs client.** Initial data is server-generated and prerendered; live data
is client-generated. There is no server round trip in the steady state, because a
100ms polling loop would cap the update rate at network latency. A real
deployment would swap the generator for a WebSocket or SSE stream into the same
`store.pushBatch` call — the ring buffer, the binner and every chart are
indifferent to where bytes come from.

**Past 200k points.** The current design is bounded by the ring buffer, not by
render cost, since LOD already decouples frame time from dataset size. To go
further:

- **Tiered retention** — full resolution for the recent window, pre-aggregated
  1min/5min rollups behind it. Sub-second detail from six hours ago is not
  something anyone reads.
- **Incremental aggregation** — the worker currently re-reduces the whole window
  each pass. Maintaining running per-bucket accumulators makes it O(new points).
- **`OffscreenCanvas`** — move rasterisation itself into the worker. Real gains,
  but it costs the direct pointer-to-canvas coupling that makes hit-testing
  simple, so it is not worth it until the main thread is genuinely the limit.
- **WebGL** — one draw call for the whole point cloud. The threshold is around a
  million visible marks; below that, Canvas 2D wins on debuggability and the
  cliff is not close.

**If updates came every 10ms instead of 100ms**, nothing structural changes —
the feed already writes into preallocated scratch and the renderer is already
decoupled from arrival rate by the dirty flag. Ten batches would coalesce into
one frame, which is what the dirty flag is for. The stress test is effectively
this experiment: 2,000 points per tick is 20,000 points/second.

---

## 9. Honest gaps

- **The benchmark table above needs filling in on the review machine.**
- No `OffscreenCanvas`, Service Worker, or PWA layer.
- No per-point hit-testing — a spatial index (quadtree keyed on pixel columns)
  is the next thing to build; the crosshair reads the axis, not the nearest
  point.
- Aggregation is full-window rather than incremental.
- No automated performance regression test. The metrics strip makes regressions
  visible but nothing fails a build on them.
