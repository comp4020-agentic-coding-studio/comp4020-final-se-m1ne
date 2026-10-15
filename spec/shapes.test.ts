// Pure geometry for the shape tools (public/shapes.js): the Shift constraints,
// drag directions, the triangle vertex rule, the degenerate-drag guard and
// descriptor validation. No DOM or server -- this is the one calculation the
// live preview, the committed op and remote/refresh replay all share.

import { describe, expect, it, vi } from "vitest";
import {
  boundsOf,
  constrainCorner,
  isMeaningfulShape,
  isValidShapeDescriptor,
  paintShape,
  shapePixelBounds,
  triangleVertices,
} from "../public/shapes.js";

const SQRT3_2 = Math.sqrt(3) / 2;
const anchor = { x: 500, y: 400 };

// All four drag quadrants, as signed offsets from the anchor.
const QUADRANTS: Array<[string, number, number]> = [
  ["down-right", 1, 1],
  ["down-left", -1, 1],
  ["up-right", 1, -1],
  ["up-left", -1, -1],
];

describe("constrainCorner: no Shift", () => {
  it("returns the raw pointer unchanged for every shape and direction", () => {
    for (const type of ["line", "rectangle", "ellipse", "triangle"]) {
      for (const [, sx, sy] of QUADRANTS) {
        const p = { x: anchor.x + sx * 200, y: anchor.y + sy * 90 };
        expect(constrainCorner(type, anchor, p, false)).toEqual(p);
      }
    }
  });

  it("never constrains a line, even with Shift (no angle snapping in this phase)", () => {
    const p = { x: 731, y: 412 };
    expect(constrainCorner("line", anchor, p, true)).toEqual(p);
  });
});

describe("constrainCorner: Shift on rectangle/ellipse makes a square/circle", () => {
  for (const type of ["rectangle", "ellipse"]) {
    for (const [name, sx, sy] of QUADRANTS) {
      it(`${type} ${name}: equal width and height, anchored, same direction, fits the dragged region`, () => {
        const p = { x: anchor.x + sx * 240, y: anchor.y + sy * 100 };
        const c = constrainCorner(type, anchor, p, true);
        const w = Math.abs(c.x - anchor.x);
        const h = Math.abs(c.y - anchor.y);
        expect(w).toBeCloseTo(h, 9);
        expect(w).toBeCloseTo(100, 9); // the smaller dragged extent
        expect(Math.sign(c.x - anchor.x)).toBe(sx);
        expect(Math.sign(c.y - anchor.y)).toBe(sy);
        expect(w).toBeLessThanOrEqual(240);
      });
    }
  }

  it("uses whichever drag extent is smaller (tall drag)", () => {
    const c = constrainCorner("rectangle", anchor, { x: anchor.x + 60, y: anchor.y + 300 }, true);
    expect(Math.abs(c.x - anchor.x)).toBeCloseTo(60, 9);
    expect(Math.abs(c.y - anchor.y)).toBeCloseTo(60, 9);
  });
});

describe("constrainCorner: Shift on triangle makes it equilateral", () => {
  for (const [name, sx, sy] of QUADRANTS) {
    it(`triangle ${name}: height = base * sqrt(3)/2 (not equal width/height), fits the dragged region`, () => {
      const dragW = 260;
      const dragH = 300; // plenty of height, so width is the binding limit
      const p = { x: anchor.x + sx * dragW, y: anchor.y + sy * dragH };
      const c = constrainCorner("triangle", anchor, p, true);
      const base = Math.abs(c.x - anchor.x);
      const height = Math.abs(c.y - anchor.y);
      expect(height).toBeCloseTo(base * SQRT3_2, 9);
      expect(height).not.toBeCloseTo(base, 3); // explicitly NOT a square bounding box
      expect(base).toBeCloseTo(dragW, 9);
      expect(Math.sign(c.x - anchor.x)).toBe(sx);
      expect(Math.sign(c.y - anchor.y)).toBe(sy);
      expect(height).toBeLessThanOrEqual(dragH);
    });
  }

  it("when the drag is short and wide, height is the binding limit and the triangle still fits", () => {
    const p = { x: anchor.x + 500, y: anchor.y + 100 };
    const c = constrainCorner("triangle", anchor, p, true);
    const base = Math.abs(c.x - anchor.x);
    const height = Math.abs(c.y - anchor.y);
    expect(height).toBeCloseTo(100, 9);
    expect(height).toBeCloseTo(base * SQRT3_2, 9);
    expect(base).toBeLessThanOrEqual(500);
  });

  it("the three vertices are mutually equidistant (a true equilateral triangle)", () => {
    for (const [, sx, sy] of QUADRANTS) {
      const c = constrainCorner("triangle", anchor, { x: anchor.x + sx * 300, y: anchor.y + sy * 400 }, true);
      const [p0, p1, p2] = triangleVertices(anchor, c);
      const d01 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const d20 = Math.hypot(p0.x - p2.x, p0.y - p2.y);
      expect(d12).toBeCloseTo(d01, 8);
      expect(d20).toBeCloseTo(d01, 8);
    }
  });
});

