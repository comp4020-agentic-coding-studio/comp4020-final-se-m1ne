import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomInt } from "node:crypto";

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
// detail. `seq` is shared globally across every room and the public canvas --
// scoping by room_id only adds a filter, it never introduces a second
// ordering concept.
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

// Additive, idempotent: adds room_id (nullable) to ops if it isn't already
// there. SQLite gives every pre-existing row NULL for a newly added column
// automatically -- no rewrite, no backfill. NULL is the Public Canvas
// sentinel, so every op that existed before this migration remains, exactly
// as it was, a Public Canvas operation.
function columnExists(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((col) => col.name === column);
}

if (!columnExists("ops", "room_id")) {
  db.exec("ALTER TABLE ops ADD COLUMN room_id TEXT");
}

// A room is just its code plus when it was created -- no name, owner,
// membership, or settings: nothing this slice needs. A room's existence here
// is also what lets "is this a real room?" be answered before ever touching
// ops, which is what makes an unknown room 404 instead of silently working.
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )
`);

const insertOpStmt = db.prepare(
  "INSERT INTO ops (id, owner_id, kind, color, size, points, created_at, room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);

const insertRoomStmt = db.prepare("INSERT INTO rooms (id, created_at) VALUES (?, ?)");
const roomExistsStmt = db.prepare("SELECT 1 FROM rooms WHERE id = ?");

// One-time, idempotent: if an old `strokes` table (the pre-migration
// vector-fragment model) is still present, every row in it is carried
// forward verbatim as a 'draw' op -- same id, owner, color, width-as-size,
// points, created_at -- in created_at order, then the old table is dropped.
// This runs generically against whatever `strokes` rows exist; it does not
// know or care about any specific historical row, which is deliberate: any
// one-off cleanup of specific known-bad rows belongs in a separate, explicit,
// run-once pass before this ever boots, not hardcoded into permanent startup
// code. Legacy rows predate rooms entirely, so they carry room_id = NULL --
// Public Canvas, same as every other pre-migration row.
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
      insertOpStmt.run(row.id, row.owner_id, "draw", row.color, row.width, row.points, row.created_at, null);
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
    roomId: row.room_id,
  };
}

// Returns the seq SQLite assigned this op -- the authoritative position in
// replay order. roomId is null for the Public Canvas, or a room's code --
// the same insert path for both, so there is exactly one implementation of
// "persist an op", not one per scope.
export function insertOp({ id, ownerId, kind, color, size, points, createdAt, roomId = null }) {
  const info = insertOpStmt.run(id, ownerId, kind, color ?? null, size, JSON.stringify(points), createdAt, roomId);
  return Number(info.lastInsertRowid);
}

// `room_id IS ?` (not `=`) so a null roomId correctly matches the Public
// Canvas rows (`=` never matches NULL in SQL) while a room code still matches
// exactly like `=` would -- one query shape serves both scopes.
export function listOps(roomId = null) {
  const rows = db
    .prepare("SELECT seq, id, owner_id, kind, color, size, points, created_at, room_id FROM ops WHERE room_id IS ? ORDER BY seq ASC")
    .all(roomId);
  return rows.map(rowToOp);
}

const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const ROOM_CODE_LENGTH = 6;

function randomRoomCode() {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

// Uniqueness is the database's job, not this function's: the PRIMARY KEY on
// rooms.id is the actual authority. A generated code that collides makes the
// INSERT fail, which is caught here only to retry with a fresh code -- never
// to paper over some other kind of failure.
export function createRoom() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomRoomCode();
    try {
      insertRoomStmt.run(code, Date.now());
      return code;
    } catch (err) {
      if (!/UNIQUE|PRIMARY KEY/i.test(String(err?.message ?? ""))) throw err;
    }
  }
  throw new Error(`could not generate a unique room code after ${10} attempts`);
}

export function roomExists(code) {
  return roomExistsStmt.get(code) !== undefined;
}
