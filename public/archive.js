// Read-only replay of Public's historical pre-pixel-wall freehand artwork --
// every op server/db.js tags doc_kind: 'freehand' (Step 1), frozen and never
// converted, deleted, or silently hidden (per the locked product direction).
//
// This necessarily duplicates a small, bounded slice of public/app.js's own
// freehand replay model (one raster layer per owner, destination-out erase
// clipped to that owner's own layer, seq-ordered composite): app.js has no
// exported functions to import from without refactoring the live,
// interactive editor, which was judged a disproportionate risk for this one
// secondary, read-only page. public/fade.js IS reused completely unchanged
// -- the one piece of this replay that already lived in its own pure module.
// There is no pointer handling, no tool state, and no write path anywhere in
// this file: GET /api/ops is the only request it ever makes.

import { fadeOpacity } from "./fade.js";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const DOCUMENT_WIDTH = 1920;
const DOCUMENT_HEIGHT = 1080;
canvas.width = DOCUMENT_WIDTH;
canvas.height = DOCUMENT_HEIGHT;

const layers = new Map(); // ownerId -> {canvas, ctx}, each owner's own full-history raster mask

function ensureLayer(ownerId) {
  let layer = layers.get(ownerId);
  if (!layer) {
    const layerCanvas = document.createElement("canvas");
    layerCanvas.width = DOCUMENT_WIDTH;
    layerCanvas.height = DOCUMENT_HEIGHT;
    layer = { canvas: layerCanvas, ctx: layerCanvas.getContext("2d") };
    layers.set(ownerId, layer);
  }
  return layer;
}

function renderPathOnLayer(layerCtx, kind, color, sizeNormalized, points) {
  if (points.length === 0) return;
  const pixels = points.map((p) => ({ x: p.x * DOCUMENT_WIDTH, y: p.y * DOCUMENT_HEIGHT }));
  layerCtx.save();
  layerCtx.globalCompositeOperation = kind === "erase" ? "destination-out" : "source-over";
  layerCtx.strokeStyle = kind === "erase" ? "#000" : color;
  layerCtx.lineWidth = sizeNormalized * DOCUMENT_WIDTH;
  layerCtx.lineCap = "round";
  layerCtx.lineJoin = "round";
  layerCtx.beginPath();
  layerCtx.moveTo(pixels[0].x, pixels[0].y);
  if (pixels.length === 1) layerCtx.lineTo(pixels[0].x, pixels[0].y);
  else for (let i = 1; i < pixels.length; i++) layerCtx.lineTo(pixels[i].x, pixels[i].y);
  layerCtx.stroke();
  layerCtx.restore();
}

let scratch = null;
function ensureScratch() {
  if (!scratch) {
    const scratchCanvas = document.createElement("canvas");
    scratchCanvas.width = DOCUMENT_WIDTH;
    scratchCanvas.height = DOCUMENT_HEIGHT;
    scratch = { canvas: scratchCanvas, ctx: scratchCanvas.getContext("2d") };
  }
  return scratch;
}

// Full replay from scratch, in server seq order (the array GET /api/ops
// already returns): rebuild every owner's own layer first, then composite
// each draw op's faded colour clipped against its own owner's current
// (already-erased-where-applicable) layer -- the same two-pass shape as
// public/app.js's rebuildAllLayers + repaintVisibleCanvas, minus every piece
// that only exists for live interaction (pending gestures, bounded-region
// repaint, undo/redo).
function renderArchive(ops) {
  layers.clear();
  for (const op of ops) {
    const layer = ensureLayer(op.ownerId);
    renderPathOnLayer(layer.ctx, op.kind, op.color, op.size, op.points);
  }

  ctx.clearRect(0, 0, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
  const { canvas: scratchCanvas, ctx: scratchCtx } = ensureScratch();
  const now = Date.now();
  for (const op of ops) {
    if (op.kind !== "draw") continue; // an erase op's only effect is already baked into its owner's layer
    const opacity = fadeOpacity(op.createdAt, now);
    if (opacity <= 0) continue;
    const ownerLayer = layers.get(op.ownerId);
    scratchCtx.clearRect(0, 0, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
    scratchCtx.globalAlpha = opacity;
    renderPathOnLayer(scratchCtx, "draw", op.color, op.size, op.points);
    scratchCtx.globalAlpha = 1;
    scratchCtx.globalCompositeOperation = "destination-in";
    scratchCtx.drawImage(ownerLayer.canvas, 0, 0);
    scratchCtx.globalCompositeOperation = "source-over";
    ctx.drawImage(scratchCanvas, 0, 0);
  }
}

async function loadArchive() {
  const res = await fetch("/api/ops"); // explicitly freehand-only (server/index.js); never includes a pixel op
  const ops = await res.json();
  renderArchive(ops);
}

loadArchive();
// Keeps the still-ongoing Public fade visibly progressing on a long-open tab,
// without needing a reload -- cheap at this interval and this document's size.
setInterval(loadArchive, 60_000);
