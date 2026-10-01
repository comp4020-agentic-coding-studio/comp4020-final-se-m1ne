import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "/data/app.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS strokes (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    color TEXT NOT NULL,
    width REAL NOT NULL,
    points TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

function rowToStroke(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    color: row.color,
    width: row.width,
    points: JSON.parse(row.points),
    createdAt: row.created_at,
  };
}

const insertStmt = db.prepare(
  "INSERT INTO strokes (id, owner_id, color, width, points, created_at) VALUES (?, ?, ?, ?, ?, ?)",
);

export function insertStroke({ id, ownerId, color, width, points, createdAt }) {
  insertStmt.run(id, ownerId, color, width, JSON.stringify(points), createdAt);
}

export function listStrokes() {
  const rows = db
    .prepare(
      "SELECT id, owner_id, color, width, points, created_at FROM strokes ORDER BY created_at ASC",
    )
    .all();
  return rows.map(rowToStroke);
}

// Scoped to one owner so the caller never even reads another participant's
// strokes, let alone modifies them -- the enforcement mechanism for erasing.
export function getStrokesByOwner(ownerId) {
  const rows = db
    .prepare("SELECT id, owner_id, color, width, points, created_at FROM strokes WHERE owner_id = ?")
    .all(ownerId);
  return rows.map(rowToStroke);
}

// Atomically swaps one stroke for zero or more fragment strokes (the result
// of erasing part of it), so a crash mid-operation can't drop or duplicate
// drawing data.
export function replaceStroke(id, fragments) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM strokes WHERE id = ?").run(id);
    for (const fragment of fragments) {
      insertStmt.run(
        fragment.id,
        fragment.ownerId,
        fragment.color,
        fragment.width,
        JSON.stringify(fragment.points),
        fragment.createdAt,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
