import { effectiveOpacity } from "./fade.js";
import {
  clampByte,
  clampPercent,
  hexToRgb,
  hsvToRgb,
  nextPickerHue,
  normalizeHue,
  rgbToHex,
  rgbToHsv,
} from "./colour.js";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const toolCursor = document.getElementById("tool-cursor");
const toolSizeSlider = document.getElementById("tool-size-slider");
const toolSizeValue = document.getElementById("tool-size-value");
const toolBrushButton = document.getElementById("tool-brush");
const toolEraserButton = document.getElementById("tool-eraser");
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

// Theme is a local UI preference only -- never sent to the server, never
// part of collaborative state (see server/db.js, untouched by this). The
// inline <head> script in index.html already resolved the initial value
// (saved localStorage choice, falling back to prefers-color-scheme) onto
// document.documentElement.dataset.theme before this module even runs, so
// this is only responsible for keeping the toggle button's own display in
// sync and persisting any future explicit choice.
function syncThemeToggleUI() {
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  themeToggle.textContent = theme === "dark" ? "Dark" : "Light";
  themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
  themeToggle.setAttribute("aria-label", `Toggle theme, currently ${theme}`);
}

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
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

let myOwnerId = null;
let color = "#1d1d1d";
// Canonical brush colour: `color` (the #rrggbb string every draw op persists,
// read unchanged below in beginGesture/persistGesture) is always derived from
// `brushColor` via rgbToHex, never assigned independently. `pickerHue` is the
// retained-hue state colour.js's nextPickerHue implements -- see its own
// comment for why a picker needs this at all. Every colour control (palette,
// hue ring, SV square, RGB/HSV sliders and numbers) is just a view onto these
// two values; see setBrushColorFromRgb/setBrushColorFromHsv/syncColourUI
// further down, which are the only functions that ever write to them.
let brushColor = hexToRgb(color);
let pickerHue = rgbToHsv(brushColor).h;
let brushSizePx = 6;
let eraserSizePx = 30;
let mode = "brush"; // "brush" | "eraser"

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
// together, never lagging behind which tool is actually selected.
function syncSizeControlToMode() {
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

function resizeCanvas() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  // Resizing a canvas clears its bitmap (browser behaviour, not a choice
  // made here), including every per-owner layer -- so a resize must replay
  // each owner's full op history from scratch at the new pixel size.
  rebuildAllLayers();
}

// Points are stored normalized to the canvas's own width/height at draw
// time, so redrawing at a different size (resize, or a different device)
// reproduces the same proportions rather than the same raw pixels.
function toNormalized(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
}

function toPixels(point) {
  return { x: point.x * canvas.width, y: point.y * canvas.height };
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
  layerCtx.lineWidth = sizeNormalized * canvas.width;
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
    scratchCtx.drawImage(ownerLayer.canvas, rx, ry, rw, rh, rx, ry, rw, rh);
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
}

async function loadMe() {
  const res = await fetch("/api/me");
  ({ ownerId: myOwnerId } = await res.json());
}

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
  const padPx = (sizeNormalized * canvas.width) / 2 + 2;
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
  // The per-frame erase preview only ever repaints the delta's own region
  // (see renderCurrentDelta); reconcile with one full, authoritative repaint
  // at gesture end so nothing has drifted. This runs once per gesture, not
  // once per frame, so it doesn't reintroduce the per-frame cost just fixed.
  if (current.kind === "erase") repaintVisibleCanvas();
  const finished = current;
  current = null;
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
  await loadOps(); // reloads authoritative active ops and repaints via the existing engine -- no alternate replay path
  updateUndoRedoButtons();
}

async function performRedo() {
  if (hasPendingGesture()) return;
  const res = await fetch(redoUrl, { method: "POST" });
  if (!res.ok) return;
  const { op } = await res.json();
  if (!op) return; // nothing left to redo
  myRedoCount = Math.max(0, myRedoCount - 1);
  await loadOps();
  updateUndoRedoButtons();
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  beginGesture(mode === "eraser" ? "erase" : "draw", pointerPos(event));
});

canvas.addEventListener("pointermove", (event) => {
  if (!current) return;
  appendToGesture(coalescedPositions(event));
});

