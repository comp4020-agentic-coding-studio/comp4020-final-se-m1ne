import {
  boundingBoxesIntersectWithMargin,
  effectiveRadius,
  eraseFromPolyline,
  segmentBoundingBox,
  strokeBoundingBox,
} from "./geometry.js";

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

// Strokes are split by ownership so the eraser preview can affect only this
// participant's own content: otherStrokes is never touched by localErase,
// so another participant's drawing can never flicker/pop under this client's
// eraser cursor. ownedStrokes is this client's own authoritative, locally
// up-to-date model, kept in sync with the server's identical geometry.
let otherStrokes = [];
let ownedStrokes = [];
let myOwnerId = null;
let color = "#1d1d1d";
let brushSizePx = Number(sizeSlider.value);
let eraserSizePx = Number(eraserSizeSlider.value);
let current = null; // { color, width, points: [{x, y}] }, width normalized like points are
let mode = "brush"; // "brush" | "eraser"
let erasing = false; // whether an eraser drag is currently in progress
let pendingPath = []; // normalized points accumulated since the last rAF flush, for the drag in progress
let eraseFrameHandle = null; // requestAnimationFrame handle for the next scheduled flush, or null
let pendingErases = []; // in-flight persistence requests for the erase drag in progress

function resizeCanvas() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  redraw();
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

function drawStroke(stroke) {
  if (stroke.points.length === 0) return;

  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width * canvas.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const pixels = stroke.points.map(toPixels);
  ctx.beginPath();
  ctx.moveTo(pixels[0].x, pixels[0].y);
  for (const point of pixels.slice(1)) ctx.lineTo(point.x, point.y);
  if (pixels.length === 1) ctx.lineTo(pixels[0].x, pixels[0].y); // a tap: draw a dot
  ctx.stroke();
}

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const stroke of otherStrokes) drawStroke(stroke);
  for (const stroke of ownedStrokes) drawStroke(stroke);
  if (current) drawStroke(current);
}

async function loadStrokes() {
  const res = await fetch("/api/strokes");
  const all = await res.json();
  otherStrokes = all.filter((s) => s.ownerId !== myOwnerId);
  ownedStrokes = all.filter((s) => s.ownerId === myOwnerId);
  redraw();
}

async function loadMe() {
  const res = await fetch("/api/me");
  ({ ownerId: myOwnerId } = await res.json());
}

async function saveStroke(stroke) {
  const res = await fetch("/api/strokes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ color: stroke.color, width: stroke.width, points: stroke.points }),
  });
  Object.assign(stroke, await res.json()); // picks up id, ownerId, createdAt from the server
}

function pointerPos(event) {
  return toNormalized(event.clientX, event.clientY);
}

function eraserRadiusNormalized() {
  return eraserSizePx / 2 / canvas.width;
}

// Applies the exact swept-capsule geometry for every consecutive pair in
// `path` (not just its endpoints), sequentially chaining through whatever
// fragments an earlier pair in the same path already produced -- so no
// movement between frames is ever dropped. Only ever touches ownedStrokes
// (this client's own, matched by ownerId learned once from /api/me): this is
// purely a rendering decision, not an authorization one -- the server
// re-derives ownership from the cookie and enforces it independently of
// anything the client does here. otherStrokes is never read or written here,
// so another participant's strokes can never flicker under this preview.
// A bounding-box prefilter skips the expensive exact test for strokes whose
// (cached) bounding box can't possibly intersect a segment's swept region --
// a scalability guard only; it can never change which strokes are affected.
function localErase(path, radius) {
  if (myOwnerId === null) return;
  let working = ownedStrokes;
  let changed = false;

  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    const segmentBox = segmentBoundingBox(from, to);
    const next = [];

    for (const stroke of working) {
      const radiusForStroke = effectiveRadius(radius, stroke.width);
      const strokeBox = (stroke._bbox ??= strokeBoundingBox(stroke.points));
      if (!boundingBoxesIntersectWithMargin(strokeBox, segmentBox, radiusForStroke)) {
        next.push(stroke);
        continue;
      }

      const result = eraseFromPolyline(stroke.points, from, to, radiusForStroke);
      if (!result.changed) {
        next.push(stroke);
        continue;
      }
      changed = true;
      for (const points of result.fragments) {
        next.push({
          id: crypto.randomUUID(), // a throwaway local id; replaced wholesale once loadStrokes() resyncs
          ownerId: stroke.ownerId,
          color: stroke.color,
          width: stroke.width,
          points,
          createdAt: stroke.createdAt,
        });
      }
    }
    working = next;
  }

  if (changed) {
    ownedStrokes = working;
    redraw();
  }
}

