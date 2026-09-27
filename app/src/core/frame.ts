/**
 * Frame scheduling.
 *
 * WHY THIS IS NOT JUST requestAnimationFrame
 * rAF is the right primitive for painting: it coalesces bursts into one repaint
 * and it costs nothing while a tab is hidden. But it makes one promise it does
 * not keep — that a requested callback eventually runs. It does not run when
 * the tab is backgrounded (Chrome throttles hidden tabs hard), and it does not
 * run at all in a context that never composites: an offscreen preview surface,
 * a headless capture, a test harness.
 *
 * This terminal is ALWAYS a background tab — you are in MT5, not here — so a
 * paint path that silently stalls is not an edge case, it is the normal case.
 * A stalled paint means the numbers on screen are quietly wrong, which is the
 * one thing this application must never do.
 *
 * So: request a frame AND arm a timer. Whichever fires first wins and cancels
 * the other. Under normal compositing the timer never fires and this is exactly
 * rAF; when rAF is starved the timer keeps the UI honest at a reduced rate.
 * On tab return, everything still pending is flushed immediately.
 */

/** How long to wait for rAF before assuming it will not come. */
const FALLBACK_MS = 250;

type Job = () => void;

const pending = new Set<Handle>();

interface Handle {
  job: Job;
  raf: number;
  timer: number;
  done: boolean;
}

function settle(h: Handle): void {
  if (h.done) return;
  h.done = true;
  if (h.raf) cancelAnimationFrame(h.raf);
  if (h.timer) clearTimeout(h.timer);
  pending.delete(h);
  h.job();
}

/**
 * Run `job` on the next frame, or on a timer if frames are not being served.
 * Returns a canceller.
 */
export function scheduleFrame(job: Job): () => void {
  const h: Handle = { job, raf: 0, timer: 0, done: false };
  pending.add(h);

  h.raf = requestAnimationFrame(() => {
    h.raf = 0;
    settle(h);
  });
  h.timer = window.setTimeout(() => {
    h.timer = 0;
    settle(h);
  }, FALLBACK_MS);

  return () => {
    if (h.done) return;
    h.done = true;
    if (h.raf) cancelAnimationFrame(h.raf);
    if (h.timer) clearTimeout(h.timer);
    pending.delete(h);
  };
}

/** Run every pending job now. */
export function flushFrames(): void {
  for (const h of [...pending]) settle(h);
}

// Coming back to the tab must show current state immediately, not one frame or
// one fallback-interval later. Without this, the first thing you see on
// returning from MT5 is the stale frame from when you left.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) flushFrames();
  });
}
