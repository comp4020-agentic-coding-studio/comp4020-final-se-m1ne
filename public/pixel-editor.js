// The one entry point loaded by every page (public/index.html's own
// <script src="/pixel-editor.js">): decides whether this page is the Public
// pixel wall, a Private pixel-art studio, or a legacy freehand Private room,
// using public/pixeldoc.js's resolveEditorMode -- never guessing, never
// reinterpreting a legacy room's freehand ops as pixel ops. A legacy room
// dynamically imports the existing, completely untouched public/app.js and
// hands off to it entirely; everything below this point only ever runs for
// the Public pixel wall or a pixel-art Private studio.
//
// The pixel engine itself (grid-accurate rasterization, deterministic
// replay, ownership-aware erase) is never reimplemented here -- every pixel
// this editor ever shows is ultimately resolved by public/pixelgrid.js's
// replayPixelOps, the exact module Step 2 built and tested in isolation.
// This file is DOM/network glue plus one performance discipline: a full
// replay of the WHOLE op history only ever runs at points bounded by user
// actions (load, undo/redo, a gesture's own persistence resolving), never
// once per animation frame while a gesture is being dragged -- see
// rebuildCommittedGrid/renderFromCommittedGrid/paintDeltaCells below for how
// a live gesture still renders correctly (including an erase correctly
// revealing an underlying contribution) without that per-frame cost.
//
// Step 6 (client-side SSE) plugs into this same structure without a rewrite:
// allOps/pendingOps/current and loadOps()/rebuildCommittedGrid() are exactly
// the authoritative-replay + local-pending-stroke seam an incoming `sync`/
// `op`/`undo`/`redo` event needs to update, the same way performUndo/
// persistGesture already do today via a plain fetch.

import { fadeOpacity } from "./fade.js";
import { hexToRgb, rgbToHex } from "./colour.js";
import { initColourPicker } from "./colour-picker-ui.js";
import { compositeOverWhite } from "./sampling.js";
import { replayPixelOps, cellsForStroke, cellKey } from "./pixelgrid.js";
import { cursorDiameterCssPx, fitZoom, stepZoom, clampZoom } from "./viewport.js";
import {
  MIN_BRUSH_SIZE,
  MAX_BRUSH_SIZE,
  DEFAULT_BRUSH_SIZE,
  PIXEL_MIN_ZOOM,
  PIXEL_MAX_ZOOM,
  PIXEL_ZOOM_LEVELS,
  resolveEditorMode,
  resolveRoomCreationResolution,
  cellFromClientPoint,
  buildRenderOps,
  removePendingOp,
  clampBrushSize,
  cellBoundsForPoints,
  boundsIntersect,
} from "./pixeldoc.js";

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
const roomCreatePopover = document.getElementById("room-create-popover");
const roomCreatePopoverClose = document.getElementById("room-create-popover-close");
const roomCreateCancelButton = document.getElementById("room-create-cancel");
const roomCreateConfirmButton = document.getElementById("room-create-confirm");
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
const gridOverlay = document.getElementById("pixel-grid-overlay");
const leaveRoomOverlay = document.getElementById("leave-room-overlay");
const leaveRoomMessage = document.getElementById("leave-room-message");
const leaveRoomCancelButton = document.getElementById("leave-room-cancel");
const leaveRoomConfirmButton = document.getElementById("leave-room-confirm");
const backToPublicLink = document.getElementById("back-to-public");

// Theme is a local UI preference only -- never sent to the server, never part
// of collaborative state. Identical in spirit to public/app.js's own theme
// code (duplicated rather than shared: it is a small, stable ~10 lines, and
// extracting a shared module for it alone was judged not worth touching the
// otherwise-untouched legacy file for).
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

const roomCode = location.pathname.match(/^\/room\/([^/]+)/)?.[1]?.toUpperCase() ?? null;

async function main() {
  let room = null;
  if (roomCode !== null) {
    try {
      const res = await fetch(`/api/rooms/${roomCode}`);
      room = res.ok ? await res.json() : null;
    } catch {
      room = null; // treated as "legacy" below, same as any other lookup failure -- never a crash
    }
  }

  const resolved = resolveEditorMode(roomCode, room);
  if (resolved.mode === "legacy") {
    // The untouched C8 freehand editor, loaded and handed off to entirely --
    // nothing below this point ever runs for a legacy room.
    await import("./app.js");
    return;
  }
  bootPixelEditor(resolved.width, resolved.height);
}

