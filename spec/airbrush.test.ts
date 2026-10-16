// Pure Airbrush raster math (public/airbrush.js): radial falloff, gap-free continuous strokes, one consistent
// opacity along a single pass (including corners and overlaps), determinism, windowed == full, and clamping.

import { describe, expect, it } from "vitest";
import { airbrushAlpha, airbrushFalloff } from "../public/airbrush.js";

const W = 1920;
const H = 1080;
const D = 40; // brush diameter in px
const SIZE = D / W;
const at = (buf: { x: number; y: number; w: number; alpha: Uint8Array }, x: number, y: number) => buf.alpha[(y - buf.y) * buf.w + (x - buf.x)];
const pt = (x: number, y: number) => ({ x: x / W, y: y / H });

describe("airbrushFalloff", () => {
  it("is 1 at the centre, 0 at and beyond the edge, and strictly decreasing in between", () => {
    expect(airbrushFalloff(0)).toBe(1);
    expect(airbrushFalloff(1)).toBe(0);
    expect(airbrushFalloff(1.5)).toBe(0);
    expect(airbrushFalloff(-1)).toBe(1);
    let prev = 1;
    for (let t = 0.05; t < 1; t += 0.05) {
      const v = airbrushFalloff(t);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
    expect(airbrushFalloff(0.5)).toBeCloseTo(0.5, 5); // smoothstep symmetry
  });

  it("is smooth at both ends (near-zero slope), so there is no hard rim and no flat-topped blob", () => {
    expect(1 - airbrushFalloff(0.02)).toBeLessThan(0.002);
    expect(airbrushFalloff(0.98)).toBeLessThan(0.002);
  });
});

describe("single stamp: soft radial alpha", () => {
  const buf = airbrushAlpha([pt(960, 540)], SIZE, W, H)!;

  it("has maximum alpha at the centre and fades monotonically to 0 at the edge along every direction", () => {
    const cx = 960, cy = 540;
    expect(at(buf, cx, cy)).toBeGreaterThanOrEqual(250);
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [0.7071, 0.7071]]) {
      let prev = 256;
      for (let k = 0; k <= D / 2 + 1; k++) {
        const x = Math.round(cx + dx * k), y = Math.round(cy + dy * k);
        if (x < buf.x || y < buf.y || x >= buf.x + buf.w || y >= buf.y + buf.h) {
          expect(k).toBeGreaterThan(D / 2 - 1);
          break;
        }
        const v = at(buf, x, y);
        expect(v).toBeLessThanOrEqual(prev + 1); // 1 level of slack for rounding on the diagonal
        prev = v;
      }
      expect(prev).toBeLessThanOrEqual(8); // essentially transparent at the rim
    }
  });

  it("the diameter is the full brush size: nothing is painted farther than size/2 from the centre", () => {
    const cx = 960, cy = 540; // the stamp is centred exactly on this document point
    for (let y = buf.y; y < buf.y + buf.h; y++)
      for (let x = buf.x; x < buf.x + buf.w; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d >= D / 2) expect(at(buf, x, y)).toBe(0);
      }
  });

  it("is circular: equal-distance pixels in every direction get (nearly) the same alpha, no square corners", () => {
    // pixel centres sit at +0.5, so the stamp (centred on the corner 960,540) is symmetric about pixels 959|960 and 539|540
    const r = [at(buf, 969, 539), at(buf, 950, 539), at(buf, 959, 549), at(buf, 959, 530)];
    expect(Math.max(...r) - Math.min(...r)).toBeLessThanOrEqual(1);
    expect(at(buf, buf.x, buf.y)).toBe(0); // the bounding-box corner is outside the circle
    expect(at(buf, buf.x + buf.w - 1, buf.y + buf.h - 1)).toBe(0);
  });

  it("is deterministic: the same input always produces the identical buffer", () => {
    const again = airbrushAlpha([pt(960, 540)].map((p) => ({ ...p })), SIZE, W, H)!;
    expect(Array.from(again.alpha)).toEqual(Array.from(buf.alpha));
  });
});

