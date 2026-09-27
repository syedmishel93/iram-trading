/**
 * ZOOM AND PAN over the graph. Pure, because the transform decides what the
 * pointer is pointing AT.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS, MEASURED
 *
 * At 1900px the canvas was 1448x898 inside a stage 448px tall: **450 pixels of
 * the graph were being drawn where nobody could see them**, because
 * `.graph-stage` clips and the height was derived from the width with no regard
 * for the room available. Half the markets sat below the fold with nothing on
 * screen to say so — worse than a visibly broken picture, because it looks
 * complete.
 *
 * Bounding the height fixed the clipping and created the real problem: fifteen
 * markets in a short box are legible only if you can move around them. Scaling
 * everything down until it fits makes every label unreadable, which is a
 * different way of hiding the same data.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO PROPERTIES CARRY THE WHOLE FEEL
 *
 * **Zooming at a point keeps that point still.** If the anchor drifts, whatever
 * you were looking at slides out from under the pointer and you spend the
 * interaction chasing it.
 *
 * **Screen and world round-trip exactly.** Hit-testing runs in world
 * coordinates and the pointer arrives in screen ones. A disagreement of a few
 * pixels means the readout names the market NEXT to the one under the cursor,
 * which no amount of looking can falsify.
 */

export interface Camera {
  /** Scale. 1 is the fitted layout at its natural size. */
  readonly zoom: number;
  /** Screen-space offset applied AFTER the scale. */
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly w: number;
  readonly h: number;
}

export const DEFAULT_CAMERA: Camera = { zoom: 1, x: 0, y: 0 };

/** Below this the graph is a smudge; above it, one node fills the box. */
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 8;

const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** A world point as it lands on the canvas. */
export function toScreen(cam: Camera, x: number, y: number): { x: number; y: number } {
  return { x: x * cam.zoom + cam.x, y: y * cam.zoom + cam.y };
}

/** A canvas point back to the layout's own coordinates. */
export function toWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom };
}

/**
 * Keep enough of the picture reachable that it cannot be dragged into nothing.
 *
 * A graph panned entirely off the edge leaves an empty box and no way back
 * except a reset the operator has to go and find. The margin is generous rather
 * than tight: clamping hard enough to feel like a wall is its own annoyance.
 */
function clampPan(cam: Camera, box: Box): Camera {
  const slackX = box.w;
  const slackY = box.h;
  const spanX = box.w * cam.zoom;
  const spanY = box.h * cam.zoom;
  return {
    zoom: cam.zoom,
    x: Math.min(slackX, Math.max(-spanX, cam.x)),
    y: Math.min(slackY, Math.max(-spanY, cam.y)),
  };
}

/**
 * Scale by `factor` about a point on the canvas, holding that point still.
 *
 * A factor that is not a usable number leaves the camera ALONE rather than
 * producing a NaN transform — one NaN and every node is drawn nowhere at all,
 * with no error and an empty canvas that reads as "no data".
 */
export function zoomAt(cam: Camera, factor: number, sx: number, sy: number, box: Box): Camera {
  if (!Number.isFinite(factor) || factor <= 0) return cam;
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
  /* THE ANCHOR STAYS PUT. Solve `world * next + x' = sx` for the world point
     currently under (sx, sy), which is what makes zooming feel like a map. */
  const w = toWorld(cam, finite(sx, 0), finite(sy, 0));
  return clampPan(
    { zoom: next, x: finite(sx, 0) - w.x * next, y: finite(sy, 0) - w.y * next },
    box,
  );
}

/** Drag: one screen pixel of pointer travel is one screen pixel of picture. */
export function panBy(cam: Camera, dx: number, dy: number, box: Box): Camera {
  return clampPan(
    { zoom: cam.zoom, x: cam.x + finite(dx, 0), y: cam.y + finite(dy, 0) },
    box,
  );
}
