import { effectiveOpacity } from "./fade.js";
import { rgbToHex } from "./colour.js";
import { initColourPicker } from "./colour-picker-ui.js";
import { compositeOverWhite } from "./sampling.js";
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

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const canvasViewport = document.getElementById("canvas-viewport");
const toolCursor = document.getElementById("tool-cursor");
const toolSizeSlider = document.getElementById("tool-size-slider");
const toolSizeValue = document.getElementById("tool-size-value");
const toolBrushButton = document.getElementById("tool-brush");
const toolEraserButton = document.getElementById("tool-eraser");
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
const themeToggle = document.getElementById("theme-toggle");
const statusDocSize = document.getElementById("status-doc-size");
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
const guestSetupConfirmButton = document.getElementById("guest-setup-confirm");
const remoteCursorsContainer = document.getElementById("remote-cursors");
const remoteStrokePreviewCanvas = document.getElementById("remote-stroke-preview");
const remoteStrokePreviewCtx = remoteStrokePreviewCanvas.getContext("2d");

// Theme is a local, per-page-load UI preference only -- never sent to the
// server, never part of collaborative state (see server/db.js, untouched by
// this), and never persisted across reloads: the inline <head> script in
// index.html always initializes document.documentElement.dataset.theme from
// the system's own prefers-color-scheme before this module even runs, so a
// manual toggle here only ever affects the CURRENT page view, never a future
// one -- a previous manual choice must never override the system default on
// the next load. This file's own listener is the ONLY one ever attached to
// #theme-toggle for a legacy page: public/pixel-editor.js wires an
// equivalent copy, but only inside its own bootPixelEditor (the "pixel"
// mode branch), which this file's import path (the "legacy" branch) never
// reaches -- the two used to both run unconditionally, which doubled every
// click back to no visible change at all.
function syncThemeToggleUI() {
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  themeToggle.textContent = theme === "dark" ? "Dark" : "Light";
  themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
  themeToggle.setAttribute("aria-label", `Toggle theme, currently ${theme}`);
}

themeToggle.addEventListener("click", () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  syncThemeToggleUI();
});

syncThemeToggleUI();

