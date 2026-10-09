// Pure, DOM-independent helpers for the pixel-art editor's document model:
// deciding which engine a page should boot (the Public pixel wall, a Private
// pixel-art studio, or an untouched legacy freehand room), the zoom range a
// pixel document uses, converting a pointer position into an integer grid
// cell, and the small bits of local-pending-gesture bookkeeping the renderer
// needs. No DOM/canvas/network dependency -- unit-testable the same way
// public/viewport.js/colour.js/fade.js already are, and imported unchanged by
// public/pixel-editor.js rather than re-implemented inline.

import { cssPointToNormalized, documentPointToPixel } from "./viewport.js";

export const PUBLIC_PIXEL_WIDTH = 2048;
export const PUBLIC_PIXEL_HEIGHT = 1152;

// The four Private pixel-art studio resolutions server/index.js accepts.
// Kept in sync by hand -- the same small, deliberate duplication this app
// already has between client and server (e.g. public/app.js's own
// HEARTBEAT_INTERVAL_MS mirrors server/db.js's).
export const PIXEL_RESOLUTIONS = [32, 64, 128, 256];
export const DEFAULT_PIXEL_RESOLUTION = 128;

export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 8;
export const DEFAULT_BRUSH_SIZE = 2;

// public/viewport.js's own MIN_ZOOM/MAX_ZOOM/ZOOM_LEVELS were sized for the
// 1920x1080 freehand document, where 400% is already enormous. A 32x32 pixel
// studio needs the opposite problem solved -- zooming an individual logical
// pixel up to tens of CSS pixels is the normal way to work with pixel art --
// so pixel documents use their own range with the exact same generic
// clampZoom/fitZoom/stepZoom functions (every one of them already takes
// min/max/levels as parameters), never a second zoom implementation.
export const PIXEL_MIN_ZOOM = 1;
export const PIXEL_MAX_ZOOM = 32;
export const PIXEL_ZOOM_LEVELS = [1, 2, 4, 8, 12, 16, 24, 32];

// Decides which editor a page should boot, given the parsed room code (null
// on the Public page) and -- for a room -- that room's own metadata exactly
// as GET /api/rooms/:code already returns it (server/index.js, Step 3):
// {code, kind: "pixel" | "legacy", width, height}. Public is unconditionally
// the pixel wall now (the primary Public experience, Step 5's product
// direction) -- `room` is ignored entirely when roomCode is null, so a
// caller never needs to fetch room metadata just to render Public. A room's
// own `kind` decides the rest: "pixel" gets the pixel editor at that room's
// stored resolution, anything else (including a lookup failure) falls back
// to "legacy" -- the existing, untouched freehand editor, never a crash or a
// silently-reinterpreted document.
export function resolveEditorMode(roomCode, room) {
  if (roomCode === null) {
    return { mode: "pixel", width: PUBLIC_PIXEL_WIDTH, height: PUBLIC_PIXEL_HEIGHT };
  }
  if (room && room.kind === "pixel" && typeof room.width === "number" && typeof room.height === "number") {
    return { mode: "pixel", width: room.width, height: room.height };
  }
  return { mode: "legacy" };
}

export function isValidPixelResolution(value) {
  return PIXEL_RESOLUTIONS.includes(value);
}

// Resolves the resolution to actually send to POST /api/rooms from the
// create-room popover's selected radio value (a string, or undefined if
// somehow none is checked) -- falls back to DEFAULT_PIXEL_RESOLUTION rather
// than sending a missing or invalid value, and never trusts an out-of-range
// one either, even though the server validates independently regardless.
export function resolveRoomCreationResolution(rawValue) {
  const n = Number(rawValue);
  return isValidPixelResolution(n) ? n : DEFAULT_PIXEL_RESOLUTION;
}

export function clampBrushSize(size) {
  const n = Math.round(size);
  if (!Number.isFinite(n)) return DEFAULT_BRUSH_SIZE;
  return Math.min(MAX_BRUSH_SIZE, Math.max(MIN_BRUSH_SIZE, n));
}

// Client (CSS pixel) pointer position -> the integer grid cell it falls in,
// for a document of the given width/height. Reuses viewport.js's own
// cssPointToNormalized/documentPointToPixel unchanged (both already take an
// arbitrary document size as a parameter, zoom/pan-independent) rather than
// re-deriving the same rect math a second time; this adds only the
// floor-and-clamp-to-a-valid-cell step a continuous freehand point never
// needed. Clamping (not just flooring) means a pointer at the exact edge of
// the canvas's own CSS box -- where documentPointToPixel can land exactly on
// width/height -- still resolves to the last valid column/row instead of one
// cell past it.
export function cellFromClientPoint(clientX, clientY, rect, width, height) {
  const normalized = cssPointToNormalized(clientX, clientY, rect);
  const pixel = documentPointToPixel(normalized, width, height);
  return {
    x: Math.min(width - 1, Math.max(0, Math.floor(pixel.x))),
    y: Math.min(height - 1, Math.max(0, Math.floor(pixel.y))),
  };
}

// A seq value guaranteed to sort after every op already in `ops` -- lets a
// local, not-yet-confirmed gesture be replayed by public/pixelgrid.js's
// replayPixelOps alongside the authoritative history, with no second
// "preview" rendering path: the local owner's own pending/in-progress work
// is simply the highest-seq (and therefore winning, for any cell it touches)
// contribution in the combined list fed to the exact same replay function
// used for everything else.
export function nextSyntheticSeq(ops) {
  let max = 0;
  for (const op of ops) if (op.seq > max) max = op.seq;
  return max + 1;
}

// Builds the combined op list to actually replay for rendering: the
// authoritative history plus this owner's own locally-pending and
// in-progress work, each stamped with an ever-increasing synthetic seq so
// they resolve exactly as "this owner's latest contribution", precisely as
// they will once the server confirms them. Pure: never mutates allOps/
// pendingOps/current. `current` may be null (no gesture in progress);
// `ownerId` may be null only before loadMe() resolves, in which case there
// is no local work to overlay yet.
export function buildRenderOps(allOps, pendingOps, current, ownerId) {
  if (ownerId === null) return allOps;
  const local = current ? [...pendingOps, current] : pendingOps;
  if (local.length === 0) return allOps;
  let seq = nextSyntheticSeq(allOps);
  const stamped = local.map((op) => ({ ...op, ownerId, seq: seq++ }));
  return [...allOps, ...stamped];
}

// An op's own bounding box in integer cell space, padded by half its brush
// size -- mirrors public/app.js's own opNormalizedBounds/opPixelBounds
// caching (the freehand engine's equivalent), adapted to integer cells. Used
// to cheaply decide which historical ops could possibly affect a given
// region, without re-deriving each op's exact touched-cell set (that's
// public/pixelgrid.js's cellsForStroke's job, and is more expensive than a
// bounding box alone needs to be for a yes/no overlap test).
export function cellBoundsForPoints(points, size) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = Math.ceil(size / 2);
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function boundsIntersect(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

// Removes exactly one finished-but-unconfirmed gesture from `pendingOps`,
// whether its persistence ultimately succeeded (the real op now lives in
// allOps) or failed (it must stop rendering as if it had happened) -- the
// same array-identity removal public/app.js's own persistGesture already
// uses for the freehand engine, extracted here as a named, independently
// testable function instead of an inline filter.
export function removePendingOp(pendingOps, finished) {
  return pendingOps.filter((op) => op !== finished);
}
