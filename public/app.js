import { effectiveOpacity } from "./fade.js";
import { rgbToHex } from "./colour.js";
import { initColourPicker } from "./colour-picker-ui.js";
import { compositeOverWhite } from "./sampling.js";
import { wireHelpPopover } from "./help-popover.js";
import { initCursorColourPicker } from "./cursor-colour-picker.js";
import { constrainCorner, isMeaningfulShape, paintShape } from "./shapes.js";
import { installNavigationMarking, isNavigating, markNavigating, releasePreviousLease } from "./presence-handoff.js";
import {
  DOCUMENT_WIDTH,
  DOCUMENT_HEIGHT,
  ZOOM_LEVELS,
  clampZoom,
  cssPointToNormalized,
  documentPointToPixel,
  brushSizeToDocumentPx,
  cursorDiameterCssPx,
  fitZoom,
  stepZoom,
} from "./viewport.js";
import {
  layerIdsFor,
  defaultLayerNamesFor,
  effectiveLayerId,
  layerSettingsStorageKey,
  parseLayerSettings,
} from "./layers.js";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const canvasViewport = document.getElementById("canvas-viewport");
const toolCursor = document.getElementById("tool-cursor");
const toolSizeSlider = document.getElementById("tool-size-slider");
const toolSizeValue = document.getElementById("tool-size-value");
const toolBrushButton = document.getElementById("tool-brush");
const toolEraserButton = document.getElementById("tool-eraser");
const SHAPE_TOOL_IDS = ["line", "rectangle", "ellipse"];
const shapeToolButtons = Object.fromEntries(SHAPE_TOOL_IDS.map((id) => [id, document.getElementById(`tool-${id}`)]));
const shapeModeControl = document.getElementById("shape-mode-control");
const shapeModeButtons = {
  outline: document.getElementById("shape-mode-outline"),
  filled: document.getElementById("shape-mode-filled"),
};
const toolEyedropperButton = document.getElementById("tool-eyedropper");
const colourGroup = document.getElementById("colour-group");
const createRoomButton = document.getElementById("create-room-button");
const joinRoomForm = document.getElementById("join-room-form");
const joinRoomCodeInput = document.getElementById("join-room-code");
const publicRoomControls = document.getElementById("public-room-controls");
const privateRoomControls = document.getElementById("private-room-controls");
const roomCodeLabel = document.getElementById("room-code-label");
const undoButton = document.getElementById("undo-button");
const redoButton = document.getElementById("redo-button");
const zoomOutButton = document.getElementById("zoom-out-button");
const zoomInButton = document.getElementById("zoom-in-button");
const zoomPercentDisplay = document.getElementById("zoom-percent");
const fitButton = document.getElementById("fit-button");
const profileButton = document.getElementById("profile-button");
const profilePopover = document.getElementById("profile-popover");
const profilePopoverClose = document.getElementById("profile-popover-close");
const profileNicknameInput = document.getElementById("profile-nickname-input");
const profileColourInput = document.getElementById("profile-colour-input");
const profileShowNicknameInput = document.getElementById("profile-show-nickname");
const profileShowCursorInput = document.getElementById("profile-show-cursor");
const profileShowOthersInput = document.getElementById("profile-show-others");
const profileSaveButton = document.getElementById("profile-save-button");
const guestSetupOverlay = document.getElementById("guest-setup-overlay");
const guestSetupNicknameInput = document.getElementById("guest-setup-nickname-input");
const guestSetupColourInput = document.getElementById("guest-setup-colour-input");
const profileColourPicker = initCursorColourPicker(document.getElementById("profile-colour-picker"), profileColourInput);
const guestSetupColourPicker = initCursorColourPicker(
  document.getElementById("guest-setup-colour-picker"),
  guestSetupColourInput,
);
const guestSetupConfirmButton = document.getElementById("guest-setup-confirm");
const remoteCursorsContainer = document.getElementById("remote-cursors");
const remoteStrokePreviewCanvas = document.getElementById("remote-stroke-preview");
const remoteStrokePreviewCtx = remoteStrokePreviewCanvas.getContext("2d");
const layerListEl = document.getElementById("layer-list");
const layerHiddenNoticeEl = document.getElementById("layer-hidden-notice");

// The one place "which canvas is this" is decided: a room page is served at
// /room/CODE (server/index.js's GET /room/:code, which 404s before ever
// reaching this script unless the room genuinely exists), so the code in the
// URL is already validated by the time this runs. Everything else below --
// which endpoints to call, and whether fading applies -- is derived once
// from this, not re-decided anywhere else.
const roomCode = location.pathname.match(/^\/room\/([^/]+)/)?.[1]?.toUpperCase() ?? null;
const isPublicCanvas = roomCode === null;
document.getElementById("workspace").classList.add(isPublicCanvas ? "is-public" : "is-private");
const opsUrl = roomCode ? `/api/rooms/${roomCode}/ops` : "/api/ops";
const drawUrl = roomCode ? `/api/rooms/${roomCode}/ops/draw` : "/api/ops/draw";
const eraseUrl = roomCode ? `/api/rooms/${roomCode}/ops/erase` : "/api/ops/erase";
// Same Public/Private split as opsUrl/drawUrl/eraseUrl above: both scopes
// have their own server route (server/index.js), reusing the exact same
// undo/redo DB logic underneath, so this is the only branch point needed.
const undoUrl = roomCode ? `/api/rooms/${roomCode}/undo` : "/api/ops/undo";
const redoUrl = roomCode ? `/api/rooms/${roomCode}/redo` : "/api/ops/redo";

// Each owner gets its own off-screen raster layer: a private <canvas> that
// only that owner's ops are ever replayed onto. Draw ops paint with
// source-over; erase ops paint with destination-out -- the browser's own
// true alpha-clearing composite mode, applied only to this layer. Because an
// owner's erase op is never even given the chance to touch any other
// owner's layer canvas, cross-owner erasure isn't filtered out after the
// fact -- there's no code path through which it could happen at all.
//
// The shared visible canvas is NOT a fixed per-owner stack (that would pin
// an owner's z-position to their first-ever op, so a later redraw could
// never appear above another owner's intervening draw -- the opposite of
// "later draws go on top"). Instead repaintVisibleCanvas replays the single
// server-seq-ordered op list directly: for each draw op it paints just that
// op's own stroke onto a reusable scratch canvas, clips it (destination-in)
// against the issuing owner's own current layer, then source-over's the
// clipped result onto the shared canvas. Erase ops never touch the shared
// canvas at all -- their only effect is already baked into the owner's own
// layer, which is exactly what later same-owner draws get clipped against --
// so destination-out is never applied to the shared canvas and one owner's
// erase can never remove another owner's pixels.
let layers = new Map(); // "ownerId:layerId" -> { canvas, ctx }, each owner's own current-state mask on that one layer
let scratch = null; // { canvas, ctx }, reused per draw-op during a repaint
let allOps = []; // op[], the full history in server seq order
let opsByOwner = new Map(); // ownerId -> op[] in seq order, used only to rebuild each owner's own layer

// allOps sorted for rendering: (layer index ascending, seq ascending) --
// seq alone is correct *within* one layer (later same-layer draws go on top,
// regardless of owner), but does not guarantee a lower document-structural
// layer stays under a higher one that happens to have an earlier seq. Memoized
// and invalidated (set to null) at every one of allOps's own mutation points
// below (loadOps, the "sync"/"op" SSE handlers, persistGesture's success
// path) so a hot path like a live erase's per-frame regional repaint never
// re-sorts the full history every frame -- only the first repaint after
// allOps actually changed pays for one.
let renderOrderOps = null;
function invalidateRenderOrder() {
  renderOrderOps = null;
}
function getRenderOrderOps() {
  if (renderOrderOps === null) {
    const ids = layerIdsFor(isPublicCanvas);
    renderOrderOps = [...allOps].sort((a, b) => {
      const layerDiff = ids.indexOf(effectiveLayerId(a, isPublicCanvas)) - ids.indexOf(effectiveLayerId(b, isPublicCanvas));
      return layerDiff !== 0 ? layerDiff : a.seq - b.seq;
    });
  }
  return renderOrderOps;
}

// Ephemeral, in-progress remote strokes -- never persisted, never touching
// allOps/opsByOwner/any real layer's own canvas. Declared here (ahead of
// repaintVisibleCanvas below, which reads it) rather than down in the
// "Remote in-progress stroke previews" section with the rest of this
// feature's logic, specifically so a remote in-progress ERASE can be
// reflected on the shared visible canvas itself -- see
// erasePreviewLayerFor/repaintVisibleCanvas and updateErasePreviewLayer
// further down for how. ownerId -> { kind, color, size, points, lastSeen,
// endTimer, snapshotCanvas, previewLayerCanvas } (the last two populated only
// for an in-progress erase; see updateErasePreviewLayer).
const remoteStrokePreviews = new Map();
const STROKE_PREVIEW_STALE_MS = 4000; // safety net for a disconnect mid-stroke that never sends stroke-end
const STROKE_PREVIEW_END_GRACE_MS = 1500; // grace window for the real "op" to arrive and supersede this first

// Returns a temporary, fully-recomputed "what this owner's layer would look
// like if their current in-progress remote erase gesture had already fully
// landed" canvas, or null if this owner has no active erase preview on this
// exact layer right now (an owner can only have one live gesture at a time,
// so a preview for a different layer than the one being asked about is not a
// match). Never mutates layers.get(ownerLayerKey(...))'s own canvas (the
// owner's real, authoritative mask) -- only ever reads it, once, to seed a
// disposable copy (see updateErasePreviewLayer) -- so persisted state can
// never be corrupted by however many times this is consulted, or by a
// preview that's later abandoned/cancelled/superseded.
function erasePreviewLayerFor(ownerId, layerId) {
  const preview = remoteStrokePreviews.get(ownerId);
  if (!preview || preview.kind !== "erase" || preview.layerId !== layerId) return null;
  return preview.previewLayerCanvas ?? null;
}

let myOwnerId = null;
// The #rrggbb string every draw op persists (read in beginGesture/
// persistGesture), kept in sync with the shared colour-picker UI's own
// internal state (public/colour-picker-ui.js) via its onChange callback,
// wired up further down once every DOM element it needs exists.
let color = "#1d1d1d";
let brushSizePx = 6;
let eraserSizePx = 30;
let mode = "brush"; // "brush" | "eraser" | "eyedropper" | "line" | "rectangle" | "ellipse"
let shapeMode = "outline"; // "outline" | "filled" -- shared by rectangle/ellipse; Line has no mode

// One shared slider's meaning depends on which tool is active: each entry
// owns its own range (matching the two permanent sliders' old min/max/step
// exactly) plus a get/set pair onto that tool's own independent size
// variable, so the control is shared while brushSizePx/eraserSizePx stay
// exactly as independent as they were before. A future tool plugs in by
// adding one more entry here, not one more permanent slider in the markup.
const toolSizes = {
  brush: {
    min: 1,
    max: 40,
    step: 1,
    get: () => brushSizePx,
    set: (px) => { brushSizePx = px; },
  },
  eraser: {
    min: 10,
    max: 100,
    step: 1,
    get: () => eraserSizePx,
    set: (px) => { eraserSizePx = px; },
  },
};
// Every shape tool uses the Brush size as its stroke width -- the same
// variable and range, so switching Brush <-> a shape never changes the number.
for (const id of ["line", "rectangle", "ellipse"]) toolSizes[id] = toolSizes.brush;

// Applies the active tool's own range and current value to the one shared
// slider -- called on every tool switch so min/max/value/display all update
// together, never lagging behind which tool is actually selected. Eyedropper
// has no entry in toolSizes (it has no size at all), so the slider is simply
// disabled rather than make up a value for it -- brushSizePx/eraserSizePx are
// left exactly as they were, and whichever one was last shown stays visible
// but inert underneath the disabled control.
function syncSizeControlToMode() {
  if (mode === "eyedropper") {
    toolSizeSlider.disabled = true;
    return;
  }
  toolSizeSlider.disabled = false;
  const cfg = toolSizes[mode];
  toolSizeSlider.min = cfg.min;
  toolSizeSlider.max = cfg.max;
  toolSizeSlider.step = cfg.step;
  toolSizeSlider.value = cfg.get();
  toolSizeValue.textContent = `${cfg.get()}px`;
}

// The gesture currently being dragged (from pointerdown to pointerup/cancel),
// painted onto the local owner's own layer as points stream in -- see
// renderCurrentDelta. Not yet persisted until the gesture ends.
let current = null; // { kind: "draw" | "erase", color: string | null, size: number (normalized), points: [{x, y}] }
let currentLastRenderedIndex = 0;
let frameHandle = null; // requestAnimationFrame handle for the next scheduled render, or null

// Finished draw gestures that are already fully painted locally but whose
// persistGesture() POST hasn't resolved yet, so they aren't in allOps (or
// opsByOwner) for a from-scratch repaint to find. A full repaintVisibleCanvas
// -- the 1Hz fade tick, a resize, anything -- can land in that gap at any
// moment once `current` has already gone null, so repaintVisibleCanvas paints
// these directly and unclipped, exactly like it does for `current`, until
// persistGesture removes each one the instant its op actually lands in
// allOps. This is what makes "local feedback never waits on persistence" true
// even across an unrelated repaint, not just immediately after pointerup.
let pendingOps = []; // finished[] -- same shape as `current`, minus points still streaming in

// Best-effort local count of this owner's own ops that are currently undone
// and still redoable in this room. There is no endpoint to ask the server
// "how many of my ops are redoable right now" (listOps only ever returns
// active ops, per the architecture's Correction 2), so this is tracked
// client-side instead: incremented on a successful undo response, decremented
// on a successful redo response, and reset to 0 both on page load (a fresh
// load has no way to know what a previous session left redoable) and the
// instant any of this owner's own draw/erase ops actually persists in this
// room (the server's abandonRedoBranch has just cleared that branch for real,
// see server/index.js's handleDraw/handleErase). canUndo, by contrast, needs
// no such tracking: opsByOwner already reflects exactly this owner's current
// active ops, so its length is always correct without any extra bookkeeping.
let myRedoCount = 0;

