import { effectiveOpacity } from "./fade.js";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const toolCursor = document.getElementById("tool-cursor");
const customColorInput = document.getElementById("custom-color");
const sizeSlider = document.getElementById("brush-size-slider");
const sizeValue = document.getElementById("brush-size-value");
const eraserSizeSlider = document.getElementById("eraser-size-slider");
const eraserSizeValue = document.getElementById("eraser-size-value");
const toolBrushButton = document.getElementById("tool-brush");
const toolEraserButton = document.getElementById("tool-eraser");
const createRoomButton = document.getElementById("create-room-button");
const joinRoomForm = document.getElementById("join-room-form");
const joinRoomCodeInput = document.getElementById("join-room-code");
const publicRoomControls = document.getElementById("public-room-controls");
const privateRoomControls = document.getElementById("private-room-controls");
const roomCodeLabel = document.getElementById("room-code-label");

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
let brushSizePx = Number(sizeSlider.value);
let eraserSizePx = Number(eraserSizeSlider.value);
let mode = "brush"; // "brush" | "eraser"

// The gesture currently being dragged (from pointerdown to pointerup/cancel),
// painted onto the local owner's own layer as points stream in -- see
// renderCurrentDelta. Not yet persisted until the gesture ends.
let current = null; // { kind: "draw" | "erase", color: string | null, size: number (normalized), points: [{x, y}] }
let currentLastRenderedIndex = 0;
let frameHandle = null; // requestAnimationFrame handle for the next scheduled render, or null

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
  if (current && myOwnerId !== null) {
    const layer = ensureLayer(myOwnerId);
    renderPathOnLayer(layer.ctx, current.kind, current.color, current.size, current.points);
    currentLastRenderedIndex = current.points.length - 1;
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
  if (current && current.kind === "draw" && myOwnerId !== null) {
    // The in-progress gesture is always the newest content in existence, so
    // it's always safe to paint it directly and unclipped on top of
    // everything just replayed above.
    renderPathOnLayer(ctx, "draw", current.color, current.size, current.points);
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
  } catch {
    // Best-effort; the gesture is already visible locally even if this
    // particular persistence call failed.
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
  persistGesture(finished);
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
    color = swatch.dataset.color;
    selectSwatch(swatch);
  });
}

const customSwatch = customColorInput.closest(".swatch");
customSwatch.style.background = customColorInput.value;

customColorInput.addEventListener("input", () => {
  color = customColorInput.value;
  customSwatch.style.background = customColorInput.value;
  selectSwatch(customSwatch);
});

sizeSlider.addEventListener("input", () => {
  brushSizePx = Number(sizeSlider.value);
  sizeValue.textContent = `${brushSizePx}px`;
  updateCursorSize();
});

eraserSizeSlider.addEventListener("input", () => {
  eraserSizePx = Number(eraserSizeSlider.value);
  eraserSizeValue.textContent = `${eraserSizePx}px`;
  updateCursorSize();
});

function setMode(newMode) {
  mode = newMode;
  toolBrushButton.classList.toggle("selected", mode === "brush");
  toolEraserButton.classList.toggle("selected", mode === "eraser");
  toolBrushButton.setAttribute("aria-pressed", String(mode === "brush"));
  toolEraserButton.setAttribute("aria-pressed", String(mode === "eraser"));
  canvas.style.cursor = "none"; // replaced by the custom circular tool-cursor overlay
  updateCursorSize();
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
  return mode === "eraser" ? eraserSizePx : brushSizePx;
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

// Visibility only -- which controls are shown, not which drawing engine
// runs. Both branches share the exact same canvas/app.js below this point.
if (isPublicCanvas) {
  createRoomButton.addEventListener("click", async () => {
    const res = await fetch("/api/rooms", { method: "POST" });
    const { code } = await res.json();
    location.href = `/room/${code}`;
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
}

resizeCanvas();
setMode(mode);
loadMe().then(loadOps); // ownership must be known before a layer can be attributed to "my own"

// Fades are extremely slow (2 percentage points per 15 minutes -- see
// public/fade.js), so a 1Hz tick is far more than enough to look continuous;
// nowhere near the cost of a per-frame animation loop. Skipped entirely while
// a gesture is in progress (current !== null): that gesture's own rendering
// (renderCurrentDelta, and endGesture's reconciliation repaint) is already
// authoritative for every pixel it touches, and an unrelated full repaint
// firing mid-drag would only race it for no benefit. Normal fade repaint
// resumes on the next tick once the gesture ends.
setInterval(() => {
  if (current) return;
  repaintVisibleCanvas();
}, 1000);
