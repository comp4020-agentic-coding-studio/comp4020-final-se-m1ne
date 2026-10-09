import { describe, expect, it } from "vitest";
import { bresenhamLine, brushStamp, cellKey, cellsForStroke, replayPixelOps } from "../public/pixelgrid.js";

function keysOf(cells: { x: number; y: number }[]): Set<string> {
  return new Set(cells.map((c) => cellKey(c.x, c.y)));
}

describe("brushStamp (integer brush footprints)", () => {
  it("size 1 is exactly the single cell", () => {
    expect(brushStamp(5, 5, 1)).toEqual([{ x: 5, y: 5 }]);
  });

  it("size 2 is a 2x2 block anchored at the point", () => {
    expect(keysOf(brushStamp(5, 5, 2))).toEqual(keysOf([
      { x: 5, y: 5 }, { x: 6, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 },
    ]));
  });

  it("size 3 is a 3x3 block truly centered on the point", () => {
    expect(keysOf(brushStamp(5, 5, 3))).toEqual(keysOf([
      { x: 4, y: 4 }, { x: 5, y: 4 }, { x: 6, y: 4 },
      { x: 4, y: 5 }, { x: 5, y: 5 }, { x: 6, y: 5 },
      { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 },
    ]));
  });

  it("size 4 is a 4x4 block, biased down-right from the point like size 2", () => {
    const cells = brushStamp(5, 5, 4);
    expect(cells).toHaveLength(16);
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    expect(Math.min(...xs)).toBe(4);
    expect(Math.max(...xs)).toBe(7);
    expect(Math.min(...ys)).toBe(4);
    expect(Math.max(...ys)).toBe(7);
  });

  it("a non-integer or sub-1 size is rounded/clamped to a valid integer brush", () => {
    expect(brushStamp(0, 0, 0)).toEqual([{ x: 0, y: 0 }]);
    expect(brushStamp(0, 0, -5)).toEqual([{ x: 0, y: 0 }]);
    expect(keysOf(brushStamp(0, 0, 2.4))).toEqual(keysOf(brushStamp(0, 0, 2)));
  });
});

