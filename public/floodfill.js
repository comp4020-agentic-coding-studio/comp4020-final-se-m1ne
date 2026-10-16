// Paint Bucket (flood fill) -- pure, DOM-free, shared by public/app.js (computing and replaying a fill) and
// server/index.js (validating one). A fill is stored as a normal 'draw' op whose shape descriptor is
//   { type: "fill", runs: [y, x, length, y, x, length, ...] }
// i.e. the exact spans (document pixels) the fill covered at the moment it was made. Storing the computed spans
// instead of "seed + colour" is what makes replay deterministic: re-rendering never re-samples the canvas, so a
// later-modified layer, a Public fade, or a refresh cannot change what an old fill covers.

export const MAX_FILL_RUNS = 60000; // bounds the stored/broadcast size of one fill (~1 MB of JSON at the very worst)
export const FILL_COLOUR_TOLERANCE = 32; // per-channel; absorbs antialiased stroke edges without leaking across a boundary

// Four-connected scanline flood fill over RGBA pixel data (as returned by getImageData). Iterative (no recursion),
// memory is one byte per pixel (visited) plus a stack that holds at most a couple of entries per emitted run.
// Returns the flat runs array, or null if the region needs more than maxRuns spans (too fragmented to store).
export function floodFillRuns(data, width, height, sx, sy, tolerance = FILL_COLOUR_TOLERANCE, maxRuns = MAX_FILL_RUNS) {
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return [];
  const seedIdx = (sy * width + sx) * 4;
  const tr = data[seedIdx], tg = data[seedIdx + 1], tb = data[seedIdx + 2], ta = data[seedIdx + 3];
  const matches = (px) => {
    const i = px * 4;
    const a = data[i + 3];
    if (ta <= 8 && a <= 8) return true; // both effectively transparent: the same "empty" colour
    return (
      Math.abs(data[i] - tr) <= tolerance &&
      Math.abs(data[i + 1] - tg) <= tolerance &&
      Math.abs(data[i + 2] - tb) <= tolerance &&
      Math.abs(a - ta) <= tolerance
    );
  };

  const visited = new Uint8Array(width * height);
  const runs = [];
  const stack = [sx, sy];
  while (stack.length > 0) {
    const y = stack.pop();
    const x = stack.pop();
    const row = y * width;
    if (visited[row + x] || !matches(row + x)) continue;
    let x0 = x;
    while (x0 > 0 && !visited[row + x0 - 1] && matches(row + x0 - 1)) x0--;
    let x1 = x;
    while (x1 < width - 1 && !visited[row + x1 + 1] && matches(row + x1 + 1)) x1++;
    visited.fill(1, row + x0, row + x1 + 1);
    runs.push(y, x0, x1 - x0 + 1);
    if (runs.length / 3 > maxRuns) return null;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let inSpan = false;
      for (let xx = x0; xx <= x1; xx++) {
        const open = !visited[nrow + xx] && matches(nrow + xx);
        if (open && !inSpan) stack.push(xx, ny);
        inSpan = open;
      }
    }
  }
  return runs;
}

// Paints a stored fill's spans onto ctx in one solid colour. Whole-pixel rects: no antialiasing, no transform.
export function paintFill(ctx, color, runs) {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = color;
  for (let i = 0; i < runs.length; i += 3) ctx.fillRect(runs[i + 1], runs[i], runs[i + 2], 1);
  ctx.restore();
}

// Axis-aligned pixel bounds of a stored fill, or null for an empty one.
export function fillRunsBounds(runs) {
  if (runs.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < runs.length; i += 3) {
    const y = runs[i], x = runs[i + 1], end = runs[i + 1] + runs[i + 2];
    if (y < minY) minY = y;
    if (y + 1 > maxY) maxY = y + 1;
    if (x < minX) minX = x;
    if (end > maxX) maxX = end;
  }
  return { minX, minY, maxX, maxY };
}

// Server/shared validation of a stored fill's runs against the document size.
export function isValidFillRuns(runs, width, height, maxRuns = MAX_FILL_RUNS) {
  if (!Array.isArray(runs) || runs.length === 0 || runs.length % 3 !== 0 || runs.length / 3 > maxRuns) return false;
  for (let i = 0; i < runs.length; i += 3) {
    const y = runs[i], x = runs[i + 1], len = runs[i + 2];
    if (!Number.isInteger(y) || !Number.isInteger(x) || !Number.isInteger(len)) return false;
    if (y < 0 || y >= height || x < 0 || len < 1 || x + len > width) return false;
  }
  return true;
}

// --- One-pixel expansion -----------------------------------------------------------------------------------
// The fill is drawn one canvas pixel wider than the region the flood found, so no thin gap is left against
// antialiased outlines. The extra pixels (the "ring": the 8-neighbour morphological dilation of the region
// minus the region itself, clipped to the document) are derived from the stored spans and never stored, so a
// live fill, a server replay, a refresh and another client all produce exactly the same ring. The ring is
// painted BENEATH the layer's other content (see repaintVisibleCanvas), so it can only show through where an
// outline is not fully opaque and never overwrites or thickens an outline.
export const FILL_EXPANSION_PX = 1; // fixed; deliberately not configurable

function mergeIntervals(list) {
  const out = [];
  for (const [a, b] of list) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// The spans (flat [y, x, length, ...]) of the dilation of `runs` by one pixel in every direction (horizontal,
// vertical and diagonal), minus `runs` itself, clipped to width x height.
export function dilateRuns(runs, width, height) {
  const core = new Map(); // row -> merged, sorted [start, end) intervals of the region
  for (let i = 0; i < runs.length; i += 3) {
    const y = runs[i];
    if (!core.has(y)) core.set(y, []);
    core.get(y).push([runs[i + 1], runs[i + 1] + runs[i + 2]]);
  }
  for (const [y, list] of core) core.set(y, mergeIntervals(list.sort((p, q) => p[0] - q[0])));
  if (core.size === 0) return [];
  let minY = Infinity, maxY = -Infinity;
  for (const y of core.keys()) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const out = [];
  for (let y = Math.max(0, minY - 1); y <= Math.min(height - 1, maxY + 1); y++) {
    const grown = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (const [a, b] of core.get(y + dy) ?? []) grown.push([Math.max(0, a - 1), Math.min(width, b + 1)]);
    }
    if (grown.length === 0) continue;
    const own = core.get(y) ?? [];
    for (const [a, b] of mergeIntervals(grown.sort((p, q) => p[0] - q[0]))) {
      let cur = a;
      for (const [oa, ob] of own) {
        if (ob <= cur || oa >= b) continue;
        if (oa > cur) out.push(y, cur, oa - cur);
        cur = Math.max(cur, ob);
      }
      if (cur < b) out.push(y, cur, b - cur);
    }
  }
  return out;
}

// Derived once per op (keyed by its runs array), never serialised with the op.
const ringCache = new WeakMap();
export function fillRingRuns(runs, width, height) {
  let ring = ringCache.get(runs);
  if (!ring) {
    ring = dilateRuns(runs, width, height);
    ringCache.set(runs, ring);
  }
  return ring;
}

// Paints only the expansion ring, in one solid colour (whole-pixel rects, same as paintFill).
export function paintFillRing(ctx, color, runs, width, height) {
  paintFill(ctx, color, fillRingRuns(runs, width, height));
}
