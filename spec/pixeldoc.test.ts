import { describe, expect, it } from "vitest";
import {
  boundsIntersect,
  buildRenderOps,
  cellBoundsForPoints,
  cellFromClientPoint,
  clampBrushSize,
  DEFAULT_PIXEL_RESOLUTION,
  isValidPixelResolution,
  nextSyntheticSeq,
  PIXEL_MAX_ZOOM,
  PIXEL_MIN_ZOOM,
  PIXEL_RESOLUTIONS,
  PIXEL_ZOOM_LEVELS,
  PUBLIC_PIXEL_HEIGHT,
  PUBLIC_PIXEL_WIDTH,
  removePendingOp,
  resolveEditorMode,
  resolveRoomCreationResolution,
} from "../public/pixeldoc.js";
import { clampZoom, fitZoom, stepZoom } from "../public/viewport.js";

// --- Pixel document selection -------------------------------------------------

describe("resolveEditorMode", () => {
  it("Public (roomCode null) is unconditionally the pixel wall at 2048x1152, regardless of any room argument", () => {
    expect(resolveEditorMode(null, null)).toEqual({ mode: "pixel", width: PUBLIC_PIXEL_WIDTH, height: PUBLIC_PIXEL_HEIGHT });
    expect(resolveEditorMode(null, { kind: "legacy" })).toEqual({
      mode: "pixel",
      width: PUBLIC_PIXEL_WIDTH,
      height: PUBLIC_PIXEL_HEIGHT,
    });
  });

  it("a pixel-kind room resolves to the pixel editor at that room's own stored resolution", () => {
    expect(resolveEditorMode("ABCDEF", { kind: "pixel", width: 64, height: 64 })).toEqual({
      mode: "pixel",
      width: 64,
      height: 64,
    });
  });

  it("a legacy-kind room resolves to the legacy editor, with no width/height carried", () => {
    expect(resolveEditorMode("ABCDEF", { kind: "legacy", width: null, height: null })).toEqual({ mode: "legacy" });
  });

  it("a missing/malformed room (lookup failure, or a pixel kind with no numeric dimensions) falls back to legacy rather than crashing or guessing", () => {
    expect(resolveEditorMode("ABCDEF", null)).toEqual({ mode: "legacy" });
    expect(resolveEditorMode("ABCDEF", { kind: "pixel", width: null, height: null })).toEqual({ mode: "legacy" });
    expect(resolveEditorMode("ABCDEF", {})).toEqual({ mode: "legacy" });
  });
});

// --- Dimension / resolution handling ------------------------------------------

describe("pixel resolution handling", () => {
  it("PIXEL_RESOLUTIONS is exactly the four supported studio sizes, and the default is 128", () => {
    expect(PIXEL_RESOLUTIONS).toEqual([32, 64, 128, 256]);
    expect(DEFAULT_PIXEL_RESOLUTION).toBe(128);
    expect(isValidPixelResolution(DEFAULT_PIXEL_RESOLUTION)).toBe(true);
  });

  it("isValidPixelResolution rejects anything outside the exact four supported sizes", () => {
    for (const bad of [0, 16, 100, 512, -32, 64.5, "64", null, undefined]) {
      expect(isValidPixelResolution(bad as unknown as number)).toBe(false);
    }
  });
});

// --- Room creation: resolving the create-room popover's selected value ------

describe("resolveRoomCreationResolution (the create-room popover's selected radio value -> what POST /api/rooms actually receives)", () => {
  it("passes through each of the four supported resolutions, given as the radio's own string value", () => {
    for (const size of PIXEL_RESOLUTIONS) {
      expect(resolveRoomCreationResolution(String(size))).toBe(size);
    }
  });

  it("falls back to the default (128) when nothing is selected (undefined, e.g. document.querySelector found no checked radio)", () => {
    expect(resolveRoomCreationResolution(undefined)).toBe(DEFAULT_PIXEL_RESOLUTION);
  });

  it("falls back to the default for any malformed or out-of-range value, never trusting it through unchecked", () => {
    for (const bad of ["", "0", "100", "abc", null]) {
      expect(resolveRoomCreationResolution(bad as unknown as string)).toBe(DEFAULT_PIXEL_RESOLUTION);
    }
  });
});

// --- Tool behaviour: brush size ------------------------------------------------

describe("clampBrushSize", () => {
  it("passes through any already-valid integer size 1-8 unchanged", () => {
    for (let size = 1; size <= 8; size++) expect(clampBrushSize(size)).toBe(size);
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(clampBrushSize(0)).toBe(1);
    expect(clampBrushSize(-5)).toBe(1);
    expect(clampBrushSize(9)).toBe(8);
    expect(clampBrushSize(999)).toBe(8);
  });

  it("rounds a fractional size to the nearest integer before clamping", () => {
    expect(clampBrushSize(3.4)).toBe(3);
    expect(clampBrushSize(3.6)).toBe(4);
  });

  it("falls back to the default for a non-finite input rather than propagating NaN", () => {
    expect(clampBrushSize(NaN)).toBe(2);
    expect(clampBrushSize(Infinity)).toBe(2);
  });
});

