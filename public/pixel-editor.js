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
// Real-time sync (startRealtimeSync, below) plugs into this same structure
// without a rewrite: allOps/pendingOps/current and rebuildCommittedGrid()
// are exactly the authoritative-replay + local-pending-stroke seam an
// incoming `sync`/`op`/`undo`/`redo` SSE event updates, the same seam
// persistGesture's own local fetch always has.

import { fadeOpacity } from "./fade.js";
import { hexToRgb, rgbToHex } from "./colour.js";
import { initColourPicker } from "./colour-picker-ui.js";
import { compositeOverWhite } from "./sampling.js";
import { installNavigationMarking, isNavigating, markNavigating, releasePreviousLease } from "./presence-handoff.js";
import { wireHelpPopover } from "./help-popover.js";
import { replayPixelOps, cellsForStroke, cellKey } from "./pixelgrid.js";
import { cursorDiameterCssPx, fitZoom, stepZoom, clampZoom } from "./viewport.js";
import {
  MIN_BRUSH_SIZE,
  MAX_BRUSH_SIZE,
  DEFAULT_BRUSH_SIZE,
  createBrushSizeState,
  PIXEL_ZOOM_MIN,
  PUBLIC_ZOOM_MAX,
  PRIVATE_ZOOM_MAX,
  PUBLIC_ZOOM_LEVELS,
  PRIVATE_ZOOM_LEVELS,
  zoomToSliderPosition,
  sliderPositionToZoom,
  GRID_MIN_ZOOM_FOR_DISPLAY,
  GRID_MAX_CELL_SIZE,
  gridCellLogicalSize,
  shouldShowPixelGrid,
  resolveEditorMode,
  cellFromClientPoint,
  buildRenderOps,
  removePendingOp,
  cellBoundsForPoints,
  boundsIntersect,
  clampCanvasDimension,
} from "./pixeldoc.js";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const canvasViewport = document.getElementById("canvas-viewport");
const toolCursor = document.getElementById("tool-cursor");
const toolSizeSlider = document.getElementById("tool-size-slider");
const toolSizeValue = document.getElementById("tool-size-value");
const toolSizeNumber = document.getElementById("tool-size-number");
const toolBrushButton = document.getElementById("tool-brush");
const toolEraserButton = document.getElementById("tool-eraser");
const toolEyedropperButton = document.getElementById("tool-eyedropper");
const colourGroup = document.getElementById("colour-group");
const createRoomButton = document.getElementById("create-room-button");
const roomCreatePopover = document.getElementById("room-create-popover");
const roomCreatePopoverClose = document.getElementById("room-create-popover-close");
const roomCreateCancelButton = document.getElementById("room-create-cancel");
const roomCreateConfirmButton = document.getElementById("room-create-confirm");
const newCanvasWidthInput = document.getElementById("new-canvas-width");
const newCanvasHeightInput = document.getElementById("new-canvas-height");
const joinRoomForm = document.getElementById("join-room-form");
const joinRoomCodeInput = document.getElementById("join-room-code");
const publicRoomControls = document.getElementById("public-room-controls");
const privateRoomControls = document.getElementById("private-room-controls");
const roomCodeLabel = document.getElementById("room-code-label");
const undoButton = document.getElementById("undo-button");
const redoButton = document.getElementById("redo-button");
const zoomOutButton = document.getElementById("zoom-out-button");
const zoomInButton = document.getElementById("zoom-in-button");
const zoomSlider = document.getElementById("zoom-slider");
const zoomPercentDisplay = document.getElementById("zoom-percent");
const fitButton = document.getElementById("fit-button");
const gridOverlay = document.getElementById("pixel-grid-overlay");
const leaveRoomOverlay = document.getElementById("leave-room-overlay");
const leaveRoomMessage = document.getElementById("leave-room-message");
const leaveRoomCancelButton = document.getElementById("leave-room-cancel");
const leaveRoomConfirmButton = document.getElementById("leave-room-confirm");
const backToPublicLink = document.getElementById("back-to-public");
const workspace = document.getElementById("workspace");
const sizeGroup = document.getElementById("size-group");
const studioSideRail = document.getElementById("studio-side-rail");
const sideRailBrushSize = document.getElementById("side-rail-brush-size");
const documentSettingsButton = document.getElementById("document-settings-button");
const documentSettingsPopover = document.getElementById("document-settings-popover");
const documentSettingsClose = document.getElementById("document-settings-close");
const documentSettingsBody = document.getElementById("document-settings-body");
const documentDimensions = document.getElementById("document-dimensions");
const gridToggle = document.getElementById("grid-toggle");

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
    // The continuous zoom slider is a pixel-editor-only control (C8's own
    // zoom was always +/- buttons only, which app.js still has and still
    // fully wires up) -- every OTHER pixel-only control already defaults to
    // HTML's own `hidden` attribute and is only ever revealed by
    // bootPixelEditor below, which never runs for a legacy page, so this is
    // the one visible exception that needs hiding explicitly rather than
    // sitting inertly on screen.
    zoomSlider.hidden = true;
    // The untouched C8 freehand editor, loaded and handed off to entirely --
    // nothing below this point ever runs for a legacy room.
    await import("./app.js");
    return;
  }
  bootPixelEditor(resolved.width, resolved.height);
}