describe("triangleVertices: isosceles triangle in the dragged bounding region", () => {
  it("base spans the full width on the anchor's edge; apex is centred on the opposite edge", () => {
    const a = { x: 100, y: 100 };
    const b = { x: 300, y: 260 };
    const [p0, p1, p2] = triangleVertices(a, b);
    expect(p0).toEqual({ x: 100, y: 100 });
    expect(p1).toEqual({ x: 300, y: 100 });
    expect(p2).toEqual({ x: 200, y: 260 });
    expect(Math.hypot(p2.x - p0.x, p2.y - p0.y)).toBeCloseTo(Math.hypot(p2.x - p1.x, p2.y - p1.y), 9); // isosceles
  });

  it("dragging down points the apex down; dragging up points it up", () => {
    const down = triangleVertices({ x: 100, y: 100 }, { x: 200, y: 200 });
    expect(down[2].y).toBeGreaterThan(down[0].y);
    const up = triangleVertices({ x: 100, y: 200 }, { x: 200, y: 100 });
    expect(up[2].y).toBeLessThan(up[0].y);
  });

  it("is the same triangle whether dragged left-to-right or right-to-left (base always spans the width)", () => {
    const ltr = triangleVertices({ x: 100, y: 100 }, { x: 300, y: 250 });
    const rtl = triangleVertices({ x: 300, y: 100 }, { x: 100, y: 250 });
    expect(new Set(ltr.map((p) => `${p.x},${p.y}`))).toEqual(new Set(rtl.map((p) => `${p.x},${p.y}`)));
  });
});

describe("boundsOf: all four drag directions give the same positive-size box", () => {
  it("normalises corners regardless of direction", () => {
    for (const [, sx, sy] of QUADRANTS) {
      const r = boundsOf(anchor, { x: anchor.x + sx * 80, y: anchor.y + sy * 50 });
      expect(r.width).toBe(80);
      expect(r.height).toBe(50);
      expect(r.left).toBe(Math.min(anchor.x, anchor.x + sx * 80));
      expect(r.top).toBe(Math.min(anchor.y, anchor.y + sy * 50));
    }
  });
});

describe("isMeaningfulShape: a click or degenerate drag creates nothing", () => {
  it("rejects a zero-length drag for every shape", () => {
    for (const type of ["line", "rectangle", "ellipse", "triangle"]) {
      expect(isMeaningfulShape(type, anchor, { ...anchor })).toBe(false);
    }
  });

  it("rejects a sub-threshold jitter", () => {
    expect(isMeaningfulShape("line", anchor, { x: anchor.x + 1, y: anchor.y + 1 })).toBe(false);
  });

  it("accepts a real line, including a perfectly horizontal or vertical one", () => {
    expect(isMeaningfulShape("line", anchor, { x: anchor.x + 50, y: anchor.y })).toBe(true);
    expect(isMeaningfulShape("line", anchor, { x: anchor.x, y: anchor.y - 50 })).toBe(true);
  });

  it("rejects an invisible zero-height/width closed shape but accepts a real one", () => {
    for (const type of ["rectangle", "ellipse", "triangle"]) {
      expect(isMeaningfulShape(type, anchor, { x: anchor.x + 80, y: anchor.y })).toBe(false);
      expect(isMeaningfulShape(type, anchor, { x: anchor.x, y: anchor.y + 80 })).toBe(false);
      expect(isMeaningfulShape(type, anchor, { x: anchor.x + 80, y: anchor.y + 60 })).toBe(true);
    }
  });
});

