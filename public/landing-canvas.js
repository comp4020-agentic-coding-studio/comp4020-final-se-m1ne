// A read-only, minimal re-implementation of public/app.js's own owner-layer
// compositing model (see that file's module-level comment for the full
// rationale: one off-screen layer per artwork owner, an erase op masks only
// that owner's own layer, and every draw op replays in global seq order,
// each one clipped -- destination-in -- against its own owner's current
// layer, so a later draw always wins regardless of whose layer it's on,
// never a fixed per-owner stacking order).
//
// Deliberately a separate, reduced copy rather than importing app.js
// directly: app.js is a full interactive editor that wires pointer/undo-
// redo/zoom/profile/cursor listeners unconditionally at module scope against
// ~50 specific element ids, so loading it on a page that doesn't have (and,
// per this feature's own "read-only, no drawing/erasing/panning/editing"
// requirement, must not have) that chrome would both crash immediately and
// risk making the landing page secretly interactive. This module reuses the
// already-shared, already-tested low-level math instead (public/fade.js's
// effectiveOpacity, public/viewport.js's document-pixel conversion) and the
// exact same wire protocol app.js's own startRealtimeSync already consumes
// (server/index.js's "sync"/"op"/"undo"/"redo" events, completely
// unmodified by this file's existence) -- so "reuse" here means reusing the
// architecture and the live data, not a second copy of the interactive
// editor's own DOM/event wiring.
import { DOCUMENT_WIDTH, DOCUMENT_HEIGHT, documentPointToPixel, brushSizeToDocumentPx } from "./viewport.js";
import { effectiveOpacity } from "./fade.js";
import { paintShape } from "./shapes.js";

function toPixels(point) {
  return documentPointToPixel(point, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
}

// Identical stroking logic to app.js's own renderPathOnLayer -- same
// composite modes, same round caps, same single-point-tap special case --
// kept in lockstep deliberately, so this preview can never visibly diverge
// from how the same op renders in the real, interactive editor.
function renderPathOnLayer(layerCtx, kind, color, sizeNormalized, points, shape) {
  if (shape && points.length === 2) {
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
    layerCtx.lineTo(pixels[0].x, pixels[0].y);
  } else {
    for (let i = 1; i < pixels.length; i++) layerCtx.lineTo(pixels[i].x, pixels[i].y);
  }
  layerCtx.stroke();
  layerCtx.restore();
}

function groupByOwner(ops) {
  const byOwner = new Map();
  for (const op of ops) {
    if (!byOwner.has(op.ownerId)) byOwner.set(op.ownerId, []);
    byOwner.get(op.ownerId).push(op);
  }
  return byOwner;
}

// Sized once, to the fixed 1920x1080 document resolution -- identical to
// app.js's own initCanvasBackingStore -- never resized again by viewport
// fitting (see public/landing.js's own cover-fit scaling, which only ever
// touches this canvas's CSS box, exactly like app.js's zoom never touches
// canvas.width/height either).
export function createPublicCanvasRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  canvas.width = DOCUMENT_WIDTH;
  canvas.height = DOCUMENT_HEIGHT;

  let layers = new Map(); // ownerId -> { canvas, ctx }
  let allOps = []; // kept sorted by seq ascending -- see applyOp/applyRedo
  let scratch = null;

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

  function ensureScratch() {
    if (!scratch) {
      const scratchCanvas = document.createElement("canvas");
      scratchCanvas.width = DOCUMENT_WIDTH;
      scratchCanvas.height = DOCUMENT_HEIGHT;
      scratch = { canvas: scratchCanvas, ctx: scratchCanvas.getContext("2d") };
    }
    return scratch;
  }

  function rebuildAllLayers() {
    layers = new Map();
    for (const [ownerId, ops] of groupByOwner(allOps)) {
      const layer = ensureLayer(ownerId);
      for (const op of ops) renderPathOnLayer(layer.ctx, op.kind, op.color, op.size, op.points, op.shape);
    }
  }

  // Full rebuild of the visible canvas from scratch, in seq order -- the
  // same scratch+clip+composite math as app.js's own repaintVisibleCanvas,
  // minus the region-restriction optimization (this renderer only ever
  // updates once per incoming op/sync, not once per animation frame, so
  // there is no hot path here that needs it) and minus any local-gesture/
  // remote-preview painting (this page never has one).
  function repaint() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const { canvas: scratchCanvas, ctx: scratchCtx } = ensureScratch();
    const now = Date.now();
    for (const op of allOps) {
      if (op.kind !== "draw") continue; // an erase op's effect is already baked into its owner's layer
      const opacity = effectiveOpacity(op, now, true); // Public only -- this page has no Private Room equivalent
      if (opacity <= 0) continue;
      const ownerLayer = layers.get(op.ownerId);
      if (!ownerLayer) continue;
      scratchCtx.clearRect(0, 0, canvas.width, canvas.height);
      scratchCtx.globalAlpha = opacity;
      renderPathOnLayer(scratchCtx, "draw", op.color, op.size, op.points, op.shape);
      scratchCtx.globalAlpha = 1;
      scratchCtx.globalCompositeOperation = "destination-in";
      scratchCtx.drawImage(ownerLayer.canvas, 0, 0);
      scratchCtx.globalCompositeOperation = "source-over";
      ctx.drawImage(scratchCanvas, 0, 0);
    }
  }

  function bySeq(a, b) {
    return a.seq - b.seq;
  }

  function applySync(ops) {
    allOps = [...ops].sort(bySeq);
    rebuildAllLayers();
    repaint();
  }

  // A draw/erase op landing live -- painted directly onto its owner's
  // existing layer (every earlier op for that owner is already there; this
  // is just the next stroke), then the whole visible canvas recomposites.
  // allOps is re-sorted (not just pushed to) because a redo (below) or a
  // network reorder could otherwise insert an op out of seq order, which
  // would silently break "later draws win" for this preview.
  function applyOp(op) {
    if (allOps.some((existing) => existing.id === op.id)) return; // belt-and-braces; this page never originates an op of its own
    allOps.push(op);
    allOps.sort(bySeq);
    const layer = ensureLayer(op.ownerId);
    renderPathOnLayer(layer.ctx, op.kind, op.color, op.size, op.points, op.shape);
    repaint();
  }

  // Undo removes one op from the active set. There is no cheap incremental
  // "un-paint" for a destination-out erase once it's been composited into a
  // layer, so (exactly like app.js's own loadOps-driven undo/redo handling)
  // this rebuilds just that one owner's layer from the remaining ops, not
  // every owner's.
  function applyUndo(op) {
    allOps = allOps.filter((existing) => existing.id !== op.id);
    const layer = ensureLayer(op.ownerId);
    layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    const remaining = allOps.filter((existing) => existing.ownerId === op.ownerId);
    for (const existing of remaining) renderPathOnLayer(layer.ctx, existing.kind, existing.color, existing.size, existing.points, existing.shape);
    repaint();
  }

  // Redo re-adds a previously-undone op -- the exact same shape applyOp
  // already handles (append, re-sort, paint onto that owner's layer,
  // recomposite), so it's reused directly rather than duplicated.
  function applyRedo(op) {
    applyOp(op);
  }

  return { applySync, applyOp, applyUndo, applyRedo };
}