// The artwork backing store is fixed at the document's own resolution,
// forever: set once here and never touched again by a window/workspace
// resize, zoom change, or Fit (see the resize listener and applyZoom below,
// neither of which assigns canvas.width/height). Zoom instead changes only
// canvas.style.width/height -- a CSS display-size change the backing store
// and every already-rendered layer are completely unaffected by.
function initCanvasBackingStore() {
  canvas.width = DOCUMENT_WIDTH;
  canvas.height = DOCUMENT_HEIGHT;
  // Same resolution as #canvas itself -- a point painted here at normalized
  // (x, y) via renderPathOnLayer therefore lands at the exact same pixel a
  // real op's replay would, so a reconciled preview-to-authoritative handoff
  // never visibly shifts.
  remoteStrokePreviewCanvas.width = DOCUMENT_WIDTH;
  remoteStrokePreviewCanvas.height = DOCUMENT_HEIGHT;
}

// Points are stored normalized [0,1], relative to the document, not to
// whatever CSS size the canvas happens to be displayed at -- so the same
// persisted point reproduces the same document position at any zoom level.
function toNormalized(clientX, clientY) {
  return cssPointToNormalized(clientX, clientY, canvas.getBoundingClientRect());
}

function toPixels(point) {
  return documentPointToPixel(point, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
}

// Keyed by (ownerId, layerId): an owner's erase must only ever affect that
// owner's own ops on that one document-structural layer, never that same
// owner's content on a different layer (see the module comment above) -- so
// each (owner, layer) pair needs its own independent mask, not one mask per
// owner shared across every layer they've ever drawn on.
function ownerLayerKey(ownerId, layerId) {
  return `${ownerId}:${layerId}`;
}

function ensureLayer(ownerId, layerId) {
  const key = ownerLayerKey(ownerId, layerId);
  let layer = layers.get(key);
  if (!layer) {
    const layerCanvas = document.createElement("canvas");
    layerCanvas.width = canvas.width;
    layerCanvas.height = canvas.height;
    layer = { canvas: layerCanvas, ctx: layerCanvas.getContext("2d") };
    layers.set(key, layer);
  }
  return layer;
}

// A small off-screen canvas for REGIONAL repaints (an erase drag repaints only a ~60x60 box per frame).
// Doing the per-op paint/clip/blit on the full 1920x1080 scratch cost several ms per overlapping op even
// for a tiny region (and large shapes overlap almost every region); a region-sized surface is ~90x
// cheaper and produces identical pixels. Grown on demand, never shrunk, reused every frame.
let regionScratch = null; // { canvas, ctx }
function ensureRegionScratch(width, height) {
  if (!regionScratch) {
    const c = document.createElement("canvas");
    regionScratch = { canvas: c, ctx: c.getContext("2d") };
  }
  const c = regionScratch.canvas;
  if (c.width < width || c.height < height) {
    c.width = Math.max(c.width, width);
    c.height = Math.max(c.height, height);
  }
  return regionScratch;
}

function ensureScratch() {
  if (!scratch || scratch.canvas.width !== canvas.width || scratch.canvas.height !== canvas.height) {
    const scratchCanvas = document.createElement("canvas");
    scratchCanvas.width = canvas.width;
    scratchCanvas.height = canvas.height;
    scratch = { canvas: scratchCanvas, ctx: scratchCanvas.getContext("2d") };
  }
  return scratch;
}

// Strokes a raw polyline -- no smoothing -- onto one owner's layer. A draw
// op uses source-over with its own color; an erase op uses destination-out,
// which only consumes the alpha/coverage of the path just stroked and
// ignores color entirely, so "#000" below is an arbitrary opaque choice.
// Shared by full replay (every historical op) and the live in-progress
// gesture (just its newest delta), so there is exactly one rendering code
// path for both draw and erase, in every situation.
function renderPathOnLayer(layerCtx, kind, color, sizeNormalized, points, shape) {
  if (shape && points.length === 2) {
    // A shape op: two document-normalised corners + {type, mode}. paintShape
    // is the same code the live preview and remote replay run.
    paintShape(
      layerCtx,
      { type: shape.type, mode: shape.mode, color, lineWidth: brushSizeToDocumentPx(sizeNormalized, DOCUMENT_WIDTH) },
      toPixels(points[0]),
      toPixels(points[1]),
    );
    return;
  }
  if (points.length === 0) return;
  const pixels = points.map(toPixels);

  layerCtx.save();
  layerCtx.globalCompositeOperation = kind === "erase" ? "destination-out" : "source-over";
  layerCtx.strokeStyle = kind === "erase" ? "#000" : color;
  layerCtx.lineWidth = brushSizeToDocumentPx(sizeNormalized, DOCUMENT_WIDTH);
  layerCtx.lineCap = "round";
  layerCtx.lineJoin = "round";

  layerCtx.beginPath();
  layerCtx.moveTo(pixels[0].x, pixels[0].y);
  if (pixels.length === 1) {
    // A tap: a zero-length path with a round cap renders as a filled circle.
    layerCtx.lineTo(pixels[0].x, pixels[0].y);
  } else {
    for (let i = 1; i < pixels.length; i++) layerCtx.lineTo(pixels[i].x, pixels[i].y);
  }
  layerCtx.stroke();
  layerCtx.restore();
}

function rebuildLayerFromOps(ownerId, layerId) {
  const layer = ensureLayer(ownerId, layerId);
  layer.canvas.width = canvas.width;
  layer.canvas.height = canvas.height;
  const ops = (opsByOwner.get(ownerId) ?? []).filter((op) => effectiveLayerId(op, isPublicCanvas) === layerId);
  for (const op of ops) renderPathOnLayer(layer.ctx, op.kind, op.color, op.size, op.points, op.shape);
}

// Every distinct (ownerId, layerId) pair actually present in allOps -- driven
// from the real op history, not a fixed cross-product of every owner with
// every one of this canvas's layers, so an owner who never drew on some
// layer never gets an empty canvas created for it.
function ownerLayerPairsInOps() {
  const pairs = new Map(); // ownerId -> Set<layerId>
  for (const op of allOps) {
    const layerId = effectiveLayerId(op, isPublicCanvas);
    if (!pairs.has(op.ownerId)) pairs.set(op.ownerId, new Set());
    pairs.get(op.ownerId).add(layerId);
  }
  return pairs;
}

function rebuildAllLayers() {
  for (const [ownerId, layerIds] of ownerLayerPairsInOps()) {
    for (const layerId of layerIds) rebuildLayerFromOps(ownerId, layerId);
  }
  if (myOwnerId !== null) {
    // Not yet in opsByOwner/allOps (persistGesture hasn't resolved), so the
    // loop above can't have replayed these -- without this, a resize
    // mid-persist would drop a pending gesture from the owner's own mask,
    // and once persistence did land it'd render clipped away to nothing on
    // the very next ops-driven repaint. Grouped by each pending op's own
    // layerId (not just current.layerId) since a user can switch layers
    // between one finished-but-unconfirmed gesture and the next.
    for (const op of pendingOps) {
      const layer = ensureLayer(myOwnerId, effectiveLayerId(op, isPublicCanvas));
      renderPathOnLayer(layer.ctx, op.kind, op.color, op.size, op.points, op.shape);
    }
    // A shape in progress is not artwork yet: it lives only on the preview overlay until pointer-up
    // commits it (endGesture), so a rebuild must not paint it into the layer.
    if (current && !current.shape) {
      const layer = ensureLayer(myOwnerId, current.layerId);
      renderPathOnLayer(layer.ctx, current.kind, current.color, current.size, current.points);
      currentLastRenderedIndex = current.points.length - 1;
    }
  }
  repaintVisibleCanvas();
}

// A draw op's own bounding box, in normalized [0,1] units padded by half its
// stroke width -- cached on the op object itself the first time it's needed.
// Normalized (not pixel) units survive a resize untouched, since the points
// that produced them don't change; only the pixel conversion below depends
// on the current canvas size.
function opNormalizedBounds(op) {
  if (!op._normBounds && op.shape && op.points.length === 2) {
    const [p, q] = op.points;
    // Stroke width is normalized by canvas WIDTH, so the same pixel padding is a larger fraction on y.
    const padX = op.size / 2 + 2 / canvas.width;
    const padY = (op.size / 2) * (canvas.width / canvas.height) + 2 / canvas.height;
    op._normBounds = {
      minX: Math.min(p.x, q.x) - padX,
      minY: Math.min(p.y, q.y) - padY,
      maxX: Math.max(p.x, q.x) + padX,
      maxY: Math.max(p.y, q.y) + padY,
    };
  }
  if (!op._normBounds) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of op.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const padX = op.size / 2 + 2 / canvas.width; // half the stroke width (round caps/joins) + antialiasing fringe
    const padY = (op.size / 2) * (canvas.width / canvas.height) + 2 / canvas.height;
    op._normBounds = { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
  }
  return op._normBounds;
}

function opPixelBounds(op) {
  const b = opNormalizedBounds(op);
  return {
    x: b.minX * canvas.width,
    y: b.minY * canvas.height,
    width: (b.maxX - b.minX) * canvas.width,
    height: (b.maxY - b.minY) * canvas.height,
  };
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// Local erase gestures that finished but are not in allOps yet (their POST is unresolved). Their effect is
// already in the owner's layer mask, so ops they cover must keep being masked until the erase op lands.
let unconfirmedErases = [];

// Every persisted erase op, grouped by (owner, layer), in seq order.
function erasesByOwnerLayer() {
  const byKey = new Map();
  for (const op of allOps) {
    if (op.kind !== "erase") continue;
    const key = ownerLayerKey(op.ownerId, effectiveLayerId(op, isPublicCanvas));
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(op);
  }
  return byKey;
}

// A draw op only has to be clipped by its owner's layer mask if an erase by that same owner on that same
// layer, newer than the op and overlapping it, exists (persisted, in flight, or being dragged right now).
// Every other op is a subset of its own mask, so masking it would change nothing except to square its
// antialiased edge alpha (op alpha x mask alpha) -- which is exactly the attenuation we must not introduce.
function opNeedsOwnerMask(op, layerId, erases) {
  if (erasePreviewLayerFor(op.ownerId, layerId)) return true;
  if (op.ownerId === myOwnerId) {
    if (current && current.kind === "erase" && current.layerId === layerId) return true;
    if (unconfirmedErases.some((e) => e.layerId === layerId)) return true;
  }
  const list = erases.get(ownerLayerKey(op.ownerId, layerId));
  if (!list) return false;
  const b = opPixelBounds(op);
  return list.some((e) => e.seq > op.seq && rectsIntersect(opPixelBounds(e), b));
}

// Full rebuild of the shared visible canvas from scratch, in global seq
// order -- see the module-level comment for why this (not a fixed per-owner
// stack) is what makes later draws win regardless of whose layer they're on.
//
// `region` (pixel-space {x, y, width, height}) restricts every clearRect and
// drawImage call below to that sub-rectangle instead of the whole canvas,
// and skips any draw op whose own bounding box can't overlap it. This is
// exactly the same per-op scratch+clip+composite math as the unrestricted
// call -- nothing is approximated -- it just leaves untouched (and therefore
// correctly unchanged) every pixel outside the region. That's what makes it
// safe to call every animation frame during a live erase: an erase can only
// ever shrink the erasing owner's own layer, so the only pixels whose
// composited result could possibly change this frame are the ones under the
// eraser's current stroke delta, which is exactly what the caller passes in.
function repaintVisibleCanvas(region) {
  const rx = region ? Math.max(0, Math.floor(region.x)) : 0;
  const ry = region ? Math.max(0, Math.floor(region.y)) : 0;
  const rw = region ? Math.min(canvas.width - rx, Math.ceil(region.x + region.width) - rx) : canvas.width;
  const rh = region ? Math.min(canvas.height - ry, Math.ceil(region.y + region.height) - ry) : canvas.height;
  if (rw <= 0 || rh <= 0) return;

  ctx.clearRect(rx, ry, rw, rh);
  // Regional repaint: work in a region-sized scratch whose origin is the region's top-left (ox, oy), so
  // each op's paint/clip/blit touches only rw x rh pixels. A full repaint keeps the full-size scratch.
  const { canvas: scratchCanvas, ctx: scratchCtx } = region ? ensureRegionScratch(rw, rh) : ensureScratch();
  const ox = region ? rx : 0;
  const oy = region ? ry : 0;
  const clipRect = region ? { x: rx, y: ry, width: rw, height: rh } : null;
  const now = Date.now(); // one shared instant for every op in this repaint, so nothing within a single pass can disagree
  // Deterministic layer-by-layer composite, bottom to top. For each layer: every committed draw op in seq
  // order (clipped by its owner's own layer mask, faded), THEN that layer's not-yet-committed content
  // (this viewer's pendingOps, then the in-progress stroke/shape, then remote draw previews). Nothing of a
  // lower layer is ever drawn after anything of a higher layer, so layer order always beats drawing time.
  const ids = layerIdsFor(isPublicCanvas);
  const erases = erasesByOwnerLayer();
  const opsByLayer = new Map(ids.map((id) => [id, []]));
  for (const op of getRenderOrderOps()) {
    if (op.kind === "draw") opsByLayer.get(effectiveLayerId(op, isPublicCanvas))?.push(op); // an erase op's only effect is already baked into its owner's layer mask and it never fades
  }

  // Every op/preview starts from a fully transparent scratch in the default compositing state, so nothing
  // from the previous one (alpha, composite mode, transform, clip) can leak into this one.
  const beginScratch = (alpha) => {
    scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
    scratchCtx.globalCompositeOperation = "source-over";
    scratchCtx.globalAlpha = 1;
    scratchCtx.clearRect(0, 0, rw, rh);
    scratchCtx.save();
    scratchCtx.translate(-ox, -oy); // paint in document coordinates, shifted so the region's origin is (0, 0)
    scratchCtx.globalAlpha = alpha;
  };
  const blitScratch = () => {
    scratchCtx.globalCompositeOperation = "source-over";
    scratchCtx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(scratchCanvas, 0, 0, rw, rh, rx, ry, rw, rh);
  };
  // Unmasked live content (never clipped by an owner layer mask: nothing erases it until it is committed).
  // Its points keep growing while it is live, so its bounds are computed fresh (opPixelBounds caches).
  const compositeLive = (item) => {
    const bounds = opPixelBounds({ points: item.points, size: item.size, shape: item.shape });
    if (clipRect && !rectsIntersect(bounds, clipRect)) return;
    beginScratch(1);
    renderPathOnLayer(scratchCtx, "draw", item.color, item.size, item.points, item.shape);
    scratchCtx.restore();
    blitScratch();
  };

  for (const layerId of ids) {
    if (layerSettings.hidden[layerId]) continue; // this viewer has locally hidden this layer -- never touches allOps/the server
    for (const op of opsByLayer.get(layerId)) {
      // Fading is applied here, and only here: to a draw op's own stroke, right before it gets clipped against
      // its owner's layer mask below. The mask (rebuildLayerFromOps) is never faded, so an owner can always
      // erase a faded stroke and nothing erased can reappear by aging back in. A fully faded op is skipped
      // (still persisted, see public/fade.js). effectiveOpacity is 1 on a Private Room, so rooms never fade.
      const opacity = effectiveOpacity(op, now, isPublicCanvas);
      if (opacity <= 0) continue;
      if (clipRect && !rectsIntersect(opPixelBounds(op), clipRect)) continue; // this op can't paint inside the dirty region at all
      const masked = opNeedsOwnerMask(op, layerId, erases);
      const ownerLayer = masked ? layers.get(ownerLayerKey(op.ownerId, layerId)) : null;
      if (masked && !ownerLayer) continue;
      beginScratch(opacity);
      renderPathOnLayer(scratchCtx, "draw", op.color, op.size, op.points, op.shape);
      scratchCtx.restore(); // back to the untransformed, default state for the mask step
      if (masked) {
      scratchCtx.globalAlpha = 1;
      scratchCtx.globalCompositeOperation = "destination-in";
      // While this op's owner has a remote erase in progress, clip against the disposable preview of their
      // post-erase layer instead of the real one (keyed strictly by this op's own owner + layer, so one
      // owner's erase can never affect another owner's artwork).
      const clipSource = erasePreviewLayerFor(op.ownerId, layerId) ?? ownerLayer.canvas;
      scratchCtx.drawImage(clipSource, rx, ry, rw, rh, 0, 0, rw, rh);
      }
      blitScratch();
    }
    if (myOwnerId !== null) {
      for (const op of pendingOps) {
        if (effectiveLayerId(op, isPublicCanvas) === layerId) compositeLive(op);
      }
      // A freehand stroke in progress; an unfinished shape on the top layer stays on the overlay canvas
      // (nothing is above it), but on a lower layer it is composited here so higher layers stay above it.
      if (current && current.kind === "draw" && current.layerId === layerId && (!current.shape || !isTopLayerId(layerId))) {
        compositeLive(current);
      }
    }
    for (const preview of remoteStrokePreviews.values()) {
      if (preview.kind === "erase" || preview.layerId !== layerId || !remotePreviewUsesVisibleCanvas(preview)) continue;
      compositeLive(preview);
    }
  }
}

// A remote draw preview on the top layer can sit on the overlay canvas (nothing is above it). One on a
// lower layer is composited into the visible canvas by repaintVisibleCanvas so higher layers stay above it.
function remotePreviewUsesVisibleCanvas(preview) {
  const ids = layerIdsFor(isPublicCanvas);
  return preview.layerId !== ids[ids.length - 1];
}

function isTopLayerId(layerId) {
  const ids = layerIdsFor(isPublicCanvas);
  return layerId === ids[ids.length - 1];
}

async function loadOps() {
  const res = await fetch(opsUrl);
  allOps = await res.json(); // already server-seq-ordered; this exact array (not owner grouping) drives stacking order
  invalidateRenderOrder();
  opsByOwner = new Map();
  layers = new Map();
  for (const op of allOps) {
    if (!opsByOwner.has(op.ownerId)) opsByOwner.set(op.ownerId, []);
    opsByOwner.get(op.ownerId).push(op);
  }
  rebuildAllLayers();
  // A full reload (an undo/redo landing, local or remote) rebuilds every
  // owner's real layer from scratch -- any snapshot an active remote erase
  // preview was built from is stale the instant that happens, so drop it
  // rather than let it keep clipping against a now-outdated "before" state.
  // The owner's next "stroke" broadcast (if that gesture is in fact still
  // going) takes a fresh snapshot from the just-rebuilt real layer.
  clearAllRemoteStrokePreviews();
}

// myNickname is null until this owner has ever completed the one-time setup
// / Profile popover (GET /api/me's own contract -- see server/index.js) --
// that null is the one and only signal maybeShowGuestSetup acts on.
// myCursorColor always has a starting value (the guest-setup dialog's own
// default swatch) so there's something sane to show before any profile is
// ever saved.
let myNickname = null;
let myCursorColor = "#1e88e5";

async function loadMe() {
  const res = await fetch("/api/me");
  const data = await res.json();
  myOwnerId = data.ownerId;
  myNickname = data.nickname;
  if (data.cursorColor) myCursorColor = data.cursorColor;
}

// --- Real-time sync (SSE) -------------------------------------------------
// Reuses the existing /api/ops(/rooms/:code)/stream endpoints -- generalized
// server-side from the pixel-art editor's own SSE machinery (see
// server/index.js's opSubscribers/broadcastOpEvent), now shared by this
// restored freehand document model too. The server sends a full
// authoritative snapshot as literally the first frame of every connection,
// including every reconnect, so a plain `sync` handler that replaces
// allOps/opsByOwner wholesale (loadOps's own existing full-reset behaviour)
// is correct for both the initial load and recovery after a dropped
// connection -- no separate GET request, no Last-Event-ID bookkeeping.
const streamUrl = `${opsUrl}/stream`;

function startRealtimeSync() {
  const source = new EventSource(streamUrl);

  source.addEventListener("sync", (event) => {
    allOps = JSON.parse(event.data).ops;
    invalidateRenderOrder();
    opsByOwner = new Map();
    layers = new Map();
    for (const op of allOps) {
      if (!opsByOwner.has(op.ownerId)) opsByOwner.set(op.ownerId, []);
      opsByOwner.get(op.ownerId).push(op);
    }
    rebuildAllLayers();
    // A fresh snapshot (initial connect or a reconnect) has no notion of
    // whatever in-progress strokes were mid-flight before it -- any preview
    // still showing at this point is already stale by definition, and the
    // owner it belongs to will simply repaint it from scratch on its next
    // "stroke" broadcast if the gesture is in fact still going.
    clearAllRemoteStrokePreviews();
  });

  source.addEventListener("op", (event) => {
    const data = JSON.parse(event.data);
    // Already applied locally the instant persistGesture's own fetch
    // resolved (see below) -- this is that same op's broadcast echoing
    // back, not new information.
    if (allOps.some((op) => op.id === data.id)) return;
    allOps.push(data);
    invalidateRenderOrder();
    if (!opsByOwner.has(data.ownerId)) opsByOwner.set(data.ownerId, []);
    opsByOwner.get(data.ownerId).push(data);
    // A remote collaborator's stroke was never painted locally (only our own
    // gestures are painted live, point by point, as they happen), so it
    // needs one real repaint to become visible -- just that one owner's own
    // (owner, layer) mask rebuilt, not every layer (rebuildAllLayers), which
    // is the whole reason ops are already kept per-owner.
    if (data.ownerId !== myOwnerId) {
      // The authoritative stroke has landed -- clear its temporary preview
      // (if any) in this same synchronous turn, immediately before painting
      // the real thing, so there is no frame in between where neither is
      // visible.
      clearRemoteStrokePreview(data.ownerId);
      rebuildLayerFromOps(data.ownerId, effectiveLayerId(data, isPublicCanvas));
      repaintVisibleCanvas();
    }
    updateUndoRedoButtons();
  });

  // Ephemeral, in-progress stroke previews -- never persisted, never
  // touching allOps/opsByOwner/any real layer. See
  // handleRemoteStrokeEvent/handleRemoteStrokeEndEvent above.
  source.addEventListener("stroke", (event) => handleRemoteStrokeEvent(JSON.parse(event.data)));
  source.addEventListener("stroke-end", (event) => handleRemoteStrokeEndEvent(JSON.parse(event.data)));

  // Undo/redo are rare next to the per-stroke frequency of "op", so there is
  // no need for a second, more surgical reconciliation path here: loadOps()
  // -- the exact same full reload performUndo/performRedo already trusted
  // before this event existed -- re-fetches the authoritative active-op list
  // and rebuilds every layer from it, correctly handling a remote or a local
  // undo/redo alike with the one already-proven code path.
  source.addEventListener("undo", loadOps);
  source.addEventListener("redo", loadOps);

  // Ephemeral collaborator cursors -- never persisted, never artwork, never
  // touching allOps/opsByOwner at all. See handleRemoteCursorEvent/
  // removeRemoteCursor below.
  source.addEventListener("cursor", (event) => handleRemoteCursorEvent(JSON.parse(event.data)));
  source.addEventListener("cursor-hide", (event) => removeRemoteCursor(JSON.parse(event.data).ownerId));

  // Deliberately no onerror/reconnect handling: EventSource retries
  // natively, and every retry is just a brand new connection to the same
  // route, which always answers with an equally fresh `sync` snapshot.
  // Closed automatically by the browser on navigation/unload; this app has
  // no in-page document-switching to additionally close it for (leaving a
  // room is always a full navigation -- see leaveRoom below).
  return source;
}

// --- Guest profile: one-time setup, Profile popover, preferences -----------
// Nickname and cursor colour are the server-side guest profile (server/
// db.js's guests table, POST /api/me/profile) -- the same record whichever
// of the one-time modal or the Profile popover last saved. The three
// visibility toggles are pure local preferences (like theme), never sent
// anywhere except as the per-request showCursor/showNickname flags the
// cursor endpoint already expected before this step (see
// handlePixelCursor's own, pre-existing contract in server/index.js) --
// "show others' cursors" has no server role at all, it only ever decides
// whether THIS tab renders an incoming cursor event.
const PROFILE_PREFS_KEY = "profilePrefs";

function loadProfilePrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_PREFS_KEY) ?? "{}");
    return {
      showNickname: parsed.showNickname !== false,
      showCursor: parsed.showCursor !== false,
      showOthersCursors: parsed.showOthersCursors !== false,
    };
  } catch {
    return { showNickname: true, showCursor: true, showOthersCursors: true };
  }
}

