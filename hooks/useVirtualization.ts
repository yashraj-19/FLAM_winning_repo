'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface VirtualizationOptions {
  itemCount: number;
  itemHeight: number;
  /** Rows rendered beyond the viewport on each side. */
  overscan?: number;
}

export interface VirtualWindow {
  startIndex: number;
  endIndex: number;
  /** translateY for the rendered slice, in pixels. */
  offsetY: number;
  /** Height of the full list, used to size the scrollbar. */
  totalHeight: number;
}

/**
 * Fixed-height windowed list.
 *
 * A 200k-row table is 200k DOM nodes, each with its own layout box and style
 * resolution. Browsers do not survive that. Here the scroll container is padded
 * to the full list height so the scrollbar behaves normally, but only the rows
 * intersecting the viewport are mounted - typically 20-40 regardless of how
 * large the dataset gets.
 *
 * Fixed row height is a deliberate constraint: it makes the visible range a
 * division rather than a measurement pass, so scrolling costs O(1) instead of
 * O(rows).
 */
export function useVirtualization({ itemCount, itemHeight, overscan = 6 }: VirtualizationOptions) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Scroll events fire faster than frames on trackpads. Coalescing to one state
  // update per frame keeps the row list from re-rendering several times for a
  // single painted frame.
  const frameRef = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setScrollTop(scrollRef.current?.scrollTop ?? 0);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      setViewportHeight(h);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visibleCount = Math.ceil(viewportHeight / itemHeight) + overscan * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(itemCount, startIndex + visibleCount);

  const window: VirtualWindow = {
    startIndex,
    endIndex,
    offsetY: startIndex * itemHeight,
    totalHeight: itemCount * itemHeight,
  };

  return { scrollRef, onScroll, window };
}