// --- Coordinate conversion -----------------------------------------------------

describe("cellFromClientPoint", () => {
  it("maps the top-left of the canvas's own CSS box to cell (0,0)", () => {
    const rect = { left: 0, top: 0, width: 320, height: 320 }; // a 32x32 document at 10x zoom
    expect(cellFromClientPoint(0, 0, rect, 32, 32)).toEqual({ x: 0, y: 0 });
  });

  it("maps the exact bottom-right corner to the last valid cell, not one past it", () => {
    const rect = { left: 0, top: 0, width: 320, height: 320 };
    expect(cellFromClientPoint(320, 320, rect, 32, 32)).toEqual({ x: 31, y: 31 });
  });

  it("maps the centre of a cell to that cell, at an arbitrary zoom level", () => {
    const rect = { left: 0, top: 0, width: 640, height: 640 }; // 32x32 document at 20x zoom: each cell is 20 CSS px
    // Cell (5, 5) spans CSS x in [100, 120); its centre is 110.
    expect(cellFromClientPoint(110, 110, rect, 32, 32)).toEqual({ x: 5, y: 5 });
  });

  it("accounts for the rect's own position, so a scrolled/panned viewport doesn't shift the result", () => {
    const rect = { left: -50, top: -30, width: 320, height: 320 };
    expect(cellFromClientPoint(-50, -30, rect, 32, 32)).toEqual({ x: 0, y: 0 });
  });

  it("clamps a pointer outside the canvas's own box (still captured mid-drag) into a valid cell", () => {
    const rect = { left: 0, top: 0, width: 320, height: 320 };
    expect(cellFromClientPoint(-20, -20, rect, 32, 32)).toEqual({ x: 0, y: 0 });
    expect(cellFromClientPoint(9999, 9999, rect, 32, 32)).toEqual({ x: 31, y: 31 });
  });

  it("resolves correctly for the Public document's own 2048x1152 grid", () => {
    const rect = { left: 0, top: 0, width: PUBLIC_PIXEL_WIDTH, height: PUBLIC_PIXEL_HEIGHT }; // 100% zoom
    expect(cellFromClientPoint(0, 0, rect, PUBLIC_PIXEL_WIDTH, PUBLIC_PIXEL_HEIGHT)).toEqual({ x: 0, y: 0 });
    expect(cellFromClientPoint(PUBLIC_PIXEL_WIDTH - 1, PUBLIC_PIXEL_HEIGHT - 1, rect, PUBLIC_PIXEL_WIDTH, PUBLIC_PIXEL_HEIGHT)).toEqual({
      x: PUBLIC_PIXEL_WIDTH - 1,
      y: PUBLIC_PIXEL_HEIGHT - 1,
    });
  });
});

// --- Zoom, adapted to pixel document dimensions (reuses viewport.js as-is) ---

describe("zoom for pixel documents (public/viewport.js's existing generic functions, pixel-specific parameters)", () => {
  it("PIXEL_MIN_ZOOM/PIXEL_MAX_ZOOM/PIXEL_ZOOM_LEVELS are a wider range than the freehand document's, since a small grid needs much higher magnification to be usable", () => {
    expect(PIXEL_MIN_ZOOM).toBeGreaterThanOrEqual(1);
    expect(PIXEL_MAX_ZOOM).toBeGreaterThan(4); // freehand's own MAX_ZOOM
    expect(PIXEL_ZOOM_LEVELS[0]).toBe(PIXEL_MIN_ZOOM);
    expect(PIXEL_ZOOM_LEVELS[PIXEL_ZOOM_LEVELS.length - 1]).toBe(PIXEL_MAX_ZOOM);
  });

  it("fitZoom scales a small 32x32 document up to fill the available workspace, within the pixel zoom range", () => {
    const zoom = fitZoom(640, 640, 32, 32, 0, PIXEL_MIN_ZOOM, PIXEL_MAX_ZOOM);
    expect(zoom).toBe(20); // 640 / 32, comfortably inside [1, 32]
  });

  it("fitZoom clamps to PIXEL_MAX_ZOOM when the workspace is large relative to a small document", () => {
    const zoom = fitZoom(4000, 4000, 32, 32, 0, PIXEL_MIN_ZOOM, PIXEL_MAX_ZOOM);
    expect(zoom).toBe(PIXEL_MAX_ZOOM);
  });

  it("fitZoom for the Public 2048x1152 document behaves like a normal large-canvas fit", () => {
    const zoom = fitZoom(4096, 2304, PUBLIC_PIXEL_WIDTH, PUBLIC_PIXEL_HEIGHT, 0, PIXEL_MIN_ZOOM, PIXEL_MAX_ZOOM);
    expect(zoom).toBe(2); // the limiting axis is width: 4096/2048 = 2, height 2304/1152 = 2 too
  });

  it("clampZoom and stepZoom work unchanged with the pixel range/levels", () => {
    expect(clampZoom(100, PIXEL_MIN_ZOOM, PIXEL_MAX_ZOOM)).toBe(PIXEL_MAX_ZOOM);
    expect(clampZoom(0, PIXEL_MIN_ZOOM, PIXEL_MAX_ZOOM)).toBe(PIXEL_MIN_ZOOM);
    expect(stepZoom(1, PIXEL_ZOOM_LEVELS, 1)).toBe(2);
    expect(stepZoom(32, PIXEL_ZOOM_LEVELS, 1)).toBe(32); // already at the top
  });
});

