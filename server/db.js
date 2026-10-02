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

// Undo/redo lifecycle, additive and idempotent like room_id above. `active`
// gates replay membership (see listOps below): every pre-existing row gets
// DEFAULT 1 automatically, so nothing already drawn is affected by this
// migration landing. `undo_order` is NULL except on a row that is currently
// undone-and-redoable -- see undoLatestOwnOp/redoLatestOwnOp/abandonRedoBranch
// for the three states this pair of columns encodes:
//   active=1                      -> participates in replay (the normal case)
//   active=0, undo_order NOT NULL -> undone, still redoable (Ctrl+Y can bring it back)
//   active=0, undo_order IS NULL  -> permanently abandoned (a later own-edit
//                                    superseded it; history keeps the row, but
//                                    it can never be redone again)
if (!columnExists("ops", "active")) {
  db.exec("ALTER TABLE ops ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
}
if (!columnExists("ops", "undo_order")) {
  db.exec("ALTER TABLE ops ADD COLUMN undo_order INTEGER");
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
// exactly like `=` would -- one query shape serves both scopes. `active = 1`
// applies identically to both scopes too: Public Canvas has no undo/redo route
// (see server/index.js), so its rows never become inactive and this filter is
// a no-op there -- it's the same replay-membership rule everywhere, not a
// second semantics introduced for rooms.
export function listOps(roomId = null) {
  const rows = db
    .prepare(
      "SELECT seq, id, owner_id, kind, color, size, points, created_at, room_id FROM ops WHERE room_id IS ? AND active = 1 ORDER BY seq ASC",
    )
    .all(roomId);
  return rows.map(rowToOp);
}

const OP_COLUMNS = "seq, id, owner_id, kind, color, size, points, created_at, room_id";

// `room_id IS ?` (not `=`), exactly like listOps above: a null roomId (the
// Public scope) must match rows where room_id is actually NULL, and `=`
// never matches NULL in SQL -- it would silently find nothing for Public and
// make every Public undo/redo/abandon a permanent no-op. A non-null roomId
// still matches exactly like `=` would, so this one query shape correctly
// serves both scopes, the same way listOps already does.
const findLatestActiveOwnOpStmt = db.prepare(
  `SELECT ${OP_COLUMNS} FROM ops WHERE room_id IS ? AND owner_id = ? AND active = 1 ORDER BY seq DESC LIMIT 1`,
);

const findLatestRedoableOwnOpStmt = db.prepare(
  `SELECT ${OP_COLUMNS} FROM ops WHERE room_id IS ? AND owner_id = ? AND active = 0 AND undo_order IS NOT NULL ORDER BY undo_order DESC LIMIT 1`,
);

// The deterministic ordering primitive for redo's LIFO order (see the
// module comment above for the three active/undo_order states). Never
// Date.now(): two undo requests inside the same millisecond would tie under
// a wall-clock marker, and wall-clock time is not guaranteed monotonic across
// process/clock adjustments anyway. Instead this reads the current max
// undo_order across the whole table and writes back max+1, in the same
// single UPDATE statement -- safe without a transaction or a separate
// counter table because DatabaseSync is fully synchronous and this module
// runs single-threaded (the same guarantee `seq`'s own AUTOINCREMENT already
// relies on, see above), so no second request's statement can ever interleave
// between this statement's read of MAX(undo_order) and its write. The scope
// is deliberately global (every room, every owner), not per-owner-per-room:
// a single shared counter still produces the correct relative LIFO order
// within any one (room, owner) subset, and avoids needing a second query
// parameterized by room/owner just to compute it.
const undoOpStmt = db.prepare(
  "UPDATE ops SET active = 0, undo_order = (SELECT COALESCE(MAX(undo_order), 0) + 1 FROM ops) WHERE seq = ?",
);

const redoOpStmt = db.prepare("UPDATE ops SET active = 1, undo_order = NULL WHERE seq = ?");

// Abandons every currently-redoable op this owner has in this scope -- called
// once a new draw/erase from them actually persists (see handleDraw/
// handleErase), for both the Public scope (roomId null) and any room. Only
// rows with undo_order still set are touched (an already-abandoned row has
// nothing left to clear), and the scope is exactly (room_id IS ?, owner_id),
// so another owner's redo branch, this same owner's branch in a different
// room, or this same owner's Private branch when a Public edit just
// persisted (or vice versa), is never touched.
const abandonRedoBranchStmt = db.prepare(
  "UPDATE ops SET undo_order = NULL WHERE room_id IS ? AND owner_id = ? AND active = 0 AND undo_order IS NOT NULL",
);

// Undoes this owner's own most-recent currently-active op in this scope, and
// only that op -- found by (room_id IS ?, owner_id, active=1) ordered by seq
// DESC, never by anything the caller supplies (see server/index.js's routes,
// which pass roomId = null for Public or a validated :code for a room, and
// ownerId from the anon cookie, nothing else). Returns the now-inactive op
// (same shape listOps returns), or null if this owner has nothing active
// left to undo. createdAt is never written by undoOpStmt below, so the
// returned op's createdAt is exactly what it was originally stamped with --
// undoing never touches fade age.
export function undoLatestOwnOp(roomId, ownerId) {
  const row = findLatestActiveOwnOpStmt.get(roomId, ownerId);
  if (!row) return null;
  undoOpStmt.run(row.seq);
  return rowToOp(row);
}

// Redoes this owner's most recently undone, still-redoable op in this scope
// (Public when roomId is null, otherwise that room) -- true LIFO by
// undo_order (not by seq: after two consecutive undos the lower-seq op can be
// the one undone most recently, see the worked example in the architecture
// report). Crucially this reactivates the SAME row -- same id, same seq, same
// owner, same created_at, same geometry, same kind -- never inserts a new op.
// redoOpStmt below only ever writes active/undo_order, so created_at is
// physically untouched: a Public op's fade age keeps counting from its
// original createdAt regardless of how long it spent undone, and redoing an
// op that has already fully faded (fadeOpacity <= 0) brings it back into
// persisted/active history without making it visible again. Not touching seq
// also means its original position in the global seq-ordered replay is
// exactly where it lands back.
export function redoLatestOwnOp(roomId, ownerId) {
  const row = findLatestRedoableOwnOpStmt.get(roomId, ownerId);
  if (!row) return null;
  redoOpStmt.run(row.seq);
  return rowToOp(row);
}

export function abandonRedoBranch(roomId, ownerId) {
  abandonRedoBranchStmt.run(roomId, ownerId);
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