// The one place "which canvas is this" is decided: a room page is served at
// /room/CODE (server/index.js's GET /room/:code, which 404s before ever
// reaching this script unless the room genuinely exists), so the code in the
// URL is already validated by the time this runs. Everything else below --
// which endpoints to call, and whether fading applies -- is derived once
// from this, not re-decided anywhere else.
const roomCode = location.pathname.match(/^\/room\/([^/]+)/)?.[1]?.toUpperCase() ?? null;
const isPublicCanvas = roomCode === null;
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
let layers = new Map(); // ownerId -> { canvas, ctx }, each owner's own current-state mask
let scratch = null; // { canvas, ctx }, reused per draw-op during a repaint
let allOps = []; // op[], the full history in server seq order -- the only thing that controls stacking order
let opsByOwner = new Map(); // ownerId -> op[] in seq order, used only to rebuild each owner's own layer

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
// landed" canvas, or null if this owner has no active erase preview right
// now. Never mutates layers.get(ownerId)'s own canvas (the owner's real,
// authoritative mask) -- only ever reads it, once, to seed a disposable copy
// (see updateErasePreviewLayer) -- so persisted state can never be corrupted
// by however many times this is consulted, or by a preview that's later
// abandoned/cancelled/superseded.
function erasePreviewLayerFor(ownerId) {
  const preview = remoteStrokePreviews.get(ownerId);
  if (!preview || preview.kind !== "erase") return null;
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
let mode = "brush"; // "brush" | "eraser" | "eyedropper"

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

function ensureLayer(ownerId) {
  let layer = layers.get(ownerId);
  if (!layer) {
    const layerCanvas = document.createElement("canvas");
    layerCanvas.width = canvas.width;
    layerCanvas.height = canvas.height;
    layer = { canvas: layerCanvas, ctx: layerCanvas.getContext("2d") };
    layers.set(ownerId, layer);
  }
  return layer;
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
function renderPathOnLayer(layerCtx, kind, color, sizeNormalized, points) {
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

function rebuildLayerFromOps(ownerId) {
  const layer = ensureLayer(ownerId);
  layer.canvas.width = canvas.width;
  layer.canvas.height = canvas.height;
  const ops = opsByOwner.get(ownerId) ?? [];
  for (const op of ops) renderPathOnLayer(layer.ctx, op.kind, op.color, op.size, op.points);
}

function rebuildAllLayers() {
  for (const ownerId of opsByOwner.keys()) rebuildLayerFromOps(ownerId);
  if (myOwnerId !== null) {
    const layer = ensureLayer(myOwnerId);
    // Not yet in opsByOwner (persistGesture hasn't resolved), so
    // rebuildLayerFromOps above can't have replayed these -- without this,
    // a resize mid-persist would drop a pending gesture from the owner's own
    // mask, and once persistence did land it'd render clipped away to
    // nothing on the very next ops-driven repaint.
    for (const op of pendingOps) renderPathOnLayer(layer.ctx, op.kind, op.color, op.size, op.points);
    if (current) {
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
  if (!op._normBounds) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of op.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = op.size / 2;
    op._normBounds = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
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
  const { canvas: scratchCanvas, ctx: scratchCtx } = ensureScratch();
  const clipRect = region ? { x: rx, y: ry, width: rw, height: rh } : null;
  const now = Date.now(); // one shared instant for every op in this repaint, so nothing within a single pass can disagree
  for (const op of allOps) {
    if (op.kind !== "draw") continue; // an erase op's only effect is already baked into its owner's layer, below, and never fades
    // Fading is applied here, and only here: to a draw op's own stroke color,
    // right before it gets clipped against its owner's layer mask below. The
    // mask itself (built in rebuildLayerFromOps) is never faded -- it stays
    // permanent and full-strength, so an owner can always erase a faded or
    // fully-invisible stroke exactly as if it were new, and nothing erased
    // can ever reappear by aging back into visibility. A fully-faded op is
    // skipped outright here -- still persisted (see public/fade.js), just no
    // longer painted. effectiveOpacity is 1 unconditionally on a Private
    // Room page (isPublicCanvas is false there), so room content never
    // fades regardless of its createdAt.
    const opacity = effectiveOpacity(op, now, isPublicCanvas);
    if (opacity <= 0) continue;
    if (clipRect && !rectsIntersect(opPixelBounds(op), clipRect)) continue; // this op can't paint inside the dirty region at all
    const ownerLayer = layers.get(op.ownerId);
    if (!ownerLayer) continue;
    scratchCtx.clearRect(rx, ry, rw, rh);
    scratchCtx.globalAlpha = opacity;
    renderPathOnLayer(scratchCtx, "draw", op.color, op.size, op.points);
    scratchCtx.globalAlpha = 1;
    scratchCtx.globalCompositeOperation = "destination-in";
    // If this op's owner has a remote erase gesture in progress right now,
    // clip against the temporary, disposable preview of their post-erase
    // layer instead of their real one -- the only reason a progressive
    // remote erase is visible at all before the gesture's own authoritative
    // op lands. Every other owner's ops are completely unaffected: this is
    // looked up per-op, keyed strictly by that op's own ownerId, so one
    // owner's in-progress erase can never clip (or fail to clip) another
    // owner's artwork, overlapping or not -- same as the real, persisted
    // erase model this is standing in for.
    const clipSource = erasePreviewLayerFor(op.ownerId) ?? ownerLayer.canvas;
    scratchCtx.drawImage(clipSource, rx, ry, rw, rh, rx, ry, rw, rh);
    scratchCtx.globalCompositeOperation = "source-over";
    ctx.drawImage(scratchCanvas, rx, ry, rw, rh, rx, ry, rw, rh);
  }
  if (myOwnerId !== null) {
    // Oldest-to-newest: each finished-but-unconfirmed gesture is strictly
    // newer than the ones before it (it couldn't start until the last one
    // ended), and the in-progress gesture, if any, is newer still -- so
    // painting in this order and always unclipped reproduces the same
    // stacking the eventual allOps-driven replay will show once persistence
    // catches up, with nothing here waiting on it.
    for (const op of pendingOps) {
      renderPathOnLayer(ctx, "draw", op.color, op.size, op.points);
    }
    if (current && current.kind === "draw") {
      renderPathOnLayer(ctx, "draw", current.color, current.size, current.points);
    }
  }
}

async function loadOps() {
  const res = await fetch(opsUrl);
  allOps = await res.json(); // already server-seq-ordered; this exact array (not owner grouping) drives stacking order
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
    if (!opsByOwner.has(data.ownerId)) opsByOwner.set(data.ownerId, []);
    opsByOwner.get(data.ownerId).push(data);
    // A remote collaborator's stroke was never painted locally (only our own
    // gestures are painted live, point by point, as they happen), so it
    // needs one real repaint to become visible -- just that one owner's own
    // layer rebuilt, not every layer (rebuildAllLayers), which is the whole
    // reason ops are already kept per-owner.
    if (data.ownerId !== myOwnerId) {
      // The authoritative stroke has landed -- clear its temporary preview
      // (if any) in this same synchronous turn, immediately before painting
      // the real thing, so there is no frame in between where neither is
      // visible.
      clearRemoteStrokePreview(data.ownerId);
      rebuildLayerFromOps(data.ownerId);
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
  guestSetupColourInput.value = myCursorColor;
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
  profileColourInput.value = myCursorColor;
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
    renderPathOnLayer(remoteStrokePreviewCtx, "draw", preview.color, preview.size, preview.points);
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
  const realLayer = layers.get(ownerId);
  if (!realLayer) return; // nothing persisted for this owner yet to preview erasing from
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
  if (preview.kind === "erase" && preview.points) {
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
  preview.lastSeen = Date.now();
  if (data.kind === "erase") {
    updateErasePreviewLayer(data.ownerId, preview);
    // Regional, not a full repaint -- the same reasoning as the local live
    // erase preview's own repaintVisibleCanvas(deltaRegionPixels(...)) call
    // in renderCurrentDelta: an erase can only shrink pixels already inside
    // its own bounding box, so nothing outside it could possibly have
    // changed.
    repaintVisibleCanvas(deltaRegionPixels(preview.points, preview.size));
  } else {
    repaintRemoteStrokePreviews();
  }
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
  const layer = ensureLayer(myOwnerId);
  const delta = current.points.slice(currentLastRenderedIndex);
  renderPathOnLayer(layer.ctx, current.kind, current.color, current.size, delta);
  currentLastRenderedIndex = current.points.length - 1;
  if (current.kind === "draw") {
    // Newest content is always safe to paint directly on top, unclipped --
    // nothing drawn after it yet, by anyone, could have occluded it.
    renderPathOnLayer(ctx, "draw", current.color, current.size, delta);
  } else {
    // An in-progress erase can retroactively shrink any of this owner's
    // already-composited draws, anywhere in the global stacking order --
    // not expressible as a direct paint, so repaint instead. But only the
    // pixels this frame's delta actually touches can have changed (erasing
    // only shrinks alpha, it never reveals anything outside the stroke), so
    // restrict the repaint to that region instead of the whole canvas --
    // see repaintVisibleCanvas's own comment for why that's still exact.
    repaintVisibleCanvas(deltaRegionPixels(delta, current.size));
  }
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

function beginGesture(kind, point) {
  if (myOwnerId === null) return;
  current = {
    kind,
    color: kind === "erase" ? null : color,
    size: (kind === "erase" ? eraserSizePx : brushSizePx) / canvas.width,
    points: [point],
  };
  currentLastRenderedIndex = 0;
  renderCurrentDelta();
  updateUndoRedoButtons(); // a gesture just became pending -- disable until it resolves
}

function appendToGesture(points) {
  if (!current) return;
  current.points.push(...points);
  queueFrame();
}

async function persistGesture(finished) {
  const endpoint = finished.kind === "erase" ? eraseUrl : drawUrl;
  const body =
    finished.kind === "erase"
      ? { radius: finished.size / 2, points: finished.points }
      : { color: finished.color, width: finished.size, points: finished.points };

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
    };
    // Appended at the end: with no live multi-user sync yet, nothing else
    // locally inserts an op into allOps mid-session, so this is always the
    // new highest-seq entry for this client's own view.
    allOps.push(op);
    if (!opsByOwner.has(myOwnerId)) opsByOwner.set(myOwnerId, []);
    opsByOwner.get(myOwnerId).push(op);
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
    updateUndoRedoButtons();
  }
}

function endGesture() {
  if (!current) return;
  cancelFrame();
  renderCurrentDelta(); // flush any points accumulated since the last rendered frame
  // One final, forced (non-throttled) preview send with the now-complete
  // points, while `current` still holds them -- guarantees remote viewers'
  // preview shows the exact final shape right before it gets reconciled away
  // by the real "op" broadcast persistGesture's save triggers below.
  sendStrokePreview(true);
  // The per-frame erase preview only ever repaints the delta's own region
  // (see renderCurrentDelta); reconcile with one full, authoritative repaint
  // at gesture end so nothing has drifted. This runs once per gesture, not
  // once per frame, so it doesn't reintroduce the per-frame cost just fixed.
  if (current.kind === "erase") repaintVisibleCanvas();
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
  appendToGesture(coalescedPositions(event));
});

function endPointerAction(event) {
  if (panState && event.pointerId === panState.pointerId) {
    panState = null;
    return;
  }
  endGesture();
}
canvas.addEventListener("pointerup", endPointerAction);
canvas.addEventListener("pointercancel", endPointerAction);

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
  mode = newMode;
  toolBrushButton.classList.toggle("selected", mode === "brush");
  toolEraserButton.classList.toggle("selected", mode === "eraser");
  toolEyedropperButton.classList.toggle("selected", mode === "eyedropper");
  toolBrushButton.setAttribute("aria-pressed", String(mode === "brush"));
  toolEraserButton.setAttribute("aria-pressed", String(mode === "eraser"));
  toolEyedropperButton.setAttribute("aria-pressed", String(mode === "eyedropper"));
  // Eyedropper has no on-canvas diameter to preview, so it gets a plain
  // native crosshair instead of the circular size-preview overlay Brush/
  // Eraser use (replaced by that overlay via updateCursorSize below).
  canvas.style.cursor = mode === "eyedropper" ? "crosshair" : "none";
  if (mode === "eyedropper") toolCursor.style.display = "none";
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
  if (mode === "eyedropper") return; // no diameter to preview -- see setMode's native crosshair instead
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
  remoteStrokePreviewCanvas.style.left = `${canvas.offsetLeft}px`;
  remoteStrokePreviewCanvas.style.top = `${canvas.offsetTop}px`;
  remoteStrokePreviewCanvas.style.width = `${canvas.clientWidth}px`;
  remoteStrokePreviewCanvas.style.height = `${canvas.clientHeight}px`;
}

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

canvas.addEventListener("pointerenter", (event) => {
  if (mode === "eyedropper") return; // crosshair only, no circular overlay
  updateCursorSize();
  toolCursor.style.left = `${event.clientX}px`;
  toolCursor.style.top = `${event.clientY}px`;
  toolCursor.style.display = "block";
});

canvas.addEventListener("pointermove", (event) => {
  toolCursor.style.left = `${event.clientX}px`;
  toolCursor.style.top = `${event.clientY}px`;
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
}

function stopPresence() {
  if (heartbeatHandle !== null) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
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
  try {
    await fetch(`/api/rooms/${roomCode}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presenceId }),
    });
  } catch {
    // Best-effort, see above.
  }
  location.href = "/";
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
    location.href = `/room/${code}?pid=${encodeURIComponent(newPresenceId)}`;
  });
  joinRoomForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = joinRoomCodeInput.value.trim().toUpperCase();
    if (code) location.href = `/room/${code}`;
  });
} else {
  publicRoomControls.hidden = true;
  privateRoomControls.hidden = false;
  roomCodeLabel.textContent = `Room: ${roomCode}`;

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
statusDocSize.textContent = `${DOCUMENT_WIDTH} × ${DOCUMENT_HEIGHT}`;
setMode(mode);
// One-shot: runs once the workspace has a valid measured size at initial
// load (hence the rAF, so #canvas-viewport has completed layout), and never
// again -- a later window resize must never re-trigger Fit (see the removed
// resize listener above).
requestAnimationFrame(applyFit);
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
if (isPublicCanvas) {
  setInterval(() => {
    if (current) return;
    repaintVisibleCanvas();
  }, 1000);
}