describe("bresenhamLine (gap-free integer interpolation)", () => {
  it("a horizontal line visits every integer x with no gaps", () => {
    const line = bresenhamLine(0, 10, 8, 10);
    expect(line).toHaveLength(9);
    expect(line.every((p) => p.y === 10)).toBe(true);
    expect(new Set(line.map((p) => p.x))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it("a vertical line visits every integer y with no gaps", () => {
    const line = bresenhamLine(10, 0, 10, 8);
    expect(line).toHaveLength(9);
    expect(line.every((p) => p.x === 10)).toBe(true);
    expect(new Set(line.map((p) => p.y))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it("a 45-degree diagonal line visits exactly the diagonal cells with no gaps", () => {
    const line = bresenhamLine(0, 0, 5, 5);
    expect(line).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }, { x: 5, y: 5 },
    ]);
  });

  it("a steep (non-45-degree) line stays connected -- every step moves at most one cell diagonally", () => {
    const line = bresenhamLine(0, 0, 2, 9);
    for (let i = 1; i < line.length; i++) {
      expect(Math.abs(line[i].x - line[i - 1].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(line[i].y - line[i - 1].y)).toBeLessThanOrEqual(1);
    }
    expect(line[0]).toEqual({ x: 0, y: 0 });
    expect(line[line.length - 1]).toEqual({ x: 2, y: 9 });
  });

  it("includes both endpoints even for a zero-length line (a tap)", () => {
    expect(bresenhamLine(3, 3, 3, 3)).toEqual([{ x: 3, y: 3 }]);
  });
});

describe("cellsForStroke (rasterization used identically by live preview and full replay)", () => {
  it("a single point stamps exactly that point's brush footprint, for every supported brush size", () => {
    for (const size of [1, 2, 3, 4, 5, 8]) {
      const cells = cellsForStroke([{ x: 10, y: 10 }], size, 64, 64);
      expect(keysOf(cells)).toEqual(keysOf(brushStamp(10, 10, size)));
    }
  });

  it("a fast horizontal drag (samples several cells apart) leaves no gaps", () => {
    const cells = cellsForStroke([{ x: 0, y: 5 }, { x: 20, y: 5 }], 1, 64, 64);
    const xs = new Set(cells.map((c) => c.x));
    for (let x = 0; x <= 20; x++) expect(xs.has(x)).toBe(true);
  });

  it("a fast vertical drag leaves no gaps", () => {
    const cells = cellsForStroke([{ x: 5, y: 0 }, { x: 5, y: 20 }], 1, 64, 64);
    const ys = new Set(cells.map((c) => c.y));
    for (let y = 0; y <= 20; y++) expect(ys.has(y)).toBe(true);
  });

  it("a fast diagonal drag leaves no gaps", () => {
    const cells = cellsForStroke([{ x: 0, y: 0 }, { x: 15, y: 15 }], 1, 64, 64);
    expect(keysOf(cells)).toEqual(keysOf(Array.from({ length: 16 }, (_, i) => ({ x: i, y: i }))));
  });

  it("a fast steep drag (far from 45 degrees) still forms a connected run with no gaps", () => {
    const cells = cellsForStroke([{ x: 0, y: 0 }, { x: 3, y: 25 }], 1, 64, 64);
    // Connectivity: every row between 0 and 25 is touched, and consecutive
    // touched rows never jump by more than one cell in x -- the gap-free
    // guarantee for a steep line, not just "some cell near every row".
    const byRow = new Map<number, number[]>();
    for (const c of cells) {
      if (!byRow.has(c.y)) byRow.set(c.y, []);
      byRow.get(c.y)!.push(c.x);
    }
    for (let y = 0; y <= 25; y++) expect(byRow.has(y)).toBe(true);
  });

  it("multiple coalesced samples along one gesture produce one fully-connected stroke", () => {
    const points = [
      { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 1 }, { x: 10, y: 3 }, { x: 10, y: 10 },
    ];
    const cells = cellsForStroke(points, 1, 64, 64);
    const keys = keysOf(cells);
    // Every consecutive sample pair's own Bresenham line must be fully covered.
    for (let i = 1; i < points.length; i++) {
      for (const p of bresenhamLine(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y)) {
        expect(keys.has(cellKey(p.x, p.y))).toBe(true);
      }
    }
  });

  it("clips at the document edges: no returned cell ever falls outside [0,width) x [0,height)", () => {
    const cells = cellsForStroke([{ x: 0, y: 0 }], 4, 8, 8);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThan(8);
      expect(c.y).toBeLessThan(8);
    }
    // A size-4 brush at (7,7) spans x,y in [6,9] (brushStamp's start offset
    // is -floor((4-1)/2) = -1); in an 8x8 document (valid indices 0..7) that
    // keeps the 2x2 sub-block at (6,7)x(6,7) and drops the rest -- clipped,
    // not wrapped or warped to some other in-bounds position.
    const atFarCorner = cellsForStroke([{ x: 7, y: 7 }], 4, 8, 8);
    expect(atFarCorner.every((c) => c.x < 8 && c.y < 8)).toBe(true);
    expect(keysOf(atFarCorner)).toEqual(
      keysOf([{ x: 6, y: 6 }, { x: 7, y: 6 }, { x: 6, y: 7 }, { x: 7, y: 7 }]),
    );
  });

  it("a stroke running off one edge and back only ever reports in-bounds cells, never duplicated", () => {
    const cells = cellsForStroke([{ x: -5, y: 3 }, { x: 5, y: 3 }], 1, 10, 10);
    expect(cells.every((c) => c.x >= 0 && c.x < 10)).toBe(true);
    const keys = cells.map((c) => cellKey(c.x, c.y));
    expect(new Set(keys).size).toBe(keys.length); // no unnecessary duplicate cells
  });

  it("produces no duplicate cells even when the brush footprint overlaps heavily between steps", () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 0 }));
    const cells = cellsForStroke(points, 5, 64, 64);
    const keys = cells.map((c) => cellKey(c.x, c.y));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is deterministic: identical inputs always produce the identical cell set", () => {
    const points = [{ x: 2, y: 2 }, { x: 9, y: 17 }, { x: 9, y: 3 }];
    const a = cellsForStroke(points, 3, 64, 64);
    const b = cellsForStroke(points, 3, 64, 64);
    expect(keysOf(a)).toEqual(keysOf(b));
  });

  it("an empty points array produces no cells", () => {
    expect(cellsForStroke([], 3, 64, 64)).toEqual([]);
  });
});