describe("a stroke: continuous, with one consistent opacity", () => {
  // A straight horizontal drag sampled sparsely (a fast mouse): samples 30px apart, far more than the radius gaps.
  const sparse = [pt(400, 500), pt(430, 500), pt(460, 500), pt(520, 500), pt(580, 500)];
  const stroke = airbrushAlpha(sparse, SIZE, W, H)!;

  it("has no gaps between samples: the centre line is at full strength the whole way", () => {
    for (let x = 400; x <= 580; x++) expect(at(stroke, x, 500)).toBeGreaterThanOrEqual(245);
  });

  it("the cross-section is identical everywhere along a straight pass (no beads where samples overlap)", () => {
    const profile = (x: number) => Array.from({ length: 41 }, (_, i) => at(stroke, x, 480 + i)).join();
    const ref = profile(450);
    for (const x of [410, 425, 431, 470, 500, 530, 560]) expect(profile(x), `x=${x}`).toBe(ref);
  });

  it("overlapping stamps never accumulate: the maximum alpha of the whole stroke stays at the single-stamp maximum", () => {
    const single = airbrushAlpha([pt(500.5, 500.5)], SIZE, W, H)!; // centred on a pixel centre: the true full-strength maximum
    expect(Math.max(...single.alpha)).toBe(255);
    expect(Math.max(...stroke.alpha)).toBe(255);
    // a dense scribble on the same spot still cannot exceed a single stamp's maximum
    const scribble = Array.from({ length: 200 }, (_, i) => pt(500 + (i % 5), 500 + (i % 3)));
    const dense = airbrushAlpha(scribble, SIZE, W, H)!;
    expect(Math.max(...dense.alpha)).toBe(255);
    // duplicating every sample 50x (200 overlapping stamps) must not change a single pixel: alpha is a max, never a sum
    const path = [pt(500, 500), pt(540, 520), pt(580, 500)];
    const once = airbrushAlpha(path, SIZE, W, H)!;
    const many = airbrushAlpha(path.flatMap((p) => Array(50).fill(p)), SIZE, W, H)!;
    expect(Array.from(many.alpha)).toEqual(Array.from(once.alpha));
  });

  it("a corner is not darker or blobbier on the inside than the straight parts", () => {
    const corner = airbrushAlpha([pt(600, 600), pt(700, 600), pt(700, 700)], SIZE, W, H)!;
    const straight = airbrushAlpha([pt(600, 600), pt(700, 600)], SIZE, W, H)!;
    expect(Math.max(...corner.alpha)).toBe(Math.max(...straight.alpha));
    // inside of the turn (up-left of the apex region is on the other side; the inner diagonal point):
    const inner = at(corner, 690, 610);
    const sameDistanceOnStraight = at(straight, 690, 610);
    expect(inner).toBeGreaterThanOrEqual(sameDistanceOnStraight); // nearer to the second leg, so at least as strong
    expect(inner).toBeLessThanOrEqual(255);
  });

  it("a diagonal stroke is gap-free too (distance to a segment is continuous)", () => {
    const diag = airbrushAlpha([pt(300, 300), pt(900, 700)], SIZE, W, H)!;
    for (let i = 0; i <= 100; i++) {
      const x = Math.round(300 + (600 * i) / 100), y = Math.round(300 + (400 * i) / 100);
      expect(at(diag, x, y)).toBeGreaterThanOrEqual(240);
    }
  });

  it("travelling the same path in the other direction paints exactly the same pixels", () => {
    const fwd = airbrushAlpha(sparse, SIZE, W, H)!;
    const back = airbrushAlpha([...sparse].reverse(), SIZE, W, H)!;
    expect(Array.from(back.alpha)).toEqual(Array.from(fwd.alpha));
  });
});

describe("regions, zoom independence and bounds", () => {
  const points = [pt(400, 500), pt(450, 520), pt(520, 480), pt(580, 520)];

  it("a windowed computation matches the full one on every pixel of the window (regional repaint == full repaint)", () => {
    const full = airbrushAlpha(points, SIZE, W, H)!;
    const win = airbrushAlpha(points, SIZE, W, H, { x: 430, y: 490, w: 90, h: 40 })!;
    for (let y = win.y; y < win.y + win.h; y++) for (let x = win.x; x < win.x + win.w; x++) expect(at(win, x, y)).toBe(at(full, x, y));
  });

  it("works with the {x,y,width,height} regions the compositor passes", () => {
    const full = airbrushAlpha(points, SIZE, W, H)!;
    const win = airbrushAlpha(points, SIZE, W, H, { x: 430, y: 490, width: 90, height: 40 })!;
    expect(at(win, 450, 510)).toBe(at(full, 450, 510));
  });

  it("depends only on document-normalised points and size, never on the on-screen zoom (soft edge is identical at any zoom)", () => {
    // there is no zoom parameter at all: two calls are the same by construction, and equal after a JSON round trip
    const a = airbrushAlpha(points, SIZE, W, H)!;
    const b = airbrushAlpha(JSON.parse(JSON.stringify(points)), SIZE, W, H)!;
    expect(Array.from(b.alpha)).toEqual(Array.from(a.alpha));
  });

  it("is clamped to the document: a stroke at or beyond the edge never writes out of bounds", () => {
    const edge = airbrushAlpha([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1.2, y: 1.2 }], SIZE, W, H)!;
    expect(edge.x).toBeGreaterThanOrEqual(0);
    expect(edge.y).toBeGreaterThanOrEqual(0);
    expect(edge.x + edge.w).toBeLessThanOrEqual(W);
    expect(edge.y + edge.h).toBeLessThanOrEqual(H);
    expect(airbrushAlpha([{ x: 5, y: 5 }], SIZE, W, H)).toBeNull(); // wholly off-document
  });

  it("a tiny brush still paints (minimum 1px radius) and an empty path paints nothing", () => {
    const tiny = airbrushAlpha([pt(100, 100)], 1 / W, W, H)!;
    expect(Math.max(...tiny.alpha)).toBeGreaterThan(0);
    expect(airbrushAlpha([], SIZE, W, H)).toBeNull();
  });
});
