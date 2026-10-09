// Pure, DOM-independent pixel-art document engine, shared by Public and every
// Private studio at whatever resolution each uses -- no Canvas APIs, no
// browser globals, no SQLite, no network. Everything here is a function of
// its arguments alone, the same discipline fade.js/viewport.js/colour.js
// already follow, so it can be unit-tested without a browser and reused
// unchanged by both the live renderer and full authoritative replay.
//
// --- Design note: why a per-cell history, not a single global value -------
//
// A naive "one color per cell, last seq wins, full stop" model cannot
// simultaneously satisfy three things this project requires at once:
//   1. an erase may only affect a cell currently owned by the erasing user
//      (ownership protection carried over from the freehand engine);
//   2. erasing a covering contribution must reveal whichever earlier,
//      still-valid contribution was underneath it, not permanently destroy
//      it (the pixel-art analogue of "destination-out only ever clears the
//      erasing owner's own layer" -- other owners' marks were never touched,
//      so they must still be there to reveal);
//   3. undo/redo (toggling a whole op's `active` flag) must be deterministic
//      and must correctly re-derive whichever contribution should be visible
//      afterward, including a contribution from an owner other than whoever
//      is being undone/redone.
//
// A single "last write wins, globally, full stop" value cannot do all three:
// once owner B's draw overwrites owner A's earlier draw at a cell, the naive
// model has no record that A's contribution ever existed, so erasing B's
// mark (or undoing B's op) has nowhere to "fall back" to.
//
// The resolution used here is the minimal structure that still fixes this:
// for each cell, track each OWNER's own latest still-active contribution at
// that cell independently (at most one entry per (cell, owner) pair, never a
// full per-op history) -- exactly mirroring, at 1-pixel granularity, how the
// freehand engine already gives every owner their own persistent raster
// layer that only that owner's own erase can ever clear. A draw op sets the
// drawing owner's entry to "drawing, with this color/seq/createdAt/id". An
// erase op sets the erasing owner's entry to "nothing" (regardless of
// whether that owner currently happens to be the one visibly on top -- an
// owner's erase always clears their own layer, just like destination-out
// always did, independent of current stacking). The cell's VISIBLE contents
// are then whichever owner's latest entry is a draw, with the highest seq
// among all owners who currently have one. This is still only O(owners who
// have ever touched that cell) of state per cell, not O(ops ever posted).

/** @typedef {{x: number, y: number}} Cell */

/**
 * One point->point straight-line walk between two integer grid cells,
 * inclusive of both endpoints, with no gaps at any slope (shallow, steep,
 * vertical, horizontal, or diagonal) -- the classic integer Bresenham
 * algorithm, chosen specifically because it never skips a cell a continuous
 * line passes through, which is what "no missing pixels during fast pointer
 * movement" actually requires between two samples that land several cells
 * apart. Pure integer arithmetic throughout: no floating point, so results
 * are exact and identical for identical inputs on any platform.
 */
export function bresenhamLine(x0, y0, x1, y1) {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);

  const points = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;

  while (true) {
    points.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return points;
}

/**
 * The square footprint an integer brush size paints, centered as evenly as
 * possible on (cx, cy): size 1 is just the cell itself; size 2 is a 2x2
 * block anchored at (cx, cy); size 3 is a 3x3 block truly centered on
 * (cx, cy); larger odd/even sizes keep alternating the same way. A plain
 * square (not a circle/diamond) is deliberate: it is the simplest shape that
 * is still exactly grid-aligned with no partial-coverage pixels at any size,
 * matching "no antialiasing or fractional pixels" -- a rounder brush shape is
 * explicitly out of scope for entry-level pixel editing at this stage.
 */
export function brushStamp(cx, cy, size) {
  const n = Math.max(1, Math.round(size));
  const start = -Math.floor((n - 1) / 2);
  const cells = [];
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      cells.push({ x: cx + start + dx, y: cy + start + dy });
    }
  }
  return cells;
}

/** Canonical string key for a grid cell, used to de-duplicate/index by position. */
export function cellKey(x, y) {
  return `${x},${y}`;
}