function bootPixelEditor(gridWidth, gridHeight) {
  const isPublicPixelWall = roomCode === null;
  const opsUrl = isPublicPixelWall ? "/api/pixels" : `/api/rooms/${roomCode}/pixels`;
  const drawUrl = `${opsUrl}/draw`;
  const eraseUrl = `${opsUrl}/erase`;
  const undoUrl = `${opsUrl}/undo`;
  const redoUrl = `${opsUrl}/redo`;

  // The backing store is the grid itself -- 1 canvas pixel = 1 logical pixel,
  // forever. Never resized by zoom/Fit/window resize (see applyZoom below,
  // which only ever assigns canvas.style.width/height); every drawing
  // coordinate from here on is already an exact integer cell in this space.
  // Presentation only -- a document background is metadata about how the
  // canvas is DISPLAYED (and, for "transparent", confirms nothing is hidden
  // behind an opaque fill), never something baked into a pixel op or
  // #canvas's own backing-store bitmap. See styles.css for the actual rules.
  function applyCanvasBackground(background) {
    canvas.classList.remove("pixel-bg-checkerboard", "pixel-bg-white");
    canvas.style.backgroundColor = "";
    if (background.kind === "transparent") {
      canvas.classList.add("pixel-bg-checkerboard");
    } else if (background.kind === "custom" && background.color) {
      canvas.style.backgroundColor = background.color;
    } else {
      canvas.classList.add("pixel-bg-white");
    }
  }

  canvas.width = gridWidth;
  canvas.height = gridHeight;
  canvas.classList.add("pixel-canvas"); // crisp (non-smoothed) CSS scaling, see styles.css
  // Public is always a solid opaque white document -- never a transparency
  // checkerboard. A Private studio's own background (transparent/white/
  // custom) is applied once its metadata is fetched (see bootPixelEditor's
  // room-fetch below); until then it defaults to white, the same as every
  // Private pixel room created before background metadata existed.
  applyCanvasBackground(isPublicPixelWall ? { kind: "white" } : { kind: "white" });
  statusDocSize.textContent = `${gridWidth} × ${gridHeight}`;

  let myOwnerId = null;
  let allOps = []; // authoritative, server-confirmed pixel ops for this document, in seq order
  let color = "#1d1d1d";
  let brushSizeCells = DEFAULT_BRUSH_SIZE;
  let mode = "brush"; // "brush" | "eraser" | "eyedropper"

  // The gesture currently being dragged, and gestures finished locally but
  // not yet confirmed by the server -- exactly public/app.js's own
  // current/pendingOps split, so an unfinished stroke is never lost and
  // never duplicated across a persist, regardless of how long the request
  // takes. `points` are already-sampled integer grid cells; gap-free
  // interpolation between consecutive points is public/pixelgrid.js's
  // cellsForStroke's own job at render/replay time, not reimplemented here.
  let current = null; // {kind, color, size, points}
  let currentLastRenderedIndex = 0; // how much of current.points this gesture's own live delta-paint has already covered
  let pendingOps = [];
  let frameHandle = null;

  // Best-effort local count of this owner's own ops currently undone and
  // still redoable, mirroring public/app.js's own myRedoCount: there is no
  // endpoint to ask "how many of mine are redoable", so this is tracked
  // client-side, reset on load and the instant any of this owner's own ops
  // actually persists (their redo branch was just abandoned server-side).
  let myRedoCount = 0;
  let zoom = PIXEL_MIN_ZOOM;

  // --- Rendering -------------------------------------------------------------
  // A full replay of the entire op history (public/pixelgrid.js's
  // replayPixelOps) is only ever run here, at points bounded by USER ACTIONS
  // (load, undo/redo, a gesture's own persistence resolving) -- never once
  // per animation frame while a gesture is being dragged, which is what
  // "avoid full-history replay on every pointer movement" rules out for a
  // large, populated document. `committedGrid` is the cached result of the
  // most recent such replay (authoritative history + this owner's own
  // finished-but-unconfirmed pendingOps, never the live in-progress
  // `current`); `myOwnedCellKeys` is the subset of it this owner currently
  // owns, snapshotted alongside it for the live erase path below.
  let committedGrid = new Map();
  let myOwnedCellKeys = new Set();

  function rebuildCommittedGrid() {
    const combined = buildRenderOps(allOps, pendingOps, null, myOwnerId);
    committedGrid = replayPixelOps(combined, gridWidth, gridHeight);
    myOwnedCellKeys = new Set();
    for (const [key, cell] of committedGrid) {
      if (cell.ownerId === myOwnerId) myOwnedCellKeys.add(key);
    }
  }

  function paintCommittedCell(x, y, cell, now) {
    const opacity = isPublicPixelWall ? fadeOpacity(cell.createdAt, now) : 1;
    if (opacity <= 0) {
      ctx.clearRect(x, y, 1, 1); // still persisted (see server/db.js), just no longer painted
      return;
    }
    const rgb = hexToRgb(cell.color);
    if (!rgb) return;
    // A plain fillRect on an unscaled, untransformed 2D context with integer
    // coordinates is exactly what makes this grid-accurate with no
    // antialiasing or fractional pixels -- there is no path stroking, and
    // nothing here depends on canvas.imageSmoothingEnabled (that setting
    // only affects drawImage-based scaling, not fill/stroke operations).
    ctx.fillStyle = opacity >= 1 ? cell.color : `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
    ctx.fillRect(x, y, 1, 1);
  }

  function parseCellKey(key) {
    const comma = key.indexOf(",");
    return { x: Number(key.slice(0, comma)), y: Number(key.slice(comma + 1)) };
  }

  // Full repaint from the already-computed committedGrid -- no replay. Used
  // after rebuildCommittedGrid (load, undo/redo, a gesture's own persistence
  // resolving) and by the Public 1Hz fade tick, which only ever needs to
  // recompute opacity for already-known cells against the current instant,
  // never to re-derive the grid itself.
  function renderFromCommittedGrid() {
    ctx.clearRect(0, 0, gridWidth, gridHeight);
    const now = Date.now();
    for (const [key, cell] of committedGrid) {
      const { x, y } = parseCellKey(key);
      paintCommittedCell(x, y, cell, now);
    }
  }

  // An op's own bounding box in cell space, cached on the op object itself
  // the first time it's needed -- mirrors public/app.js's own
  // opNormalizedBounds caching for the freehand engine. Only ever meaningful
  // for allOps entries (the same object every call), not the freshly-
  // rewrapped pendingOps/current synthetic copies buildRenderOps produces
  // each call -- caching on those is harmless, just never actually reused.
  function opBounds(op) {
    if (!op._cellBounds) op._cellBounds = cellBoundsForPoints(op.points, op.size);
    return op._cellBounds;
  }

  // Paints only the cells a gesture's OWN delta touches, directly -- never a
  // full-history replay. A draw always wins outright for the cells it
  // touches (public/pixelgrid.js's own rule: later draw beats any current
  // owner), so it's always safe to paint it straight onto the canvas. An
  // erase can retroactively reveal a DIFFERENT owner's earlier contribution
  // underneath (see pixelgrid.js's design note on per-cell ownership) -- not
  // expressible as a direct paint, so it's resolved with a real replay, but
  // one spatially bounded to only the ops whose own cached bounding box
  // overlaps this frame's delta: the cost scales with local drawing density
  // near this stroke, never with the whole document's history.
  function paintDeltaCells(deltaCells) {
    if (deltaCells.length === 0) return;
    if (current.kind === "draw") {
      for (const { x, y } of deltaCells) {
        ctx.fillStyle = current.color;
        ctx.fillRect(x, y, 1, 1);
      }
      return;
    }

    // Erase: for cells this owner doesn't currently own, nothing can ever
    // change (an unauthorized erase has no effect) -- skip them without even
    // considering a bounded replay.
    const candidateCells = deltaCells.filter(({ x, y }) => myOwnedCellKeys.has(cellKey(x, y)));
    if (candidateCells.length === 0) return;

    const region = cellBoundsForPoints(candidateCells, 1);
    const localOps = buildRenderOps(allOps, pendingOps, current, myOwnerId);
    const relevant = [];
    for (let i = 0; i < localOps.length; i++) {
      // The current gesture itself (always the last entry) is always
      // included regardless of bounds -- cells it erased earlier THIS SAME
      // gesture, outside this frame's own small delta region, must still be
      // accounted for.
      if (i === localOps.length - 1 || boundsIntersect(opBounds(localOps[i]), region)) relevant.push(localOps[i]);
    }
    const grid = replayPixelOps(relevant, gridWidth, gridHeight);
    const now = Date.now();
    for (const { x, y } of candidateCells) {
      const key = cellKey(x, y);
      const cell = grid.get(key);
      if (cell) paintCommittedCell(x, y, cell, now);
      else ctx.clearRect(x, y, 1, 1);
    }
  }

  // Paints only the portion of the in-progress gesture accumulated since the
  // last rendered frame -- not the whole path again. One point before the
  // new ones is included so Bresenham interpolation (cellsForStroke) connects
  // correctly across the frame boundary, exactly like public/app.js's own
  // renderCurrentDelta does for the freehand engine.
  function renderCurrentDelta() {
    if (!current) return;
    const start = Math.max(0, currentLastRenderedIndex - 1);
    const delta = current.points.slice(start);
    currentLastRenderedIndex = current.points.length;
    paintDeltaCells(cellsForStroke(delta, current.size, gridWidth, gridHeight));
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

  async function loadOps() {
    const res = await fetch(opsUrl);
    allOps = await res.json();
    rebuildCommittedGrid();
    renderFromCommittedGrid();
  }

  async function loadMe() {
    const res = await fetch("/api/me");
    ({ ownerId: myOwnerId } = await res.json());
  }

  function pointerCell(event) {
    return cellFromClientPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), gridWidth, gridHeight);
  }

  // Every point the browser actually sampled since the last event, not just
  // the one coalesced event the browser chose to dispatch -- the same
  // getCoalescedEvents discipline public/app.js already uses, so a fast
  // drag's true path is captured even when pointer polling outpaces frame
  // rate. Falls back to the event itself wherever coalesced events aren't
  // available or report none.
  function coalescedCells(event) {
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const samples = coalesced.length > 0 ? coalesced : [event];
    return samples.map(pointerCell);
  }

  function hasPendingGesture() {
    return current !== null || pendingOps.length > 0;
  }

  function updateUndoRedoButtons() {
    const pending = hasPendingGesture();
    const myOwnOps = allOps.filter((op) => op.ownerId === myOwnerId);
    undoButton.disabled = pending || myOwnOps.length === 0;
    redoButton.disabled = pending || myRedoCount <= 0;
  }

  function beginGesture(kind, cell) {
    if (myOwnerId === null) return;
    current = { kind, color: kind === "erase" ? null : color, size: brushSizeCells, points: [cell] };
    currentLastRenderedIndex = 0;
    renderCurrentDelta(); // immediate feedback for the very first point -- never waits on a queued frame
    updateUndoRedoButtons(); // a gesture just became pending -- disable until it resolves
  }

  function appendToGesture(cells) {
    if (!current) return;
    current.points.push(...cells);
    queueFrame();
  }

  // Unlike public/app.js's freehand persistGesture, a pixel gesture that
  // fails to persist is NOT left visible: its pixels were never actually
  // saved, so keeping them on screen would be exactly the "incorrect local
  // result" this editor must avoid, not a harmless best-effort leniency.
  // Either way, the gesture leaves pendingOps and a committed-grid rebuild +
  // full repaint always follows -- the ONE full replay this gesture ever
  // causes, at its own completion, not per frame -- so the canvas never
  // shows a state neither the server nor allOps agrees with.
  async function persistGesture(finished) {
    const endpoint = finished.kind === "erase" ? eraseUrl : drawUrl;
    const body =
      finished.kind === "erase"
        ? { size: finished.size, points: finished.points }
        : { color: finished.color, size: finished.size, points: finished.points };
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${endpoint} responded ${res.status}`);
      const saved = await res.json();
      allOps.push(saved);
      myRedoCount = 0; // this owner's remaining redo branch in this scope was just abandoned server-side
    } catch {
      // Left out of allOps entirely -- removed from pendingOps below, so the
      // next rebuild reflects only what the server actually has.
    } finally {
      pendingOps = removePendingOp(pendingOps, finished);
      rebuildCommittedGrid();
      renderFromCommittedGrid();
      updateUndoRedoButtons();
    }
  }

  function endGesture() {
    if (!current) return;
    cancelFrame();
    renderCurrentDelta(); // flush any points accumulated since the last rendered frame
    const finished = current;
    current = null;
    pendingOps.push(finished); // handed off before persistGesture's first await, so a rebuild in the gap still finds it
    updateUndoRedoButtons();
    persistGesture(finished);
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
    if (!op) return;
    myRedoCount = Math.max(0, myRedoCount - 1);
    await loadOps();
    updateUndoRedoButtons();
  }

  // Eyedropper: reads the exact colour already visible on #canvas at this
  // cell. The rendering functions above have already done all the real work
  // by the time this runs -- seq-ordered ownership, Public fade, and any
  // still-pending/in-progress local work are all already baked into this one
  // bitmap -- so this never replays ops or reconstructs fade itself, it just
  // reads one pixel from the same context every render already draws into.
  // compositeOverWhite (sampling.js, unchanged) recovers the colour actually
  // visible on screen from the raw RGBA, including a fully empty (alpha 0)
  // cell -- #canvas's own background (white, custom, or a checkerboard) is a
  // separate CSS layer getImageData cannot see, exactly like the freehand
  // engine's literal white background.
  function sampleColourAt(cell) {
    const [r, g, b, a] = ctx.getImageData(cell.x, cell.y, 1, 1).data;
    colourPicker.setColor(rgbToHex(compositeOverWhite(r, g, b, a)));
    setMode("brush");
  }

  // --- Pointer handling --------------------------------------------------
  // Middle-mouse drag pan, checked first, before Eyedropper and before
  // beginGesture: a middle-click can never be interpreted as a draw/erase
  // gesture, never creates an op, never touches colour/tool state. Baseline
  // pan (wheel/trackpad/scrollbar) needs no code: it's native
  // #canvas-viewport overflow:auto.
  let panState = null;

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
      event.preventDefault();
      beginPan(event);
      return;
    }
    if (mode === "eyedropper") {
      sampleColourAt(pointerCell(event)); // read-only and one-shot: no gesture, no op, no persistence request
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    beginGesture(mode === "eraser" ? "erase" : "draw", pointerCell(event));
  });

  canvas.addEventListener("pointermove", (event) => {
    if (panState && event.pointerId === panState.pointerId) {
      canvasViewport.scrollLeft = panState.startScrollLeft - (event.clientX - panState.startClientX);
      canvasViewport.scrollTop = panState.startScrollTop - (event.clientY - panState.startClientY);
      return;
    }
    if (!current) return;
    appendToGesture(coalescedCells(event));
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

  // --- Tools / size --------------------------------------------------------
  // One shared range for Brush and Eraser alike (1-8 integer cells) -- unlike
  // the freehand engine's two different per-tool ranges, pixel brush/eraser
  // sizes mean the exact same thing (public/pixelgrid.js's PixelOp.size).
  function syncSizeControlToMode() {
    if (mode === "eyedropper") {
      toolSizeSlider.disabled = true;
      return;
    }
    toolSizeSlider.disabled = false;
    toolSizeSlider.min = String(MIN_BRUSH_SIZE);
    toolSizeSlider.max = String(MAX_BRUSH_SIZE);
    toolSizeSlider.step = "1";
    toolSizeSlider.value = String(brushSizeCells);
    toolSizeValue.textContent = `${brushSizeCells}px`;
  }

  function updateCursorSize() {
    if (mode === "eyedropper") return;
    // 1 logical pixel already equals 1 document pixel in this grid, so the
    // brush's own on-canvas diameter in "document px" is just its cell
    // count -- cursorDiameterCssPx (viewport.js, unchanged) only needs that
    // scaled by the current zoom, exactly as it already does for freehand.
    const diameter = cursorDiameterCssPx(brushSizeCells, zoom);
    toolCursor.style.width = `${diameter}px`;
    toolCursor.style.height = `${diameter}px`;
  }

  function setMode(newMode) {
    mode = newMode;
    toolBrushButton.classList.toggle("selected", mode === "brush");
    toolEraserButton.classList.toggle("selected", mode === "eraser");
    toolEyedropperButton.classList.toggle("selected", mode === "eyedropper");
    toolBrushButton.setAttribute("aria-pressed", String(mode === "brush"));
    toolEraserButton.setAttribute("aria-pressed", String(mode === "eraser"));
    toolEyedropperButton.setAttribute("aria-pressed", String(mode === "eyedropper"));
    canvas.style.cursor = mode === "eyedropper" ? "crosshair" : "none";
    if (mode === "eyedropper") toolCursor.style.display = "none";
    syncSizeControlToMode();
    updateCursorSize();
    colourGroup.classList.toggle("colour-controls-dimmed", mode === "eraser");
  }

  toolBrushButton.addEventListener("click", () => setMode("brush"));
  toolEraserButton.addEventListener("click", () => setMode("eraser"));
  toolEyedropperButton.addEventListener("click", () => setMode("eyedropper"));

  toolSizeSlider.addEventListener("input", () => {
    brushSizeCells = clampBrushSize(Number(toolSizeSlider.value));
    toolSizeValue.textContent = `${brushSizeCells}px`;
    updateCursorSize();
  });

  canvas.addEventListener("pointerenter", (event) => {
    if (mode === "eyedropper") return;
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

  // --- Colour --------------------------------------------------------------
  // The exact same established custom-colour interaction the freehand editor
  // uses -- preset swatches, the Hue-ring/SV-square wheel, RGB/HSV sliders --
  // via the shared public/colour-picker-ui.js module, so there is exactly one
  // colour-selection implementation for both editors, not two.
  const colourPicker = initColourPicker({
    initialColor: color,
    onChange: (hex) => {
      color = hex;
    },
  });

  // --- Zoom / Fit / grid overlay --------------------------------------------
  // Reuses public/viewport.js's clampZoom/fitZoom/stepZoom completely
  // unchanged -- every one of them already takes min/max/levels as
  // parameters -- with pixeldoc.js's own PIXEL_MIN_ZOOM/MAX_ZOOM/LEVELS,
  // sized for magnifying a small logical grid rather than a 1920x1080
  // freehand canvas. Zoom still only ever changes canvas.style.width/height,
  // never canvas.width/height, so it never clears or replays a single pixel
  // of artwork.
  const FIT_MARGIN_PX = 24;
  const GRID_OVERLAY_MIN_ZOOM = 8; // below this, individual cells are too small for a grid to help rather than add noise

  function updateGridOverlay() {
    if (zoom < GRID_OVERLAY_MIN_ZOOM) {
      gridOverlay.hidden = true;
      return;
    }
    gridOverlay.hidden = false;
    gridOverlay.style.left = `${canvas.offsetLeft}px`;
    gridOverlay.style.top = `${canvas.offsetTop}px`;
    gridOverlay.style.width = canvas.style.width;
    gridOverlay.style.height = canvas.style.height;
    gridOverlay.style.backgroundSize = `${zoom}px ${zoom}px`;
  }

  function applyZoom(nextZoom) {
    zoom = clampZoom(nextZoom, PIXEL_MIN_ZOOM, PIXEL_MAX_ZOOM);
    canvas.style.width = `${gridWidth * zoom}px`;
    canvas.style.height = `${gridHeight * zoom}px`;
    zoomPercentDisplay.textContent = `${Math.round(zoom * 100)}%`;
    updateCursorSize();
    updateGridOverlay();
  }

  function applyFit() {
    applyZoom(
      fitZoom(canvasViewport.clientWidth, canvasViewport.clientHeight, gridWidth, gridHeight, FIT_MARGIN_PX, PIXEL_MIN_ZOOM, PIXEL_MAX_ZOOM),
    );
  }

  zoomInButton.addEventListener("click", () => applyZoom(stepZoom(zoom, PIXEL_ZOOM_LEVELS, 1)));
  zoomOutButton.addEventListener("click", () => applyZoom(stepZoom(zoom, PIXEL_ZOOM_LEVELS, -1)));
  fitButton.addEventListener("click", applyFit);

  // --- Private Room presence / invite-code joining --------------------------
  // Identical lifecycle to public/app.js's own (duplicated rather than
  // shared, for the same reason as the theme toggle above): a lease on "this
  // tab is still open", renewed every HEARTBEAT_INTERVAL_MS, with an
  // explicit Leave dropping it immediately rather than waiting for it to go
  // stale. The server-side heartbeat/expiry logic (server/db.js) is entirely
  // unchanged by this step and already treats a pixel-art room exactly like
  // a legacy one.
  const HEARTBEAT_INTERVAL_MS = 30_000;
  let presenceId = null;
  let heartbeatHandle = null;

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
      return false;
    }
  }

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

  async function leaveRoom() {
    stopPresence();
    try {
      await fetch(`/api/rooms/${roomCode}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presenceId }),
      });
    } catch {
      // Best-effort; the heartbeat simply stopping is still the correctness fallback.
    }
    location.href = "/";
  }

  if (isPublicPixelWall) {
    // Resolution is chosen as part of the creation interaction -- a small
    // popover confirmed before anything is created -- not a permanently-
    // visible toolbar control, and never editable again once a room exists
    // (its resolution is fixed forever at creation, server/db.js's own
    // immutability for width/height).
    function openRoomCreatePopover() {
      const rect = createRoomButton.getBoundingClientRect();
      const popoverWidth = 220;
      roomCreatePopover.style.top = `${rect.bottom + 6}px`;
      roomCreatePopover.style.left = `${Math.min(rect.left, window.innerWidth - popoverWidth - 8)}px`;
      roomCreatePopover.hidden = false;
      createRoomButton.setAttribute("aria-expanded", "true");
    }
    function closeRoomCreatePopover() {
      roomCreatePopover.hidden = true;
      createRoomButton.setAttribute("aria-expanded", "false");
    }

    createRoomButton.addEventListener("click", () => {
      if (roomCreatePopover.hidden) openRoomCreatePopover();
      else closeRoomCreatePopover();
    });
    roomCreatePopoverClose.addEventListener("click", closeRoomCreatePopover);
    document.addEventListener("pointerdown", (event) => {
      if (roomCreatePopover.hidden) return;
      if (roomCreatePopover.contains(event.target) || createRoomButton.contains(event.target)) return;
      closeRoomCreatePopover();
    });
    window.addEventListener("keydown", (event) => {
      if (!roomCreatePopover.hidden && event.key === "Escape") closeRoomCreatePopover();
    });

    roomCreateConfirmButton.addEventListener("click", async () => {
      const checked = document.querySelector('input[name="room-resolution"]:checked');
      const resolution = resolveRoomCreationResolution(checked?.value);
      closeRoomCreatePopover();
      const newPresenceId = crypto.randomUUID();
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presenceId: newPresenceId, resolution }),
      });
      const { code } = await res.json();
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
    // Read-only document information -- this room's resolution is fixed
    // forever at creation, so it is shown here (and in the status bar's own
    // statusDocSize, set above), never as an editable control inside a room.
    roomCodeLabel.textContent = `Room: ${roomCode} (${gridWidth} × ${gridHeight})`;

    const pidFromUrl = new URLSearchParams(location.search).get("pid");
    presenceId = pidFromUrl && pidFromUrl.length > 0 ? pidFromUrl : crypto.randomUUID();
    if (pidFromUrl) history.replaceState(null, "", location.pathname);

    backToPublicLink.addEventListener("click", (event) => {
      event.preventDefault();
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

  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const target = document.activeElement;
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

  setMode(mode);
  // Public's document may extend far beyond the viewport (2048x1152) and is
  // deliberately never auto-Fit on load -- a visitor lands at 100%, panning
  // to see more, rather than the whole wall being shrunk to fit on open. A
  // Private studio (still typically small) keeps the existing one-shot Fit.
  requestAnimationFrame(() => {
    if (isPublicPixelWall) applyZoom(1);
    else applyFit();
  });
  loadMe().then(loadOps).then(updateUndoRedoButtons); // ownership must be known before "my own" pending work can render

  // Exists solely to animate the Public wall's fade -- a Private studio's
  // effectiveOpacity never changes with time, so there is nothing for a
  // from-scratch repaint to pick up between ticks. Cheap even for a large,
  // populated wall: renderFromCommittedGrid only recomputes fade opacity for
  // already-known cells against the current instant, it never re-replays
  // history. Skipped entirely while a gesture is in progress, for the same
  // reason public/app.js skips its own: the gesture's own rendering is
  // already authoritative for every pixel it touches.
  if (isPublicPixelWall) {
    setInterval(() => {
      if (current) return;
      renderFromCommittedGrid();
    }, 1000);
  }
}

main();
