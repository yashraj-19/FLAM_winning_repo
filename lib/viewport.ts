import type { Viewport } from './types';

/**
 * Holds the visible time/value window.
 *
 * Deliberately *not* React state. Panning emits pointer events at or above the
 * refresh rate; routing each one through `useState` would re-render the whole
 * dashboard 60+ times a second just to move a camera. Instead the viewport is a
 * mutable object the draw loop reads directly, and React only hears about it
 * through a throttled channel.
 *
 * Same two-channel pattern as TimeSeriesStore, for the same reason:
 *   - subscribe()          fires immediately, wired to scheduler.invalidate()
 *   - subscribeThrottled() fires at most every 60ms, wired to the SVG axis
 *                          labels. A label lagging one frame behind the canvas
 *                          during a drag is invisible; 60 React renders a
 *                          second is not.
 */
export class ViewportStore {
  private vp: Viewport;
  private listeners = new Set<() => void>();
  private throttledListeners = new Set<() => void>();
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  /** When true the window tracks the newest data instead of staying put. */
  private following = true;

  /** Width of the live window in ms. Preserved across live updates. */
  private spanMs: number;

  constructor(initial: Viewport, spanMs = 60_000) {
    this.vp = { ...initial };
    this.spanMs = spanMs;
  }

  get current(): Readonly<Viewport> {
    return this.vp;
  }

  get isFollowing(): boolean {
    return this.following;
  }

  get span(): number {
    return this.vp.tMax - this.vp.tMin;
  }

  setFollowing(on: boolean): void {
    if (this.following === on) return;
    this.following = on;
    this.notify();
  }

  set(next: Partial<Viewport>): void {
    Object.assign(this.vp, next);
    this.notify();
  }

  /**
   * Slide the window to the newest timestamp. Called on every data tick while
   * following. Keeps the span fixed so live mode does not slowly zoom out.
   */
  followTo(tMax: number): void {
    if (!this.following) return;
    this.vp.tMax = tMax;
    this.vp.tMin = tMax - this.spanMs;
    this.notify();
  }

  /** Drag. dx is in pixels; plotWidth converts it to a time delta. */
  panByPixels(dx: number, plotWidth: number): void {
    // A click is a pointerdown/up with no movement, and it used to land here
    // with dx === 0 - which changed nothing visually but still dropped out of
    // live mode. The window then froze while the ring buffer kept overwriting,
    // and once it lapped, every point fell outside the window and all four
    // charts went blank with no explanation. Zero-distance drags are not pans.
    if (plotWidth <= 0 || dx === 0) return;
    const dt = (dx / plotWidth) * this.span;
    this.vp.tMin -= dt;
    this.vp.tMax -= dt;
    // Any manual pan detaches from live mode - otherwise the next tick would
    // yank the window back and the drag would feel broken.
    this.following = false;
    this.notify();
  }

  /**
   * Wheel zoom anchored at the cursor, so the timestamp under the pointer stays
   * under the pointer. Anchoring at the centre instead is the usual shortcut
   * and it feels wrong the moment you try to zoom into an off-centre spike.
   */
  zoomAt(factor: number, anchorPx: number, plotX: number, plotWidth: number): void {
    if (plotWidth <= 0) return;
    const ratio = Math.min(1, Math.max(0, (anchorPx - plotX) / plotWidth));
    const anchorT = this.vp.tMin + ratio * this.span;

    let nextSpan = this.span * factor;
    // Floor at 1s and ceiling at 24h: below the floor float64 millis get noisy,
    // above the ceiling there is no data to show anyway.
    nextSpan = Math.min(86_400_000, Math.max(1_000, nextSpan));

    this.vp.tMin = anchorT - ratio * nextSpan;
    this.vp.tMax = this.vp.tMin + nextSpan;
    this.spanMs = nextSpan;
    this.following = false;
    this.notify();
  }

  /** Jump to a fixed window ending at `now`, and resume following. */
  setSpan(spanMs: number, now: number): void {
    this.spanMs = spanMs;
    this.vp.tMax = now;
    this.vp.tMin = now - spanMs;
    this.following = true;
    this.notify();
  }

  /**
   * Keep a parked window within reach of the data that still exists.
   *
   * The ring buffer is finite, so retention is bounded by rate: at 2,600
   * points/second a 200k buffer holds about 76 seconds. A window parked outside
   * that span shows nothing at all - not because anything is broken, but
   * because the data it points at has been overwritten. Rather than leave the
   * user staring at four empty charts, slide the window back to the nearest
   * edge of what is still retained, preserving its span.
   *
   * Only applies when parked; live mode is already pinned to the newest point.
   */
  clampToData(dataMin: number, dataMax: number): void {
    if (this.following || dataMax <= dataMin) return;
    const span = this.span;
    if (this.vp.tMin > dataMax) {
      this.vp.tMax = dataMax;
      this.vp.tMin = dataMax - span;
      this.notify();
    } else if (this.vp.tMax < dataMin) {
      this.vp.tMin = dataMin;
      this.vp.tMax = dataMin + span;
      this.notify();
    }
  }

  setValueRange(vMin: number, vMax: number): void {
    // Ignore degenerate ranges; a zero-height plot divides by zero downstream.
    if (!isFinite(vMin) || !isFinite(vMax) || vMax <= vMin) return;
    this.vp.vMin = vMin;
    this.vp.vMax = vMax;
    this.notify();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribeThrottled(fn: () => void): () => void {
    this.throttledListeners.add(fn);
    return () => this.throttledListeners.delete(fn);
  }

  private notify(): void {
    for (const l of this.listeners) l();

    if (this.throttleTimer === null && this.throttledListeners.size > 0) {
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        for (const l of this.throttledListeners) l();
      }, 60);
    }
  }

  dispose(): void {
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.throttleTimer = null;
    this.listeners.clear();
    this.throttledListeners.clear();
  }
}
