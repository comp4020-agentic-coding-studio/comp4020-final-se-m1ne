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