let profilePrefs = loadProfilePrefs();

function saveProfilePrefs() {
  localStorage.setItem(PROFILE_PREFS_KEY, JSON.stringify(profilePrefs));
}

// --- Layers: personal settings (name, visibility, selected layer) ----------
// Layer order/ids are fixed (public/layers.js); only these three things are
// ever personal to this viewer -- never sent to the server, never broadcast,
// never visible to anyone else. Same "local-only preference" contract as
// profilePrefs above, with one addition this app has no prior precedent for:
// isolation per canvas/room, since a Private Room's own layer names/hidden
// state must never leak into (or be overwritten by) a different room's, or
// Public's own. See public/layers.js's layerSettingsStorageKey/
// parseLayerSettings for the key scheme and defaulting rules.
const LAYER_IDS = layerIdsFor(isPublicCanvas);
const LAYER_DEFAULT_NAMES = defaultLayerNamesFor(isPublicCanvas);
const LAYER_SETTINGS_KEY = layerSettingsStorageKey(roomCode);

function loadLayerSettings() {
  return parseLayerSettings(localStorage.getItem(LAYER_SETTINGS_KEY), LAYER_IDS, LAYER_DEFAULT_NAMES);
}

let layerSettings = loadLayerSettings();

function saveLayerSettings() {
  localStorage.setItem(LAYER_SETTINGS_KEY, JSON.stringify(layerSettings));
}

// Not shown twice for the same held gesture attempt, and resets its own
// dismiss timer on a repeat trigger rather than stacking a second element --
// there is exactly one #layer-hidden-notice node, reused for every trigger.
let layerHiddenNoticeTimer = null;
const LAYER_HIDDEN_NOTICE_MS = 2500;

function showLayerHiddenNotice() {
  layerHiddenNoticeEl.textContent = "This layer is hidden. Make it visible to draw.";
  layerHiddenNoticeEl.hidden = false;
  clearTimeout(layerHiddenNoticeTimer);
  layerHiddenNoticeTimer = setTimeout(() => {
    layerHiddenNoticeEl.hidden = true;
  }, LAYER_HIDDEN_NOTICE_MS);
}

// Which layer card (if any) is currently showing its name as an editable
// input rather than plain text -- at most one at a time, mirroring the
// "exactly one popover open" assumption the profile/colour popovers already
// make elsewhere in this file. renamingControlsEl is the input+checkmark
// wrapper for that one rename in progress -- the exact element the
// outside-click handler below treats as "inside" (everything else, including
// the rest of that same card, counts as "outside" and cancels).
let renamingLayerId = null;
let renamingControlsEl = null;

function selectLayer(layerId) {
  if (layerId === layerSettings.selected) return;
  layerSettings.selected = layerId;
  saveLayerSettings();
  renderLayerPanel();
}

function toggleLayerVisibility(layerId) {
  if (layerSettings.hidden[layerId]) delete layerSettings.hidden[layerId];
  else layerSettings.hidden[layerId] = true;
  saveLayerSettings();
  renderLayerPanel();
  // A visibility change can add or remove content from the composited
  // picture without any op itself changing -- repaint to reflect it
  // immediately, purely local, no fetch, no effect on allOps/the server.
  repaintVisibleCanvas();
  repaintRemoteStrokePreviews();
}

function beginRenameLayer(layerId) {
  renamingLayerId = layerId;
  renderLayerPanel();
}

function saveRenameLayer(layerId, rawValue) {
  const trimmed = rawValue.trim();
  // Empty/whitespace-only is rejected outright -- the previous name is kept,
  // exactly as if no edit had been attempted.
  if (trimmed.length > 0) {
    layerSettings.names[layerId] = trimmed;
    saveLayerSettings();
  }
  renamingLayerId = null;
  renamingControlsEl = null;
  renderLayerPanel();
}