canvas.addEventListener("pointerup", endGesture);
canvas.addEventListener("pointercancel", endGesture);

function selectSwatch(swatch) {
  document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
  swatch.classList.add("selected");
}

for (const swatch of document.querySelectorAll(".swatch[data-color]")) {
  swatch.addEventListener("click", () => {
    const rgb = hexToRgb(swatch.dataset.color);
    if (!rgb) return; // malformed preset data-color -- ignore rather than crash
    setBrushColorFromRgb(rgb);
  });
}

// --- Custom colour -----------------------------------------------------------
// One integrated Hue-ring + SV-square picker (#colour-wheel), plus RGB and
// HSV sliders/number inputs, all views of the single canonical brushColor/
// pickerHue state declared above. Every control below reaches that state
// through exactly one of two setters:
//   - setBrushColorFromRgb: an RGB-derived change (a preset, an RGB slider or
//     number). pickerHue only follows along when the result has meaningful
//     saturation (colour.js's nextPickerHue) -- so greying a colour out and
//     back returns to the same hue instead of snapping to red.
//   - setBrushColorFromHsv: an HSV-derived change (the hue ring, the SV
//     square, an HSV slider or number). The caller is responsible for what
//     pickerHue should be *before* calling this -- a hue-ring/H-slider edit
//     assigns it directly (an explicit hue edit always wins); an SV-square
//     drag or an S/V slider edit passes the existing pickerHue through
//     unchanged, since those never change which hue is selected.
// Both setters funnel into syncColourUI(), the only place any control's
// value is written -- always via direct property assignment, never
// .dispatchEvent, so writing a value back here can never itself re-trigger
// the "input" listener that led here.
const colourCurrent = document.getElementById("colour-current");
const editColourButton = document.getElementById("edit-colour-button");
const colourPopover = document.getElementById("colour-popover");
const colourPopoverClose = document.getElementById("colour-popover-close");
const colourWheelCanvas = document.getElementById("colour-wheel");
const colourWheelCtx = colourWheelCanvas.getContext("2d");
const colourPreviewSwatch = document.getElementById("colour-preview-swatch");
const colourPreviewHex = document.getElementById("colour-preview-hex");
const rgbRSlider = document.getElementById("rgb-r-slider");
const rgbRNumber = document.getElementById("rgb-r-number");
const rgbGSlider = document.getElementById("rgb-g-slider");
const rgbGNumber = document.getElementById("rgb-g-number");
const rgbBSlider = document.getElementById("rgb-b-slider");
const rgbBNumber = document.getElementById("rgb-b-number");
const hsvHSlider = document.getElementById("hsv-h-slider");
const hsvHNumber = document.getElementById("hsv-h-number");
const hsvSSlider = document.getElementById("hsv-s-slider");
const hsvSNumber = document.getElementById("hsv-s-number");
const hsvVSlider = document.getElementById("hsv-v-slider");
const hsvVNumber = document.getElementById("hsv-v-number");

// Logical (CSS-pixel) geometry, fixed by the markup's width="180" attribute.
// Read before the backing-store resize below overwrites the width property.
const WHEEL_SIZE = colourWheelCanvas.width;
const WHEEL_CENTER = WHEEL_SIZE / 2;
const WHEEL_OUTER_RADIUS = WHEEL_CENTER - 2;
const WHEEL_RING_THICKNESS = 18;
const WHEEL_INNER_RADIUS = WHEEL_OUTER_RADIUS - WHEEL_RING_THICKNESS;
const WHEEL_SQUARE_HALF = (WHEEL_INNER_RADIUS - 4) / Math.SQRT2; // inscribed so corners stay clear of the ring

// Backing store scaled for crisp rendering on high-DPI screens. Every drawing
// coordinate from here on stays in the logical WHEEL_SIZE-by-WHEEL_SIZE space
// (via colourWheelCtx.setTransform below); pointer handling maps client
// coordinates through the canvas's CSS-pixel bounding rect, which is always
// that same logical space regardless of backing-store scale, so the two can
// never disagree about where the pointer is.
const wheelDpr = window.devicePixelRatio || 1;
colourWheelCanvas.width = WHEEL_SIZE * wheelDpr;
colourWheelCanvas.height = WHEEL_SIZE * wheelDpr;
colourWheelCanvas.style.width = `${WHEEL_SIZE}px`;
colourWheelCanvas.style.height = `${WHEEL_SIZE}px`;
colourWheelCtx.setTransform(wheelDpr, 0, 0, wheelDpr, 0, 0);

