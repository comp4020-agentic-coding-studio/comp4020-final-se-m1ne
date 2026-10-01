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

export function insertStroke({ id, ownerId, color, width, points, createdAt }) {
  db.prepare(
    "INSERT INTO strokes (id, owner_id, color, width, points, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, ownerId, color, width, JSON.stringify(points), createdAt);
}

export function listStrokes() {
  const rows = db
    .prepare(
      "SELECT id, owner_id, color, width, points, created_at FROM strokes ORDER BY created_at ASC",
    )
    .all();
  return rows.map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    color: row.color,
    width: row.width,
    points: JSON.parse(row.points),
    createdAt: row.created_at,
  }));
}
