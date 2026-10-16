// Triangle is no longer a tool and the server refuses to create one, but
// triangle ops saved while it existed must keep replaying: nothing is migrated,
// deleted or rewritten. This reads and writes server/db.js directly (a throwaway
// DB, like spec/rooms-lifecycle.test.ts) because a stored triangle can no longer
// be produced through the HTTP API.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let db: typeof import("../server/db.js");

// server/db.js is untyped JS, so TypeScript infers parameter types from default values (`roomId = null`,
// `shape = null`) and rejects a real room code or shape. State the actual contract once, here.
type RoomId = string | null;
type StoredOp = { id: string; seq: number; ownerId: string; color: string; size: number; points: Array<{ x: number; y: number }>; shape?: { type: string; mode: string } };
type NewOp = Omit<StoredOp, "seq"> & { kind: "draw"; createdAt: number; roomId: RoomId };
const api = {
  insertOp: (op: NewOp) => (db.insertOp as unknown as (o: NewOp) => number)(op),
  listOps: (room: RoomId) => (db.listOps as unknown as (r: RoomId) => StoredOp[])(room),
  undoOwn: (room: RoomId, owner: string) => (db.undoLatestOwnOp as unknown as (r: RoomId, o: string) => StoredOp | null)(room, owner),
  redoOwn: (room: RoomId, owner: string) => (db.redoLatestOwnOp as unknown as (r: RoomId, o: string) => StoredOp | null)(room, owner),
};

beforeAll(async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "comp4020-legacy-triangle-db-"));
  process.env.DB_PATH = join(dbDir, "app.db");
  db = await import("../server/db.js");
});

const CORNERS = [
  { x: 0.2, y: 0.3 },
  { x: 0.5, y: 0.7 },
];

function legacyTriangle(ownerId: string, roomId: string | null, mode: "outline" | "filled") {
  const op = {
    id: randomUUID(),
    ownerId,
    kind: "draw" as const,
    color: "#e85d5d",
    size: 0.004,
    points: CORNERS,
    createdAt: Date.now(),
    roomId,
    shape: { type: "triangle", mode },
  };
  return { op, seq: api.insertOp(op) };
}

describe("stored triangle ops are still read back unchanged", () => {
  it("Public: a saved triangle is listed with its shape descriptor, corners, colour and size", () => {
    const { op, seq } = legacyTriangle(randomUUID(), null, "filled");
    const listed = api.listOps(null).find((o) => o.id === op.id)!;
    expect(listed.seq).toBe(seq);
    expect(listed.shape).toEqual({ type: "triangle", mode: "filled" });
    expect(listed.points).toEqual(CORNERS);
    expect(listed.color).toBe("#e85d5d");
    expect(listed.size).toBe(0.004);
  });

  it("Private: a saved triangle is listed in its own room and nowhere else", () => {
    const room = db.createRoom(randomUUID(), randomUUID(), Date.now());
    const other = db.createRoom(randomUUID(), randomUUID(), Date.now());
    const { op } = legacyTriangle(randomUUID(), room, "outline");
    expect(api.listOps(room).some((o) => o.id === op.id)).toBe(true);
    expect(api.listOps(other).some((o) => o.id === op.id)).toBe(false);
    expect(api.listOps(null).some((o) => o.id === op.id)).toBe(false);
  });

  it("owner-specific undo and redo still work on a stored triangle, restoring the same row", () => {
    const owner = randomUUID();
    const room = db.createRoom(randomUUID(), owner, Date.now());
    const { op, seq } = legacyTriangle(owner, room, "filled");
    expect(api.undoOwn(room, owner)?.id).toBe(op.id);
    expect(api.listOps(room)).toHaveLength(0);
    const redone = api.redoOwn(room, owner)!;
    expect(redone.id).toBe(op.id);
    expect(redone.shape).toEqual({ type: "triangle", mode: "filled" });
    expect(redone.seq).toBe(seq);
  });

  it("another guest's undo cannot touch a stored triangle", () => {
    const owner = randomUUID();
    const room = db.createRoom(randomUUID(), owner, Date.now());
    const { op } = legacyTriangle(owner, room, "outline");
    expect(api.undoOwn(room, randomUUID())).toBeNull();
    expect(api.listOps(room).map((o) => o.id)).toEqual([op.id]);
  });
});