// --- replayPixelOps ----------------------------------------------------------

function draw(overrides: Partial<{
  id: string; ownerId: string; color: string; size: number;
  points: { x: number; y: number }[]; createdAt: number; seq: number; active: boolean;
}> = {}) {
  return {
    id: overrides.id ?? `op-${overrides.seq ?? Math.random()}`,
    ownerId: overrides.ownerId ?? "owner-A",
    kind: "draw" as const,
    color: overrides.color ?? "#1d1d1d",
    size: overrides.size ?? 1,
    points: overrides.points ?? [{ x: 5, y: 5 }],
    createdAt: overrides.createdAt ?? 1000,
    seq: overrides.seq ?? 1,
    active: overrides.active,
  };
}

function erase(overrides: Partial<{
  id: string; ownerId: string; size: number;
  points: { x: number; y: number }[]; createdAt: number; seq: number; active: boolean;
}> = {}) {
  return {
    id: overrides.id ?? `erase-${overrides.seq ?? Math.random()}`,
    ownerId: overrides.ownerId ?? "owner-A",
    kind: "erase" as const,
    color: null,
    size: overrides.size ?? 1,
    points: overrides.points ?? [{ x: 5, y: 5 }],
    createdAt: overrides.createdAt ?? 1000,
    seq: overrides.seq ?? 1,
    active: overrides.active,
  };
}