function cancelRenameLayer() {
  renamingLayerId = null;
  renamingControlsEl = null;
  renderLayerPanel();
}

// Inline SVG eye / eye-with-slash, following the existing icon convention in
// this app (viewBox 0 0 24 24, currentColor) -- no eye icon exists anywhere
// else in the codebase to reuse.
const EYE_OPEN_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path d="M1.5 12 C4 7 8 4.5 12 4.5 C16 4.5 20 7 22.5 12 C20 17 16 19.5 12 19.5 C8 19.5 4 17 1.5 12 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />' +
  '<circle cx="12" cy="12" r="3.2" fill="currentColor" />' +
  "</svg>";
const EYE_CLOSED_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path d="M1.5 12 C4 7 8 4.5 12 4.5 C16 4.5 20 7 22.5 12 C20 17 16 19.5 12 19.5 C8 19.5 4 17 1.5 12 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />' +
  '<circle cx="12" cy="12" r="3.2" fill="currentColor" />' +
  '<line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />' +
  "</svg>";

// Rebuilds #layer-list's children from scratch -- cheap (2 or 4 cards, never
// a hot path), called once at boot and on every layerSettings/renamingLayerId
// change. Rendered in descending display order (highest layer first, per the
// LAYERS panel's visual spec) -- purely cosmetic ordering, independent of the
// bottom-to-top compositing order computed elsewhere from LAYER_IDS directly.
function renderLayerPanel() {
  layerListEl.replaceChildren();
  for (const layerId of [...LAYER_IDS].reverse()) {
    const card = document.createElement("div");
    card.className = "layer-card";
    if (layerId === layerSettings.selected) card.classList.add("selected");

    const eyeButton = document.createElement("button");
    eyeButton.type = "button";
    eyeButton.className = "layer-eye";
    const hidden = Boolean(layerSettings.hidden[layerId]);
    eyeButton.innerHTML = hidden ? EYE_CLOSED_SVG : EYE_OPEN_SVG;
    eyeButton.setAttribute("aria-label", hidden ? `Show ${layerSettings.names[layerId]}` : `Hide ${layerSettings.names[layerId]}`);
    eyeButton.setAttribute("aria-pressed", String(!hidden));
    eyeButton.addEventListener("click", (event) => {
      event.stopPropagation(); // never also triggers the card's own select-on-click handler
      toggleLayerVisibility(layerId);
    });
    card.appendChild(eyeButton);

    if (renamingLayerId === layerId) {
      // Wraps just the input + checkmark -- the one element the outside-click
      // handler below treats as "inside" the active edit. Everything else,
      // including the rest of this same card (the eye icon, clicking the
      // card background), counts as "outside" and cancels rather than saves.
      const controls = document.createElement("div");
      controls.className = "layer-rename-controls";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "layer-name-input";
      input.value = layerSettings.names[layerId];
      input.setAttribute("aria-label", "Layer name");
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          saveRenameLayer(layerId, input.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelRenameLayer();
        }
      });
      controls.appendChild(input);

      const confirmButton = document.createElement("button");
      confirmButton.type = "button";
      confirmButton.className = "layer-rename-confirm";
      confirmButton.setAttribute("aria-label", "Confirm layer name");
      confirmButton.textContent = "✓";
      confirmButton.addEventListener("click", (event) => {
        event.stopPropagation();
        saveRenameLayer(layerId, input.value);
      });
      controls.appendChild(confirmButton);

      controls.addEventListener("click", (event) => event.stopPropagation());
      card.appendChild(controls);
      renamingControlsEl = controls;

      // Auto-focus and select the existing name the instant this card
      // enters edit mode -- queued as a microtask so the input is already
      // attached to the document (replaceChildren above) before focus()/
      // select() are called on it.
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
    } else {
      const nameEl = document.createElement("span");
      nameEl.className = "layer-name";
      nameEl.textContent = layerSettings.names[layerId];
      card.appendChild(nameEl);
    }

    // Single click anywhere on the card selects. Double-click renames only when it lands on the card's
    // front/left half (by the card's own width, not the text's); the back half only selects.
    card.addEventListener("click", () => selectLayer(layerId));
    card.addEventListener("dblclick", (event) => {
      if (renamingLayerId === layerId) return; // already editing; the input handles its own double-clicks
      if (event.target instanceof Element && event.target.closest(".layer-eye")) return;
      selectLayer(layerId);
      const rect = card.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) beginRenameLayer(layerId);
    });
    layerListEl.appendChild(card);
  }
}

// Outside-click cancels an in-progress rename (never saves) -- the same
// document-level pointerdown + .contains() guard profilePopover/colourPopover
// already use elsewhere in this file, scoped to just the input+checkmark
// wrapper (renamingControlsEl), not the whole card or layer list -- clicking
// the eye icon, a different layer's card, or even this same card's own
// background outside the controls must cancel, never save. The confirm
// button's own click handler is inside that wrapper and calls
// stopPropagation, so a pointerdown there never reaches this listener at
// all, and can never race this cancel path.
document.addEventListener("pointerdown", (event) => {
  if (renamingLayerId === null || !renamingControlsEl) return;
  if (renamingControlsEl.contains(event.target)) return;
  cancelRenameLayer();
});
window.addEventListener("keydown", (event) => {
  if (renamingLayerId !== null && event.key === "Escape") cancelRenameLayer();
});

async function saveProfile(nickname, cursorColor) {
  const res = await fetch("/api/me/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname, cursorColor }),
  });
  if (!res.ok) return false;
  const saved = await res.json();
  myNickname = saved.nickname;
  myCursorColor = saved.cursorColor;
  return true;
}

// Shown once, the very first time this browser draws here with no nickname
// on record yet (GET /api/me's own nickname still null) -- completing it
// always sets one, so it is never shown again afterward.
function maybeShowGuestSetup() {
  if (myNickname !== null) return;
  guestSetupColourPicker.setValue(myCursorColor);
  guestSetupOverlay.hidden = false;
}

guestSetupConfirmButton.addEventListener("click", async () => {
  const nickname = guestSetupNicknameInput.value.trim();
  if (nickname.length === 0 || nickname.length > 20) return; // the form's own maxlength already stops longer input
  const ok = await saveProfile(nickname, guestSetupColourInput.value);
  if (!ok) return;
  guestSetupOverlay.hidden = true;
});

function openProfilePopover() {
  profileNicknameInput.value = myNickname ?? "";
  profileColourPicker.setValue(myCursorColor);
  profileShowNicknameInput.checked = profilePrefs.showNickname;
  profileShowCursorInput.checked = profilePrefs.showCursor;
  profileShowOthersInput.checked = profilePrefs.showOthersCursors;
  const rect = profileButton.getBoundingClientRect();
  const popoverWidth = 220;
  profilePopover.style.top = `${rect.bottom + 6}px`;
  profilePopover.style.left = `${Math.min(rect.left, window.innerWidth - popoverWidth - 8)}px`;
  profilePopover.hidden = false;
  profileButton.setAttribute("aria-expanded", "true");
}
function closeProfilePopover() {
  profilePopover.hidden = true;
  profileButton.setAttribute("aria-expanded", "false");
}
profileButton.addEventListener("click", () => {
  if (profilePopover.hidden) openProfilePopover();
  else closeProfilePopover();
});
profilePopoverClose.addEventListener("click", closeProfilePopover);
document.addEventListener("pointerdown", (event) => {
  if (profilePopover.hidden) return;
  if (profilePopover.contains(event.target) || profileButton.contains(event.target)) return;
  closeProfilePopover();
});
window.addEventListener("keydown", (event) => {
  if (!profilePopover.hidden && event.key === "Escape") closeProfilePopover();
});

profileSaveButton.addEventListener("click", async () => {
  const nickname = profileNicknameInput.value.trim();
  if (nickname.length === 0 || nickname.length > 20) return;
  const ok = await saveProfile(nickname, profileColourInput.value);
  if (!ok) return;
  profilePrefs = {
    showNickname: profileShowNicknameInput.checked,
    showCursor: profileShowCursorInput.checked,
    showOthersCursors: profileShowOthersInput.checked,
  };
  saveProfilePrefs();
  // Independent of drawing permissions, and effective immediately -- a
  // preference toggled off here must not wait for the next natural cursor
  // event to take visible effect.
  if (!profilePrefs.showCursor) hideMyCursor();
  if (!profilePrefs.showOthersCursors) clearAllRemoteCursors();
  closeProfilePopover();
});

// --- Cursor broadcasting ----------------------------------------------------
const cursorUrl = `${opsUrl}/cursor`;
const CURSOR_SEND_INTERVAL_MS = 100; // ~10/s: lightweight, still reads as live movement

let lastCursorSendAt = 0;

async function sendCursorUpdate(x, y) {
  if (!profilePrefs.showCursor) return;
  try {
    await fetch(cursorUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y, showCursor: true, showNickname: profilePrefs.showNickname }),
    });
  } catch {
    // best-effort, same spirit as every other ephemeral network call here (sendHeartbeat, etc.)
  }
}

async function hideMyCursor() {
  try {
    await fetch(cursorUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ showCursor: false }),
    });
  } catch {
    // best-effort
  }
}

// --- In-progress stroke broadcasting -----------------------------------------
// Lets other viewers see this gesture growing before pointerup, without
// persisting a single intermediate segment: every call here is the exact
// same ephemeral, best-effort POST pattern as sendCursorUpdate/hideMyCursor
// above, to a route (handleFreehandStrokePreview, server/index.js) that never
// touches insertOp or the ops table. Throttled independently of
// renderCurrentDelta's own per-animation-frame cadence (queueFrame can run
// far more often than this needs to send over the network) -- the FULL
// accumulated points-so-far are sent every time, not just the newest delta,
// so a single missed/delayed broadcast is harmless: the next one is already a
// complete, self-sufficient snapshot of the stroke so far, the same
// always-a-full-snapshot philosophy startRealtimeSync's own `sync` frame uses.
const strokeUrl = `${opsUrl}/stroke`;
const STROKE_SEND_INTERVAL_MS = 120;
let lastStrokeSendAt = 0;

async function sendStrokePreview(force) {
  if (!current) return;
  const now = Date.now();
  if (!force && now - lastStrokeSendAt < STROKE_SEND_INTERVAL_MS) return;
  lastStrokeSendAt = now;
  try {
    await fetch(strokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        active: true,
        kind: current.kind,
        color: current.color,
        size: current.size,
        points: current.points,
        layerId: current.layerId,
        ...(current.shape ? { shape: current.shape } : {}),
      }),
    });
  } catch {
    // best-effort
  }
}