// --- Local-pending-gesture bookkeeping (shared with Step 6's SSE reuse) ------

// --- Bounded-region math for the incremental erase-reveal repaint ----------
// (the performance path that avoids a full-history replay on every pointer
// movement for a large, populated document -- see public/pixel-editor.js's
// renderCurrentDelta)

describe("cellBoundsForPoints / boundsIntersect", () => {
  it("computes the exact bounding box of a single point, padded by half the brush size", () => {
    expect(cellBoundsForPoints([{ x: 10, y: 10 }], 4)).toEqual({ minX: 8, minY: 8, maxX: 12, maxY: 12 });
  });

  it("computes the bounding box spanning multiple points", () => {
    expect(cellBoundsForPoints([{ x: 0, y: 5 }, { x: 10, y: 0 }, { x: 3, y: 8 }], 2)).toEqual({
      minX: -1, minY: -1, maxX: 11, maxY: 9,
    });
  });

  it("two overlapping boxes intersect; two disjoint boxes do not", () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const overlapping = { minX: 5, minY: 5, maxX: 15, maxY: 15 };
    const disjoint = { minX: 20, minY: 20, maxX: 30, maxY: 30 };
    expect(boundsIntersect(a, overlapping)).toBe(true);
    expect(boundsIntersect(a, disjoint)).toBe(false);
  });

  it("boxes that merely touch at an edge count as intersecting (inclusive boundary)", () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const touching = { minX: 10, minY: 0, maxX: 20, maxY: 10 };
    expect(boundsIntersect(a, touching)).toBe(true);
  });
});

describe("nextSyntheticSeq / buildRenderOps / removePendingOp", () => {
  it("nextSyntheticSeq is one past the highest seq present, or 1 for an empty history", () => {
    expect(nextSyntheticSeq([])).toBe(1);
    expect(nextSyntheticSeq([{ seq: 5 }, { seq: 2 }, { seq: 9 }])).toBe(10);
  });

  it("buildRenderOps returns allOps unchanged when there is no local owner yet, or no pending/current work", () => {
    const allOps = [{ seq: 1 }];
    expect(buildRenderOps(allOps, [], null, null)).toBe(allOps);
    expect(buildRenderOps(allOps, [], null, "owner-A")).toBe(allOps);
  });

  it("buildRenderOps appends pending and current ops stamped with this owner's id and ever-increasing synthetic seqs after the authoritative history", () => {
    const allOps = [{ seq: 1, ownerId: "owner-B" }, { seq: 4, ownerId: "owner-C" }];
    const pending = [{ kind: "draw", points: [{ x: 1, y: 1 }] }];
    const current = { kind: "draw", points: [{ x: 2, y: 2 }] };
    const combined = buildRenderOps(allOps, pending, current, "owner-A");

    expect(combined.slice(0, 2)).toEqual(allOps); // authoritative history is untouched and comes first
    expect(combined).toHaveLength(4);
    expect(combined[2]).toMatchObject({ ownerId: "owner-A", points: [{ x: 1, y: 1 }] });
    expect(combined[3]).toMatchObject({ ownerId: "owner-A", points: [{ x: 2, y: 2 }] });
    expect(combined[2].seq).toBeGreaterThan(4); // sorts after every real op
    expect(combined[3].seq).toBeGreaterThan(combined[2].seq); // current is always "later" than any already-finished pending gesture
  });

  it("buildRenderOps never mutates its inputs", () => {
    const allOps = [{ seq: 1 }];
    const pending = [{ kind: "draw", points: [] }];
    const current = { kind: "erase", points: [] };
    const beforeAll = JSON.stringify(allOps);
    const beforePending = JSON.stringify(pending);
    buildRenderOps(allOps, pending, current, "owner-A");
    expect(JSON.stringify(allOps)).toBe(beforeAll);
    expect(JSON.stringify(pending)).toBe(beforePending);
  });

  it("removePendingOp removes exactly the given gesture by identity, leaving others untouched", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    expect(removePendingOp([a, b, c], b)).toEqual([a, c]);
    expect(removePendingOp([a, b, c], { id: "b" })).toEqual([a, b, c]); // a different object, even with equal content, is not removed
  });
});
