import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Same throwaway-database-per-boot harness as spec/pixel-schema-migration.test.ts
// (see that file's own top-of-file comment for why a fresh module specifier
// is needed per boot). This file only exercises the new layer_id column on
// ops -- the migration precedent it follows is the `shape` column, not
// `doc_kind` (no CHECK constraint, nullable with no DEFAULT, never backfilled
// on existing rows).
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

describe("layer_id schema migration (backward-compatible, additive only)", () => {
  it("1. a fresh database gets layer_id on ops", async () => {
    const dbPath = tempDbPath("comp4020-layer-migration-fresh-");
    await bootDb(dbPath);
    expect(tableColumns(dbPath, "ops")).toContain("layer_id");
  });

  it("2. insertOp without layerId still works, and listOps/rowToOp return layerId: null for it", async () => {
    const dbPath = tempDbPath("comp4020-layer-migration-no-layer-");
    const db = await bootDb(dbPath);
    const ownerId = randomUUID();

    db.insertOp({
      id: randomUUID(),
      ownerId,
      kind: "draw",
      color: "#1d1d1d",
      size: 0.02,
      points: [{ x: 0.1, y: 0.1 }],
      createdAt: Date.now(),
      roomId: null,
      // layerId intentionally omitted -- exercises insertOp's own default
    });

    const ops = db.listOps(null);
    expect(ops).toHaveLength(1);
    expect(ops[0].layerId).toBeNull();
  });

  it("3. insertOp with an explicit layerId persists and round-trips it", async () => {
    const dbPath = tempDbPath("comp4020-layer-migration-with-layer-");
    const db = await bootDb(dbPath);
    const ownerId = randomUUID();

    db.insertOp({
      id: randomUUID(),
      ownerId,
      kind: "draw",
      color: "#1d1d1d",
      size: 0.02,
      points: [{ x: 0.1, y: 0.1 }],
      createdAt: Date.now(),
      roomId: null,
      // server/db.js is untyped by design (see tsconfig.json); layerId's
      // inferred type comes from its `= null` default, so a real layer id
      // needs the same explicit escape hatch roomId uses elsewhere in this
      // suite (spec/rooms-lifecycle.test.ts), rather than a db.js annotation.
      layerId: "lineart" as unknown as null,
    });

    const ops = db.listOps(null);
    expect(ops).toHaveLength(1);
    expect(ops[0].layerId).toBe("lineart");
  });

  it("4. an existing (pre-layer-system) op row survives a migration boot with layer_id = NULL, byte-for-byte otherwise unchanged", async () => {
    const dbPath = tempDbPath("comp4020-layer-migration-legacy-");

    // Seed the database with the pre-layer-system shape: every column up to
    // and including `shape`, but no layer_id at all.
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
        created_at INTEGER NOT NULL,
        room_id TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        undo_order INTEGER,
        doc_kind TEXT NOT NULL DEFAULT 'freehand',
        shape TEXT
      )
    `);
    const legacyOpId = randomUUID();
    const legacyOwnerId = randomUUID();
    const legacyPoints = JSON.stringify([{ x: 0.4, y: 0.4 }]);
    seed
      .prepare(
        "INSERT INTO ops (id, owner_id, kind, color, size, points, created_at, room_id, doc_kind) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(legacyOpId, legacyOwnerId, "draw", "#43a047", 0.015, legacyPoints, 555_555_555, null, "freehand");
    seed.close();

    const db = await bootDb(dbPath);

    const opRow = rawRow(dbPath, "SELECT * FROM ops WHERE id = ?", legacyOpId)!;
    expect(opRow.owner_id).toBe(legacyOwnerId);
    expect(opRow.color).toBe("#43a047");
    expect(opRow.points).toBe(legacyPoints);
    expect(opRow.created_at).toBe(555_555_555);
    expect(opRow.layer_id).toBeNull(); // migrated, never backfilled to anything else

    expect(db.listOps(null).find((op) => op.id === legacyOpId)?.layerId).toBeNull();
  });

  it("5. booting twice against the same already-migrated database is idempotent: no duplicate column, no error", async () => {
    const dbPath = tempDbPath("comp4020-layer-migration-repeat-");
    await bootDb(dbPath);
    await bootDb(dbPath);

    expect(tableColumns(dbPath, "ops").filter((c) => c === "layer_id")).toHaveLength(1);
  });

  it("6. booting twice preserves a layerId inserted between boots", async () => {
    const dbPath = tempDbPath("comp4020-layer-migration-repeat-data-");
    const first = await bootDb(dbPath);
    const ownerId = randomUUID();
    first.insertOp({
      id: randomUUID(),
      ownerId,
      kind: "erase",
      color: null,
      size: 0.05,
      points: [{ x: 0.6, y: 0.6 }],
      createdAt: Date.now(),
      roomId: null,
      layerId: "layer2" as unknown as null,
    });

    const second = await bootDb(dbPath);
    const ops = second.listOps(null);
    expect(ops).toHaveLength(1);
    expect(ops[0].layerId).toBe("layer2");
  });
});
