// Airbrush (soft-edge brush) -- pure raster math plus one paint helper, shared by public/app.js and
// public/landing-canvas.js. A stroke is stored as a normal 'draw' op with shape {type: "airbrush"}, the brush
// size as its full diameter, and the freehand points -- nothing else. Rendering is a deterministic function of
// (points, size, colour), so a live stroke, a replay, a refresh and another client all produce the same pixels.
//
// Alpha of a pixel = falloff(distance from the pixel centre to the stroke's polyline / radius). It is the MAX over
// the path, never a sum of stamps, so a single pass has one consistent opacity: no dark beads where samples
// overlap, no dark spot inside a corner, no gaps between samples (distance to a segment is continuous).
import { hexToRgb } from "./colour.js";

export const AIRBRUSH_SHAPE = Object.freeze({ type: "airbrush" });

// 1 at the centre, 0 at the edge, smooth (zero slope at both ends): 1 - smoothstep(t).
export function airbrushFalloff(t) {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - t * t * (3 - 2 * t);
}

const MIN_RADIUS_PX = 1; // a 1px "diameter" brush would otherwise miss pixel centres entirely

function radiusPx(sizeNormalized, docW) {
  return Math.max(MIN_RADIUS_PX, (sizeNormalized * docW) / 2);
}

function intersect(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// Pixel box the stroke can touch (path bounds grown by the radius), clamped to the document.
function strokeBox(points, r, docW, docH) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    const x = p.x * docW, y = p.y * docH;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const x0 = Math.max(0, Math.floor(minX - r));
  const y0 = Math.max(0, Math.floor(minY - r));
  const x1 = Math.min(docW, Math.ceil(maxX + r) + 1);
  const y1 = Math.min(docH, Math.ceil(maxY + r) + 1);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function rasterize(points, r, docW, docH, area) {
  const alpha = new Uint8Array(area.w * area.h);
  const r2 = r * r;
  const n = points.length;
  for (let s = 0; s < (n === 1 ? 1 : n - 1); s++) {
    const a = points[s], b = points[n === 1 ? 0 : s + 1];
    const ax = a.x * docW, ay = a.y * docH, bx = b.x * docW, by = b.y * docH;
    const sx0 = Math.max(area.x, Math.floor(Math.min(ax, bx) - r));
    const sy0 = Math.max(area.y, Math.floor(Math.min(ay, by) - r));
    const sx1 = Math.min(area.x + area.w, Math.ceil(Math.max(ax, bx) + r) + 1);
    const sy1 = Math.min(area.y + area.h, Math.ceil(Math.max(ay, by) + r) + 1);
    if (sx1 <= sx0 || sy1 <= sy0) continue;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let py = sy0; py < sy1; py++) {
      const cy = py + 0.5;
      for (let px = sx0; px < sx1; px++) {
        const cx = px + 0.5;
        let t = len2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = cx - (ax + t * dx), qy = cy - (ay + t * dy);
        const d2 = qx * qx + qy * qy;
        if (d2 >= r2) continue;
        const v = Math.round(255 * airbrushFalloff(Math.sqrt(d2) / r));
        const i = (py - area.y) * area.w + (px - area.x);
        if (v > alpha[i]) alpha[i] = v;
      }
    }
  }
  return { x: area.x, y: area.y, w: area.w, h: area.h, alpha };
}

function crop(buf, win) {
  const area = intersect(buf, win);
  if (!area) return null;
  const alpha = new Uint8Array(area.w * area.h);
  for (let row = 0; row < area.h; row++) {
    const from = (area.y - buf.y + row) * buf.w + (area.x - buf.x);
    alpha.set(buf.alpha.subarray(from, from + area.w), row * area.w);
  }
  return { x: area.x, y: area.y, w: area.w, h: area.h, alpha };
}

// Full-stroke alpha buffers, cached per points array (committed ops never change their points) under a fixed byte
// budget so a canvas full of large strokes cannot grow memory without bound: oldest entries are evicted first.
// A growing live stroke has a different length every frame, so its entry is simply stale and recomputed, never reused.
const CACHE_BUDGET_BYTES = 48 * 1024 * 1024;
const cache = new Map();
let cacheBytes = 0;

function remember(points, entry) {
  const old = cache.get(points);
  if (old) {
    cacheBytes -= old.buf.alpha.length;
    cache.delete(points);
  }
  cache.set(points, entry);
  cacheBytes += entry.buf.alpha.length;
  for (const [key, e] of cache) {
    if (cacheBytes <= CACHE_BUDGET_BYTES || key === points) break;
    cache.delete(key);
    cacheBytes -= e.buf.alpha.length;
  }
}

// The stroke's alpha {x, y, w, h, alpha: Uint8Array(w*h)} in document pixels, or null if it touches nothing.
// `win` ({x, y, w, h} or {x, y, width, height}, document pixels) limits the computation to that window -- the
// result for any pixel is the same either way, so regional and full repaints agree. Points are
// document-normalised, like every other op.
/** @param {{x: number, y: number, w?: number, h?: number, width?: number, height?: number} | null} [win] */
export function airbrushAlpha(points, sizeNormalized, docW, docH, win = null) {
  if (!points || points.length === 0) return null;
  const window = win ? { x: win.x, y: win.y, w: win.w ?? win.width, h: win.h ?? win.height } : null;
  const r = radiusPx(sizeNormalized, docW);
  const hit = cache.get(points);
  if (hit && hit.n === points.length && hit.r === r && hit.docW === docW && hit.docH === docH) {
    return window ? crop(hit.buf, window) : hit.buf;
  }
  const box = strokeBox(points, r, docW, docH);
  if (!box) return null;
  const area = window ? intersect(box, window) : box;
  if (!area) return null;
  const buf = rasterize(points, r, docW, docH, area);
  if (!window) remember(points, { n: points.length, r, docW, docH, buf });
  return buf;
}

let tmp = null;

// Paints the stroke onto ctx (source-over, respecting ctx.globalAlpha and transform). part === "mask" paints the
// stroke's hard footprint instead (every touched pixel fully opaque): that is what an owner's layer mask holds, so
// masking a soft stroke by it (destination-in) leaves the soft alpha intact and an erase still removes pixels.
/** @param {{x: number, y: number, w?: number, h?: number, width?: number, height?: number} | null} [win] */
export function paintAirbrush(ctx, color, sizeNormalized, points, docW, docH, part, win = null) {
  const buf = airbrushAlpha(points, sizeNormalized, docW, docH, win);
  if (!buf) return;
  const mask = part === "mask";
  const rgb = mask ? { r: 0, g: 0, b: 0 } : (hexToRgb(color) ?? { r: 0, g: 0, b: 0 });
  if (!tmp) tmp = document.createElement("canvas");
  tmp.width = buf.w;
  tmp.height = buf.h;
  const tctx = tmp.getContext("2d");
  const image = tctx.createImageData(buf.w, buf.h);
  const d = image.data;
  for (let i = 0, o = 0; i < buf.alpha.length; i++, o += 4) {
    const a = buf.alpha[i];
    d[o] = rgb.r;
    d[o + 1] = rgb.g;
    d[o + 2] = rgb.b;
    d[o + 3] = mask ? (a > 0 ? 255 : 0) : a;
  }
  tctx.putImageData(image, 0, 0);
  ctx.drawImage(tmp, buf.x, buf.y);
}
