import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// This file never talks to spec/global-setup.ts's spawned server (its own
// port, its own DB_PATH) -- it boots server/db.js directly, against its own
// throwaway files, the same way spec/rooms-lifecycle.test.ts does. Unlike
// that file, this suite needs server/db.js's module-level migration code to
// run fresh, more than once, against several distinct database files (a
// brand-new one, a hand-seeded pre-migration one, the same one twice) --
// which a single `import("../server/db.js")` cannot do, since Node's ESM
// loader caches a module by its exact specifier and would otherwise only
// ever run that top-level code once for this whole file. Appending a unique
// query string to the specifier is the standard way to force a genuinely
// fresh module evaluation (a fresh `DatabaseSync` open, a fresh run of every
// `columnExists`-gated migration) per boot, while still exercising the exact
// same module code the real server/index.js imports.
type DbModule = typeof import("../server/db.js");

async function bootDb(dbPath: string): Promise<DbModule> {
  process.env.DB_PATH = dbPath;
  const specifier = `${new URL("../server/db.js", import.meta.url).href}?boot=${randomUUID()}`;
  return import(/* @vite-ignore */ specifier) as Promise<DbModule>;
}

function tempDbPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return join(dir, "app.db");
}

// Raw, independent introspection -- deliberately never goes through
// listOps/rowToOp (this step does not touch either), so these tests see the
// real on-disk schema and values regardless of what a later step chooses to
// expose through the module's own read path.
function tableColumns(dbPath: string, table: string): string[] {
  const raw = new DatabaseSync(dbPath);
  try {
    return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  } finally {
    raw.close();
  }
}

function rawRow(dbPath: string, sql: string, ...params: (string | number)[]): Record<string, unknown> | undefined {
  const raw = new DatabaseSync(dbPath);
  try {
    return raw.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  } finally {
    raw.close();
  }
}

