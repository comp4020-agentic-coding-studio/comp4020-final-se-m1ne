// Shape geometry shared by the live preview, the committed local render, remote
// replay and refresh replay -- the single place a shape's outline is computed,
// so none of them can disagree.
//
// A shape op stores only its two defining corner points in document pixels
// (the drag's anchor and its final pointer position, in that order) plus
// {type, mode}. Everything else -- the Shift constraint, the triangle's
// apex -- is derived here from those two points, so the same op renders
// identically everywhere.

export const SHAPE_TYPES = ["line", "rectangle", "ellipse", "triangle"];
export const SHAPE_MODES = ["outline", "filled"];

const SQRT3_OVER_2 = Math.sqrt(3) / 2;

// A drag shorter than this (in document pixels) is a click, not a shape -- it
// must not create an accidental one.
export const MIN_SHAPE_DRAG_PX = 3;

// Whether corners a (anchor) and b (final, already constrained) describe a real
// shape. A line needs length; every other shape needs a non-degenerate
// bounding box as well, so a perfectly horizontal drag cannot commit an
// invisible zero-height rectangle/ellipse/triangle.
export function isMeaningfulShape(type, a, b) {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  if (Math.hypot(dx, dy) < MIN_SHAPE_DRAG_PX) return false;
  return type === "line" || (dx >= 1 && dy >= 1);
}

// The constrained opposite corner for a Shift-drag from `anchor` to `pointer`,
// in the same quadrant as the drag. Fits inside the dragged region (uses the
// smaller extent) so the constrained shape never exceeds what was dragged.
//   rectangle / ellipse: equal width and height (square / circle).
//   triangle: height = width * sqrt(3)/2 (equilateral), the width being the
//             base; fits when both the width and the derived height fit.
//   line: never constrained.
export function constrainCorner(type, anchor, pointer, shift) {
  if (!shift || type === "line") return { x: pointer.x, y: pointer.y };
  const dx = pointer.x - anchor.x;
  const dy = pointer.y - anchor.y;
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  const w = Math.abs(dx);
  const h = Math.abs(dy);
  if (type === "triangle") {
    // Largest equilateral triangle whose base is <= w and height <= h.
    const base = Math.min(w, h / SQRT3_OVER_2);
    return { x: anchor.x + sx * base, y: anchor.y + sy * base * SQRT3_OVER_2 };
  }
  const side = Math.min(w, h);
  return { x: anchor.x + sx * side, y: anchor.y + sy * side };
}

// Normalised bounding rectangle of the two corners.
export function boundsOf(a, b) {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return { left, top, right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

// The triangle's three vertices for corners a (anchor) and b (opposite
// corner). The base spans the bounding region's width along the edge at the
// anchor's y; the apex is centred horizontally on the opposite horizontal
// edge. Dragging away from the anchor vertically therefore points the apex
// that way: down-drag -> apex at the bottom, up-drag -> apex at the top.
//   Reading the spec literally: "base spans the bounding region's width and
//   whose apex is centred horizontally at the opposite vertical edge", and
//   "drag direction determines whether the triangle points upward or
//   downward". Pointer-down is the anchor, so the base lies on the anchor's
//   horizontal edge and the apex on the far one: dragging downward (b.y >
//   a.y) puts the base on top and the apex at the bottom (pointing down);
//   dragging upward puts the base at the bottom and the apex on top
//   (pointing up).
export function triangleVertices(a, b) {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const midX = (left + right) / 2;
  return [
    { x: left, y: a.y },
    { x: right, y: a.y },
    { x: midX, y: b.y },
  ];
}

// Builds the canvas path for a shape into ctx (no stroke/fill call). Points are
// document pixels.
export function traceShapePath(ctx, type, a, b) {
  ctx.beginPath();
  if (type === "line") {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    return;
  }
  if (type === "rectangle") {
    const r = boundsOf(a, b);
    ctx.rect(r.left, r.top, r.width, r.height);
    return;
  }
  if (type === "ellipse") {
    const r = boundsOf(a, b);
    ctx.ellipse((r.left + r.right) / 2, (r.top + r.bottom) / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2);
    return;
  }
  const [p0, p1, p2] = triangleVertices(a, b);
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.closePath();
}

// Draws one shape onto ctx. `a`/`b` are the (already-constrained) corners in
// document pixels. Lines and outlines stroke with lineWidth; filled shapes are
// filled with the same colour and no separate outline.
export function paintShape(ctx, { type, mode, color, lineWidth }, a, b) {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  traceShapePath(ctx, type, a, b);
  if (type !== "line" && mode === "filled") {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }
  ctx.restore();
}

// Axis-aligned pixel bounds of a shape (for dirty-region repaint and the
// off-screen culling in repaintVisibleCanvas), padded for the stroke.
export function shapePixelBounds(type, mode, a, b, lineWidth) {
  const r = boundsOf(a, b);
  const pad = type !== "line" && mode === "filled" ? 2 : lineWidth / 2 + 2;
  return { x: r.left - pad, y: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

// Server-side/shared validation of a shape descriptor.
export function isValidShapeDescriptor(shape) {
  if (!shape || typeof shape !== "object") return false;
  if (!SHAPE_TYPES.includes(shape.type)) return false;
  if (shape.type === "line") return shape.mode === undefined || shape.mode === "outline";
  return SHAPE_MODES.includes(shape.mode);
}
