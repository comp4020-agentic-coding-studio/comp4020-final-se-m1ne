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

// One uniform range for every tool/mode combination -- Public Pencil,
// Public Eraser, Private Pencil, Private Eraser all share the exact same
// 1-100 ceiling, never a scope-dependent cap, and never a rule derived from
// a document's own width/height. Kept in sync by hand with server/index.js's
// own MAX_BRUSH_SIZE.
export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 100;
export const DEFAULT_BRUSH_SIZE = 2;

// New Canvas dialog: independent, directly-editable width/height (a
// rectangular canvas is fully supported, unlike the older square-only
// PIXEL_RESOLUTIONS enum above, which POST /api/rooms still accepts
// unchanged for backward compatibility). Kept in sync by hand with
// server/index.js's own MIN_CANVAS_DIMENSION/MAX_CANVAS_DIMENSION.
//
// 2048 (not the requested 10000) is the highest limit defensible under the
// CURRENT renderer architecture: #canvas's backing store is one single,
// dense <canvas> sized exactly gridWidth x gridHeight (never tiled or
// virtualized), so its native bitmap memory is unavoidably width*height*4
// bytes, regardless of how sparse the actual artwork is (committedGrid, the
// JS-side cache, IS already a Map keyed by painted cell, costing nothing for
// a blank one). A 10000x10000 document would need a ~381 MiB backing store
// for that bitmap alone -- several times the ~16.7 million px (4096x4096)
// area historically documented as the point older/mobile WebKit builds can
// refuse or fail a single canvas at, and enough to risk a slow full-canvas
// clearRect (renderFromCommittedGrid's own full-repaint path, run at load/
// undo/redo/gesture-resolve boundaries) or an out-of-memory tab kill on a
// constrained device. 2048x2048 (~16 MiB) keeps a 4x margin below that
// documented ceiling, and reuses the exact scale Public's own 2048x1152
// document (~9.4 MiB) already ships and has been exercised at. Supporting
// 10000x10000 safely would need a tiled/virtualized canvas renderer --
// splitting the document into multiple smaller canvases, or rendering only
// the current viewport -- which is a substantial renderer rewrite out of
// scope for this change.
export const MIN_CANVAS_DIMENSION = 16;
export const MAX_CANVAS_DIMENSION = 2048;
export const DEFAULT_CANVAS_SIZE = 128;

// Document background: metadata about how a pixel-art studio's canvas is
// displayed, never an ordinary drawing operation (server/db.js's rooms.
// background_kind/background_color, Step "canvas foundation"). Kept in sync
// by hand with server/index.js's own BACKGROUND_KINDS.
export const BACKGROUND_KINDS = ["transparent", "white", "custom"];
export const DEFAULT_BACKGROUND_COLOR = "#ffffff";

// public/viewport.js's own MIN_ZOOM/MAX_ZOOM/ZOOM_LEVELS were sized for the
// 1920x1080 freehand document, where 400% is already enormous. Pixel
// documents need a much wider range in the OTHER direction too -- zooming
// below 100% to see a large Public wall, or a very small Private studio
// zoomed up to tens of CSS pixels per logical pixel -- so pixel documents use
// their own range with the exact same generic clampZoom/fitZoom/stepZoom
// functions (every one of them already takes min/max/levels as parameters),
// never a second zoom implementation. The minimum is shared; only the
// maximum differs by scope (kept in sync by hand with nothing server-side --
// zoom is pure display, never validated or persisted).
export const PIXEL_ZOOM_MIN = 0.1; // 10% -- also the floor fitZoom itself can land on for a document larger than the viewport
export const PUBLIC_ZOOM_MAX = 8; // 800%
export const PRIVATE_ZOOM_MAX = 32; // 3200%

// Discrete steps the Zoom In/Out BUTTONS cycle through (see stepZoom) -- the
// continuous SLIDER (zoomToSliderPosition/sliderPositionToZoom below) is a
// separate, unquantized control over the exact same [min, max] range, not
// limited to these named stops.
export const PUBLIC_ZOOM_LEVELS = [0.1, 0.25, 0.5, 1, 2, 4, 8];
export const PRIVATE_ZOOM_LEVELS = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

// A linear slider is unusable across a 0.1-32 (320x) range: half the track
// would cover 0.1-16 and the other half just 16-32. Mapping slider position
// through a logarithm instead gives equal visual travel to equal zoom
// *ratios* (e.g. 25%->50% feels the same drag distance as 400%->800%),
// which is the standard fix for a wide-ratio zoom control. position is
// always normalized to [0, 1] -- the caller scales that onto its own actual
// <input type="range"> integer range.
export function zoomToSliderPosition(zoomValue, minZoom, maxZoom) {
  const clamped = Math.min(maxZoom, Math.max(minZoom, zoomValue));
  const logMin = Math.log(minZoom);
  const logMax = Math.log(maxZoom);
  if (logMax === logMin) return 0; // degenerate range guard; never hit with this app's real min/max
  return (Math.log(clamped) - logMin) / (logMax - logMin);
}