function inBounds(x, y, width, height) {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/**
 * Rasterizes one gesture's already-sampled points (integer-ish grid
 * coordinates; non-integers are rounded defensively) into the de-duplicated,
 * document-clipped set of cells an integer brush size actually paints --
 * walking a gap-free Bresenham line between every consecutive pair of
 * samples (not just stamping each sample in isolation), so a fast drag whose
 * samples land several cells apart still produces a fully connected stroke.
 * This is the one rasterizer every caller shares: the live local preview, a
 * just-finished local gesture, and full authoritative replay (below) all
 * call this same function, never a second implementation.
 *
 * @param {Cell[]} points
 * @param {number} brushSize
 * @param {number} width
 * @param {number} height
 * @returns {Cell[]}
 */
export function cellsForStroke(points, brushSize, width, height) {
  if (!Array.isArray(points) || points.length === 0) return [];

  const touched = new Map(); // cellKey -> Cell, de-duplicating every stamped cell from every segment

  function stampAt(cx, cy) {
    for (const cell of brushStamp(cx, cy, brushSize)) {
      if (!inBounds(cell.x, cell.y, width, height)) continue; // clipped at the document edge, never wrapped or warped
      touched.set(cellKey(cell.x, cell.y), cell);
    }
  }

  let prev = null;
  for (const point of points) {
    const gx = Math.round(point.x);
    const gy = Math.round(point.y);
    if (prev === null) {
      stampAt(gx, gy);
    } else {
      for (const { x, y } of bresenhamLine(prev.x, prev.y, gx, gy)) stampAt(x, y);
    }
    prev = { x: gx, y: gy };
  }

  return Array.from(touched.values());
}

/**
 * @typedef {Object} PixelOp
 * @property {string} id
 * @property {string} ownerId
 * @property {"draw"|"erase"} kind
 * @property {string|null} color   required for "draw", ignored for "erase"
 * @property {number} size         integer brush size, in cells
 * @property {Cell[]} points       raw sampled grid points, not yet rasterized
 * @property {number} createdAt
 * @property {number} seq          authoritative server order; see replayPixelOps
 * @property {boolean} [active]    defaults to true when omitted -- false means undone
 */

/**
 * @typedef {Object} VisibleCell
 * @property {number} seq
 * @property {string} opId
 * @property {string} ownerId
 * @property {string|null} color
 * @property {number} createdAt
 */

/**
 * Deterministically resolves the authoritative visible state of every
 * painted cell from a list of pixel ops, draw and erase alike. See the
 * module-level design note above for why this is a per-(cell, owner) latest-
 * contribution model rather than one global last-write-wins value.
 *
 * Rules, applied per cell:
 *  - A draw op unconditionally becomes its OWNER's latest contribution at
 *    every cell it touches -- it may overwrite a cell regardless of which
 *    other owner (or no one) currently shows there (later draw always wins,
 *    the same rule the freehand engine already used for stacking order).
 *  - An erase op clears its OWNER's own latest contribution at every cell it
 *    touches, and only that owner's -- it can never remove, and has no
 *    effect whatsoever on, any other owner's contribution, whether or not
 *    that other owner currently happens to be the one visibly on top.
 *  - A cell's VISIBLE contents are whichever owner's latest contribution is
 *    currently a draw, choosing the highest seq among every owner who has
 *    one -- so erasing (or undoing) whatever was covering an older
 *    contribution correctly reveals it again, with its own original opId,
 *    ownerId, color and createdAt untouched, exactly as if the covering
 *    contribution had never existed.
 *  - `active: false` (an undone op) is skipped entirely, identically to the
 *    server's own `active = 1` replay filter -- this is what lets undo/redo
 *    be simulated by toggling this flag and replaying again.
 *
 * The per-(cell, owner) reduction keeps only the highest-seq entry, which
 * makes the result independent of the order `ops` is iterated in -- not just
 * robust to accidental reordering, but a genuine property: replaying the
 * same active op set in any order yields the same visible grid, since seq
 * (never iteration order, never createdAt) is the only thing that decides a
 * winner at each (cell, owner) pair.
 *
 * Fade is deliberately NOT applied here: each VisibleCell keeps the winning
 * draw op's own original createdAt untouched, so a renderer can compute
 * Public fade opacity from it afterward without this pure engine needing to
 * know about fade, the current time, or whether the document is Public or
 * Private at all.
 *
 * @param {PixelOp[]} ops
 * @param {number} width
 * @param {number} height
 * @returns {Map<string, VisibleCell>} cellKey -> the one winning contribution, for every non-empty cell
 */
export function replayPixelOps(ops, width, height) {
  const perCell = new Map(); // cellKey -> Map(ownerId -> that owner's latest contribution at this cell)

  for (const op of ops) {
    if (op.active === false) continue; // undone -- excluded from replay, same meaning as listOps' active = 1 filter
    const cells = cellsForStroke(op.points, op.size, width, height);
    if (cells.length === 0) continue;

    for (const { x, y } of cells) {
      const key = cellKey(x, y);
      let owners = perCell.get(key);
      if (!owners) {
        owners = new Map();
        perCell.set(key, owners);
      }
      const existing = owners.get(op.ownerId);
      if (existing && existing.seq >= op.seq) continue; // this owner already has a later contribution at this cell
      owners.set(op.ownerId, {
        kind: op.kind,
        seq: op.seq,
        opId: op.id,
        ownerId: op.ownerId,
        color: op.kind === "draw" ? op.color : null,
        createdAt: op.createdAt,
      });
    }
  }

  const visible = new Map();
  for (const [key, owners] of perCell) {
    let winner = null;
    for (const entry of owners.values()) {
      if (entry.kind !== "draw") continue; // this owner's latest action here was an erase -- they contribute nothing now
      if (!winner || entry.seq > winner.seq) winner = entry;
    }
    if (winner) {
      visible.set(key, {
        seq: winner.seq,
        opId: winner.opId,
        ownerId: winner.ownerId,
        color: winner.color,
        createdAt: winner.createdAt,
      });
    }
  }
  return visible;
}