// Sent the instant a gesture ends locally, whether or not persistGesture's
// own save goes on to succeed -- see handleRemoteStrokeEndEvent's own comment
// for how a remote viewer reconciles this against the real "op" event without
// a visible gap, and how a failed save still gets its stale preview cleaned
// up even though no "op" ever arrives to supersede it.
async function endStrokePreview() {
  try {
    await fetch(strokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
  } catch {
    // best-effort
  }
}

// --- Remote cursor rendering -------------------------------------------------
// Purely visual DOM elements inside #remote-cursors (position: absolute,
// pointer-events: none -- see styles.css) -- never drawn into #canvas's own
// 2D context, so a cursor can never become, or be mistaken for, saved
// artwork, and can never intercept a pointer event meant for the canvas.
const remoteCursors = new Map(); // ownerId -> { el, dotEl, labelEl, x, y, lastSeen }
const REMOTE_CURSOR_STALE_MS = 8000; // safety net for an abrupt disconnect that never sent cursor-hide

function remoteCursorScreenPosition(x, y) {
  // Same reference frame public/pixel-editor.js's own grid overlay already
  // uses (canvas.offsetLeft/offsetTop, relative to #canvas-viewport's own
  // positioned box): correct under panning for free, since an absolutely
  // positioned descendant of the scrolling container scrolls with its
  // content; correct under zoom because canvas.clientWidth/clientHeight
  // already reflect the current zoomed CSS size.
  return {
    left: canvas.offsetLeft + x * canvas.clientWidth,
    top: canvas.offsetTop + y * canvas.clientHeight,
  };
}

function ensureRemoteCursorEntry(ownerId) {
  let entry = remoteCursors.get(ownerId);
  if (!entry) {
    const el = document.createElement("div");
    el.className = "remote-cursor";
    const dotEl = document.createElement("div");
    dotEl.className = "remote-cursor-dot";
    const labelEl = document.createElement("span");
    labelEl.className = "remote-cursor-label";
    labelEl.hidden = true;
    el.appendChild(dotEl);
    el.appendChild(labelEl);
    remoteCursorsContainer.appendChild(el);
    entry = { el, dotEl, labelEl, x: 0, y: 0, lastSeen: 0 };
    remoteCursors.set(ownerId, entry);
  }
  return entry;
}

function removeRemoteCursor(ownerId) {
  const entry = remoteCursors.get(ownerId);
  if (!entry) return;
  entry.el.remove();
  remoteCursors.delete(ownerId);
}

function clearAllRemoteCursors() {
  for (const ownerId of [...remoteCursors.keys()]) removeRemoteCursor(ownerId);
}

function renderRemoteCursor(entry) {
  const { left, top } = remoteCursorScreenPosition(entry.x, entry.y);
  entry.el.style.left = `${left}px`;
  entry.el.style.top = `${top}px`;
}

// Called whenever THIS viewer's own zoom changes -- a remote cursor's last
// known normalized position never changes, but its on-screen pixel position
// does, exactly like every drawn pixel's own on-screen position does.
function repositionAllRemoteCursors() {
  for (const entry of remoteCursors.values()) renderRemoteCursor(entry);
}

function handleRemoteCursorEvent(data) {
  if (data.ownerId === myOwnerId) return; // never render an echo of my own cursor
  if (!profilePrefs.showOthersCursors) return;
  const entry = ensureRemoteCursorEntry(data.ownerId);
  entry.x = data.x;
  entry.y = data.y;
  entry.lastSeen = Date.now();
  entry.dotEl.style.background = data.color;
  entry.labelEl.style.background = data.color;
  if (data.nickname) {
    entry.labelEl.textContent = data.nickname;
    entry.labelEl.hidden = false;
  } else {
    entry.labelEl.hidden = true;
  }
  renderRemoteCursor(entry);
}

setInterval(() => {
  const now = Date.now();
  for (const [ownerId, entry] of remoteCursors) {
    if (now - entry.lastSeen > REMOTE_CURSOR_STALE_MS) removeRemoteCursor(ownerId);
  }
}, 3000);

// --- Remote in-progress stroke previews -------------------------------------
// Renders OTHER participants' strokes while they're still being dragged. A
// draw preview paints onto the dedicated #remote-stroke-preview overlay
// canvas, exactly like before -- never #canvas's own 2D context, allOps,
// opsByOwner, or any owner's real layer. An erase preview is different: an
// overlay canvas starts (and stays) transparent, so there is nothing for a
// destination-out stroke to reveal there the way there would be on the
// owner's real layer -- so instead it's reflected directly on the shared
// visible canvas itself, via a temporary, disposable copy of that owner's
// layer (see erasePreviewLayerFor/updateErasePreviewLayer below and
// repaintVisibleCanvas's own use of erasePreviewLayerFor), which
// repaintVisibleCanvas clips that owner's draw ops against instead of their
// real layer for as long as this preview is active. Either way, there is no
// code path through which a preview could become, or be mistaken for,
// persisted artwork: the only things that ever add a real op to allOps are
// the "op" SSE handler and persistGesture below, and the only thing that ever
// writes to layers.get(ownerId)'s own canvas is rebuildLayerFromOps/
// renderCurrentDelta (this owner's own local gesture) -- none of them touched
// by any of this. See handleFreehandStrokePreview in server/index.js for the
// matching ephemeral broadcast side (same never-persisted pattern as cursors,
// above).

function repaintRemoteStrokePreviews() {
  remoteStrokePreviewCtx.clearRect(0, 0, remoteStrokePreviewCanvas.width, remoteStrokePreviewCanvas.height);
  for (const preview of remoteStrokePreviews.values()) {
    if (preview.kind === "erase") continue; // rendered directly into the visible canvas instead -- see erasePreviewLayerFor
    if (remotePreviewUsesVisibleCanvas(preview)) continue; // lower-layer preview: composited in layer order by repaintVisibleCanvas
    if (layerSettings.hidden[preview.layerId]) continue; // this viewer has locally hidden the layer this in-progress stroke belongs to
    renderPathOnLayer(remoteStrokePreviewCtx, "draw", preview.color, preview.size, preview.points, preview.shape);
  }
}

// (Re)computes preview.previewLayerCanvas -- a full, disposable copy of this
// owner's real layer with every point accumulated so far in this gesture
// erased out of it -- always recomputed from scratch from preview.
// snapshotCanvas (a plain pixel copy of the owner's real layer, taken once,
// the moment this preview first appears, and never touched again), never
// incrementally. A dropped or reordered "stroke" frame therefore can't
// compound an error: whichever one arrives next is still a complete,
// self-sufficient recomputation of "the whole gesture so far", exactly like
// the preview's own points already are (see handleFreehandStrokePreview,
// server/index.js). Nothing here ever reads from or writes to
// layers.get(ownerId)'s own canvas except the one, one-time, read-only
// drawImage that seeds the snapshot -- the owner's real, authoritative mask
// is otherwise completely untouched by any of this, however many times it
// recomputes or however this gesture ends.
function updateErasePreviewLayer(ownerId, preview) {
  const realLayer = layers.get(ownerLayerKey(ownerId, preview.layerId));
  if (!realLayer) return; // nothing persisted for this owner on this layer yet to preview erasing from
  if (!preview.snapshotCanvas) {
    preview.snapshotCanvas = document.createElement("canvas");
    preview.snapshotCanvas.width = canvas.width;
    preview.snapshotCanvas.height = canvas.height;
    preview.snapshotCanvas.getContext("2d").drawImage(realLayer.canvas, 0, 0);
  }
  if (!preview.previewLayerCanvas) {
    preview.previewLayerCanvas = document.createElement("canvas");
    preview.previewLayerCanvas.width = canvas.width;
    preview.previewLayerCanvas.height = canvas.height;
  }
  const previewCtx = preview.previewLayerCanvas.getContext("2d");
  previewCtx.clearRect(0, 0, preview.previewLayerCanvas.width, preview.previewLayerCanvas.height);
  previewCtx.drawImage(preview.snapshotCanvas, 0, 0);
  renderPathOnLayer(previewCtx, "erase", null, preview.size, preview.points);
}

function clearRemoteStrokePreview(ownerId) {
  const preview = remoteStrokePreviews.get(ownerId);
  if (!preview) return;
  if (preview.endTimer !== null) clearTimeout(preview.endTimer);
  remoteStrokePreviews.delete(ownerId);
  if (preview.kind !== "erase" && preview.points && remotePreviewUsesVisibleCanvas(preview)) {
    repaintVisibleCanvas(unionRegions(preview.lastRegion, deltaRegionPixels(preview.points, preview.size)));
  } else if (preview.kind === "erase" && preview.points) {
    // Restores this owner's real, committed layer over exactly the region
    // this preview's erase might have affected. On the "the real op landed"
    // path this is redundant with (but harmless before) the fuller repaint
    // that follows it there; on every OTHER path this preview can end --
    // persistGesture failed, the drawing client disconnected outright, or
    // this preview simply went stale -- nothing else is guaranteed to ever
    // repaint this region again, so without this an abandoned erase would
    // stay visibly (but never actually) erased forever: an exact restore to
    // the last real committed appearance, not just "stop changing further".
    repaintVisibleCanvas(deltaRegionPixels(preview.points, preview.size));
  } else {
    repaintRemoteStrokePreviews();
  }
}

function clearAllRemoteStrokePreviews() {
  for (const ownerId of [...remoteStrokePreviews.keys()]) clearRemoteStrokePreview(ownerId);
}

function handleRemoteStrokeEvent(data) {
  if (data.ownerId === myOwnerId) return; // never preview an echo of my own in-progress gesture
  let preview = remoteStrokePreviews.get(data.ownerId);
  if (!preview) {
    preview = { endTimer: null, snapshotCanvas: null, previewLayerCanvas: null };
    remoteStrokePreviews.set(data.ownerId, preview);
  } else if (preview.endTimer !== null) {
    // Fresh progress for this owner supersedes any earlier stroke-end grace
    // timer -- that timer belonged to a previous (already-finished) stroke,
    // and must never fire against this new, still-in-progress one.
    clearTimeout(preview.endTimer);
    preview.endTimer = null;
  }
  preview.kind = data.kind;
  preview.color = data.color;
  preview.size = data.size;
  preview.points = data.points;
  preview.shape = data.shape;
  // Defaulted the same way a real op's missing/stale layerId is (bottom
  // layer) -- a preview from an older client with no layerId at all still
  // gets a sensible, deterministic layer to preview erasing from.
  preview.layerId = effectiveLayerId({ layerId: data.layerId }, isPublicCanvas);
  preview.lastSeen = Date.now();
  if (data.kind === "erase") {
    updateErasePreviewLayer(data.ownerId, preview);
    // Regional, not a full repaint -- the same reasoning as the local live
    // erase preview's own repaintVisibleCanvas(deltaRegionPixels(...)) call
    // in renderCurrentDelta: an erase can only shrink pixels already inside
    // its own bounding box, so nothing outside it could possibly have
    // changed.
    repaintVisibleCanvas(deltaRegionPixels(preview.points, preview.size));
  } else if (remotePreviewUsesVisibleCanvas(preview)) {
    // Lower layer: composite in layer order. The union with last frame's region also clears a shrinking shape.
    const region = deltaRegionPixels(preview.points, preview.size);
    repaintVisibleCanvas(unionRegions(preview.lastRegion, region));
    preview.lastRegion = region;
    repaintRemoteStrokePreviews();
  } else {
    repaintRemoteStrokePreviews();
  }
}

function unionRegions(a, b) {
  if (!a) return b;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, width: Math.max(a.x + a.width, b.x + b.width) - x0, height: Math.max(a.y + a.height, b.y + b.height) - y0 };
}

// The drawing client sends stroke-end the instant its own gesture ends,
// whether or not persistence goes on to succeed (see endGesture/
// endStrokePreview below). Rather than clear the preview immediately here --
// which would blank it out right before the real stroke appears -- arm a
// short grace timer instead: the normal "op" broadcast almost always arrives
// within this window (see startRealtimeSync's "op" listener, which clears any
// pending preview the instant it does) and replaces the preview with the
// authoritative committed stroke in the very same synchronous turn, so there
// is no visible gap or flicker. Only when nothing ever supersedes it --
// persistGesture failed, or the drawing client disconnected outright -- does
// this timer actually fire, which is what keeps a failed or abandoned stroke
// from leaving a permanent ghost on every other viewer's screen.
function handleRemoteStrokeEndEvent(data) {
  const preview = remoteStrokePreviews.get(data.ownerId);
  if (!preview || preview.endTimer !== null) return;
  preview.endTimer = setTimeout(() => clearRemoteStrokePreview(data.ownerId), STROKE_PREVIEW_END_GRACE_MS);
}

setInterval(() => {
  const now = Date.now();
  for (const [ownerId, preview] of remoteStrokePreviews) {
    if (now - preview.lastSeen > STROKE_PREVIEW_STALE_MS) clearRemoteStrokePreview(ownerId);
  }
}, 2000);

function pointerPos(event) {
  return toNormalized(event.clientX, event.clientY);
}

// Every point the browser actually sampled since the last event
// (getCoalescedEvents), not just the one coalesced event the browser chose to
// dispatch -- so a fast drag's true path is captured even when pointer
// polling outpaces frame rate. Falls back to the event itself wherever
// coalesced events aren't available, or report none. Kept from the earlier
// vector-fragment implementation: denser sampling is just as necessary for
// faithful raster replay (a fast sweep must erase continuously, not in
// gaps) as it was for exact capsule geometry, so this one piece survives the
// migration unchanged.
function coalescedPositions(event) {
  const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const samples = coalesced.length > 0 ? coalesced : [event];
  return samples.map(pointerPos);
}

function queueFrame() {
  if (frameHandle === null) {
    frameHandle = requestAnimationFrame(() => {
      frameHandle = null;
      renderCurrentDelta();
    });
  }
}

