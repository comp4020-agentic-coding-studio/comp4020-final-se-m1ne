import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "/data/app.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Append-only drawing operations. `seq` is SQLite's own AUTOINCREMENT rowid,
// assigned at the moment a row's INSERT actually commits. Because DatabaseSync
// is fully synchronous and Node runs this module single-threaded, two
// concurrent HTTP requests can never interleave their inserts -- whichever
// request's handler reaches insertOp() first is the one that gets the lower
// seq, full stop. That makes `seq` (not `created_at`, and never HTTP arrival
// order) the one authoritative replay order: every client that calls
// listOps() reconstructs the exact same picture, regardless of network
// timing, because draw and erase are not commutative for the same owner
// (draw-then-erase and erase-then-draw can leave different pixels) and so the
// order ops are replayed in is part of the result, not an implementation
// detail.
db.exec(`
  CREATE TABLE IF NOT EXISTS ops (
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

const insertOpStmt = db.prepare(
  "INSERT INTO ops (id, owner_id, kind, color, size, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

// One-time, idempotent: if an old `strokes` table (the pre-migration
// vector-fragment model) is still present, every row in it is carried
// forward verbatim as a 'draw' op -- same id, owner, color, width-as-size,
// points, created_at -- in created_at order, then the old table is dropped.
// This runs generically against whatever `strokes` rows exist; it does not
// know or care about any specific historical row, which is deliberate: any
// one-off cleanup of specific known-bad rows belongs in a separate, explicit,
// run-once pass before this ever boots, not hardcoded into permanent startup
// code.
function migrateLegacyStrokesIfPresent() {
  const strokesTableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'strokes'")
    .get();
  if (!strokesTableExists) return;

  const legacyRows = db
    .prepare("SELECT id, owner_id, color, width, points, created_at FROM strokes ORDER BY created_at ASC, rowid ASC")
    .all();

  db.exec("BEGIN");
  try {
    for (const row of legacyRows) {
      insertOpStmt.run(row.id, row.owner_id, "draw", row.color, row.width, row.points, row.created_at);
    }
    db.exec("DROP TABLE strokes");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

migrateLegacyStrokesIfPresent();

function rowToOp(row) {
  return {
    seq: row.seq,
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    color: row.color,
    size: row.size,
    points: JSON.parse(row.points),
    createdAt: row.created_at,
  };
}

// Returns the seq SQLite assigned this op -- the authoritative position in
// replay order.
export function insertOp({ id, ownerId, kind, color, size, points, createdAt }) {
  const info = insertOpStmt.run(id, ownerId, kind, color ?? null, size, JSON.stringify(points), createdAt);
  return Number(info.lastInsertRowid);
}

export function listOps() {
  const rows = db
    .prepare("SELECT seq, id, owner_id, kind, color, size, points, created_at FROM ops ORDER BY seq ASC")
    .all();
  return rows.map(rowToOp);
}