function bootPixelEditor(gridWidth, gridHeight) {
  // Wired only inside bootPixelEditor (the "pixel" branch only), never at module top level, so
  // it is never double-registered alongside public/app.js's own copy of this
  // same wiring on a "legacy" page.
  wireHelpPopover();

  const isPublicPixelWall = roomCode === null;
  // One uniform ceiling for every tool/mode combination -- never a
  // scope-dependent cap (see server/index.js's/pixeldoc.js's own
  // MAX_BRUSH_SIZE comments for why 100, not larger).
  const maxBrushSize = MAX_BRUSH_SIZE;
  const zoomMax = isPublicPixelWall ? PUBLIC_ZOOM_MAX : PRIVATE_ZOOM_MAX;
  const zoomLevels = isPublicPixelWall ? PUBLIC_ZOOM_LEVELS : PRIVATE_ZOOM_LEVELS;
  const opsUrl = isPublicPixelWall ? "/api/pixels" : `/api/rooms/${roomCode}/pixels`;
  const drawUrl = `${opsUrl}/draw`;
  const eraseUrl = `${opsUrl}/erase`;
  const undoUrl = `${opsUrl}/undo`;
  const redoUrl = `${opsUrl}/redo`;
  const streamUrl = `${opsUrl}/stream`;

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
  // Every document (Public and Private alike) is a solid opaque white
  // canvas -- the background is no longer configurable from the UI.
  applyCanvasBackground({ kind: "white", color: null });

  let myOwnerId = null;
  let allOps = []; // authoritative, server-confirmed pixel ops for this document, in seq order
  let color = "#1d1d1d";
  // Pencil and Eraser each keep their own independently-remembered size (the
  // C8 freehand editor's own toolSizes behaviour, restored here) -- ONE
  // shared slider/numeric input, but switching tools never overwrites the
  // other tool's stored value. See pixeldoc.js's createBrushSizeState.
  const toolSizes = createBrushSizeState(maxBrushSize, DEFAULT_BRUSH_SIZE);
  let mode = "brush"; // "brush" | "eraser" | "eyedropper"

  function activeToolSize() {
    return toolSizes.get(mode === "eraser" ? "eraser" : "brush");
  }

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
  let zoom = PIXEL_ZOOM_MIN;
  // The user's own ON/OFF grid preference -- a pure local display
  // preference (like theme), never sent to the server, never part of
  // collaborative state, defaulting to ON per spec. Persisted so it
  // survives a reload, the same way theme already does.
  let gridPreferenceOn = localStorage.getItem("pixelGridOn") !== "false";

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
      // Every cell in one call shares current.color -- fillStyle is set
      // ONCE here, not per cell. A large brush (up to MAX_BRUSH_SIZE=100)
      // can touch thousands of cells in a single frame, and re-parsing the
      // identical colour string on every one of those fillRect calls is
      // pure waste; this is a correctness-neutral micro-optimization (the
      // painted pixels are bit-for-bit identical either way).
      ctx.fillStyle = current.color;
      for (const { x, y } of deltaCells) {
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

  // --- Real-time sync (SSE) -------------------------------------------------
  // Reuses the existing /api/pixels/stream (Public) and
  // /api/rooms/:code/pixels/stream (Private) endpoints unchanged -- never a
  // second transport. The server's own design (see server/index.js's
  // startPixelStream) sends a full authoritative snapshot as literally the
  // first frame of every connection, including every reconnect, so a plain
  // `sync` handler that REPLACES allOps wholesale is correct for the initial
  // load AND for recovering after a dropped connection -- no separate GET
  // request, no Last-Event-ID bookkeeping. `op`/`undo`/`redo` are the same
  // three broadcasts handlePixelDraw/handlePixelErase/the undo and redo
  // routes already send on every successful write, to every subscriber of
  // this exact scope (Public, or this one room) -- including the browser
  // tab that made the request itself, which is why both handlers below
  // dedupe by id rather than assuming every event is "from someone else".
  function applyRemoteOpState(data) {
    const idx = allOps.findIndex((op) => op.id === data.id);
    if (idx === -1) allOps.push(data);
    else allOps[idx] = data;
    // Undo/redo can touch any cell anywhere in the document's history, so
    // there is no cheaper correct option here than a full repaint -- unlike
    // a draw/erase, this is not a per-frame hot path (a user undoes/redoes
    // far less often than they draw), so that cost is a non-issue.
    rebuildCommittedGrid();
    renderFromCommittedGrid();
    updateUndoRedoButtons();
  }

  function startRealtimeSync() {
    const source = new EventSource(streamUrl);

    source.addEventListener("sync", (event) => {
      const data = JSON.parse(event.data);
      allOps = data.ops;
      rebuildCommittedGrid();
      renderFromCommittedGrid();
      updateUndoRedoButtons();
    });

    source.addEventListener("op", (event) => {
      const data = JSON.parse(event.data);
      // Already applied locally the instant persistGesture's own fetch
      // resolved (see below) -- this is that same op's broadcast echoing
      // back, not new information, so there is nothing further to do.
      if (allOps.some((op) => op.id === data.id)) return;
      allOps.push(data);
      rebuildCommittedGrid();
      // A remote collaborator's stroke was never rendered locally (no local
      // gesture painted it incrementally the way our own strokes are), so
      // it needs the one real repaint to actually become visible; our own
      // just-finished gesture already looks correct on screen without one
      // (this is the same success-path optimization persistGesture already
      // relies on, just phrased the other way around: skip the repaint
      // when WE already know it's right, do it when we don't).
      if (data.ownerId !== myOwnerId) renderFromCommittedGrid();
      updateUndoRedoButtons();
    });

    source.addEventListener("undo", (event) => applyRemoteOpState(JSON.parse(event.data)));
    source.addEventListener("redo", (event) => applyRemoteOpState(JSON.parse(event.data)));

    // Deliberately no onerror/reconnect handling: EventSource retries
    // natively, and every retry is just a brand new connection to the same
    // route, which always answers with an equally fresh `sync` snapshot --
    // there is no missed-event state to reconcile by hand. Closed
    // automatically by the browser on navigation/unload; this app has no
    // in-page document-switching to additionally close it for (leaving a
    // room is always a full navigation -- see leaveRoom below).
    return source;
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
    // size is whichever tool `kind` corresponds to's own independently
    // remembered size -- NOT always the Pencil's, which was the regression:
    // an erase gesture must use the Eraser's own stored size, never the
    // Pencil's, even though they share one on-screen slider.
    current = { kind, color: kind === "erase" ? null : color, size: activeToolSize(), points: [cell] };
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
  // Either way, the gesture leaves pendingOps and a committed-grid rebuild
  // always follows -- rebuildCommittedGrid's own cache (committedGrid/
  // myOwnedCellKeys) must reflect reality either way, for every FUTURE
  // lookup (the next gesture's bounded erase replay, ownership checks, the
  // eyedropper, the Public fade tick).
  //
  // A full CANVAS REPAINT (renderFromCommittedGrid -- clearRect over the
  // whole document, then redraw every known cell, cost proportional to the
  // document's total painted-cell history) is a different matter: on
  // SUCCESS, the gesture's own incremental rendering (paintDeltaCells, run
  // every frame during the drag) has already painted the exactly correct
  // final pixels for every cell this gesture touched -- a draw always wins
  // outright, and an erase's own live rendering already resolved whatever
  // it reveals via a bounded replay -- so a second full repaint here would
  // recompute and redraw thousands of already-correct pixels for nothing.
  // It's only needed on FAILURE, to visually roll back an optimistic
  // rendering the server never actually accepted.
  async function persistGesture(finished) {
    const endpoint = finished.kind === "erase" ? eraseUrl : drawUrl;
    const body =
      finished.kind === "erase"
        ? { size: finished.size, points: finished.points }
        : { color: finished.color, size: finished.size, points: finished.points };
    let succeeded = false;
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
      succeeded = true;
    } catch {
      // Left out of allOps entirely -- removed from pendingOps below, so the
      // next rebuild reflects only what the server actually has.
    } finally {
      pendingOps = removePendingOp(pendingOps, finished);
      rebuildCommittedGrid();
      if (!succeeded) renderFromCommittedGrid();
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
    updateUndoRedoButtons(); // the Redo button's own enablement only ever depends on local myRedoCount, not on allOps
    // allOps/committedGrid/the repaint all update once the matching `undo`
    // SSE broadcast echoes back (applyRemoteOpState, above) -- the exact
    // same event a remote collaborator's own undo delivers, so both are
    // handled by one code path, never two.
  }

  async function performRedo() {
    if (hasPendingGesture()) return;
    const res = await fetch(redoUrl, { method: "POST" });
    if (!res.ok) return;
    const { op } = await res.json();
    if (!op) return;
    myRedoCount = Math.max(0, myRedoCount - 1);
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
  // One shared range for Brush and Eraser alike -- the uniform 1-100 ceiling
  // (public/pixeldoc.js's MAX_BRUSH_SIZE), identical for Public and Private,
  // never a scaling rule derived from canvas size. ONE shared slider and ONE
  // shared numeric input control whichever tool is currently active, but
  // Pencil and Eraser each keep their own independently-remembered size
  // underneath (toolSizes, above) -- restoring the C8 freehand editor's own
  // per-tool independence. A direct numeric input is shown alongside the
  // slider (not instead of the freehand engine's own read-only
  // #tool-size-value output, which stays untouched for public/app.js).
  toolSizeValue.hidden = true;
  toolSizeNumber.hidden = false;

  // Applies the active tool's own remembered size to the one shared
  // slider/number -- called on every tool switch so neither ever shows (or
  // silently inherits) the OTHER tool's value. Eyedropper has no size of its
  // own: the control is simply disabled, leaving whichever size was last
  // shown visible but inert underneath, exactly like the C8 freehand editor.
  function syncSizeControlToMode() {
    if (mode === "eyedropper") {
      toolSizeSlider.disabled = true;
      toolSizeNumber.disabled = true;
      return;
    }
    toolSizeSlider.disabled = false;
    toolSizeNumber.disabled = false;
    toolSizeSlider.min = String(MIN_BRUSH_SIZE);
    toolSizeSlider.max = String(maxBrushSize);
    toolSizeSlider.step = "1";
    toolSizeNumber.min = String(MIN_BRUSH_SIZE);
    toolSizeNumber.max = String(maxBrushSize);
    const size = activeToolSize();
    toolSizeSlider.value = String(size);
    toolSizeNumber.value = String(size);
  }

  function updateCursorSize() {
    if (mode === "eyedropper") return;
    // 1 logical pixel already equals 1 document pixel in this grid, so the
    // brush's own on-canvas diameter in "document px" is just its cell
    // count -- cursorDiameterCssPx (viewport.js, unchanged) only needs that
    // scaled by the current zoom, exactly as it already does for freehand.
    const diameter = cursorDiameterCssPx(activeToolSize(), zoom);
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
    syncSizeControlToMode(); // restores THIS tool's own stored size to the shared slider/number
    updateCursorSize();
    colourGroup.classList.toggle("colour-controls-dimmed", mode === "eraser");
  }

  toolBrushButton.addEventListener("click", () => setMode("brush"));
  toolEraserButton.addEventListener("click", () => setMode("eraser"));
  toolEyedropperButton.addEventListener("click", () => setMode("eyedropper"));

  // Writes only to the CURRENTLY ACTIVE tool's own stored size -- the
  // inactive tool's size is never touched by this, however many times the
  // slider/number fire while this tool stays selected.
  function setToolSize(rawValue) {
    const clamped = toolSizes.set(mode === "eraser" ? "eraser" : "brush", rawValue);
    toolSizeSlider.value = String(clamped);
    toolSizeNumber.value = String(clamped);
    updateCursorSize();
  }
  toolSizeSlider.addEventListener("input", () => setToolSize(toolSizeSlider.value));
  toolSizeNumber.addEventListener("input", () => setToolSize(toolSizeNumber.value));

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
  // parameters -- with pixeldoc.js's own scope-specific PIXEL_ZOOM_MIN/
  // zoomMax/zoomLevels (10%-800% Public, 10%-3200% Private), sized for
  // magnifying a small logical grid rather than a 1920x1080 freehand canvas.
  // Zoom still only ever changes canvas.style.width/height, never
  // canvas.width/height, so it never clears or replays a single pixel of
  // artwork. #zoom-slider is a continuous control over the same range,
  // logarithmically mapped (pixeldoc.js's zoomToSliderPosition/
  // sliderPositionToZoom) since a linear slider would waste almost all of
  // its travel above 100% on a 320x range -- it, the +/- buttons, the
  // percentage readout, Fit, and ctrl/cmd+wheel all funnel through this one
  // applyZoom, so there is exactly one zoom state, never a second one to
  // drift out of sync.
  const FIT_MARGIN_PX = 24;
  const ZOOM_SLIDER_RESOLUTION = Number(zoomSlider.max) || 1000;

  // Viewport-bounded by construction: this is one CSS background-image tile
  // pattern sized/positioned to match the canvas's own CSS box (never a line
  // per logical pixel, and never iterated per cell), so its cost is O(1)
  // regardless of document size or zoom -- the same technique behind every
  // "repeating background" grid overlay. shouldShowPixelGrid (pixeldoc.js) is
  // the one decision point for VISIBILITY: purely gridPreferenceOn now, never
  // hidden by zoom alone (that previously left Grid ON producing no visible
  // difference at ordinary zoom levels, e.g. Public's own 56% or Private's
  // own 514%, both well under the old always-hide-below-8x threshold).
  // gridCellLogicalSize instead makes the VISIBLE grid coarser at low zoom
  // (a sparse multiple-logical-pixel spacing) and finer at high zoom
  // (individual logical pixel boundaries, once that stays legible) --
  // spacing only, never a reason to hide it outright.
  function updateGridOverlay() {
    if (!shouldShowPixelGrid(gridPreferenceOn)) {
      gridOverlay.hidden = true;
      return;
    }
    gridOverlay.hidden = false;
    gridOverlay.style.left = `${canvas.offsetLeft}px`;
    gridOverlay.style.top = `${canvas.offsetTop}px`;
    // The overlay's own box is sized from the canvas's ACTUAL rendered rect
    // (getBoundingClientRect), not from canvas.style.width/height's raw
    // string: a browser can round/sub-pixel-snap a fractional CSS length
    // (gridWidth * zoom is essentially never a whole number) when it
    // actually lays the canvas out, so the TRUE on-screen scale can differ
    // very slightly from the raw `zoom` value. Deriving the grid tile size
    // from this same rect -- rather than recomputing it independently from
    // `zoom` -- means the grid is always measured against the exact same
    // geometry the canvas itself was actually rendered at, so the two can
    // never drift apart. That drift was small in absolute terms but got
    // multiplied by a large coarse cellSize at low zoom, which is exactly
    // where the misalignment was visible.
    const rect = canvas.getBoundingClientRect();
    gridOverlay.style.width = `${rect.width}px`;
    gridOverlay.style.height = `${rect.height}px`;
    const cellSize = gridCellLogicalSize(zoom, GRID_MIN_ZOOM_FOR_DISPLAY, GRID_MAX_CELL_SIZE);
    const screenCellPxX = cellSize * (rect.width / gridWidth);
    const screenCellPxY = cellSize * (rect.height / gridHeight);
    gridOverlay.style.backgroundSize = `${screenCellPxX}px ${screenCellPxY}px`;
  }

  // Reflects the user's own Grid preference in the Document popover --
  // separate from (and never changed by) updateGridOverlay's own temporary
  // low-zoom suppression above.
  function syncGridToggleUI() {
    gridToggle.textContent = gridPreferenceOn ? "On" : "Off";
    gridToggle.setAttribute("aria-pressed", String(gridPreferenceOn));
  }
  gridToggle.addEventListener("click", () => {
    gridPreferenceOn = !gridPreferenceOn;
    localStorage.setItem("pixelGridOn", String(gridPreferenceOn));
    syncGridToggleUI();
    updateGridOverlay();
  });
  syncGridToggleUI();

  // Keeps whatever document point is currently under (anchorClientX,
  // anchorClientY) -- the viewport's own centre by default, or the pointer
  // for wheel-zoom -- visually fixed across the zoom change, by reading the
  // canvas's actual rendered box (getBoundingClientRect already reflects
  // #canvas-viewport's own centring-when-it-fits/scroll-when-it-doesn't
  // layout, so this needs no special case for either) before and after
  // resizing, and adjusting scroll by exactly the difference. This is what
  // stops the canvas from jumping to some other part of the document on
  // every zoom change.
  function applyZoom(nextZoom, anchorClientX, anchorClientY) {
    const previousZoom = zoom;
    const viewportRect = canvasViewport.getBoundingClientRect();
    const targetClientX = anchorClientX ?? viewportRect.left + viewportRect.width / 2;
    const targetClientY = anchorClientY ?? viewportRect.top + viewportRect.height / 2;
    const rectBefore = canvas.getBoundingClientRect();
    const docX = (targetClientX - rectBefore.left) / previousZoom;
    const docY = (targetClientY - rectBefore.top) / previousZoom;

    zoom = clampZoom(nextZoom, PIXEL_ZOOM_MIN, zoomMax);
    canvas.style.width = `${gridWidth * zoom}px`;
    canvas.style.height = `${gridHeight * zoom}px`;
    zoomPercentDisplay.textContent = `${Math.round(zoom * 100)}%`;
    zoomSlider.value = String(Math.round(zoomToSliderPosition(zoom, PIXEL_ZOOM_MIN, zoomMax) * ZOOM_SLIDER_RESOLUTION));

    const rectAfter = canvas.getBoundingClientRect();
    canvasViewport.scrollLeft += rectAfter.left + docX * zoom - targetClientX;
    canvasViewport.scrollTop += rectAfter.top + docY * zoom - targetClientY;

    updateCursorSize();
    updateGridOverlay();
  }

  function applyFit() {
    applyZoom(fitZoom(canvasViewport.clientWidth, canvasViewport.clientHeight, gridWidth, gridHeight, FIT_MARGIN_PX, PIXEL_ZOOM_MIN, zoomMax));
  }

  // A high-frequency zoom source (dragging the slider, a fast wheel/trackpad
  // burst) can fire many events within a single animation frame; applyZoom
  // itself does two getBoundingClientRect reads (before/after, needed for
  // the anchor math above) plus a canvas.style.width/height write, and on a
  // large on-screen canvas box that write is a real reflow+repaint cost for
  // the browser's own compositor. Coalescing to at most one applyZoom call
  // per animation frame -- keeping only the LATEST request, exactly like
  // queueFrame/renderCurrentDelta already does for a drawing gesture -- cuts
  // that cost without changing the final result: the zoom level converged on
  // is identical, only intermediate sub-frame steps are coalesced.
  let pendingZoomRequest = null;
  let zoomFrameHandle = null;
  function scheduleZoom(nextZoom, anchorClientX, anchorClientY) {
    pendingZoomRequest = { nextZoom, anchorClientX, anchorClientY };
    if (zoomFrameHandle === null) {
      zoomFrameHandle = requestAnimationFrame(() => {
        zoomFrameHandle = null;
        const { nextZoom, anchorClientX, anchorClientY } = pendingZoomRequest;
        applyZoom(nextZoom, anchorClientX, anchorClientY);
      });
    }
  }

  zoomInButton.addEventListener("click", () => applyZoom(stepZoom(zoom, zoomLevels, 1)));
  zoomOutButton.addEventListener("click", () => applyZoom(stepZoom(zoom, zoomLevels, -1)));
  fitButton.addEventListener("click", applyFit);
  zoomSlider.addEventListener("input", () => {
    scheduleZoom(sliderPositionToZoom(Number(zoomSlider.value) / ZOOM_SLIDER_RESOLUTION, PIXEL_ZOOM_MIN, zoomMax));
  });
  // ctrl/cmd+wheel only -- a plain wheel/trackpad scroll keeps doing native
  // #canvas-viewport panning (overflow: auto), untouched. preventDefault
  // (needing { passive: false }) stops the browser's own page-zoom gesture
  // from also firing for the same ctrl+wheel/pinch input.
  canvasViewport.addEventListener(
    "wheel",
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      scheduleZoom(zoom * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    },
    { passive: false },
  );

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
    if (ok) releasePreviousLease(presenceId);
  }
  function stopPresence() {
    if (heartbeatHandle !== null) {
      clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
  }

  async function leaveRoom() {
    stopPresence();
    // Released by the Public page's handoff once it has registered its own lease.
    markNavigating(roomCode, presenceId);
    // "/" is the landing page now (public/landing.html) -- returning from a
    // Private Room must enter the Public editor directly, not the landing page.
    location.href = "/canvas";
  }

  // The shared Procreate/Pixquare-inspired editor shell: ONE DOM layout,
  // top toolbar, left control rail, canvas workspace, and status bar, used
  // identically by Public and every Private studio -- never two separately
  // designed interfaces. #tool-ribbon (Tools/Size/Colours) stays a compact
  // top toolbar via .studio-layout's own CSS; only the brush-size slider and
  // its direct numeric input -- #size-group's own `.size-control` wrapper
  // div, moved whole via appendChild (which MOVES a node, keeping its id,
  // markup, and every already-wired listener) -- relocate to the canvas's
  // own left edge (#studio-side-rail). #size-group itself is left behind
  // empty (its "Size" label has no content to label in a slim top toolbar),
  // so it's hidden rather than shown as a stray empty group. Applied
  // unconditionally (both Public and Private): mode-specific differences are
  // controlled below by explicit Public/Private state (room navigation,
  // document settings content), never by duplicating this shell.
  workspace.classList.add("studio-layout");
  studioSideRail.hidden = false;
  sideRailBrushSize.appendChild(sizeGroup.querySelector(".size-control"));
  sizeGroup.hidden = true;

  // #document-settings-button/#document-settings-popover: shown for BOTH
  // Public and Private (dimensions + the Grid toggle apply to either); a
  // pixel-art room additionally relocates its own room code into the
  // popover body, below. Never shown for a legacy room --
  // this code never runs for one at all (main() hands off to app.js first).
  documentSettingsButton.hidden = false;
  documentDimensions.textContent = `${gridWidth} × ${gridHeight}`;

  function openDocumentSettingsPopover() {
    const rect = documentSettingsButton.getBoundingClientRect();
    const popoverWidth = 240;
    documentSettingsPopover.style.top = `${rect.bottom + 6}px`;
    documentSettingsPopover.style.left = `${Math.min(rect.left, window.innerWidth - popoverWidth - 8)}px`;
    documentSettingsPopover.hidden = false;
    documentSettingsButton.setAttribute("aria-expanded", "true");
  }
  function closeDocumentSettingsPopover() {
    documentSettingsPopover.hidden = true;
    documentSettingsButton.setAttribute("aria-expanded", "false");
  }
  documentSettingsButton.addEventListener("click", () => {
    if (documentSettingsPopover.hidden) openDocumentSettingsPopover();
    else closeDocumentSettingsPopover();
  });
  documentSettingsClose.addEventListener("click", closeDocumentSettingsPopover);
  document.addEventListener("pointerdown", (event) => {
    if (documentSettingsPopover.hidden) return;
    if (documentSettingsPopover.contains(event.target) || documentSettingsButton.contains(event.target)) return;
    closeDocumentSettingsPopover();
  });
  window.addEventListener("keydown", (event) => {
    if (!documentSettingsPopover.hidden && event.key === "Escape") closeDocumentSettingsPopover();
  });

  if (isPublicPixelWall) {
    // The New Canvas dialog: independent width/height, confirmed before
    // anything is created -- not a permanently-visible toolbar control.
    // Width/height are never editable again once a room exists
    // (server/db.js's own immutability). The canvas is always white.
    function openRoomCreatePopover() {
      const rect = createRoomButton.getBoundingClientRect();
      const popoverWidth = 240;
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

    newCanvasWidthInput.addEventListener("input", () => {
      newCanvasWidthInput.value = String(clampCanvasDimension(newCanvasWidthInput.value));
    });
    newCanvasHeightInput.addEventListener("input", () => {
      newCanvasHeightInput.value = String(clampCanvasDimension(newCanvasHeightInput.value));
    });

    roomCreateConfirmButton.addEventListener("click", async () => {
      const width = clampCanvasDimension(newCanvasWidthInput.value);
      const height = clampCanvasDimension(newCanvasHeightInput.value);
      closeRoomCreatePopover();
      const newPresenceId = crypto.randomUUID();
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presenceId: newPresenceId, width, height }),
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

    // Room code additionally relocates into the
    // (already shared, already-wired-above) #document-settings-popover --
    // not a full-width persistent row. #back-to-public is deliberately NOT
    // relocated: it stays exactly where the markup already has it, a direct
    // sibling of #document-settings-button inside #private-room-controls,
    // so it remains visible in the header without opening anything -- a
    // directly-visible Back to Public control is mandatory, never exclusive
    // to the Document popover.
    documentSettingsBody.appendChild(roomCodeLabel);

    // Read-only document information -- this room's dimensions are fixed
    // forever at creation, never an editable control inside a room.
    roomCodeLabel.textContent = `Room: ${roomCode}`;

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
  // ownership must be known before "my own" pending work (and the op/undo/
  // redo echo dedupe above) can be judged correctly; startRealtimeSync's own
  // `sync` handler is what actually populates allOps and renders for the
  // first time -- see the SSE section above for why there is no separate
  // GET request for the initial load any more.
  loadMe().then(() => {
    startRealtimeSync();
    updateUndoRedoButtons();
  });

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