describe("pixel-art schema migration (backward-compatible, additive only)", () => {
  it("1. a fresh database gets doc_kind on ops, width/height on rooms, and a guests table", async () => {
    const dbPath = tempDbPath("comp4020-migration-fresh-");
    await bootDb(dbPath);

    expect(tableColumns(dbPath, "ops")).toContain("doc_kind");
    expect(tableColumns(dbPath, "rooms")).toEqual(expect.arrayContaining(["width", "height"]));
    expect(tableColumns(dbPath, "guests")).toEqual(expect.arrayContaining(["owner_id", "nickname", "created_at"]));
  });

  it("2. a fresh database's existing exported functions still work exactly as before", async () => {
    const dbPath = tempDbPath("comp4020-migration-fresh-functions-");
    const db = await bootDb(dbPath);
    const ownerId = randomUUID();

    const seq = db.insertOp({
      id: randomUUID(),
      ownerId,
      kind: "draw",
      color: "#1d1d1d",
      size: 0.02,
      points: [{ x: 0.1, y: 0.1 }],
      createdAt: Date.now(),
      roomId: null,
    });
    expect(typeof seq).toBe("number");
    expect(db.listOps(null)).toHaveLength(1);

    const code = db.createRoom(randomUUID(), ownerId);
    expect(db.getActiveRoom(code)).not.toBeNull();
  });

  it("3. an existing C8-shaped database preserves every legacy op/room row byte-for-byte and gains doc_kind='freehand', width/height=NULL, and a guests table", async () => {
    const dbPath = tempDbPath("comp4020-migration-legacy-");

    // Seed the database with exactly the pre-migration shape C8 shipped:
    // no room_id/active/undo_order/doc_kind on ops, no empty_since/width/
    // height on rooms, no guests table at all.
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE ops (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('draw', 'erase')),
        color TEXT,
        size REAL NOT NULL,
        points TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    seed.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);
    const legacyOpId = randomUUID();
    const legacyOwnerId = randomUUID();
    const legacyPoints = JSON.stringify([{ x: 0.3, y: 0.3 }]);
    seed
      .prepare(
        "INSERT INTO ops (id, owner_id, kind, color, size, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(legacyOpId, legacyOwnerId, "draw", "#8e24aa", 0.02, legacyPoints, 123_456_789);
    const legacyRoomCode = "LEGACY1";
    seed.prepare("INSERT INTO rooms (id, created_at) VALUES (?, ?)").run(legacyRoomCode, 123_000_000);
    seed.close();

    const db = await bootDb(dbPath);

    const opRow = rawRow(dbPath, "SELECT * FROM ops WHERE id = ?", legacyOpId)!;
    expect(opRow.owner_id).toBe(legacyOwnerId);
    expect(opRow.kind).toBe("draw");
    expect(opRow.color).toBe("#8e24aa");
    expect(opRow.size).toBe(0.02);
    expect(opRow.points).toBe(legacyPoints);
    expect(opRow.created_at).toBe(123_456_789);
    expect(opRow.doc_kind).toBe("freehand"); // migrated default, never rewritten to anything else
    expect(opRow.room_id).toBeNull(); // pre-existing Public op, untouched by this step

    const roomRow = rawRow(dbPath, "SELECT * FROM rooms WHERE id = ?", legacyRoomCode)!;
    expect(roomRow.created_at).toBe(123_000_000);
    expect(roomRow.width).toBeNull();
    expect(roomRow.height).toBeNull();

    expect(tableColumns(dbPath, "guests")).toEqual(expect.arrayContaining(["owner_id", "nickname", "created_at"]));

    // The legacy room and op are not just present on disk -- they still work
    // through every existing, unmodified room-lifecycle/ops function.
    expect(db.getActiveRoom(legacyRoomCode, 123_000_001)).not.toBeNull();
    expect(db.listOps(null).some((op) => op.id === legacyOpId)).toBe(true);
  });

  it("4. booting twice against the same already-migrated database is idempotent: no duplicate columns, no duplicate tables, no error", async () => {
    const dbPath = tempDbPath("comp4020-migration-repeat-");
    await bootDb(dbPath);
    await bootDb(dbPath); // same file, second independent boot

    expect(tableColumns(dbPath, "ops").filter((c) => c === "doc_kind")).toHaveLength(1);
    expect(tableColumns(dbPath, "rooms").filter((c) => c === "width")).toHaveLength(1);
    expect(tableColumns(dbPath, "rooms").filter((c) => c === "height")).toHaveLength(1);

    const guestTables = rawRow(
      dbPath,
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'guests'",
    )!;
    expect(guestTables.n).toBe(1);
  });

  it("5. booting twice preserves data inserted between boots (no table rebuild silently drops rows)", async () => {
    const dbPath = tempDbPath("comp4020-migration-repeat-data-");
    const first = await bootDb(dbPath);
    const ownerId = randomUUID();
    first.insertOp({
      id: randomUUID(),
      ownerId,
      kind: "draw",
      color: "#43a047",
      size: 0.01,
      points: [{ x: 0.5, y: 0.5 }],
      createdAt: Date.now(),
      roomId: null,
    });

    const second = await bootDb(dbPath);
    expect(second.listOps(null)).toHaveLength(1);
  });

  it("6. a guest nickname row is keyed by owner_id, stored independently, and never affects ownership-scoped undo/redo", async () => {
    const dbPath = tempDbPath("comp4020-migration-guests-");
    const db = await bootDb(dbPath);
    const ownerId = randomUUID();
    const nicknameCreatedAt = Date.now();

    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("INSERT INTO guests (owner_id, nickname, created_at) VALUES (?, ?, ?)")
        .run(ownerId, "Casey", nicknameCreatedAt);
    } finally {
      raw.close();
    }

    const guestRow = rawRow(dbPath, "SELECT * FROM guests WHERE owner_id = ?", ownerId)!;
    expect(guestRow.nickname).toBe("Casey");
    expect(guestRow.created_at).toBe(nicknameCreatedAt);

    // The nickname row has no bearing on ownership: this owner can still
    // draw and undo exactly their own op, through the same unmodified
    // functions every other ownership-scoped test already relies on.
    db.insertOp({
      id: randomUUID(),
      ownerId,
      kind: "draw",
      color: "#1e88e5",
      size: 0.02,
      points: [{ x: 0.2, y: 0.2 }],
      createdAt: Date.now(),
      roomId: null,
    });
    const undone = db.undoLatestOwnOp(null, ownerId);
    expect(undone).not.toBeNull();
    expect(db.listOps(null)).toHaveLength(0);
  });
});