let hueRingImage = null; // cached static ring render -- fixed geometry, never depends on the current colour

function renderHueRing() {
  const ringCanvas = document.createElement("canvas");
  ringCanvas.width = WHEEL_SIZE;
  ringCanvas.height = WHEEL_SIZE;
  const rctx = ringCanvas.getContext("2d");
  const steps = 360;
  for (let i = 0; i < steps; i++) {
    const h0 = (i / steps) * 360;
    const h1 = ((i + 1) / steps) * 360;
    const { r, g, b } = hsvToRgb({ h: (h0 + h1) / 2, s: 100, v: 100 });
    rctx.beginPath();
    rctx.moveTo(WHEEL_CENTER, WHEEL_CENTER);
    rctx.arc(WHEEL_CENTER, WHEEL_CENTER, WHEEL_OUTER_RADIUS, (h0 * Math.PI) / 180, (h1 * Math.PI) / 180);
    rctx.closePath();
    rctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    rctx.fill();
  }
  // Punch out the centre, leaving just the ring band -- this destination-out
  // only ever touches this throwaway offscreen canvas, never the shared
  // drawing canvas or either of its contexts.
  rctx.globalCompositeOperation = "destination-out";
  rctx.beginPath();
  rctx.arc(WHEEL_CENTER, WHEEL_CENTER, WHEEL_INNER_RADIUS, 0, Math.PI * 2);
  rctx.fill();
  rctx.globalCompositeOperation = "source-over";
  hueRingImage = ringCanvas;
}

function drawMarker(x, y) {
  colourWheelCtx.beginPath();
  colourWheelCtx.arc(x, y, 5, 0, Math.PI * 2);
  colourWheelCtx.strokeStyle = "#ffffff";
  colourWheelCtx.lineWidth = 2;
  colourWheelCtx.stroke();
  colourWheelCtx.beginPath();
  colourWheelCtx.arc(x, y, 5, 0, Math.PI * 2);
  colourWheelCtx.strokeStyle = "#1d1d1d";
  colourWheelCtx.lineWidth = 1;
  colourWheelCtx.stroke();
}

function renderColourWheel() {
  if (!hueRingImage) renderHueRing();
  colourWheelCtx.clearRect(0, 0, WHEEL_SIZE, WHEEL_SIZE);
  colourWheelCtx.drawImage(hueRingImage, 0, 0, WHEEL_SIZE, WHEEL_SIZE);

  // SV square: solid hue fill, then a white-to-transparent horizontal
  // gradient (saturation) and a transparent-to-black vertical gradient
  // (value) layered on top -- the standard three-fill way to render one.
  const left = WHEEL_CENTER - WHEEL_SQUARE_HALF;
  const top = WHEEL_CENTER - WHEEL_SQUARE_HALF;
  const side = WHEEL_SQUARE_HALF * 2;
  const pureHue = hsvToRgb({ h: pickerHue, s: 100, v: 100 });

  colourWheelCtx.fillStyle = `rgb(${pureHue.r}, ${pureHue.g}, ${pureHue.b})`;
  colourWheelCtx.fillRect(left, top, side, side);

  const satGradient = colourWheelCtx.createLinearGradient(left, 0, left + side, 0);
  satGradient.addColorStop(0, "rgba(255,255,255,1)");
  satGradient.addColorStop(1, "rgba(255,255,255,0)");
  colourWheelCtx.fillStyle = satGradient;
  colourWheelCtx.fillRect(left, top, side, side);

  const valGradient = colourWheelCtx.createLinearGradient(0, top, 0, top + side);
  valGradient.addColorStop(0, "rgba(0,0,0,0)");
  valGradient.addColorStop(1, "rgba(0,0,0,1)");
  colourWheelCtx.fillStyle = valGradient;
  colourWheelCtx.fillRect(left, top, side, side);

  // Hue marker, on the ring at the retained hue.
  const hueAngle = (pickerHue * Math.PI) / 180;
  const hueMarkerRadius = (WHEEL_INNER_RADIUS + WHEEL_OUTER_RADIUS) / 2;
  drawMarker(WHEEL_CENTER + Math.cos(hueAngle) * hueMarkerRadius, WHEEL_CENTER + Math.sin(hueAngle) * hueMarkerRadius);

  // SV marker: horizontal = saturation, vertical = value with top = high
  // value (matches applySvFromPoint's own mapping below).
  const hsv = rgbToHsv(brushColor);
  drawMarker(left + (hsv.s / 100) * side, top + (1 - hsv.v / 100) * side);
}

