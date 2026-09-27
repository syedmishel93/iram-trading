/**
 * ZOOM AND PAN — `viz/camera.ts`.
 *
 * MEASURED BEFORE THIS EXISTED. At 1900px the canvas was 1448x898 inside a stage
 * 448px tall: **450 pixels of the graph were drawn where nobody could see them**,
 * silently, because `.graph-stage` clips. Half the markets were below the fold
 * with nothing on screen to say so — which is worse than a visibly broken
 * picture, because it looks complete.
 *
 * So the height stopped being derived from the width, and the camera arrived at
 * the same time: a dense graph in a short box needs to be moved around, not just
 * scaled down until every label is unreadable.
 *
 * THE TEST THAT MATTERS IS `zooming at a point keeps that point still`. Any other
 * behaviour means the thing under the pointer runs away from it as you zoom,
 * which is the difference between a map you can read and one you fight.
 *
 * THE SECOND IS `screen and world round-trip exactly`. Hit-testing happens in
 * world coordinates and the pointer arrives in screen ones; if the two
 * conversions disagree by even a little, the tooltip names a neighbour.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  toScreen,
  toWorld,
  zoomAt,
  type Camera,
} from "../src/viz/camera";

const BOX = { w: 800, h: 500 };

describe("moving between what is drawn and what is pointed at", () => {
  it("SCREEN AND WORLD ROUND-TRIP EXACTLY", () => {
    /* Hit-testing works in world coordinates and the pointer arrives in screen
       ones. A disagreement of a few pixels means the tooltip names the market
       next to the one under the cursor, which is unfalsifiable by eye. */
    const cam: Camera = { zoom: 2.3, x: -140, y: 77 };
    for (const [sx, sy] of [[0, 0], [400, 250], [799, 499], [12.5, 333.25]] as const) {
      const w = toWorld(cam, sx, sy);
      const back = toScreen(cam, w.x, w.y);
      expect(back.x).toBeCloseTo(sx, 9);
      expect(back.y).toBeCloseTo(sy, 9);
    }
  });

  it("the default camera is the identity, so an untouched graph is undistorted", () => {
    expect(DEFAULT_CAMERA.zoom).toBe(1);
    const w = toWorld(DEFAULT_CAMERA, 123, 456);
    expect(w).toEqual({ x: 123, y: 456 });
  });
});

describe("zooming", () => {
  it("ZOOMING AT A POINT KEEPS THAT POINT STILL", () => {
    /* The whole feel of a zoomable picture. If the anchor drifts, whatever you
       were looking at slides out from under the pointer and you chase it. */
    const start: Camera = { zoom: 1, x: 0, y: 0 };
    const anchor = { x: 610, y: 190 };
    const before = toWorld(start, anchor.x, anchor.y);

    let cam = start;
    for (const step of [1.2, 1.2, 1.2, 0.8]) {
      cam = zoomAt(cam, step, anchor.x, anchor.y, BOX);
      const after = toScreen(cam, before.x, before.y);
      expect(after.x).toBeCloseTo(anchor.x, 6);
      expect(after.y).toBeCloseTo(anchor.y, 6);
    }
  });

  it("clamps, so the picture cannot be lost in either direction", () => {
    // Zoomed to 400x, one node fills the canvas and nothing can be found.
    let cam: Camera = DEFAULT_CAMERA;
    for (let i = 0; i < 60; i += 1) cam = zoomAt(cam, 1.4, 400, 250, BOX);
    expect(cam.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    for (let i = 0; i < 120; i += 1) cam = zoomAt(cam, 0.7, 400, 250, BOX);
    expect(cam.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
  });

  it("a nonsense factor leaves the camera alone rather than producing NaN", () => {
    // One NaN in the transform and every node is drawn nowhere, with no error.
    for (const bad of [0, -1, Number.NaN, Infinity]) {
      const cam = zoomAt(DEFAULT_CAMERA, bad, 100, 100, BOX);
      expect(Number.isFinite(cam.zoom)).toBe(true);
      expect(Number.isFinite(cam.x)).toBe(true);
      expect(cam.zoom).toBe(DEFAULT_CAMERA.zoom);
    }
  });
});

describe("panning", () => {
  it("moves the picture with the pointer, one pixel for one pixel", () => {
    // Dragging that does not track the pointer reads as lag, not as movement.
    const cam = panBy({ zoom: 2, x: 10, y: -5 }, 30, -12, BOX);
    expect(cam.x).toBe(40);
    expect(cam.y).toBe(-17);
  });

  it("KEEPS SOME OF THE PICTURE ON SCREEN, so it cannot be dragged into nothing", () => {
    /* A graph panned entirely off the edge leaves an empty box and no way back
       except a reset the operator has to find. The clamp keeps a margin of it
       reachable at every zoom. */
    let cam: Camera = { zoom: 1, x: 0, y: 0 };
    for (let i = 0; i < 100; i += 1) cam = panBy(cam, 500, 500, BOX);
    expect(cam.x).toBeLessThanOrEqual(BOX.w);
    expect(cam.y).toBeLessThanOrEqual(BOX.h);
    for (let i = 0; i < 200; i += 1) cam = panBy(cam, -500, -500, BOX);
    expect(cam.x).toBeGreaterThanOrEqual(-BOX.w * MIN_ZOOM - BOX.w);
  });

  it("never emits a NaN however it is driven", () => {
    const cam = panBy({ zoom: 2, x: 0, y: 0 }, Number.NaN, Infinity, BOX);
    expect(Number.isFinite(cam.x)).toBe(true);
    expect(Number.isFinite(cam.y)).toBe(true);
  });
});