export function sliderPositionToZoom(position, minZoom, maxZoom) {
  const clampedPosition = Math.min(1, Math.max(0, position));
  const logMin = Math.log(minZoom);
  const logMax = Math.log(maxZoom);
  return Math.exp(logMin + clampedPosition * (logMax - logMin));
}

// Below this many screen (CSS) pixels per logical pixel, individual grid
// cells are too small for gridlines spaced every single logical pixel to
// help rather than just add noise -- `zoom` in this app IS already "screen
// px per logical px" by construction (canvas.style.width is always
// gridWidth * zoom), so this is compared directly against it, no separate
// unit conversion needed. This used to be the point below which the WHOLE
// grid was hidden; it is now instead the point below which the grid gets
// COARSER instead of disappearing (see gridCellLogicalSize) -- Grid ON
// previously produced no visible difference at ordinary zoom levels (e.g.
// Public's own 56%, Private's own 514%, both well under 8x) because the
// grid was simply suppressed there entirely.
export const GRID_MIN_ZOOM_FOR_DISPLAY = 8;

// The coarse grid never spaces lines further apart than this many logical
// pixels, so an extremely low zoom still shows SOME grid structure across a
// reasonably sized document rather than growing the spacing without bound.
export const GRID_MAX_CELL_SIZE = 128;

// How many logical pixels apart grid lines should be drawn at this zoom:
// 1 (every logical pixel -- "individual logical pixel boundaries") once
// zoom is already high enough that doing so stays legible (the resulting
// on-screen cell is at least minScreenPxPerCell CSS px); otherwise the
// smallest power-of-two spacing that IS legible at this zoom, capped at
// maxCellSize. Doubling by powers of two keeps the coarse grid's own cells
// aligned with common pixel-art block sizes (8x8, 16x16 tiles), not an
// arbitrary spacing, and the result is always an exact divisor-aligned
// multiple of the logical pixel grid, so lines never drift off a true pixel
// boundary.
export function gridCellLogicalSize(zoom, minScreenPxPerCell = GRID_MIN_ZOOM_FOR_DISPLAY, maxCellSize = GRID_MAX_CELL_SIZE) {
  let cell = 1;
  while (cell * zoom < minScreenPxPerCell && cell < maxCellSize) {
    cell *= 2;
  }
  return cell;
}

// The ONE decision point for whether the pixel-grid overlay should currently
// be visible at all: purely the user's own ON/OFF preference (defaults ON,
// persisted in localStorage -- see public/pixel-editor.js). Zoom no longer
// hides the grid outright -- see gridCellLogicalSize, which instead makes it
// coarser at low zoom so it stays a visible, useful reference at any zoom
// level rather than disappearing below a threshold.
export function shouldShowPixelGrid(gridPreferenceOn) {
  return gridPreferenceOn;
}

// Decides which editor a page should boot, given the parsed room code (null
// on the Public page) and -- for a room -- that room's own metadata exactly
// as GET /api/rooms/:code already returns it (server/index.js, Step 3):
// {code, kind: "pixel" | "legacy", width, height}. Public is unconditionally
// the restored C8 freehand wall again -- the pixel-art era's own ops are
// untouched in the database (docKind "pixel", still fully readable via
// /api/pixels if ever needed again), just no longer the live Public
// experience. `room` is ignored entirely when roomCode is null, so a caller
// never needs to fetch room metadata just to render Public. A room's own
// `kind` decides the rest: an EXISTING pixel-art studio (one that already
// has stored width/height -- created before this restoration) still opens
// in the pixel editor, so that artwork stays reachable and editable rather
// than orphaned; any other room (including a lookup failure, and every
// NEWLY created room from now on, since room creation itself was restored
// to its C8 shape) falls back to "legacy" -- the untouched freehand editor.
export function resolveEditorMode(roomCode, room) {
  if (roomCode === null) {
    return { mode: "legacy" };
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

// maxSize is the caller's own ceiling (MAX_BRUSH_SIZE) -- never derived here
// from a document's own dimensions.
export function clampBrushSize(size, maxSize) {
  const n = Math.round(size);
  if (!Number.isFinite(n)) return Math.min(DEFAULT_BRUSH_SIZE, maxSize);
  return Math.min(maxSize, Math.max(MIN_BRUSH_SIZE, n));
}

// Pencil and Eraser each keep their OWN selected size -- restoring the exact
// independence the original C8 freehand editor had (public/app.js's own
// toolSizes map, one entry per tool with its own get/set) against ONE shared
// slider/numeric input: the widget is shared, the state underneath it is
// not. A tool switch never touches the other tool's stored size; setting one
// tool's size never touches the other's. This is a factory, not a singleton,
// specifically so it is this exact state machine (not a parallel
// reimplementation) that both public/pixel-editor.js and this module's own
// tests exercise.
export function createBrushSizeState(maxSize, defaultSize = DEFAULT_BRUSH_SIZE) {
  const clampedDefault = clampBrushSize(defaultSize, maxSize);
  const sizes = { brush: clampedDefault, eraser: clampedDefault };
  return {
    get(tool) {
      return sizes[tool];
    },
    set(tool, value) {
      const clamped = clampBrushSize(Number(value), maxSize);
      sizes[tool] = clamped;
      return clamped;
    },
  };
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