// Which region a drag started in, held for the whole gesture so dragging
// past the control's edge keeps adjusting the same thing instead of jumping
// between hue and SV mid-drag.
let wheelDragMode = null; // "hue" | "sv" | null

function wheelLocalPoint(event) {
  const rect = colourWheelCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left - WHEEL_CENTER, y: event.clientY - rect.top - WHEEL_CENTER };
}

function applyHueFromPoint(x, y) {
  let degrees = (Math.atan2(y, x) * 180) / Math.PI;
  if (degrees < 0) degrees += 360;
  pickerHue = degrees; // explicit hue edit: always adopted, regardless of resulting saturation
  const hsv = rgbToHsv(brushColor);
  setBrushColorFromHsv({ h: pickerHue, s: hsv.s, v: hsv.v });
}

function applySvFromPoint(x, y) {
  const cx = Math.min(WHEEL_SQUARE_HALF, Math.max(-WHEEL_SQUARE_HALF, x));
  const cy = Math.min(WHEEL_SQUARE_HALF, Math.max(-WHEEL_SQUARE_HALF, y));
  const s = ((cx + WHEEL_SQUARE_HALF) / (WHEEL_SQUARE_HALF * 2)) * 100;
  const v = (1 - (cy + WHEEL_SQUARE_HALF) / (WHEEL_SQUARE_HALF * 2)) * 100;
  setBrushColorFromHsv({ h: pickerHue, s, v });
}

colourWheelCanvas.addEventListener("pointerdown", (event) => {
  colourWheelCanvas.setPointerCapture(event.pointerId);
  const { x, y } = wheelLocalPoint(event);
  if (Math.abs(x) <= WHEEL_SQUARE_HALF && Math.abs(y) <= WHEEL_SQUARE_HALF) {
    wheelDragMode = "sv";
    applySvFromPoint(x, y);
  } else if (Math.hypot(x, y) <= WHEEL_OUTER_RADIUS) {
    wheelDragMode = "hue";
    applyHueFromPoint(x, y);
  } else {
    wheelDragMode = null;
  }
});

colourWheelCanvas.addEventListener("pointermove", (event) => {
  if (!wheelDragMode) return;
  const { x, y } = wheelLocalPoint(event);
  if (wheelDragMode === "hue") applyHueFromPoint(x, y);
  else applySvFromPoint(x, y);
});

function endWheelDrag() {
  wheelDragMode = null;
}
colourWheelCanvas.addEventListener("pointerup", endWheelDrag);
colourWheelCanvas.addEventListener("pointercancel", endWheelDrag);

function setBrushColorFromRgb(rgb) {
  brushColor = { r: clampByte(rgb.r), g: clampByte(rgb.g), b: clampByte(rgb.b) };
  color = rgbToHex(brushColor);
  pickerHue = nextPickerHue(pickerHue, rgbToHsv(brushColor));
  syncColourUI();
}

function setBrushColorFromHsv(hsv) {
  brushColor = hsvToRgb(hsv);
  color = rgbToHex(brushColor);
  syncColourUI();
}

// Whichever preset swatch matches the live brush colour stays visually
// "selected"; anything typed or dragged in via the popover that doesn't
// exactly match a preset simply leaves no preset selected -- the large
// current-colour display (#colour-current) is what shows that colour
// instead, so there's no need for a stand-in swatch to claim "selected".
function syncSelectedSwatch() {
  const presetMatch = Array.from(document.querySelectorAll(".swatch[data-color]")).find(
    (s) => s.dataset.color.toLowerCase() === color,
  );
  document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
  if (presetMatch) selectSwatch(presetMatch);
}