describe("replayPixelOps (authoritative, deterministic, ownership-aware replay)", () => {
  it("a single draw op is visible at exactly the cells it touches", () => {
    const op = draw({ seq: 1, points: [{ x: 5, y: 5 }], color: "#e53935" });
    const grid = replayPixelOps([op], 64, 64);
    expect(grid.get(cellKey(5, 5))).toEqual({
      seq: 1, opId: op.id, ownerId: "owner-A", color: "#e53935", createdAt: 1000,
    });
  });

  it("two users drawing over the exact same cell: the higher-seq draw wins regardless of owner", () => {
    const a = draw({ id: "a", ownerId: "owner-A", seq: 1, color: "#111111", createdAt: 1000 });
    const b = draw({ id: "b", ownerId: "owner-B", seq: 2, color: "#222222", createdAt: 2000 });
    const grid = replayPixelOps([a, b], 64, 64);
    const cell = grid.get(cellKey(5, 5))!;
    expect(cell.ownerId).toBe("owner-B");
    expect(cell.color).toBe("#222222");
    expect(cell.opId).toBe("b");
    expect(cell.createdAt).toBe(2000);
  });

  it("a later draw from the SAME owner also simply overwrites their own earlier one", () => {
    const a = draw({ id: "a", ownerId: "owner-A", seq: 1, color: "#111111" });
    const b = draw({ id: "b", ownerId: "owner-A", seq: 2, color: "#333333" });
    const grid = replayPixelOps([a, b], 64, 64);
    expect(grid.get(cellKey(5, 5))?.color).toBe("#333333");
  });

  it("an owner-authorized erase removes that owner's own visible contribution", () => {
    const d = draw({ id: "d", ownerId: "owner-A", seq: 1 });
    const e = erase({ id: "e", ownerId: "owner-A", seq: 2 });
    const grid = replayPixelOps([d, e], 64, 64);
    expect(grid.has(cellKey(5, 5))).toBe(false);
  });

  it("an unauthorized erase (a different owner than whoever is currently visible) has no effect", () => {
    const d = draw({ id: "d", ownerId: "owner-A", seq: 1, color: "#1d1d1d" });
    const strangerErase = erase({ id: "e", ownerId: "owner-STRANGER", seq: 2 });
    const grid = replayPixelOps([d, strangerErase], 64, 64);
    const cell = grid.get(cellKey(5, 5))!;
    expect(cell.ownerId).toBe("owner-A");
    expect(cell.color).toBe("#1d1d1d");
    expect(cell.opId).toBe("d");
  });

  it("an erase from an owner who never drew there at all is a true no-op, never creating visible content", () => {
    const strangerErase = erase({ ownerId: "owner-STRANGER", seq: 1 });
    const grid = replayPixelOps([strangerErase], 64, 64);
    expect(grid.has(cellKey(5, 5))).toBe(false);
  });

  it("erasing a covering contribution reveals the most recent underlying still-valid contribution, with its ORIGINAL owner, color, opId and createdAt intact", () => {
    const underlying = draw({ id: "under", ownerId: "owner-A", seq: 1, color: "#1d1d1d", createdAt: 1000 });
    const covering = draw({ id: "cover", ownerId: "owner-B", seq: 2, color: "#e53935", createdAt: 2000 });
    const coveringErase = erase({ id: "erase-cover", ownerId: "owner-B", seq: 3 });
    const grid = replayPixelOps([underlying, covering, coveringErase], 64, 64);
    expect(grid.get(cellKey(5, 5))).toEqual({
      seq: 1, opId: "under", ownerId: "owner-A", color: "#1d1d1d", createdAt: 1000,
    });
  });

  it("erasing the covering contribution does not disturb an unrelated owner's contribution elsewhere", () => {
    const elsewhere = draw({ id: "elsewhere", ownerId: "owner-C", seq: 1, points: [{ x: 40, y: 40 }] });
    const covering = draw({ id: "cover", ownerId: "owner-B", seq: 2, points: [{ x: 5, y: 5 }] });
    const coveringErase = erase({ id: "erase-cover", ownerId: "owner-B", seq: 3, points: [{ x: 5, y: 5 }] });
    const grid = replayPixelOps([elsewhere, covering, coveringErase], 64, 64);
    expect(grid.get(cellKey(40, 40))?.opId).toBe("elsewhere");
    expect(grid.has(cellKey(5, 5))).toBe(false);
  });

  it("undo simulation: marking the covering draw inactive reveals the same underlying contribution as erasing it would", () => {
    const underlying = draw({ id: "under", ownerId: "owner-A", seq: 1, color: "#1d1d1d", createdAt: 1000 });
    const covering = draw({ id: "cover", ownerId: "owner-B", seq: 2, color: "#e53935", createdAt: 2000, active: false });
    const grid = replayPixelOps([underlying, covering], 64, 64);
    expect(grid.get(cellKey(5, 5))).toEqual({
      seq: 1, opId: "under", ownerId: "owner-A", color: "#1d1d1d", createdAt: 1000,
    });
  });

  it("redo simulation: reactivating the same op (active: true again) restores it at its original seq/content, not a new one", () => {
    const underlying = draw({ id: "under", ownerId: "owner-A", seq: 1, createdAt: 1000 });
    const covering = draw({ id: "cover", ownerId: "owner-B", seq: 2, color: "#e53935", createdAt: 2000, active: true });
    const grid = replayPixelOps([underlying, covering], 64, 64);
    expect(grid.get(cellKey(5, 5))).toEqual({
      seq: 2, opId: "cover", ownerId: "owner-B", color: "#e53935", createdAt: 2000,
    });
  });

  it("undoing an erase (marking it inactive) restores the previously-erased contribution", () => {
    const d = draw({ id: "d", ownerId: "owner-A", seq: 1, color: "#1d1d1d", createdAt: 1000 });
    const e = erase({ id: "e", ownerId: "owner-A", seq: 2, active: false }); // the erase itself has been undone
    const grid = replayPixelOps([d, e], 64, 64);
    expect(grid.get(cellKey(5, 5))).toEqual({
      seq: 1, opId: "d", ownerId: "owner-A", color: "#1d1d1d", createdAt: 1000,
    });
  });

  it("an op with no explicit active field is treated as active (default)", () => {
    const d = draw({ id: "d", seq: 1 });
    delete (d as { active?: boolean }).active;
    const grid = replayPixelOps([d], 64, 64);
    expect(grid.has(cellKey(5, 5))).toBe(true);
  });

  it("is deterministic and order-independent: shuffling the same active op set yields the same visible grid", () => {
    const ops = [
      draw({ id: "a", ownerId: "owner-A", seq: 1, points: [{ x: 1, y: 1 }], color: "#111111" }),
      draw({ id: "b", ownerId: "owner-B", seq: 3, points: [{ x: 1, y: 1 }], color: "#222222" }),
      erase({ id: "c", ownerId: "owner-B", seq: 5, points: [{ x: 1, y: 1 }] }),
      draw({ id: "d", ownerId: "owner-C", seq: 2, points: [{ x: 9, y: 9 }], color: "#333333" }),
    ];
    const forward = replayPixelOps(ops, 64, 64);
    const shuffled = replayPixelOps([...ops].reverse(), 64, 64);
    // Map iteration order depends on each cell's first-encounter order while
    // processing `ops`, which differs between the forward and shuffled runs
    // even when their content is identical -- so compare both sides sorted
    // by key, not raw .entries() order, and also check each cell directly.
    const sortByKey = (m: Map<string, unknown>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sortByKey(forward)).toEqual(sortByKey(shuffled));
    expect(forward.get(cellKey(1, 1))).toEqual(shuffled.get(cellKey(1, 1)));
    expect(forward.get(cellKey(9, 9))).toEqual(shuffled.get(cellKey(9, 9)));
  });

  it("replaying the same ops twice produces byte-for-byte identical results (pure function, no hidden state)", () => {
    const ops = [draw({ seq: 1 }), draw({ seq: 2, ownerId: "owner-B", points: [{ x: 6, y: 6 }] })];
    const first = replayPixelOps(ops, 64, 64);
    const second = replayPixelOps(ops, 64, 64);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("independent grid dimensions: the same ops replayed against two different document sizes clip independently, with no shared state leaking between calls", () => {
    const ops = [draw({ seq: 1, points: [{ x: 30, y: 30 }] })];
    const small = replayPixelOps(ops, 32, 32); // 30,30 is in-bounds for a 32x32 document
    const smaller = replayPixelOps(ops, 16, 16); // but out-of-bounds for a 16x16 document
    expect(small.has(cellKey(30, 30))).toBe(true);
    expect(smaller.size).toBe(0);
    // Replaying the larger document again afterward is unaffected by having
    // just replayed the smaller one -- no module-level mutable state.
    const smallAgain = replayPixelOps(ops, 32, 32);
    expect(smallAgain.has(cellKey(30, 30))).toBe(true);
  });

  it("two separate documents (e.g. Public and a Private room) never see each other's ops: isolation is the caller's job of not mixing op lists, and replay itself has no cross-call memory", () => {
    const publicOps = [draw({ id: "pub", ownerId: "owner-A", seq: 1, points: [{ x: 2, y: 2 }] })];
    const roomOps = [draw({ id: "room", ownerId: "owner-A", seq: 1, points: [{ x: 2, y: 2 }], color: "#e53935" })];
    const publicGrid = replayPixelOps(publicOps, 512, 288);
    const roomGrid = replayPixelOps(roomOps, 32, 32);
    expect(publicGrid.get(cellKey(2, 2))?.opId).toBe("pub");
    expect(roomGrid.get(cellKey(2, 2))?.opId).toBe("room");
  });

  it("an inactive op present anywhere in the input list contributes nothing, even if it is the only op touching a cell", () => {
    const onlyOp = draw({ seq: 1, active: false });
    expect(replayPixelOps([onlyOp], 64, 64).size).toBe(0);
  });
});