describe("paintShape: Outline strokes, Filled fills, one colour, no extra outline", () => {
  function fakeCtx() {
    return {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
      rect: vi.fn(), ellipse: vi.fn(), stroke: vi.fn(), fill: vi.fn(),
      strokeStyle: "", fillStyle: "", lineWidth: 0, lineCap: "", lineJoin: "", globalCompositeOperation: "",
    };
  }
  const a = { x: 10, y: 10 };
  const b = { x: 110, y: 70 };

  it("outline: strokes the boundary with the colour and width, never fills", () => {
    for (const type of ["rectangle", "ellipse", "triangle"]) {
      const ctx = fakeCtx();
      paintShape(ctx, { type, mode: "outline", color: "#112233", lineWidth: 6 }, a, b);
      expect(ctx.stroke).toHaveBeenCalledTimes(1);
      expect(ctx.fill).not.toHaveBeenCalled();
    }
  });

  it("filled: fills with the one drawing colour and adds no outline", () => {
    for (const type of ["rectangle", "ellipse", "triangle"]) {
      const ctx = fakeCtx();
      let fillColourAtFill = "";
      ctx.fill = vi.fn(() => { fillColourAtFill = ctx.fillStyle; });
      paintShape(ctx, { type, mode: "filled", color: "#abcdef", lineWidth: 6 }, a, b);
      expect(ctx.fill).toHaveBeenCalledTimes(1);
      expect(ctx.stroke).not.toHaveBeenCalled();
      expect(fillColourAtFill).toBe("#abcdef");
    }
  });

  it("a line always strokes, whatever mode it is given", () => {
    const ctx = fakeCtx();
    paintShape(ctx, { type: "line", mode: "filled", color: "#112233", lineWidth: 4 }, a, b);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(ctx.moveTo).toHaveBeenCalledWith(a.x, a.y);
    expect(ctx.lineTo).toHaveBeenCalledWith(b.x, b.y);
  });

  it("traces the triangle through exactly its three vertices", () => {
    const ctx = fakeCtx();
    paintShape(ctx, { type: "triangle", mode: "outline", color: "#000000", lineWidth: 2 }, a, b);
    const [p0, p1, p2] = triangleVertices(a, b);
    expect(ctx.moveTo).toHaveBeenCalledWith(p0.x, p0.y);
    expect(ctx.lineTo).toHaveBeenNthCalledWith(1, p1.x, p1.y);
    expect(ctx.lineTo).toHaveBeenNthCalledWith(2, p2.x, p2.y);
    expect(ctx.closePath).toHaveBeenCalled();
  });
});

describe("shapePixelBounds", () => {
  it("covers the shape plus half the stroke, in every drag direction", () => {
    for (const [, sx, sy] of QUADRANTS) {
      const b = { x: anchor.x + sx * 120, y: anchor.y + sy * 70 };
      const r = shapePixelBounds("rectangle", "outline", anchor, b, 10);
      expect(r.x).toBeLessThanOrEqual(Math.min(anchor.x, b.x) - 5);
      expect(r.y).toBeLessThanOrEqual(Math.min(anchor.y, b.y) - 5);
      expect(r.x + r.width).toBeGreaterThanOrEqual(Math.max(anchor.x, b.x) + 5);
      expect(r.y + r.height).toBeGreaterThanOrEqual(Math.max(anchor.y, b.y) + 5);
    }
  });
});

describe("isValidShapeDescriptor", () => {
  it("accepts the four types with a valid mode (line needs none)", () => {
    expect(isValidShapeDescriptor({ type: "line" })).toBe(true);
    expect(isValidShapeDescriptor({ type: "line", mode: "outline" })).toBe(true);
    for (const type of ["rectangle", "ellipse", "triangle"]) {
      expect(isValidShapeDescriptor({ type, mode: "outline" })).toBe(true);
      expect(isValidShapeDescriptor({ type, mode: "filled" })).toBe(true);
    }
  });

  it("rejects unknown types, missing/unknown modes, a filled line, and non-objects", () => {
    expect(isValidShapeDescriptor({ type: "star", mode: "filled" })).toBe(false);
    expect(isValidShapeDescriptor({ type: "rectangle" })).toBe(false);
    expect(isValidShapeDescriptor({ type: "rectangle", mode: "stripey" })).toBe(false);
    expect(isValidShapeDescriptor({ type: "line", mode: "filled" })).toBe(false);
    for (const bad of [null, undefined, "rectangle", 5, []]) expect(isValidShapeDescriptor(bad)).toBe(false);
  });
});