// Fire-and-forget: persistence never gates the next visible frame. The
// server computes and stores the authoritative result independently (scoped
// to the caller's own strokes, chaining through the same path exactly like
// localErase does); its response isn't applied back onto ownedStrokes here;
// see finishErasing for why that's safe.
function sendErase(path, radius) {
  return fetch("/api/erase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, radius }),
  }).catch(() => {});
}

// Pulls every point the browser actually sampled since the last event
// (getCoalescedEvents), not just the one coalesced event the browser chose to
// dispatch -- so a fast drag's true path is captured even when pointer
// polling outpaces frame rate. Falls back to the event itself wherever
// coalesced events aren't available, or report none.
function accumulatePointerPath(event) {
  const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const samples = coalesced.length > 0 ? coalesced : [event];
  for (const sample of samples) pendingPath.push(pointerPos(sample));
}

function queueEraseFrame() {
  if (eraseFrameHandle === null) {
    eraseFrameHandle = requestAnimationFrame(flushErase);
  }
}

// Runs the exact geometry (and its batched persistence) at most once per
// rendered frame, regardless of how many raw pointer samples arrived since
// the last one -- this is what keeps the authoritative update cheap and
// bounded while still landing inside the same frame as the cursor move that
// triggered it, since a frame's pointer events are dispatched before that
// frame's requestAnimationFrame callbacks run.
function flushErase() {
  eraseFrameHandle = null;
  if (pendingPath.length < 2) return;
  const radius = eraserRadiusNormalized();
  const path = pendingPath;
  pendingPath = [path[path.length - 1]]; // carry the endpoint forward as the next frame's anchor
  localErase(path, radius);
  pendingErases.push(sendErase(path, radius));
}

// Used at pointerup/pointercancel: flushes synchronously rather than waiting
// for the next animation frame, since the gesture is ending now and there
// won't be one.
function flushEraseNow() {
  if (eraseFrameHandle !== null) {
    cancelAnimationFrame(eraseFrameHandle);
    eraseFrameHandle = null;
  }
  flushErase();
  pendingPath = [];
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  if (mode === "eraser") {
    const point = pointerPos(event);
    erasing = true;
    pendingErases = [];
    pendingPath = [point, point]; // a tap: a degenerate zero-length segment, same as a plain click today
    queueEraseFrame();
    return;
  }
  current = { color, width: brushSizePx / canvas.width, points: [pointerPos(event)] };
  redraw();
});

canvas.addEventListener("pointermove", (event) => {
  if (mode === "eraser") {
    if (event.buttons !== 0 && erasing) {
      accumulatePointerPath(event);
      queueEraseFrame();
    }
    return;
  }
  if (!current) return;
  current.points.push(pointerPos(event));
  redraw();
});

function endStroke() {
  if (!current) return;
  const finished = current;
  current = null;
  ownedStrokes.push(finished);
  redraw();
  saveStroke(finished);
}

// Once persistence for every batched request in this drag has actually
// landed, pull the confirmed server state in one shot. Local and server
// state should already agree (same geometry, same algorithm), so this is
// normally invisible -- it's a correctness backstop, not how erasing is
// meant to look.
async function finishErasing() {
  if (pendingErases.length === 0) return;
  const settled = pendingErases;
  pendingErases = [];
  await Promise.all(settled);
  await loadStrokes();
}

canvas.addEventListener("pointerup", () => {
  flushEraseNow();
  erasing = false;
  endStroke();
  finishErasing();
});
canvas.addEventListener("pointercancel", () => {
  flushEraseNow();
  erasing = false;
  endStroke();
  finishErasing();
});

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
// stroke's width is stored), and the canvas's backing-store size tracks its
// CSS size 1:1 (resizeCanvas sets canvas.width = canvas.clientWidth), so no
// conversion is needed and a resize can't desync the two.
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
resizeCanvas();
setMode(mode);
loadMe().then(loadStrokes); // ownership must be known before loadStrokes can split by it