// Paints a slider's track gradient between the two colours its own min/max
// would actually produce, holding every other channel at the given values --
// e.g. the R slider's track runs rgb(0,G,B) -> rgb(255,G,B), not a fixed
// black -> red ramp, so the track always reflects what dragging it would
// really do to the live colour. Reuses rgbToHex (colour.js) rather than
// duplicating hex formatting; writes only the two CSS custom properties
// styles.css's gradient rule reads, never a colour onto the slider directly.
function setSliderGradient(slider, startRgb, endRgb) {
  slider.style.setProperty("--grad-start", rgbToHex(startRgb));
  slider.style.setProperty("--grad-end", rgbToHex(endRgb));
}

// The only place any colour control's value is written -- always via direct
// property assignment, never .dispatchEvent (see the block comment above).
function syncColourUI() {
  const hsv = rgbToHsv(brushColor);
  colourCurrent.style.background = color;
  syncSelectedSwatch();
  colourPreviewSwatch.style.background = color;
  colourPreviewHex.textContent = color;

  rgbRSlider.value = String(brushColor.r);
  rgbRNumber.value = String(brushColor.r);
  rgbGSlider.value = String(brushColor.g);
  rgbGNumber.value = String(brushColor.g);
  rgbBSlider.value = String(brushColor.b);
  rgbBNumber.value = String(brushColor.b);

  // H always reflects the retained pickerHue, not rgbToHsv(brushColor).h --
  // at s=0 the latter is arbitrary (grey has no hue), so showing it would
  // visibly lose the hue the achromatic-retention policy is keeping.
  hsvHSlider.value = String(Math.round(pickerHue));
  hsvHNumber.value = String(Math.round(pickerHue));
  hsvSSlider.value = String(Math.round(hsv.s));
  hsvSNumber.value = String(Math.round(hsv.s));
  hsvVSlider.value = String(Math.round(hsv.v));
  hsvVNumber.value = String(Math.round(hsv.v));

  // R/G/B tracks: vary only the one channel, holding the other two at their
  // current values. The H track is a fixed spectrum (styles.css, never
  // recomputed here); S/V vary only their own channel, holding the retained
  // pickerHue and the other of S/V constant.
  setSliderGradient(rgbRSlider, { r: 0, g: brushColor.g, b: brushColor.b }, { r: 255, g: brushColor.g, b: brushColor.b });
  setSliderGradient(rgbGSlider, { r: brushColor.r, g: 0, b: brushColor.b }, { r: brushColor.r, g: 255, b: brushColor.b });
  setSliderGradient(rgbBSlider, { r: brushColor.r, g: brushColor.g, b: 0 }, { r: brushColor.r, g: brushColor.g, b: 255 });
  setSliderGradient(hsvSSlider, hsvToRgb({ h: pickerHue, s: 0, v: hsv.v }), hsvToRgb({ h: pickerHue, s: 100, v: hsv.v }));
  setSliderGradient(hsvVSlider, hsvToRgb({ h: pickerHue, s: hsv.s, v: 0 }), hsvToRgb({ h: pickerHue, s: hsv.s, v: 100 }));

  if (!colourPopover.hidden) renderColourWheel();
}

function openColourPopover() {
  const rect = editColourButton.getBoundingClientRect();
  const popoverWidth = 232;
  colourPopover.style.top = `${rect.bottom + 6}px`;
  colourPopover.style.left = `${Math.min(rect.left, window.innerWidth - popoverWidth - 8)}px`;
  colourPopover.hidden = false;
  editColourButton.setAttribute("aria-expanded", "true");
  renderColourWheel();
}

function closeColourPopover() {
  colourPopover.hidden = true;
  editColourButton.setAttribute("aria-expanded", "false");
}

editColourButton.addEventListener("click", () => {
  if (colourPopover.hidden) openColourPopover();
  else closeColourPopover();
});

colourPopoverClose.addEventListener("click", closeColourPopover);

// Outside-click close: a pointerdown already in flight when the popover first
// opens can't reach here before `hidden` is set (click fires after
// pointerdown), so opening and closing never race each other -- see the two
// listeners' relative order for why.
document.addEventListener("pointerdown", (event) => {
  if (colourPopover.hidden) return;
  if (colourPopover.contains(event.target) || editColourButton.contains(event.target)) return;
  closeColourPopover();
});

