'use client';

import { useEffect, useRef, useState } from 'react';
import { useEngine } from '@/components/providers/DataProvider';
import type { AggregateRequest, AggregateResponse } from '@/lib/types';

export interface AggregationState {
  result: AggregateResponse | null;
  /** Worker-side processing time for the most recent accepted result, in ms. */
  elapsed: number;
  ready: boolean;
}

interface Scratch {
  timestamps: Float64Array;
  values: Float32Array;
  categories: Uint8Array;
}

/**
 * Drives the aggregation worker and hands back the latest grid.
 *
 * Three things this has to get right:
 *
 * 1. **Stale responses.** Requests are async and the window keeps moving, so a
 *    slow response can arrive after a newer one. Every request carries a
 *    monotonic id and anything older than the newest accepted id is dropped.
 *    Without that, panning quickly makes the heatmap jump backwards as
 *    out-of-order replies land.
 *
 * 2. **Back-pressure.** The worker is only sent a new window once it has
 *    answered the previous one. Posting on a fixed timer regardless would queue
 *    work faster than it drains under load, and the heatmap would fall further
 *    behind the longer you ran it.
 *
 * 3. **Buffer ping-pong.** Transferring an ArrayBuffer moves ownership, so the
 *    naive version allocated a fresh copy of the window for every request - at
 *    a full 200k buffer and a 220ms cadence that is ~2.6MB five times a second,
 *    roughly 12MB/s of garbage. Instead one capacity-sized scratch set is
 *    allocated on mount, transferred to the worker, and transferred straight
 *    back in the response. Steady-state allocation on this path is zero.
 *
 *    Because back-pressure guarantees only one request is ever in flight, a
 *    single scratch set is enough: it is either here or at the worker, never
 *    both. `scratchRef` being null *is* the in-flight flag.
 */
export function useAggregation(columns: number, intervalMs = 220): AggregationState {
  const { store, viewport, scheduler } = useEngine();
  const [state, setState] = useState<AggregationState>({ result: null, elapsed: 0, ready: false });

  const workerRef = useRef<Worker | null>(null);
  const scratchRef = useRef<Scratch | null>(null);
  const nextIdRef = useRef(1);
  const acceptedIdRef = useRef(0);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  useEffect(() => {
    // `new URL(..., import.meta.url)` is the form the Next.js bundler
    // recognises; it emits the worker as its own chunk instead of inlining it
    // into the main bundle.
    const worker = new Worker(new URL('../lib/aggregation.worker.ts', import.meta.url));
    workerRef.current = worker;

    // Sized to the ring buffer's capacity once, then reused forever.
    scratchRef.current = {
      timestamps: new Float64Array(store.capacity),
      values: new Float32Array(store.capacity),
      categories: new Uint8Array(store.capacity),
    };

    worker.onmessage = (e: MessageEvent<AggregateResponse>) => {
      const res = e.data;

      // Reclaim the borrowed buffers first, and unconditionally - even for a
      // stale result. Dropping them on the stale path would leak the scratch
      // set and silently fall back to allocating a new one every request.
      scratchRef.current = {
        timestamps: res.timestamps,
        values: res.values,
        categories: res.categories,
      };

      if (res.requestId < acceptedIdRef.current) return;
      acceptedIdRef.current = res.requestId;
      setState({ result: res, elapsed: res.elapsed, ready: true });
      scheduler.invalidate();
    };

    return () => {
      worker.onmessage = null;
      worker.terminate();
      workerRef.current = null;
      scratchRef.current = null;
    };
  }, [scheduler, store]);

  useEffect(() => {
    const id = setInterval(() => {
      const worker = workerRef.current;
      const scratch = scratchRef.current;
      // A null scratch means the previous request has not come back yet.
      if (!worker || !scratch || store.count === 0) return;

      const count = store.snapshotInto(scratch.timestamps, scratch.values, scratch.categories);
      if (count === 0) return;

      const vp = viewport.current;
      const req: AggregateRequest = {
        requestId: nextIdRef.current++,
        tMin: vp.tMin,
        tMax: vp.tMax,
        categoryMask: 0xff,
        columns: columnsRef.current,
        series: 6,
        count,
        timestamps: scratch.timestamps,
        values: scratch.values,
        categories: scratch.categories,
      };

      // Hand off ownership before posting: after transfer these arrays are
      // detached here, and touching them would throw.
      scratchRef.current = null;
      worker.postMessage(req, [
        scratch.timestamps.buffer,
        scratch.values.buffer,
        scratch.categories.buffer,
      ]);
    }, intervalMs);

    return () => clearInterval(id);
  }, [store, viewport, intervalMs]);

  return state;
}
