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

// Public keeps its original, smaller ceiling; a Private pixel-art studio
// supports the full professional range, 1-64, regardless of that studio's
// own (possibly much smaller) width/height -- never a scaling rule derived
// from canvas size. Kept in sync by hand with server/index.js's own
// PUBLIC_MAX_BRUSH_SIZE/PRIVATE_MAX_BRUSH_SIZE.
export const MIN_BRUSH_SIZE = 1;
export const PUBLIC_MAX_BRUSH_SIZE = 8;
export const PRIVATE_MAX_BRUSH_SIZE = 64;
export const DEFAULT_BRUSH_SIZE = 2;

// New Canvas dialog: independent, directly-editable width/height (a
// rectangular canvas is fully supported, unlike the older square-only
// PIXEL_RESOLUTIONS enum above, which POST /api/rooms still accepts
// unchanged for backward compatibility). Kept in sync by hand with
// server/index.js's own MIN_CANVAS_DIMENSION/MAX_CANVAS_DIMENSION.
export const MIN_CANVAS_DIMENSION = 16;
export const MAX_CANVAS_DIMENSION = 512;
export const DEFAULT_CANVAS_SIZE = 128;

// Document background: metadata about how a pixel-art studio's canvas is
// displayed, never an ordinary drawing operation (server/db.js's rooms.
// background_kind/background_color, Step "canvas foundation"). Kept in sync
// by hand with server/index.js's own BACKGROUND_KINDS.
export const BACKGROUND_KINDS = ["transparent", "white", "custom"];
export const DEFAULT_BACKGROUND_COLOR = "#ffffff";

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
    return {
      mode: "pixel",
      width: room.width,
      height: room.height,
      // Falls back to opaque white only if the room response genuinely
      // omitted background (never expected from a real server response,
      // which always includes it for a pixel room -- this is purely
      // defensive, the same spirit as every other fallback in this function).
      background: room.background ?? { kind: "white", color: null },
    };
  }
  return { mode: "legacy" };
}

// PIXEL_RESOLUTIONS/isValidPixelResolution describe the original square-only
// room-creation shape (server/index.js's own `resolution` field), still
// fully supported server-side for backward compatibility even though the
// New Canvas dialog now always sends independent width/height instead (see
// clampCanvasDimension/resolveNewCanvasBackground below).
export function isValidPixelResolution(value) {
  return PIXEL_RESOLUTIONS.includes(value);
}

// maxSize is the caller's own scope ceiling (PUBLIC_MAX_BRUSH_SIZE or
// PRIVATE_MAX_BRUSH_SIZE) -- never derived here from a document's own
// dimensions.
export function clampBrushSize(size, maxSize) {
  const n = Math.round(size);
  if (!Number.isFinite(n)) return Math.min(DEFAULT_BRUSH_SIZE, maxSize);
  return Math.min(maxSize, Math.max(MIN_BRUSH_SIZE, n));
}

// Live-clamps a New Canvas dialog width/height field as the user types --
// never silently substitutes the default for an out-of-range number (that
// would be surprising mid-edit), only for a genuinely non-numeric value.
export function clampCanvasDimension(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CANVAS_SIZE;
  return Math.min(MAX_CANVAS_DIMENSION, Math.max(MIN_CANVAS_DIMENSION, n));
}

export function isValidBackgroundKind(kind) {
  return BACKGROUND_KINDS.includes(kind);
}

// Resolves the New Canvas dialog's (or the in-studio "change background"
// control's) selected kind + optional custom colour into the canonical
// {kind, color} shape POST /api/rooms and POST /api/rooms/:code/background
// both expect -- color is always null except for "custom", and "custom"
// always has SOME colour (falling back to white) rather than sending an
// empty one.
export function resolveNewCanvasBackground(kind, color) {
  if (kind === "custom") {
    return { kind: "custom", color: typeof color === "string" && color.length > 0 ? color : DEFAULT_BACKGROUND_COLOR };
  }
  if (kind === "transparent") return { kind: "transparent", color: null };
  return { kind: "white", color: null };
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
