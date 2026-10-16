// Pure flood-fill logic (public/floodfill.js): enclosed / empty / four-connected regions, bounds, validation,
// and that a very large fill is iterative and bounded (no recursion, one byte per pixel + a small stack).

import { describe, expect, it } from "vitest";
import { floodFillRuns, fillRunsBounds, isValidFillRuns, MAX_FILL_RUNS } from "../public/floodfill.js";

const W = 20;
const H = 12;
function blank(w = W, h = H) {
  return new Uint8ClampedArray(w * h * 4); // fully transparent
}
function setPx(data: Uint8ClampedArray, w: number, x: number, y: number, rgba = [0, 0, 0, 255]) {
  data.set(rgba, (y * w + x) * 4);
}
function filledSet(runs: number[]) {
  const set = new Set<string>();
  for (let i = 0; i < runs.length; i += 3) for (let k = 0; k < runs[i + 2]; k++) set.add(`${runs[i + 1] + k},${runs[i]}`);
  return set;
}

describe("floodFillRuns", () => {
  it("fills the whole empty layer when nothing bounds it", () => {
    const runs = floodFillRuns(blank(), W, H, 3, 3)!;
    expect(filledSet(runs).size).toBe(W * H);
  });

  it("fills only an enclosed region and stops at its wall", () => {
    const data = blank();
    for (let x = 4; x <= 12; x++) { setPx(data, W, x, 2); setPx(data, W, x, 8); }
    for (let y = 2; y <= 8; y++) { setPx(data, W, 4, y); setPx(data, W, 12, y); }
    const inside = filledSet(floodFillRuns(data, W, H, 8, 5)!);
    expect(inside.size).toBe(7 * 5); // 7x5 interior, walls excluded
    expect(inside.has("8,5")).toBe(true);
    expect(inside.has("4,5")).toBe(false); // the wall
    expect(inside.has("2,5")).toBe(false); // outside the box
  });

  it("is four-connected: a diagonal gap in a wall does not leak", () => {
    const data = blank(6, 6);
    // diagonal wall from (0,5) to (5,0): pixels touch only at corners
    for (let i = 0; i < 6; i++) setPx(data, 6, i, 5 - i);
    const upperLeft = filledSet(floodFillRuns(data, 6, 6, 0, 0)!);
    expect(upperLeft.has("5,5")).toBe(false);
    expect(upperLeft.has("0,0")).toBe(true);
    expect(upperLeft.size).toBe(15); // triangle above the diagonal: 5+4+3+2+1
  });

  it("is not a global colour replacement: a separate region of the same colour is untouched", () => {
    const data = blank();
    for (let y = 0; y < H; y++) setPx(data, W, 10, y); // vertical wall splits the layer in two
    const left = filledSet(floodFillRuns(data, W, H, 2, 2)!);
    expect(left.has("15,5")).toBe(false);
    expect(left.size).toBe(10 * H);
  });

  it("filling a solid-coloured region replaces just that region", () => {
    const data = blank();
    for (let y = 0; y < H; y++) for (let x = 0; x < 8; x++) setPx(data, W, x, y, [255, 0, 0, 255]);
    const red = filledSet(floodFillRuns(data, W, H, 1, 1)!);
    expect(red.size).toBe(8 * H);
    expect(red.has("9,1")).toBe(false);
  });

  it("returns nothing for a seed outside the document", () => {
    expect(floodFillRuns(blank(), W, H, -1, 0)).toEqual([]);
    expect(floodFillRuns(blank(), W, H, W, 0)).toEqual([]);
  });

  it("stays inside the document bounds", () => {
    const runs = floodFillRuns(blank(), W, H, 0, 0)!;
    const b = fillRunsBounds(runs)!;
    expect(b).toEqual({ minX: 0, minY: 0, maxX: W, maxY: H });
  });

  it("fills a full 1920x1080 empty layer iteratively (no recursion) with one span per row", () => {
    const w = 1920, h = 1080;
    const data = new Uint8ClampedArray(w * h * 4);
    const t = performance.now();
    const runs = floodFillRuns(data, w, h, 960, 540)!;
    const ms = performance.now() - t;
    expect(runs.length / 3).toBe(h); // spans, not 2 million pixels
    expect(runs.length).toBeLessThan(MAX_FILL_RUNS * 3);
    expect(ms).toBeLessThan(2000);
  });

  it("a worst-case fragmented region is refused (null) once it needs more spans than the cap", () => {
    const w = 400, h = 400;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x % 2 === 1 && y % 2 === 0) data.set([0, 0, 0, 255], (y * w + x) * 4);
    // checker-ish walls: far more than 60 spans is easy; use a tiny cap to prove the guard
    expect(floodFillRuns(data, w, h, 0, 1, 32, 50)).toBeNull();
  });
});

describe("isValidFillRuns", () => {
  it("accepts well-formed spans and rejects malformed or out-of-document ones", () => {
    expect(isValidFillRuns([0, 0, 5], 10, 10)).toBe(true);
    expect(isValidFillRuns([], 10, 10)).toBe(false);
    expect(isValidFillRuns([0, 0], 10, 10)).toBe(false);
    expect(isValidFillRuns([0, 8, 5], 10, 10)).toBe(false); // runs off the right edge
    expect(isValidFillRuns([10, 0, 1], 10, 10)).toBe(false); // row outside
    expect(isValidFillRuns([0, 0, 0], 10, 10)).toBe(false); // empty span
    expect(isValidFillRuns([0.5, 0, 1], 10, 10)).toBe(false);
    expect(isValidFillRuns(Array(3 * (MAX_FILL_RUNS + 1)).fill(0), 10, 10)).toBe(false);
  });
});
