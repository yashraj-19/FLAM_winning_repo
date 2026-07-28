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

/**
 * Drives the aggregation worker and hands back the latest grid.
 *
 * Two things this has to get right:
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
 */
export function useAggregation(columns: number, intervalMs = 220): AggregationState {
  const { store, viewport, scheduler } = useEngine();
  const [state, setState] = useState<AggregationState>({ result: null, elapsed: 0, ready: false });

  const workerRef = useRef<Worker | null>(null);
  const nextIdRef = useRef(1);
  const acceptedIdRef = useRef(0);
  const inFlightRef = useRef(false);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  useEffect(() => {
    // `new URL(..., import.meta.url)` is the form the Next.js bundler
    // recognises; it emits the worker as its own chunk instead of inlining it
    // into the main bundle.
    const worker = new Worker(new URL('../lib/aggregation.worker.ts', import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<AggregateResponse>) => {
      inFlightRef.current = false;
      const res = e.data;
      if (res.requestId < acceptedIdRef.current) return; // stale, discard
      acceptedIdRef.current = res.requestId;
      setState({ result: res, elapsed: res.elapsed, ready: true });
      scheduler.invalidate();
    };

    return () => {
      worker.onmessage = null;
      worker.terminate();
      workerRef.current = null;
    };
  }, [scheduler]);

  useEffect(() => {
    const id = setInterval(() => {
      const worker = workerRef.current;
      if (!worker || inFlightRef.current) return;
      if (store.count === 0) return;

      const vp = viewport.current;
      const snap = store.snapshot();
      const req: AggregateRequest = {
        requestId: nextIdRef.current++,
        tMin: vp.tMin,
        tMax: vp.tMax,
        categoryMask: 0xff,
        columns: columnsRef.current,
        series: 6,
        timestamps: snap.timestamps,
        values: snap.values,
        categories: snap.categories,
      };

      inFlightRef.current = true;
      worker.postMessage(req, [
        snap.timestamps.buffer,
        snap.values.buffer,
        snap.categories.buffer,
      ]);
    }, intervalMs);

    return () => clearInterval(id);
  }, [store, viewport, intervalMs]);

  return state;
}
