/**
 * Frame scheduling and measurement.
 *
 * The pattern shown in most canvas-in-React examples is a per-component
 * `requestAnimationFrame` loop started inside `useEffect`. That has two
 * problems this app cannot afford:
 *
 *   1. Without `cancelAnimationFrame` in the cleanup, every effect re-run
 *      starts a *second* loop. The old one never stops. Both keep drawing.
 *   2. Four charts means four independent loops, each with its own callback
 *      overhead and its own idea of when "now" is, all competing inside the
 *      same 16.67ms budget.
 *
 * Instead there is exactly one rAF loop for the whole page. Charts register a
 * draw function; the scheduler calls them in order, once per frame, and only
 * when something is actually dirty. When nothing changes the loop parks itself
 * and the tab drops to zero CPU.
 */

export type DrawFn = (now: number) => void;

interface Task {
  id: number;
  draw: DrawFn;
}

export class RenderScheduler {
  private tasks: Task[] = [];
  private nextId = 1;
  private rafId: number | null = null;
  private dirty = true;
  private running = false;

  /** ms spent inside draw callbacks on the last frame. */
  lastRenderTime = 0;

  register(draw: DrawFn): () => void {
    const id = this.nextId++;
    this.tasks.push({ id, draw });
    this.invalidate();
    return () => {
      const i = this.tasks.findIndex((t) => t.id === id);
      if (i !== -1) this.tasks.splice(i, 1);
    };
  }

  /** Mark the scene as needing a redraw and wake the loop if it is parked. */
  invalidate(): void {
    this.dirty = true;
    if (this.running && this.rafId === null) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.dirty = true;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private tick = (now: number) => {
    this.rafId = null;
    if (!this.running) return;

    if (this.dirty) {
      this.dirty = false;
      const t0 = performance.now();
      for (const task of this.tasks) task.draw(now);
      this.lastRenderTime = performance.now() - t0;
    }

    // Only queue the next frame if work is pending. A permanently-scheduled rAF
    // keeps the compositor awake and burns battery on an idle dashboard.
    if (this.dirty) this.rafId = requestAnimationFrame(this.tick);
  };
}

/**
 * Rolling FPS counter.
 *
 * Measures real frame delivery with its own rAF loop rather than counting draw
 * calls, so it still reports honestly when the scheduler is parked or when the
 * main thread is blocked by something outside the renderer.
 */
export class FrameClock {
  private frames = 0;
  private dropped = 0;
  private last = 0;
  private windowStart = 0;
  private rafId: number | null = null;

  fps = 0;
  droppedFrames = 0;

  start(): void {
    if (this.rafId !== null) return;
    this.last = performance.now();
    this.windowStart = this.last;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private tick = (now: number) => {
    const delta = now - this.last;
    this.last = now;
    this.frames++;

    // 20ms allows some jitter around the 16.67ms budget without crying wolf.
    if (delta > 20) this.dropped++;

    if (now - this.windowStart >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.windowStart));
      this.droppedFrames = this.dropped;
      this.frames = 0;
      this.dropped = 0;
      this.windowStart = now;
    }

    this.rafId = requestAnimationFrame(this.tick);
  };
}

/** Chromium-only heap reading. Returns 0 where unsupported. */
export function readHeapMB(): number {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number };
  };
  if (!perf.memory) return 0;
  return Math.round((perf.memory.usedJSHeapSize / 1048576) * 10) / 10;
}

/**
 * Trailing-edge rAF throttle for pointer events.
 *
 * pointermove can fire well above display refresh rate (120-1000Hz on some
 * devices). Handling every event means doing layout work for frames that will
 * never be painted. This collapses a burst into one call per frame.
 */
export function rafThrottle<T extends unknown[]>(fn: (...args: T) => void): ((...args: T) => void) & { cancel(): void } {
  let queued = false;
  let latest: T;
  let rafId = 0;
  const wrapped = (...args: T) => {
    latest = args;
    if (queued) return;
    queued = true;
    rafId = requestAnimationFrame(() => {
      queued = false;
      fn(...latest);
    });
  };
  wrapped.cancel = () => {
    if (queued) cancelAnimationFrame(rafId);
    queued = false;
  };
  return wrapped;
}
