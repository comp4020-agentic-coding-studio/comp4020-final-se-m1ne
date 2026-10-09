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

// Additive, idempotent, like every migration above: distinguishes legacy
// freehand vector ops (points are normalized [0,1] floats, size is a stroke
// width/diameter -- the shape every C8 op already has) from the pixel-art
// op shape a later step introduces (points are integer grid cells, size is
// an integer brush size in cells). Every row that exists before this
// migration lands -- every historical C8 op -- gets 'freehand'
// automatically via DEFAULT, exactly once, and this migration never writes
// to an existing row's doc_kind afterward: that is what keeps historical C8
// artwork byte-for-byte intact (for a later read-only legacy archive)
// rather than converted, deleted, or silently hidden.
//
// No CHECK constraint is added here, deliberately: SQLite's ALTER TABLE ADD
// COLUMN can't retroactively constrain a column the way the original CREATE
// TABLE's `kind IN ('draw', 'erase')` does for a fresh table, and no other
// column this file has ever migrated in this way (room_id, active,
// undo_order, above) carries one either -- every one of them relies on this
// module's own functions to only ever write valid values. doc_kind follows
// that same established precedent rather than introducing a new one.
// insertOp is intentionally left untouched in this step: nothing yet writes
// a value other than this column's own default, so every op inserted today
// -- and every op already inserted before today -- is 'freehand', which is
// exactly what "existing operation semantics... unmodified in this step"
// requires.
if (!columnExists("ops", "doc_kind")) {
  db.exec("ALTER TABLE ops ADD COLUMN doc_kind TEXT NOT NULL DEFAULT 'freehand'");
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

// Additive, idempotent, like ops.room_id above. NULL means "occupied, or
// never yet observed empty"; a non-NULL value is the instant (derived from
// persisted presence evidence, see reconcileRoom) the room's last live lease
// expired -- the anchor ROOM_EMPTY_EXPIRY_MS counts forward from, see below.
if (!columnExists("rooms", "empty_since")) {
  db.exec("ALTER TABLE rooms ADD COLUMN empty_since INTEGER");
}

// Additive, idempotent, like empty_since above. NULL on both -- the state of
// every room that exists before this migration lands, and of every room
// created today, since createRoom does not populate them in this step --
// means "this room predates resolution selection": a legacy freehand room,
// fixed at the existing 1920x1080 document, exactly as it already behaves
// (nothing about createRoom, getActiveRoom, or any other room-lifecycle
// function changes here). A later step that teaches createRoom to accept and
// persist a resolution will give new pixel-art studios a non-NULL pair;
// every room that exists today keeps working unmodified either way, which is
// the whole point of these columns being nullable.
if (!columnExists("rooms", "width")) {
  db.exec("ALTER TABLE rooms ADD COLUMN width INTEGER");
}
if (!columnExists("rooms", "height")) {
  db.exec("ALTER TABLE rooms ADD COLUMN height INTEGER");
}

// Additive, idempotent, like width/height above. Document background is
// metadata about how a pixel-art studio's canvas is DISPLAYED -- opaque
// white, opaque custom colour, or true transparency (shown as a checkerboard
// client-side) -- never an ordinary drawing operation, never stored in
// `ops`, and never touching pixel ownership or dimensions. DEFAULT 'white'
// means every room that exists before this migration lands -- every legacy
// freehand room (background is simply unused there) and every pixel-art
// studio created under the earlier resolution-only API (which had no
// background concept and behaved as opaque white) -- keeps exactly its prior
// visual appearance. background_color is only ever non-NULL when
// background_kind = 'custom' (server/index.js's own validation enforces
// this; nothing here needs a CHECK constraint to do it, the same precedent
// doc_kind/active/undo_order above already established).
if (!columnExists("rooms", "background_kind")) {
  db.exec("ALTER TABLE rooms ADD COLUMN background_kind TEXT NOT NULL DEFAULT 'white'");
}
if (!columnExists("rooms", "background_color")) {
  db.exec("ALTER TABLE rooms ADD COLUMN background_color TEXT");
}

// A lease, not a membership list: one row per (room, tab/page-load), reset on
// every heartbeat. presence_id is never the artwork-owner identity (owner_id,
// the same anon_id draw/erase ops already use) -- it only exists to let two
// tabs from the same browser/owner be counted as two independent occupants,
// so one tab closing never looks like its owner leaving entirely. No FK to
// rooms: a room's deletion (expireRoom below) always deletes this table's
// rows for that room_id first and explicitly, in the same transaction, so
// nothing here is ever left pointing at a room that no longer exists.
db.exec(`
  CREATE TABLE IF NOT EXISTS presence (
    room_id TEXT NOT NULL,
    presence_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (room_id, presence_id)
  )
`);

// A one-time guest nickname, keyed by the same owner_id every draw/erase op
// and presence row already uses -- not a second identity system, and never
// itself an authority: nothing in this table is read by any ownership,
// erase, or undo/redo check, all of which stay keyed on owner_id alone (the
// httpOnly anon_id cookie, server/anon.js, completely unchanged by this
// table's existence). This table exists purely so a nickname can be looked
// up/displayed; a later step owns actually reading or writing it.
db.exec(`
  CREATE TABLE IF NOT EXISTS guests (
    owner_id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const STALE_TIMEOUT_MS = 90_000;
export const ROOM_EMPTY_EXPIRY_MS = 24 * 60 * 60 * 1000;

const insertOpStmt = db.prepare(
  "INSERT INTO ops (id, owner_id, kind, color, size, points, created_at, room_id, doc_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);

// width/height are NULL for a legacy freehand room (the default every
// pre-Step-3 call site still gets, see createRoom below) and this room's own
// dimensions in cells for a pixel-art studio -- the one fact every pixel
// route needs to validate operations and every legacy route needs to keep
// ignoring. background_kind/background_color default to 'white'/NULL for
// every caller that doesn't pass them (every pre-background-metadata call
// site, legacy and pixel-art alike).
const insertRoomStmt = db.prepare(
  "INSERT INTO rooms (id, created_at, width, height, background_kind, background_color) VALUES (?, ?, ?, ?, ?, ?)",
);
const selectRoomStmt = db.prepare(
  "SELECT id, created_at, empty_since, width, height, background_kind, background_color FROM rooms WHERE id = ?",
);
const updateBackgroundStmt = db.prepare("UPDATE rooms SET background_kind = ?, background_color = ? WHERE id = ?");
const deleteRoomStmt = db.prepare("DELETE FROM rooms WHERE id = ?");
const clearEmptySinceStmt = db.prepare("UPDATE rooms SET empty_since = NULL WHERE id = ?");
const setEmptySinceStmt = db.prepare("UPDATE rooms SET empty_since = ? WHERE id = ?");

const upsertPresenceStmt = db.prepare(`
  INSERT INTO presence (room_id, presence_id, owner_id, last_seen)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(room_id, presence_id) DO UPDATE SET owner_id = excluded.owner_id, last_seen = excluded.last_seen
`);
const livePresenceExistsStmt = db.prepare("SELECT 1 FROM presence WHERE room_id = ? AND last_seen >= ? LIMIT 1");
const maxLastSeenStmt = db.prepare("SELECT MAX(last_seen) AS maxLastSeen FROM presence WHERE room_id = ?");
const deleteStalePresenceStmt = db.prepare("DELETE FROM presence WHERE room_id = ? AND last_seen < ?");
const deleteAllPresenceForRoomStmt = db.prepare("DELETE FROM presence WHERE room_id = ?");
const deleteOnePresenceStmt = db.prepare("DELETE FROM presence WHERE room_id = ? AND presence_id = ?");
const deleteOpsForRoomStmt = db.prepare("DELETE FROM ops WHERE room_id = ?");

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
      insertOpStmt.run(row.id, row.owner_id, "draw", row.color, row.width, row.points, row.created_at, null, "freehand");
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
    docKind: row.doc_kind,
  };
}

// Returns the seq SQLite assigned this op -- the authoritative position in
// replay order. roomId is null for the Public Canvas, or a room's code --
// the same insert path for both, so there is exactly one implementation of
// "persist an op", not one per scope. docKind defaults to "freehand" so every
// existing caller (the freehand draw/erase routes, and every direct-db.js
// test predating this step) keeps inserting exactly what it always has --
// only the new pixel routes (server/index.js) ever pass "pixel" explicitly.
export function insertOp({ id, ownerId, kind, color, size, points, createdAt, roomId = null, docKind = "freehand" }) {
  const info = insertOpStmt.run(
    id, ownerId, kind, color ?? null, size, JSON.stringify(points), createdAt, roomId, docKind,
  );
  return Number(info.lastInsertRowid);
}

// `room_id IS ?` (not `=`) so a null roomId correctly matches the Public
// Canvas rows (`=` never matches NULL in SQL) while a room code still matches
// exactly like `=` would -- one query shape serves both scopes. `active = 1`
// applies identically to both scopes too -- it's the same replay-membership
// rule everywhere, not a second semantics introduced for rooms.
//
// docKind defaults to "freehand": every pre-Step-3 call site (the existing
// freehand GET /api/ops and GET /api/rooms/:code/ops routes, and every
// existing test) keeps seeing exactly the freehand replay list it always has,
// even once pixel ops start sharing the same room_id scope -- a Public pixel
// op and a Public freehand op both live under room_id IS NULL, so without
// this filter the old routes would start seeing pixel rows mixed in the
// moment any pixel op existed. The new pixel routes pass docKind: "pixel"
// explicitly; there is no third value, so one parameter cleanly serves both.
export function listOps(roomId = null, docKind = "freehand") {
  const rows = db
    .prepare(
      "SELECT seq, id, owner_id, kind, color, size, points, created_at, room_id, doc_kind " +
        "FROM ops WHERE room_id IS ? AND doc_kind = ? AND active = 1 ORDER BY seq ASC",
    )
    .all(roomId, docKind);
  return rows.map(rowToOp);
}

const OP_COLUMNS = "seq, id, owner_id, kind, color, size, points, created_at, room_id, doc_kind";

// `room_id IS ?` (not `=`), exactly like listOps above: a null roomId (the
// Public scope) must match rows where room_id is actually NULL, and `=`
// never matches NULL in SQL -- it would silently find nothing for Public and
// make every Public undo/redo/abandon a permanent no-op. A non-null roomId
// still matches exactly like `=` would, so this one query shape correctly
// serves both scopes, the same way listOps already does.
// doc_kind is part of the scope here for the same reason it is in listOps:
// once a Public (or a room's) freehand and pixel ops can share the exact
// same room_id, an owner's freehand Undo must never reach into their pixel
// history (which the freehand UI has no way to re-render) or vice versa.
// Every pre-Step-3 caller still passes "freehand" (see undoLatestOwnOp/
// redoLatestOwnOp/abandonRedoBranch below), so this is a no-op filter for
// every op that exists before this step.
const findLatestActiveOwnOpStmt = db.prepare(
  `SELECT ${OP_COLUMNS} FROM ops WHERE room_id IS ? AND owner_id = ? AND doc_kind = ? AND active = 1 ORDER BY seq DESC LIMIT 1`,
);

const findLatestRedoableOwnOpStmt = db.prepare(
  `SELECT ${OP_COLUMNS} FROM ops WHERE room_id IS ? AND owner_id = ? AND doc_kind = ? AND active = 0 AND undo_order IS NOT NULL ORDER BY undo_order DESC LIMIT 1`,
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
  "UPDATE ops SET undo_order = NULL WHERE room_id IS ? AND owner_id = ? AND doc_kind = ? AND active = 0 AND undo_order IS NOT NULL",
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
export function undoLatestOwnOp(roomId, ownerId, docKind = "freehand") {
  const row = findLatestActiveOwnOpStmt.get(roomId, ownerId, docKind);
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
export function redoLatestOwnOp(roomId, ownerId, docKind = "freehand") {
  const row = findLatestRedoableOwnOpStmt.get(roomId, ownerId, docKind);
  if (!row) return null;
  redoOpStmt.run(row.seq);
  return rowToOp(row);
}

export function abandonRedoBranch(roomId, ownerId, docKind = "freehand") {
  abandonRedoBranchStmt.run(roomId, ownerId, docKind);
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

// The single place "is this lease still live" gets decided: a presence row
// counts as live iff it was last renewed within STALE_TIMEOUT_MS of `now`.
// Everything below -- occupancy, empty_since derivation, reconciliation --
// is built on this one threshold so there is exactly one definition of
// staleness, not one per call site.
//
// Reconciles a room's occupancy bookkeeping against its persisted presence
// evidence, strictly in this order: (1) decide live-vs-stale from last_seen
// alone, nothing else; (2) if live presence exists, the room is occupied --
// clear a stale empty_since if one is somehow still set, and it is now safe
// to drop presence rows that are individually stale (the live row(s) are
// evidence enough on their own); (3) if no live presence exists and
// empty_since is still NULL, capture MAX(last_seen) as the occupancy-evidence
// BEFORE deleting anything, and derive empty_since = maxLastSeen +
// STALE_TIMEOUT_MS from it -- never from `now`, so a reconciliation that
// happens to run hours late (the Fly machine was stopped, nobody touched the
// room) does not drift empty_since forward; (4) if empty_since is already
// set, it is left untouched -- reconciliation only ever establishes
// empty_since once, it never recomputes it. Only after empty_since is either
// confirmed set or correctly left alone do now-redundant stale rows actually
// get deleted, so the timestamp evidence they represent is never destroyed
// before it has been captured in empty_since.
function reconcileRoom(roomId, now = Date.now()) {
  const room = selectRoomStmt.get(roomId);
  if (!room) return null;

  db.exec("BEGIN");
  try {
    const staleThreshold = now - STALE_TIMEOUT_MS;
    const isLive = livePresenceExistsStmt.get(roomId, staleThreshold) !== undefined;

    if (isLive) {
      if (room.empty_since !== null) {
        clearEmptySinceStmt.run(roomId);
        room.empty_since = null;
      }
      deleteStalePresenceStmt.run(roomId, staleThreshold);
    } else {
      if (room.empty_since === null) {
        const { maxLastSeen } = maxLastSeenStmt.get(roomId);
        if (maxLastSeen !== null) {
          const emptySince = maxLastSeen + STALE_TIMEOUT_MS;
          setEmptySinceStmt.run(emptySince, roomId);
          room.empty_since = emptySince;
        }
      }
      // No live presence remains, so every row still here is stale by
      // definition -- and if empty_since needed capturing, it already was,
      // above, before this line.
      deleteAllPresenceForRoomStmt.run(roomId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return room;
}

// Inclusive boundary: a room that has been empty for exactly
// ROOM_EMPTY_EXPIRY_MS is already expired, not "expiring next instant".
function isRoomExpired(room, now = Date.now()) {
  return room.empty_since !== null && now >= room.empty_since + ROOM_EMPTY_EXPIRY_MS;
}

// The exact transactional delete the architecture specifies: presence, then
// ops, then the room itself, all three or none. Public ops (room_id IS NULL)
// are never touched -- every statement here is scoped to this one roomId.
function expireRoom(roomId) {
  db.exec("BEGIN");
  try {
    deleteAllPresenceForRoomStmt.run(roomId);
    deleteOpsForRoomStmt.run(roomId);
    deleteRoomStmt.run(roomId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// The one entry point every room-gating route and lifecycle function uses to
// ask "does this room exist right now": reconciles first (so empty_since
// reflects reality before expiry is judged), then physically deletes the
// room if it turns out to be expired. Either way an expired room comes back
// as null -- indistinguishable from a room code that was never issued, which
// is what makes an expired room 404 instead of silently reachable.
export function getActiveRoom(code, now = Date.now()) {
  const room = reconcileRoom(code, now);
  if (!room) return null;
  if (isRoomExpired(room, now)) {
    expireRoom(code);
    return null;
  }
  return room;
}

// Uniqueness is the database's job, not this function's: the PRIMARY KEY on
// rooms.id is the actual authority. A generated code that collides makes the
// INSERT fail, which is caught here only to retry with a fresh code -- never
// to paper over some other kind of failure. The creator's first presence row
// is inserted in the SAME transaction as the room, per attempt, so a room
// row can never commit without a live presence row already sitting under
// it -- there is no window between "room exists" and "someone is present in
// it" for a concurrent request to observe.
// width/height are appended AFTER now (not inserted before it) so every
// existing 3-positional-argument call (createRoom(presenceId, ownerId, now),
// used throughout spec/rooms-lifecycle.test.ts) keeps meaning exactly what it
// always has -- a legacy freehand room, width/height defaulting to NULL.
// backgroundKind/backgroundColor are appended after THOSE for the identical
// reason: every existing 5-positional-argument pixel-room-creation call
// (server/index.js's old resolution-only path) keeps creating an opaque
// white studio, exactly as it always has, without needing to change.
export function createRoom(
  presenceId,
  ownerId,
  now = Date.now(),
  width = null,
  height = null,
  backgroundKind = "white",
  backgroundColor = null,
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomRoomCode();
    db.exec("BEGIN");
    try {
      insertRoomStmt.run(code, now, width, height, backgroundKind, backgroundColor);
      upsertPresenceStmt.run(code, presenceId, ownerId, now);
      db.exec("COMMIT");
      return code;
    } catch (err) {
      db.exec("ROLLBACK");
      if (!/UNIQUE|PRIMARY KEY/i.test(String(err?.message ?? ""))) throw err;
    }
  }
  throw new Error(`could not generate a unique room code after ${10} attempts`);
}

// Updates a pixel-art studio's background metadata only -- never touches
// width/height (immutable after creation), never touches `ops` (so no
// drawing content, and no pixel ownership, is ever affected), and never
// recreates the room row. server/index.js validates kind/colour before this
// is ever called and gates it to pixel-art rooms only (a legacy freehand
// room's background_kind is simply unused); this function itself does not
// re-validate, matching this file's existing convention of trusting its own
// callers for input shape (server/index.js is always the one caller).
export function setRoomBackground(roomId, kind, color) {
  updateBackgroundStmt.run(kind, color, roomId);
  return selectRoomStmt.get(roomId);
}

// Renews one tab's lease. Validates the room first (same not-found semantics
// as an unknown room if it has expired), then upserts (room_id, presence_id,
// owner_id, last_seen), then reconciles -- so a heartbeat that reoccupies a
// room whose last lease had gone stale (empty_since was set) clears
// empty_since as a direct consequence of reconcileRoom seeing a live row
// again, rather than needing separate reoccupation logic here. Returns null
// if the room does not exist/has expired, so the route can 404 identically
// to every other room-gated endpoint.
export function recordHeartbeat(roomId, presenceId, ownerId, now = Date.now()) {
  const room = getActiveRoom(roomId, now);
  if (!room) return null;
  upsertPresenceStmt.run(roomId, presenceId, ownerId, now);
  return reconcileRoom(roomId, now);
}

// Proactively removes exactly one tab's lease -- never any other presence
// row, even another tab sharing the same ownerId. If another live lease
// remains, the room stays occupied and empty_since (if somehow set) is
// cleared. If this was the last live lease, this is stronger evidence than
// waiting for the lease to go stale, so empty_since is set to `now` itself
// -- but only if it is not already set, so an explicit leave can never move
// an already-established empty_since. Either way, now that no live presence
// remains, the remaining (by definition stale) rows are cleaned up. Returns
// null if the room does not exist/has expired, else the room's current row.
export function leavePresence(roomId, presenceId, now = Date.now()) {
  const room = getActiveRoom(roomId, now);
  if (!room) return null;

  db.exec("BEGIN");
  try {
    deleteOnePresenceStmt.run(roomId, presenceId);
    const staleThreshold = now - STALE_TIMEOUT_MS;
    const isLive = livePresenceExistsStmt.get(roomId, staleThreshold) !== undefined;
    if (isLive) {
      clearEmptySinceStmt.run(roomId);
    } else {
      const current = selectRoomStmt.get(roomId);
      if (current.empty_since === null) {
        setEmptySinceStmt.run(now, roomId);
      }
      deleteAllPresenceForRoomStmt.run(roomId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return selectRoomStmt.get(roomId);
}

// Test/introspection helper: how many presence rows a room currently has,
// with no reconciliation side effect -- used to assert stale rows were
// actually physically removed (or weren't, before evidence was captured).
export function presenceCount(roomId) {
  return db.prepare("SELECT COUNT(*) AS n FROM presence WHERE room_id = ?").get(roomId).n;
}

// --- Guest nickname (cosmetic display metadata, never an authority) --------
//
// Keyed by owner_id, the same server-derived anon_id every draw/erase op and
// presence row already uses -- there is no second identity to manage. Every
// ownership/erase/undo check in this file reads owner_id directly from a
// draw/erase op or a presence row; none of them, and nothing in
// server/index.js, ever consults this table. A nickname is purely something
// to look up and display next to that owner_id.

const upsertGuestStmt = db.prepare(`
  INSERT INTO guests (owner_id, nickname, created_at)
  VALUES (?, ?, ?)
  ON CONFLICT(owner_id) DO UPDATE SET nickname = excluded.nickname
`);
const selectGuestStmt = db.prepare("SELECT nickname FROM guests WHERE owner_id = ?");

// null means this owner has never set a nickname -- the one-time setup
// prompt's own cue to appear, decided entirely by the caller (server/
// index.js), not by anything in this module.
export function getGuestNickname(ownerId) {
  const row = selectGuestStmt.get(ownerId);
  return row ? row.nickname : null;
}

// Upsert: a later call from the same owner updates their nickname in place
// rather than erroring or creating a second row (owner_id is the PRIMARY
// KEY) -- "one-time setup" is a UI convention (server/index.js only prompts
// when getGuestNickname is still null), not something this function itself
// enforces, so an owner can still change a previously-set nickname later.
// created_at is intentionally only ever written on the FIRST insert: the
// ON CONFLICT clause never mentions it, so updating a nickname later leaves
// this owner's original guest-since instant untouched.
export function setGuestNickname(ownerId, nickname, now = Date.now()) {
  upsertGuestStmt.run(ownerId, nickname, now);
  return nickname;
}