window.addEventListener("keydown", (event) => {
  if (!colourPopover.hidden && event.key === "Escape") closeColourPopover();
});

function wireRgbChannel(slider, number, key) {
  const commit = (value) => setBrushColorFromRgb({ ...brushColor, [key]: clampByte(Number(value)) });
  slider.addEventListener("input", () => commit(slider.value));
  number.addEventListener("input", () => commit(number.value));
}
wireRgbChannel(rgbRSlider, rgbRNumber, "r");
wireRgbChannel(rgbGSlider, rgbGNumber, "g");
wireRgbChannel(rgbBSlider, rgbBNumber, "b");

function currentHsv() {
  return rgbToHsv(brushColor);
}

hsvHSlider.addEventListener("input", () => {
  pickerHue = normalizeHue(Number(hsvHSlider.value));
  const hsv = currentHsv();
  setBrushColorFromHsv({ h: pickerHue, s: hsv.s, v: hsv.v });
});
hsvHNumber.addEventListener("input", () => {
  pickerHue = normalizeHue(Number(hsvHNumber.value));
  const hsv = currentHsv();
  setBrushColorFromHsv({ h: pickerHue, s: hsv.s, v: hsv.v });
});
hsvSSlider.addEventListener("input", () => {
  setBrushColorFromHsv({ h: pickerHue, s: clampPercent(Number(hsvSSlider.value)), v: currentHsv().v });
});
hsvSNumber.addEventListener("input", () => {
  setBrushColorFromHsv({ h: pickerHue, s: clampPercent(Number(hsvSNumber.value)), v: currentHsv().v });
});
hsvVSlider.addEventListener("input", () => {
  setBrushColorFromHsv({ h: pickerHue, s: currentHsv().s, v: clampPercent(Number(hsvVSlider.value)) });
});
hsvVNumber.addEventListener("input", () => {
  setBrushColorFromHsv({ h: pickerHue, s: currentHsv().s, v: clampPercent(Number(hsvVNumber.value)) });
});

syncColourUI();

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
  toolBrushButton.setAttribute("aria-pressed", String(mode === "brush"));
  toolEraserButton.setAttribute("aria-pressed", String(mode === "eraser"));
  canvas.style.cursor = "none"; // replaced by the custom circular tool-cursor overlay
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

// A circular outline tracking the pointer, sized to the tool's actual
// on-canvas diameter -- not a decorative icon, and never drawn into the
// canvas's own 2D context, so it can never end up in persisted artwork.
// brushSizePx/eraserSizePx are already defined in canvas CSS-pixel terms
// (that's the slider's native unit; normalization only happens when a
// gesture's size is stored), and the canvas's backing-store size tracks its
// CSS size 1:1 (resizeCanvas sets canvas.width = canvas.clientWidth), so no
// conversion is needed and a resize can't desync the two. Both tools now
// stroke with lineWidth = size * canvas.width, so this on-screen circle is
// exactly the footprint that will actually be painted -- not an
// approximation of it.
function currentToolDiameterPx() {
  return toolSizes[mode].get();
}

function updateCursorSize() {
  const diameter = currentToolDiameterPx();
  toolCursor.style.width = `${diameter}px`;
  toolCursor.style.height = `${diameter}px`;
}

canvas.addEventListener("pointerenter", (event) => {
  updateCursorSize();
  toolCursor.style.left = `${event.clientX}px`;
  toolCursor.style.top = `${event.clientY}px`;
  toolCursor.style.display = "block";
});

canvas.addEventListener("pointermove", (event) => {
  toolCursor.style.left = `${event.clientX}px`;
  toolCursor.style.top = `${event.clientY}px`;
});

canvas.addEventListener("pointerleave", () => {
  toolCursor.style.display = "none";
});

window.addEventListener("resize", () => {
  resizeCanvas();
  updateCursorSize();
});

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

resizeCanvas();
setMode(mode);
loadMe().then(loadOps).then(updateUndoRedoButtons); // ownership must be known before a layer can be attributed to "my own"

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