function cancelFrame() {
  if (frameHandle !== null) {
    cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
}

// Paints only the portion of the in-progress gesture accumulated since the
// last render -- not the whole path again -- directly onto the local
// owner's own layer, then recomposites. This is what makes drawing and
// erasing visible immediately, every frame, without waiting on the network:
// the pixels are already final by the time persistGesture's request even
// goes out, so there is nothing left to reconcile when it comes back.
function renderCurrentDelta() {
  if (!current || myOwnerId === null) return;
  const layer = ensureLayer(myOwnerId, current.layerId);
  const delta = current.points.slice(currentLastRenderedIndex);
  renderPathOnLayer(layer.ctx, current.kind, current.color, current.size, delta);
  currentLastRenderedIndex = current.points.length - 1;
  // Never painted straight onto the visible canvas: a regional, layer-ordered repaint composites this
  // stroke (draw: from `current`; erase: through the owner's mask) at its own layer's position. Only the
  // pixels this frame's delta touches can have changed, so the repaint is restricted to that region.
  repaintVisibleCanvas(deltaRegionPixels(delta, current.size));
  sendStrokePreview(false);
}

// The pixel-space rectangle a stroke delta could possibly have painted into:
// its own bounding box, padded by half the stroke width plus a couple of
// pixels for antialiased edges.
function deltaRegionPixels(points, sizeNormalized) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const padPx = brushSizeToDocumentPx(sizeNormalized, DOCUMENT_WIDTH) / 2 + 2;
  const x0 = minX * canvas.width - padPx;
  const y0 = minY * canvas.height - padPx;
  const x1 = maxX * canvas.width + padPx;
  const y1 = maxY * canvas.height + padPx;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// The owner's layer exactly as it was when the current ERASE began (null for any other gesture). Live
// erasing strokes each frame's few points as a separate path, and every separate round-capped
// destination-out stroke composites against the partly erased edge left by the one before, so the
// live mask drifts from the one replay builds by stroking the whole path once (thousands of antialiased
// edge pixels, alpha up to ~100/255, measured). endGesture restores this snapshot and erases the
// whole path once, which is bit-identical to replay.
let eraseLayerSnapshot = null;

function snapshotLayerForErase() {
  const layer = ensureLayer(myOwnerId, layerSettings.selected);
  if (!eraseLayerSnapshot || eraseLayerSnapshot.width !== layer.canvas.width || eraseLayerSnapshot.height !== layer.canvas.height) {
    eraseLayerSnapshot = document.createElement("canvas");
    eraseLayerSnapshot.width = layer.canvas.width;
    eraseLayerSnapshot.height = layer.canvas.height;
  }
  const sctx = eraseLayerSnapshot.getContext("2d");
  sctx.clearRect(0, 0, eraseLayerSnapshot.width, eraseLayerSnapshot.height);
  sctx.drawImage(layer.canvas, 0, 0);
}

function beginGesture(kind, point) {
  if (myOwnerId === null) return;
  // Blocked before any state mutation (no current set, no snapshot taken, no
  // layer/canvas touched) -- a hidden layer's content must never be drawn or
  // erased while it's hidden, only resume once it's visible again.
  if (layerSettings.hidden[layerSettings.selected]) {
    showLayerHiddenNotice();
    return;
  }
  eraseLayerSnapshot && kind !== "erase" && (eraseLayerSnapshot = null);
  if (kind === "erase") snapshotLayerForErase();
  current = {
    kind,
    color: kind === "erase" ? null : color,
    size: (kind === "erase" ? eraserSizePx : brushSizePx) / canvas.width,
    points: [point],
    layerId: layerSettings.selected,
  };
  currentLastRenderedIndex = 0;
  renderCurrentDelta();
  updateUndoRedoButtons(); // a gesture just became pending -- disable until it resolves
}

function appendToGesture(points) {
  if (!current) return;
  if (current.shape) return; // a shape gesture is driven by updateShapeGesture, never by appended freehand points
  current.points.push(...points);
  queueFrame();
}

// --- Shape gestures (Line / Rectangle / Ellipse) ------------------------------
// A shape gesture reuses `current` so Undo/Redo guards, pending-op bookkeeping,
// persistence and the realtime "op" broadcast all work exactly as for a brush
// stroke. Its `points` is always [anchor, end] (document-normalised), where
// `end` is recomputed from the anchor, the raw pointer and the CURRENT Shift
// state on every change -- so the preview, the committed op and a remote
// replay all come from the single constrainCorner/paintShape geometry in
// shapes.js. While dragging, the shape is painted ONLY on the preview overlay
// (never on the real canvas or the owner's layer), so cancelling it can leave
// no trace; pointer-up is what commits it.
let shapeRawPointer = null; // latest raw pointer position (document-normalised) of the active shape drag
let shapeShift = false; // Shift state, kept live by pointermove/keydown/keyup

function shapeEnd(type, anchorNorm, pointerNorm, shift) {
  // Constrain in document PIXELS (the aspect-correct space) and convert back,
  // so square/circle/equilateral are true on the 1920x1080 document and not
  // merely equal in the normalised, non-square [0,1] space.
  const a = toPixels(anchorNorm);
  const p = toPixels(pointerNorm);
  const end = constrainCorner(type, a, p, shift);
  return { x: end.x / DOCUMENT_WIDTH, y: end.y / DOCUMENT_HEIGHT };
}

function beginShapeGesture(type, point) {
  if (myOwnerId === null) return;
  // Same hidden-active-layer guard as beginGesture: blocked before any state
  // mutation, so no pointer capture side effect reaches an actual shape being
  // created or persisted while its layer is hidden.
  if (layerSettings.hidden[layerSettings.selected]) {
    showLayerHiddenNotice();
    return;
  }
  current = {
    kind: "draw",
    color,
    size: brushSizePx / canvas.width,
    points: [point, point],
    shape: type === "line" ? { type } : { type, mode: shapeMode },
    layerId: layerSettings.selected,
  };
  shapeRawPointer = point;
  currentLastRenderedIndex = 0;
  paintShapePreview();
  updateUndoRedoButtons();
}

function updateShapeGesture() {
  if (!current || !current.shape || shapeRawPointer === null) return;
  current.points = [current.points[0], shapeEnd(current.shape.type, current.points[0], shapeRawPointer, shapeShift)];
  paintShapePreview();
  sendStrokePreview(false);
}

// Pixel region the lower-layer shape preview last occupied on the visible canvas (null when none).
let shapePreviewRegion = null;

function paintShapePreview() {
  repaintRemoteStrokePreviews();
  if (!current || !current.shape) return;
  if (isTopLayerId(current.layerId)) {
    renderPathOnLayer(remoteStrokePreviewCtx, "draw", current.color, current.size, current.points, current.shape);
    return;
  }
  // Lower layer: the overlay would sit above higher layers, so composite the preview in layer order instead,
  // repainting only the union of where it was and where it is now (also clears a shrinking shape).
  const region = deltaRegionPixels(current.points, current.size);
  repaintVisibleCanvas(unionRegions(shapePreviewRegion, region));
  shapePreviewRegion = region;
}

// Removes a lower-layer shape preview from the visible canvas once `current` no longer holds it.
function clearShapePreviewRegion() {
  const region = shapePreviewRegion;
  shapePreviewRegion = null;
  if (region) repaintVisibleCanvas(region);
}

// The pointer that started the active freehand/erase gesture (see lostpointercapture).
let gesturePointerId = null;

// Drops a Brush/Eraser gesture whose pointer capture was lost without a pointerup: nothing is saved or
// broadcast as an op. The stroke was painted live into the owner's layer and onto the visible canvas, so
// rebuild both from the committed (and still-pending) ops, which removes it; a stroke that was never
// persisted is not in them.
function cancelFreehandGesture() {
  if (!current || current.shape) return;
  const cancelledLayerId = current.layerId;
  cancelFrame();
  current = null;
  gesturePointerId = null;
  // rebuildAllLayers only rebuilds owners that have committed ops; if this guest has none yet, clear
  // their layer explicitly so the abandoned stroke does not linger in it.
  if (myOwnerId !== null && !opsByOwner.has(myOwnerId)) rebuildLayerFromOps(myOwnerId, cancelledLayerId);
  rebuildAllLayers();
  endStrokePreview();
  updateUndoRedoButtons();
}

// Drops an unfinished shape without saving, broadcasting an op, or leaving any
// pixels behind (the preview overlay is simply repainted without it).
function cancelShapeGesture() {
  if (!current || !current.shape) return;
  cancelFrame();
  current = null;
  shapeRawPointer = null;
  clearShapePreviewRegion();
  repaintRemoteStrokePreviews();
  endStrokePreview();
  updateUndoRedoButtons();
}

async function persistGesture(finished) {
  const endpoint = finished.kind === "erase" ? eraseUrl : drawUrl;
  const body =
    finished.kind === "erase"
      ? { radius: finished.size / 2, points: finished.points, layerId: finished.layerId }
      : {
          color: finished.color,
          width: finished.size,
          points: finished.points,
          layerId: finished.layerId,
          ...(finished.shape ? { shape: finished.shape } : {}),
        };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${endpoint} responded ${res.status}`);
    const saved = await res.json();
    const op = {
      seq: saved.seq,
      id: saved.id,
      ownerId: saved.ownerId,
      kind: finished.kind,
      color: finished.color,
      size: finished.size,
      points: finished.points,
      createdAt: saved.createdAt,
      layerId: finished.layerId,
      ...(finished.shape ? { shape: finished.shape } : {}),
    };
    // Appended at the end: with no live multi-user sync yet, nothing else
    // locally inserts an op into allOps mid-session, so this is always the
    // new highest-seq entry for this client's own view.
    // The SSE "op" echo can land before this response; never record the same op twice.
    if (!allOps.some((existing) => existing.id === op.id)) {
      allOps.push(op);
      invalidateRenderOrder();
      if (!opsByOwner.has(myOwnerId)) opsByOwner.set(myOwnerId, []);
      opsByOwner.get(myOwnerId).push(op);
    }
    // Already painted onto my own layer live, point by point, as the
    // gesture happened -- this only keeps the replay history in sync for a
    // future resize/reload. No re-render here: the server never recomputes
    // or transforms this op's geometry, so there is nothing that could
    // disagree with what's already on screen, and so nothing to pop.
    // This owner's remaining redo branch in this scope was just abandoned
    // server-side (see handleDraw/handleErase's abandonRedoBranch call) --
    // mirror that locally so the Redo button doesn't stay enabled for a
    // branch that no longer exists. Unconditional: Public and Private alike.
    myRedoCount = 0;
  } catch {
    // Best-effort; the gesture is already visible locally even if this
    // particular persistence call failed.
  } finally {
    // Whether or not persistence succeeded, this gesture is no longer the
    // thing standing between a from-scratch repaint and a blank spot where
    // it used to be: on success allOps now replays it; on failure it's left
    // exactly as visible as it already was, which is the pre-existing
    // best-effort contract above, not something this gap-closing fix changes.
    if (finished.kind === "draw") pendingOps = pendingOps.filter((op) => op !== finished);
    else unconfirmedErases = unconfirmedErases.filter((op) => op !== finished);
    updateUndoRedoButtons();
  }
}

// At the end of an erase: make the owner's layer mask exactly what replay will build (restore the pre-erase
// snapshot, erase the whole path once), then repaint the visible canvas -- but only the rows where the mask
// really changed, found by diffing the alpha channel of the live mask against the reconciled one. That region
// is a thin band along the stroke's antialiased edges, so this stays cheap however many ops exist; the old
// full-history repaint cost one 1920x1080 composite per op in a single blocking task (~1 s at 120 ops).
function reconcileEraseMask() {
  if (!eraseLayerSnapshot || myOwnerId === null) return;
  const layer = ensureLayer(myOwnerId, current.layerId);
  const w = layer.canvas.width;
  const h = layer.canvas.height;
  const region = deltaRegionPixels(current.points, current.size);
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(w, Math.ceil(region.x + region.width));
  const y1 = Math.min(h, Math.ceil(region.y + region.height));
  if (x1 <= x0 || y1 <= y0) return;
  const rw = x1 - x0;
  const rh = y1 - y0;
  const before = layer.ctx.getImageData(x0, y0, rw, rh).data;
  layer.ctx.clearRect(x0, y0, rw, rh);
  layer.ctx.drawImage(eraseLayerSnapshot, x0, y0, rw, rh, x0, y0, rw, rh);
  // the whole path once, clipped to the box (nothing outside it can have been touched by this erase)
  layer.ctx.save();
  layer.ctx.beginPath();
  layer.ctx.rect(x0, y0, rw, rh);
  layer.ctx.clip();
  renderPathOnLayer(layer.ctx, "erase", null, current.size, current.points);
  layer.ctx.restore();
  const after = layer.ctx.getImageData(x0, y0, rw, rh).data;
  // Mark the TILES that contain a changed mask pixel. The changed pixels lie along a thin curve (the stroke's
  // antialiased edges), so a bounding box of them can be nearly the whole canvas; repainting tile by tile makes
  // the cost follow the edge length instead.
  const TILE = 64;
  const tilesX = Math.ceil(rw / TILE);
  const dirty = new Set();
  for (let i = 3, p = 0; i < after.length; i += 4, p++) {
    if (after[i] !== before[i]) {
      const px = p % rw;
      const py = (p - px) / rw;
      dirty.add(Math.floor(py / TILE) * tilesX + Math.floor(px / TILE));
    }
  }
  eraseLayerSnapshot = null;
  for (const key of dirty) {
    const tx = (key % tilesX) * TILE;
    const ty = Math.floor(key / tilesX) * TILE;
    // one pixel of margin so the repaint covers the antialiased fringe on the tile border
    repaintVisibleCanvas({ x: x0 + tx - 1, y: y0 + ty - 1, width: Math.min(TILE, rw - tx) + 2, height: Math.min(TILE, rh - ty) + 2 });
  }
}

function endGesture() {
  if (!current) return;
  if (current.shape) {
    const [a, b] = current.points;
    if (!isMeaningfulShape(current.shape.type, toPixels(a), toPixels(b))) {
      cancelShapeGesture(); // a click (or a degenerate drag) must not create an accidental shape
      return;
    }
    // Commit: paint onto the owner's own layer (so erasing and replay agree)
    // and the visible canvas, then hand off to the normal persist path.
    const layer = ensureLayer(myOwnerId, current.layerId);
    renderPathOnLayer(layer.ctx, "draw", current.color, current.size, current.points, current.shape);
    const finishedShape = current;
    current = null;
    shapeRawPointer = null;
    endStrokePreview();
    pendingOps.push(finishedShape);
    // The shape now lives in pendingOps (no longer `current`): composite it at its layer position, over the
    // footprint of both the preview it replaces and itself, and drop any top-layer overlay preview in the
    // same synchronous turn so it is never visible twice or not at all.
    const previewRegion = shapePreviewRegion;
    shapePreviewRegion = null;
    repaintVisibleCanvas(unionRegions(previewRegion, opPixelBounds(finishedShape)));
    repaintRemoteStrokePreviews();
    updateUndoRedoButtons();
    persistGesture(finishedShape);
    return;
  }
  cancelFrame();
  renderCurrentDelta(); // flush any points accumulated since the last rendered frame
  // One final, forced (non-throttled) preview send with the now-complete
  // points, while `current` still holds them -- guarantees remote viewers'
  // preview shows the exact final shape right before it gets reconciled away
  // by the real "op" broadcast persistGesture's save triggers below.
  sendStrokePreview(true);
  if (current.kind === "erase") reconcileEraseMask();
  const finished = current;
  current = null;
  // Tells every other viewer this stroke is no longer in progress, whether or
  // not persistGesture's own save (below) goes on to succeed -- see
  // handleRemoteStrokeEndEvent's own comment for why this never races the
  // real "op" broadcast into a visible gap or a stuck ghost preview.
  endStrokePreview();
  // Handed off to pendingOps before persistGesture's first await: a repaint
  // triggered by anything (the fade tick, a resize) between here and
  // persistGesture's op landing in allOps must still find this gesture
  // somewhere to paint, since allOps itself doesn't have it yet.
  if (finished.kind === "draw") pendingOps.push(finished);
  else unconfirmedErases.push(finished);
  updateUndoRedoButtons();
  persistGesture(finished);
}

// True whenever an unconfirmed gesture exists: either still being dragged
// (`current`) or finished locally but not yet confirmed persisted
// (`pendingOps`). Undo/redo must never race one of these -- the server-side
// "latest active op" or "latest redoable op" it would act on could change the
// instant persistGesture's response lands, which is exactly the ambiguity
// this guard exists to avoid.
function hasPendingGesture() {
  return current !== null || pendingOps.length > 0;
}

// Shared by Public and Private alike. canUndo is read directly off
// opsByOwner -- the exact set of this owner's currently active ops in this
// scope, already kept correct by every loadOps()/persistGesture call -- so it
// needs no separate tracking. canRedo relies on myRedoCount (see its
// declaration above) since that information doesn't otherwise exist on the
// client.
function updateUndoRedoButtons() {
  const pending = hasPendingGesture();
  const myOwnOps = opsByOwner.get(myOwnerId) ?? [];
  undoButton.disabled = pending || myOwnOps.length === 0;
  redoButton.disabled = pending || myRedoCount <= 0;
}

async function performUndo() {
  if (hasPendingGesture()) return;
  const res = await fetch(undoUrl, { method: "POST" });
  if (!res.ok) return;
  const { op } = await res.json();
  if (!op) return; // nothing left to undo -- not an error, just a no-op
  myRedoCount += 1;
  updateUndoRedoButtons(); // the Redo button's own enablement only ever depends on local myRedoCount, not on allOps
  // allOps/opsByOwner/the repaint all update once the matching `undo` SSE
  // broadcast echoes back (startRealtimeSync's own loadOps call, above) --
  // the exact same event a remote collaborator's own undo delivers, so both
  // are handled by one code path, never two.
}

async function performRedo() {
  if (hasPendingGesture()) return;
  const res = await fetch(redoUrl, { method: "POST" });
  if (!res.ok) return;
  const { op } = await res.json();
  if (!op) return; // nothing left to redo
  myRedoCount = Math.max(0, myRedoCount - 1);
  updateUndoRedoButtons();
}

// Clamps a backing-store pixel index into [0, exclusiveMax - 1] -- the valid
// row/column range for an exclusiveMax-wide/tall bitmap -- so a pointer at
// the extreme edge of the canvas never requests an out-of-bounds pixel.
function clampPixelIndex(n, exclusiveMax) {
  return Math.min(exclusiveMax - 1, Math.max(0, n));
}

// Eyedropper: reads the exact colour already visible on #canvas at this
// point. repaintVisibleCanvas has already done all the real work by the time
// this runs -- seq-ordered overlap, owner-clipped erasing, Public fade, and
// any still-pending/in-progress local strokes are all already baked into
// this one bitmap -- so this never replays ops, looks at owner layers, or
// reconstructs fade; it just reads one pixel from the same context every
// other repaint already draws into.
//
// The one thing that pixel read can't see on its own: #canvas's own bitmap
// is transparent (alpha 0) wherever nothing has been drawn, since the white
// the user sees there is a separate, literal, never-themed CSS background
// (#canvas { background: #ffffff }, styles.css) that getImageData cannot
// read. compositeOverWhite (sampling.js) recovers the colour actually
// visible on screen from the raw RGBA, for a fully empty pixel, a fully
// opaque one, and every anti-aliased/faded alpha in between.
function sampleColourAt(point) {
  const pixel = toPixels(point);
  const x = clampPixelIndex(Math.floor(pixel.x), canvas.width);
  const y = clampPixelIndex(Math.floor(pixel.y), canvas.height);
  const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
  colourPicker.setColor(rgbToHex(compositeOverWhite(r, g, b, a)));
  setMode("brush");
}

// Middle-mouse drag pan: pure workspace-viewport scroll state, isolated from
// every drawing tool. Checked first, before the Eyedropper branch, before
// setPointerCapture-for-drawing, and before beginGesture -- so a middle-click
// can never be interpreted as a draw/erase gesture, never creates an op or an
// Undo/Redo entry, never sends a persistence request, and never touches
// colour/tool state. Baseline pan (wheel/trackpad/scrollbar) needs no code at
// all: it's native #canvas-viewport overflow:auto, including its scroll-range
// clamping -- see styles.css.
let panState = null; // { pointerId, startClientX, startClientY, startScrollLeft, startScrollTop } | null

function beginPan(event) {
  canvas.setPointerCapture(event.pointerId);
  panState = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startScrollLeft: canvasViewport.scrollLeft,
    startScrollTop: canvasViewport.scrollTop,
  };
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 1) {
    event.preventDefault(); // suppress the browser's own middle-click autoscroll/paste behaviour
    beginPan(event);
    return;
  }
  if (mode === "eyedropper") {
    // Read-only and one-shot: no pointer capture, no gesture, so this can
    // never create a DRAW/ERASE op, an Undo/Redo entry, or a persistence
    // request, and never touches room/presence state.
    sampleColourAt(pointerPos(event));
    return;
  }
  canvas.setPointerCapture(event.pointerId);
  if (shapeToolButtons[mode]) {
    shapeShift = event.shiftKey;
    beginShapeGesture(mode, pointerPos(event));
    return;
  }
  gesturePointerId = event.pointerId;
  beginGesture(mode === "eraser" ? "erase" : "draw", pointerPos(event));
});

canvas.addEventListener("pointermove", (event) => {
  if (panState && event.pointerId === panState.pointerId) {
    // Native overflow:auto clamps scrollLeft/scrollTop to the valid range on
    // assignment, so no explicit clamping is needed here (see Correction 1:
    // no clampScrollOffset helper).
    canvasViewport.scrollLeft = panState.startScrollLeft - (event.clientX - panState.startClientX);
    canvasViewport.scrollTop = panState.startScrollTop - (event.clientY - panState.startClientY);
    return;
  }
  if (!current) return;
  if (current.shape) {
    shapeShift = event.shiftKey;
    shapeRawPointer = pointerPos(event);
    updateShapeGesture();
    return;
  }
  appendToGesture(coalescedPositions(event));
});

function endPointerAction(event) {
  if (panState && event.pointerId === panState.pointerId) {
    panState = null;
    return;
  }
  endGesture();
}
canvas.addEventListener("pointerup", (event) => {
  if (current && current.shape) {
    // Recompute the final geometry from the Shift state at release.
    shapeShift = event.shiftKey;
    shapeRawPointer = pointerPos(event);
    updateShapeGesture();
  }
  endPointerAction(event);
});
canvas.addEventListener("pointercancel", (event) => {
  if (current && current.shape) {
    cancelShapeGesture(); // an interrupted shape drag is dropped, never committed
    return;
  }
  endPointerAction(event);
});
canvas.addEventListener("lostpointercapture", (event) => {
  if (current && current.shape) {
    cancelShapeGesture();
    return;
  }
  // A normal stroke ends with pointerup, which runs first and clears `current`, so reaching this point with
  // a live freehand/erase gesture means capture was lost without a pointerup. Only the pointer that started
  // the gesture counts (another finger lifting must not cancel it).
  if (current && event.pointerId === gesturePointerId) cancelFreehandGesture();
});

// Shift pressed or released mid-drag updates the preview immediately, without
// the pointer having to move. Escape cancels an unfinished shape.
window.addEventListener("keydown", (event) => {
  if (!current || !current.shape) return;
  if (event.key === "Escape") {
    event.preventDefault();
    cancelShapeGesture();
  } else if (event.key === "Shift" && !shapeShift) {
    shapeShift = true;
    updateShapeGesture();
  }
});
window.addEventListener("keyup", (event) => {
  if (event.key === "Shift" && current && current.shape && shapeShift) {
    shapeShift = false;
    updateShapeGesture();
  }
});

// Preset swatches + the integrated Hue-ring/SV-square wheel + RGB/HSV
// sliders: the established custom-colour interaction, extracted unchanged
// into public/colour-picker-ui.js (shared with public/pixel-editor.js, so
// there is exactly one colour-selection implementation, not two). `color`
// above is kept in sync via onChange -- the only thing this module's own
// internal brushColor/pickerHue state is responsible for externally.
const colourPicker = initColourPicker({
  initialColor: color,
  onChange: (hex) => {
    color = hex;
  },
});

toolSizeSlider.addEventListener("input", () => {
  const cfg = toolSizes[mode];
  cfg.set(Number(toolSizeSlider.value));
  toolSizeValue.textContent = `${cfg.get()}px`;
  updateCursorSize();
});

function setMode(newMode) {
  if (current && current.shape) cancelShapeGesture(); // switching tools mid-shape drops the preview
  mode = newMode;
  toolBrushButton.classList.toggle("selected", mode === "brush");
  toolEraserButton.classList.toggle("selected", mode === "eraser");
  for (const id of SHAPE_TOOL_IDS) {
    shapeToolButtons[id].classList.toggle("selected", mode === id);
    shapeToolButtons[id].setAttribute("aria-pressed", String(mode === id));
  }
  // The one Outline/Filled selector shows only for the three closed shapes.
  shapeModeControl.hidden = !(mode === "rectangle" || mode === "ellipse");
  toolEyedropperButton.classList.toggle("selected", mode === "eyedropper");
  toolBrushButton.setAttribute("aria-pressed", String(mode === "brush"));
  toolEraserButton.setAttribute("aria-pressed", String(mode === "eraser"));
  toolEyedropperButton.setAttribute("aria-pressed", String(mode === "eyedropper"));
  // Eyedropper has no on-canvas diameter to preview, so it gets a plain
  // native crosshair instead of the circular size-preview overlay Brush/
  // Eraser use (replaced by that overlay via updateCursorSize below).
  // Eyedropper and the shape tools have no circular brush footprint to preview.
  const crosshairTool = mode === "eyedropper" || Boolean(shapeToolButtons[mode]);
  canvas.style.cursor = crosshairTool ? "crosshair" : "none";
  if (crosshairTool) toolCursor.style.display = "none";
  syncSizeControlToMode();
  updateCursorSize();
  // Colour doesn't apply to the Eraser, but stays editable while it's active
  // (simpler and more predictable than disabling it -- see colour-group's own
  // styling); this is purely a visual hint, opacity-only so it can never shift
  // the ribbon's layout.
  colourGroup.classList.toggle("colour-controls-dimmed", mode === "eraser");
}

toolBrushButton.addEventListener("click", () => setMode("brush"));
toolEraserButton.addEventListener("click", () => setMode("eraser"));
for (const id of SHAPE_TOOL_IDS) shapeToolButtons[id].addEventListener("click", () => setMode(id));

function setShapeMode(next) {
  shapeMode = next;
  for (const [key, button] of Object.entries(shapeModeButtons)) {
    button.classList.toggle("selected", key === next);
    button.setAttribute("aria-pressed", String(key === next));
  }
}
shapeModeButtons.outline.addEventListener("click", () => setShapeMode("outline"));
shapeModeButtons.filled.addEventListener("click", () => setShapeMode("filled"));
toolEyedropperButton.addEventListener("click", () => setMode("eyedropper"));

// A circular outline tracking the pointer, sized to the tool's actual
// on-canvas diameter -- not a decorative icon, and never drawn into the
// canvas's own 2D context, so it can never end up in persisted artwork.
// brushSizePx/eraserSizePx are already defined in document-pixel terms
// (that's the slider's native unit; normalization only happens when a
// gesture's size is stored), but the cursor overlay is CSS-pixel chrome drawn
// over the (possibly zoomed) workspace -- so its diameter must additionally
// be scaled by the current zoom to visually match the footprint that will
// actually be painted (both tools stroke with lineWidth = size * document
// width). See cursorDiameterCssPx in viewport.js.
function currentToolDiameterPx() {
  return toolSizes[mode].get();
}

function updateCursorSize() {
  if (mode === "eyedropper" || shapeToolButtons[mode]) return; // no diameter to preview -- see setMode's native crosshair instead
  const diameter = cursorDiameterCssPx(currentToolDiameterPx(), zoom);
  toolCursor.style.width = `${diameter}px`;
  toolCursor.style.height = `${diameter}px`;
}

// --- Zoom / Fit -------------------------------------------------------------
// Zoom changes only the canvas's CSS display box (style.width/height), never
// canvas.width/height -- so it never clears, resizes, or replays a single
// pixel of artwork, and native #canvas-viewport overflow:auto automatically
// recomputes the scrollable range from the new display size with no explicit
// scroll-clamping code of our own.
const FIT_MARGIN_PX = 24;
let zoom = 1;

// Keeps #remote-stroke-preview's CSS box in exact lockstep with #canvas's own
// (same offset within their shared positioning context #canvas-viewport, same
// displayed size) -- the same offsetLeft/offsetTop/clientWidth/clientHeight
// #remote-cursors' own remoteCursorScreenPosition already reads for the same
// reason. Needed because, unlike #remote-cursors (one absolutely-positioned
// dot per owner, each placed individually), this overlay is itself a scaled
// <canvas> whose entire box must match #canvas's pixel-for-pixel for a
// normalized point painted into it to land on the same screen pixel.
function positionRemoteStrokePreview() {
  // The canvas is centred in a flex viewport, so its offset changes whenever the layout does (window
  // resize, a scrollbar appearing, the toolbar row settling) -- not only when zoom changes. Read the
  // fractional box (offset* and client* round to whole pixels, which left a sub-pixel error after Fit)
  // so the overlay always covers exactly the same screen rectangle as the canvas.
  const viewportRect = canvasViewport.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  remoteStrokePreviewCanvas.style.left = `${canvasRect.left - viewportRect.left + canvasViewport.scrollLeft - canvasViewport.clientLeft}px`;
  remoteStrokePreviewCanvas.style.top = `${canvasRect.top - viewportRect.top + canvasViewport.scrollTop - canvasViewport.clientTop}px`;
  remoteStrokePreviewCanvas.style.width = `${canvasRect.width}px`;
  remoteStrokePreviewCanvas.style.height = `${canvasRect.height}px`;
}

// Re-sync whenever the canvas or its viewport changes size or position for ANY reason. ResizeObserver
// fires on layout changes (window resize, toolbar/scrollbar changes, zoom); the window resize listener
// covers the canvas re-centring without its own size changing.
if (typeof ResizeObserver === "function") {
  const ro = new ResizeObserver(positionRemoteStrokePreview);
  ro.observe(canvas);
  ro.observe(canvasViewport);
}
window.addEventListener("resize", positionRemoteStrokePreview);

function applyZoom(nextZoom) {
  zoom = clampZoom(nextZoom);
  canvas.style.width = `${DOCUMENT_WIDTH * zoom}px`;
  canvas.style.height = `${DOCUMENT_HEIGHT * zoom}px`;
  zoomPercentDisplay.textContent = `${Math.round(zoom * 100)}%`;
  updateCursorSize();
  // A remote cursor's own normalized position never changes here -- only
  // its on-screen pixel position does, exactly like every drawn pixel's own
  // on-screen position does.
  repositionAllRemoteCursors();
  positionRemoteStrokePreview();
}

// One-shot: computed against whatever the workspace viewport measures right
// now. Never re-run automatically by a later browser resize -- only by the
// explicit initial boot-time call below, or a user click on Fit.
function applyFit() {
  applyZoom(fitZoom(canvasViewport.clientWidth, canvasViewport.clientHeight, DOCUMENT_WIDTH, DOCUMENT_HEIGHT, FIT_MARGIN_PX));
}

zoomInButton.addEventListener("click", () => applyZoom(stepZoom(zoom, ZOOM_LEVELS, 1)));
zoomOutButton.addEventListener("click", () => applyZoom(stepZoom(zoom, ZOOM_LEVELS, -1)));
fitButton.addEventListener("click", applyFit);

// Moves the circular cursor overlay via `transform: translate(...)` only --
// never left/top -- so the browser can reposition it on the compositor
// thread alone, with no layout/paint forced on #tool-cursor's `position:
// fixed` box every pointermove. The trailing `translate(-50%, -50%)`
// reproduces the exact same centering the CSS rule used to apply on its
// own (now folded in here since it has to share the transform property with
// the live position); same final on-screen box, just composited instead of
// laid out.
function positionToolCursor(clientX, clientY) {
  toolCursor.style.transform = `translate(${clientX}px, ${clientY}px) translate(-50%, -50%)`;
}

canvas.addEventListener("pointerenter", (event) => {
  if (mode === "eyedropper" || shapeToolButtons[mode]) return; // crosshair only, no circular overlay
  updateCursorSize();
  positionToolCursor(event.clientX, event.clientY);
  toolCursor.style.display = "block";
});

canvas.addEventListener("pointermove", (event) => {
  positionToolCursor(event.clientX, event.clientY);
  // Throttled, independent of drawing: broadcasts this tab's own position to
  // every other viewer of this exact document, regardless of which tool is
  // selected or whether a gesture is in progress.
  const now = Date.now();
  if (now - lastCursorSendAt >= CURSOR_SEND_INTERVAL_MS) {
    lastCursorSendAt = now;
    const pos = pointerPos(event);
    sendCursorUpdate(pos.x, pos.y);
  }
});

canvas.addEventListener("pointerleave", () => {
  toolCursor.style.display = "none";
  hideMyCursor();
});

// Deliberately does nothing to the document: a browser/workspace resize
// changes layout only (the workspace viewport simply has more or less room,
// which native overflow:auto handles on its own) -- it never mutates
// canvas.width/height, never replays artwork, never re-runs Fit, and never
// changes zoom. Nothing about the cursor overlay's size depends on window
// size either (only zoom and tool size do, see updateCursorSize), so there is
// genuinely nothing left for a resize listener to do.

// --- Private Room presence -------------------------------------------------
// presenceId identifies this one tab/page-load, never this browser or this
// owner: crypto.randomUUID(), held only in module state, never written to
// localStorage or a cookie, so two tabs in the same room (even the same
// browser, same anon_id) always carry distinct presence. Heartbeats renew
// it every HEARTBEAT_INTERVAL_MS; nothing about drawing or erasing ever
// renews it -- presence is a lease on "this tab is still open", not a proxy
// for "this owner is still active".
const HEARTBEAT_INTERVAL_MS = 30_000;
let presenceId = null;
let heartbeatHandle = null;

const leaveRoomOverlay = document.getElementById("leave-room-overlay");
const leaveRoomMessage = document.getElementById("leave-room-message");
const leaveRoomCancelButton = document.getElementById("leave-room-cancel");
const leaveRoomConfirmButton = document.getElementById("leave-room-confirm");
const backToPublicLink = document.getElementById("back-to-public");

function openLeaveRoomDialog() {
  leaveRoomMessage.textContent =
    `Save room code ${roomCode} if you want to return.\n` +
    "Once everyone leaves, the room will be kept for 24 hours before it expires.";
  leaveRoomOverlay.hidden = false;
}

function closeLeaveRoomDialog() {
  leaveRoomOverlay.hidden = true;
}

async function sendHeartbeat() {
  try {
    const res = await fetch(`/api/rooms/${roomCode}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presenceId }),
    });
    return res.ok;
  } catch {
    return false; // best-effort -- a missed heartbeat just lets the lease go stale sooner
  }
}

// The 30s interval only ever starts after a first heartbeat actually
// succeeds, so a room that's already expired (or any other failure) never
// ends up silently polling an endpoint that can only keep 404ing.
async function startPresence() {
  const ok = await sendHeartbeat();
  if (ok && heartbeatHandle === null) {
    heartbeatHandle = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  }
  if (ok) releasePreviousLease(presenceId);
}

function stopPresence() {
  if (heartbeatHandle !== null) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
}

// Public Canvas's own lease, registered the exact same way the landing
// page's own presence does (public/landing.js's sendHeartbeat/startPresence,
// server/index.js's /api/presence/heartbeat -- server/db.js's
// recordPublicHeartbeat), via the same site-wide `presence` table and
// therefore the same site-wide Online Now count. Without this, a guest who
// opens /canvas directly (never visiting the landing page first) had no
// presence lease anywhere at all, and Online Now undercounted the site's
// actual active guests. Reuses the same presenceId/heartbeatHandle module
// state as the Private Room lease above -- isPublicCanvas and a Private Room
// are mutually exclusive on any one page load, so only one of the two ever
// runs.
async function sendPublicHeartbeat() {
  try {
    await fetch("/api/presence/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presenceId }),
    });
  } catch {
    // best-effort, see sendHeartbeat above
  }
}

async function startPublicPresence() {
  presenceId = crypto.randomUUID();
  heartbeatHandle = setInterval(sendPublicHeartbeat, HEARTBEAT_INTERVAL_MS);
  await sendPublicHeartbeat();
  releasePreviousLease(presenceId);
}

// Best-effort proactive leave on navigation/tab close -- sendBeacon, same
// reasoning as public/landing.js's own leavePresenceBestEffort (a Blob with
// an explicit JSON content type, since fetch may not survive an unloading
// page and sendBeacon's own default content type isn't JSON).
function leavePublicPresenceBestEffort() {
  if (!presenceId || isNavigating() || typeof navigator.sendBeacon !== "function") return;
  try {
    navigator.sendBeacon("/api/presence/leave", new Blob([JSON.stringify({ presenceId })], { type: "application/json" }));
  } catch {
    // best-effort
  }
}

// Proactively drops this one presence row before navigating away, so the
// room's occupancy (and empty_since, if this was the last live lease)
// reflects the Leave immediately rather than only after the lease goes
// stale. Best-effort: the heartbeat simply stopping is still the
// correctness fallback if this request never lands (closed tab, crash, lost
// network -- none of which can run this at all).
async function leaveRoom() {
  stopPresence();
  // The Public page releases this room lease (POST /api/presence/handoff)
  // only after it has registered its own, so Online Now never dips; the room's
  // empty_since is still set by that release.
  markNavigating(roomCode, presenceId);
  // "/" is the landing page now (public/landing.html) -- returning from a
  // Private Room must enter the Public editor directly, not the landing page.
  location.href = "/canvas";
}

// Visibility only -- which controls are shown, not which drawing engine
// runs. Both branches share the exact same canvas/app.js below this point.
if (isPublicCanvas) {
  createRoomButton.addEventListener("click", async () => {
    // Generated client-side, synchronously, before the create-room POST, so
    // the room row and the creator's first presence row can be inserted in
    // the very same transaction (server/db.js's createRoom) -- there is no
    // window where the room exists but nobody is present in it.
    const newPresenceId = crypto.randomUUID();
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presenceId: newPresenceId }),
    });
    const { code } = await res.json();
    // Carries this exact presenceId across the full-page navigation to
    // /room/CODE via a query param -- not localStorage/sessionStorage, and
    // not a fresh id minted after arrival, which would otherwise leave the
    // creation lease's id orphaned (live for up to STALE_TIMEOUT_MS with no
    // tab ever heartbeating it again). The room page reads and immediately
    // scrubs it (see the pid handling below), so it never persists in the
    // visible URL, bookmarks, or history.
    markNavigating("public", presenceId);
    location.href = `/room/${code}?pid=${encodeURIComponent(newPresenceId)}`;
  });
  joinRoomForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = joinRoomCodeInput.value.trim().toUpperCase();
    if (code) {
      markNavigating("public", presenceId);
      location.href = `/room/${code}`;
    }
  });

  window.addEventListener("pagehide", leavePublicPresenceBestEffort);
  installNavigationMarking(() => (presenceId ? { scope: "public", presenceId } : null));
  startPublicPresence();
} else {
  publicRoomControls.hidden = true;
  privateRoomControls.hidden = false;
  roomCodeLabel.textContent = `Private Room · ${roomCode}`;

  // Reuses the creation request's own presenceId when this load is the
  // post-creation redirect (see above); otherwise (direct join by typed
  // code, or a reload after the pid has already been scrubbed) mints a
  // fresh one. Either way the param is stripped from the visible URL right
  // away so it can never be bookmarked, shared, or left in browser history.
  const pidFromUrl = new URLSearchParams(location.search).get("pid");
  presenceId = pidFromUrl && pidFromUrl.length > 0 ? pidFromUrl : crypto.randomUUID();
  if (pidFromUrl) history.replaceState(null, "", location.pathname);

  backToPublicLink.addEventListener("click", (event) => {
    event.preventDefault(); // never navigate directly -- confirm first
    openLeaveRoomDialog();
  });
  leaveRoomCancelButton.addEventListener("click", closeLeaveRoomDialog);
  leaveRoomConfirmButton.addEventListener("click", () => {
    closeLeaveRoomDialog();
    leaveRoom();
  });
  window.addEventListener("keydown", (event) => {
    if (!leaveRoomOverlay.hidden && event.key === "Escape") closeLeaveRoomDialog();
  });

  window.addEventListener("pagehide", () => {
    if (!presenceId || isNavigating() || typeof navigator.sendBeacon !== "function") return;
    try {
      navigator.sendBeacon(`/api/rooms/${roomCode}/leave`, new Blob([JSON.stringify({ presenceId })], { type: "application/json" }));
    } catch {
      // best-effort
    }
  });
  installNavigationMarking(() => (presenceId ? { scope: roomCode, presenceId } : null));
  startPresence();
}

undoButton.addEventListener("click", performUndo);
redoButton.addEventListener("click", performRedo);

// Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, shared by Public and Private alike -- one
// listener, not a separate implementation per scope. performUndo/performRedo
// already resolve against whichever scope's undoUrl/redoUrl was derived
// above, so there is nothing here that needs to branch on isPublicCanvas.
window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const target = document.activeElement;
  // Never hijack typing -- e.g. the Join-room code field on the Public
  // Canvas, or any future text input on a room page.
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

  const key = event.key.toLowerCase();
  if (key === "z" && event.shiftKey) {
    event.preventDefault();
    performRedo();
  } else if (key === "z") {
    event.preventDefault();
    performUndo();
  } else if (key === "y") {
    event.preventDefault();
    performRedo();
  }
});

initCanvasBackingStore();
setMode(mode);
// Unconditional: this module is always "legacy" mode exclusively (see
// public/pixeldoc.js's resolveEditorMode) -- it is never loaded alongside
// public/pixel-editor.js's own copy of this same wiring (that one runs only
// inside bootPixelEditor, the mutually exclusive "pixel" branch),.
wireHelpPopover();
// One-shot: runs once the workspace has a valid measured size at initial
// load (hence the rAF, so #canvas-viewport has completed layout), and never
// again -- a later window resize must never re-trigger Fit (see the removed
// resize listener above).
requestAnimationFrame(applyFit);
// The LAYERS panel is purely local state (public/layers.js) -- it needs no
// ownership or server round-trip, so it renders immediately rather than
// waiting on loadMe() below.
renderLayerPanel();

// ownership must be known before a layer can be attributed to "my own";
// startRealtimeSync's own `sync` handler is what actually populates allOps
// and renders for the first time -- see the SSE section above for why there
// is no separate GET request for the initial load any more.
profileButton.hidden = false;
loadMe().then(() => {
  startRealtimeSync();
  updateUndoRedoButtons();
  maybeShowGuestSetup();
});

// A draw op's fade opacity quantized to the canvas's own 8-bit alpha
// resolution (Uint8ClampedArray) -- repainting again before this changes
// would composite the exact same pixels, so it's the cheap (pure arithmetic,
// no canvas work) test the fade tick below uses to decide whether a real
// repaint is even needed. Cached onto the op object itself as
// _lastPaintedFadeQuant, the same memoization style opNormalizedBounds
// already uses, so it's invalidated for free whenever allOps is replaced by a
// fresh sync/loadOps array of brand-new op objects.
function fadeQuantizedOpacity(op, now) {
  return Math.round(effectiveOpacity(op, now, isPublicCanvas) * 255);
}

// True only if some draw op's visible fade level has actually moved since
// the last real repaint -- never approximates the repaint itself (that still
// always runs with the exact, unquantized opacity), only whether one is due.
function publicFadeNeedsRepaint(now) {
  for (const op of allOps) {
    if (op.kind !== "draw") continue;
    if (op._lastPaintedFadeQuant !== fadeQuantizedOpacity(op, now)) return true;
  }
  return false;
}

function markFadePainted(now) {
  for (const op of allOps) {
    if (op.kind !== "draw") continue;
    op._lastPaintedFadeQuant = fadeQuantizedOpacity(op, now);
  }
}

// Exists solely to animate the Public Canvas's fade -- a Private Room's
// effectiveOpacity never changes with time, so there is nothing for a
// from-scratch repaint to pick up between one tick and the next, and running
// it there anyway would just be a continuous, pointless source of full
// repaints. Fades are extremely slow (2 percentage points per 15 minutes --
// see public/fade.js), so a 1Hz tick is far more than enough to look
// continuous; nowhere near the cost of a per-frame animation loop. Skipped
// entirely while a gesture is in progress (current !== null): that gesture's
// own rendering (renderCurrentDelta, and endGesture's reconciliation repaint)
// is already authoritative for every pixel it touches, and an unrelated full
// repaint firing mid-drag would only race it for no benefit. Normal fade
// repaint resumes on the next tick once the gesture ends.
//
// publicFadeNeedsRepaint below additionally skips the actual repaint (the
// expensive part: a full clearRect + per-op scratch composite + drawImage
// for every op in history) on most of these ticks, since at 2 percentage
// points per 15 minutes an op's fade only crosses a visible (1/255) boundary
// roughly every ~3 minutes -- every other tick would otherwise repaint a
// canvas that looks pixel-identical to the one already on screen. This is
// what kept a growing op history from turning this 1Hz tick into a
// recurring main-thread stall (visible as idle cursor stutter) once a public
// canvas accumulates enough strokes.
if (isPublicCanvas) {
  setInterval(() => {
    if (current) return;
    const now = Date.now();
    if (!publicFadeNeedsRepaint(now)) return;
    repaintVisibleCanvas();
    markFadePainted(now);
  }, 1000);
}
