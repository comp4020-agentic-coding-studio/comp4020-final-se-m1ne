import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrSetAnonId } from "./anon.js";
import {
  abandonRedoBranch,
  createRoom,
  getActiveRoom,
  getGuestNickname,
  insertOp,
  leavePresence,
  listOps,
  recordHeartbeat,
  redoLatestOwnOp,
  setGuestNickname,
  undoLatestOwnOp,
} from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = process.env.PORT ?? 8080;

const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, "public")));

// Explicitly scoped to the freehand replay list -- this is the exact
// contract the C8 frontend already depends on, preserved unchanged even once
// Public pixel ops exist under the same room_id (null) scope (see GET
// /api/pixels below for the pixel-only equivalent).
app.get("/api/ops", (req, res) => {
  res.json(listOps(null, "freehand"));
});

// Tells the caller its own anon_id (and, if ever set, its own display
// nickname). This doesn't weaken the cookie's httpOnly ownership enforcement
// -- the server never trusts anything the client claims about ownership --
// it just lets the client group ops into "my layer" vs "everyone else's
// layer" for rendering, the same distinction the server already makes by
// stamping every posted op with this same id. The cookie is Path=/, so the
// same anon_id already applies in every room -- no room-scoped identity is
// introduced. nickname is purely cosmetic (server/db.js's guests table) and
// is never read by, or capable of influencing, any ownership/erase/undo
// check anywhere in this file.
app.get("/api/me", (req, res) => {
  const ownerId = getOrSetAnonId(req, res);
  res.json({ ownerId, nickname: getGuestNickname(ownerId) });
});

const NICKNAME_MAX_LENGTH = 24;

// Rejects anything that isn't a short, printable, non-empty string -- this is
// input validation, not display escaping. Every renderer must still treat a
// nickname as plain text (never markup) regardless of what passes here.
function normalizeNickname(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > NICKNAME_MAX_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null; // no control/formatting characters
  return trimmed;
}

// Sets or updates the caller's own nickname -- cosmetic display metadata
// only, keyed by the same server-derived anon_id every draw/erase op already
// uses. There is no ownerId field anywhere in this request body (ownerId
// always comes from the same httpOnly cookie every other route already
// trusts), and nothing this route touches is ever read by any ownership,
// erase, or undo/redo check: setting a nickname can never authorize drawing,
// erasing, or undoing anything, for this owner or anyone else's.
app.post("/api/me/nickname", (req, res) => {
  const ownerId = getOrSetAnonId(req, res);
  const nickname = normalizeNickname(req.body?.nickname);
  if (nickname === null) {
    res
      .status(400)
      .json({ error: `nickname must be a non-empty string of at most ${NICKNAME_MAX_LENGTH} characters` });
    return;
  }
  setGuestNickname(ownerId, nickname);
  res.status(200).json({ ownerId, nickname });
});

function isPoint(value) {
  return value && typeof value.x === "number" && typeof value.y === "number";
}

function pointsValid(points) {
  return Array.isArray(points) && points.length > 0 && points.every(isPoint);
}

// Persists one brush gesture as a single append-only op. ownerId always
// comes from getOrSetAnonId (the httpOnly cookie), never from the request
// body -- there is no ownerId field in the body at all, so there is nothing
// for a client to spoof. Shared by the Public Canvas and every room: roomId
// is the only thing that varies, and it always comes from the caller's own
// route (never the request body either), never from anything a client could
// supply directly.
function handleDraw(req, res, roomId) {
  const { color, width, points } = req.body ?? {};
  const widthValid = typeof width === "number" && Number.isFinite(width) && width > 0;

  if (typeof color !== "string" || !widthValid || !pointsValid(points)) {
    res
      .status(400)
      .json({ error: "a draw op needs a color, a positive width, and at least one {x, y} point" });
    return;
  }

  const op = {
    id: randomUUID(),
    ownerId: getOrSetAnonId(req, res),
    kind: "draw",
    color,
    size: width,
    points,
    createdAt: Date.now(),
    roomId,
    docKind: "freehand",
  };
  const seq = insertOp(op);
  // A fresh edit abandons this owner's own remaining redo branch in this
  // scope (conventional editor behaviour: undo, undo, then draw something new
  // means the undone-but-not-yet-redone step is gone for good). Runs for
  // Public (roomId null) exactly the same as for a room -- abandonRedoBranch
  // scopes by `room_id IS ?`, so this can never reach into a different scope.
  // Scoped to "freehand" explicitly: this owner's pixel redo branch (if any,
  // in this same room_id scope) is a different document and must never be
  // touched by a freehand edit.
  abandonRedoBranch(roomId, op.ownerId, "freehand");
  res.status(201).json({ ...op, seq });
}

// Persists one eraser gesture's full dragged path as a single append-only
// op, under the caller's own server-derived ownerId. Nothing is read,
// matched, or deleted here -- there is no stroke geometry to intersect
// against. An owner's erase op is only ever replayed (client-side, see
// public/app.js) onto that same owner's own raster layer, so there is no
// code path, here or in the renderer, by which one owner's erase could ever
// touch another owner's pixels. Shared by the Public Canvas and every room,
// the same way handleDraw is.
function handleErase(req, res, roomId) {
  const { radius, points } = req.body ?? {};
  const radiusValid = typeof radius === "number" && Number.isFinite(radius) && radius > 0;

  if (!radiusValid || !pointsValid(points)) {
    res.status(400).json({ error: "an erase op needs a positive radius and at least one {x, y} point" });
    return;
  }

  const op = {
    id: randomUUID(),
    ownerId: getOrSetAnonId(req, res),
    kind: "erase",
    color: null,
    size: radius * 2, // stored as a diameter, the same unit draw's `size` uses
    points,
    createdAt: Date.now(),
    roomId,
    docKind: "freehand",
  };
  const seq = insertOp(op);
  // See the matching comment in handleDraw: a fresh edit abandons this
  // owner's own remaining redo branch in this scope, Public and room alike,
  // scoped to "freehand" so this owner's pixel redo branch is never touched.
  abandonRedoBranch(roomId, op.ownerId, "freehand");
  res.status(201).json({ ...op, seq });
}

app.post("/api/ops/draw", (req, res) => handleDraw(req, res, null));
app.post("/api/ops/erase", (req, res) => handleErase(req, res, null));

// --- Pixel-art documents -----------------------------------------------------
// A second, parallel op family, deliberately NOT layered onto the existing
// /api/ops(/rooms/:code) routes above: those routes, and the C8 frontend that
// calls them, keep their exact existing contract (normalized [0,1] float
// points, a continuous stroke width) completely untouched, so the shipped
// frontend keeps working unmodified while this groundwork lands. A pixel op
// has a structurally different shape (integer grid cells, an integer brush
// size 1-8) that is never silently reinterpreted as, or accepted on, a
// freehand route, and vice versa -- see the room-kind guards further below.

const PUBLIC_PIXEL_WIDTH = 512;
const PUBLIC_PIXEL_HEIGHT = 288;
const PIXEL_RESOLUTIONS = [32, 64, 128, 256];
const MIN_BRUSH_SIZE = 1;
const MAX_BRUSH_SIZE = 8;

function isFiniteInt(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isPixelPoint(value, width, height) {
  return (
    value &&
    isFiniteInt(value.x) &&
    isFiniteInt(value.y) &&
    value.x >= 0 &&
    value.x < width &&
    value.y >= 0 &&
    value.y < height
  );
}

// Every sampled point must already be an in-bounds integer grid cell -- never
// silently clamped or clipped here. (A brush stamp centered on an in-bounds
// point may still extend partly off-grid near an edge; that is a rendering/
// replay concern public/pixelgrid.js's cellsForStroke already clips
// correctly, not something this validator needs to re-decide.)
function pixelPointsValid(points, width, height) {
  return Array.isArray(points) && points.length > 0 && points.every((p) => isPixelPoint(p, width, height));
}

function isValidBrushSize(size) {
  return isFiniteInt(size) && size >= MIN_BRUSH_SIZE && size <= MAX_BRUSH_SIZE;
}

// A room with no stored resolution is a legacy freehand room (Step 1's
// nullable width/height columns); one with a resolution is a pixel-art
// studio. This is the one place that distinction is decided, reused by every
// guard below so a room is never treated as both at once.
function isPixelRoom(room) {
  return room.width !== null;
}

// --- Realtime (SSE) ----------------------------------------------------------
// One in-process subscriber set per pixel document -- the Public wall, or one
// specific pixel-art room -- never a second notion of scope beyond the exact
// same (roomId) key every pixel route above already validates against. A
// single Fly machine and one synchronous SQLite connection (server/db.js)
// make this in-memory fan-out correct and sufficient: there is exactly one
// Node process that could ever need to know about a write, so no broker
// (Redis or otherwise) is needed to fan it out to the others. Legacy
// freehand rooms/ops never get a scope key here at all -- there is no stream
// route that ever resolves one for them (see the route guards below), so a
// freehand write can structurally never broadcast into a pixel stream.
const pixelSubscribers = new Map(); // scopeKey -> Set<ServerResponse>

function pixelScopeKey(roomId) {
  return roomId === null ? "__public__" : roomId;
}

function subscribePixelStream(roomId, res) {
  const key = pixelScopeKey(roomId);
  let subscribers = pixelSubscribers.get(key);
  if (!subscribers) {
    subscribers = new Set();
    pixelSubscribers.set(key, subscribers);
  }
  subscribers.add(res);
  return function unsubscribe() {
    subscribers.delete(res);
    if (subscribers.size === 0) pixelSubscribers.delete(key);
  };
}

// Writes one SSE frame to every subscriber currently in this exact scope --
// Public pixel wall or one specific room, never both, never any other room.
// Called only after a write has already committed (insertOp/undoLatestOwnOp/
// redoLatestOwnOp have already returned, synchronously -- see server/db.js),
// so a rejected/invalid request, which returns before ever reaching this
// point, can never cause a broadcast. A write failing to reach a particular
// subscriber (a socket that is already gone but whose 'close' cleanup
// hasn't run yet) is swallowed here -- best-effort, exactly like every other
// best-effort network call in this codebase (see public/app.js's own
// comments on persistGesture/sendHeartbeat) -- and is not this request's
// problem to report; that subscriber's own cleanup handles it.
function broadcastPixelEvent(roomId, event, data) {
  const subscribers = pixelSubscribers.get(pixelScopeKey(roomId));
  if (!subscribers || subscribers.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(frame);
    } catch {
      // best-effort; the subscriber's own 'close' handler (startPixelStream
      // below) is the real cleanup path, not this write.
    }
  }
}

const SSE_HEARTBEAT_INTERVAL_MS = 20_000;

// GET handler shared by the Public and Private pixel stream routes below.
// Sends a complete authoritative snapshot as the very first frame on this
// connection, synchronously, in the same tick this subscriber is registered
// -- before this function returns to the event loop, so no concurrent
// request's insertOp/undo/redo (all synchronous, see server/db.js) can ever
// commit and broadcast in the gap between "subscribed" and "received the
// snapshot": there is no gap for one to land in. Every subsequent reconnect
// (the browser's native EventSource retry included) is just a brand new call
// to this same route, so it always gets an equally fresh snapshot -- no
// Last-Event-ID or missed-event bookkeeping is needed.
function startPixelStream(req, res, roomId, width, height) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disables any intermediary proxy's response buffering for this stream
  });

  const unsubscribe = subscribePixelStream(roomId, res);
  const ops = listOps(roomId, "pixel");
  res.write(`event: sync\ndata: ${JSON.stringify({ docKind: "pixel", width, height, ops })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n"); // a comment line: keeps the connection alive through idle proxies, not a real event
    } catch {
      // connection already gone; req's 'close' below runs the real cleanup
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// --- Ephemeral collaborator cursors ------------------------------------------
// Never persisted in SQLite, never touches the presence table/lease (that
// stays exactly what it already was: a durable, DB-backed signal of room
// OCCUPANCY, unrelated to where any one pointer currently is -- see
// server/db.js's own presence comments). A cursor update is pure in-process
// pub/sub over the exact same per-scope subscriber sets the op/undo/redo
// broadcasts above already use, so Public/Private/room isolation holds here
// for the same structural reason it does there: one scope key, reused, never
// a second one invented for cursors.

// A small, fast, deterministic string hash -- not cryptographic, not meant to
// be: it only ever needs to turn the same ownerId into the same hue every
// time, on this server, with no persisted state and no coordination between
// owners. Never derived from, or influenced by, anything a client supplies.
function hashOwnerId(ownerId) {
  let hash = 0;
  for (let i = 0; i < ownerId.length; i++) {
    hash = (hash * 31 + ownerId.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function cursorColorForOwner(ownerId) {
  const hue = hashOwnerId(ownerId) % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

function isValidCursorCoordinate(value, limit) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < limit;
}

// Handles one cursor update for one pixel document (Public or a specific
// pixel-art room) -- never persisted, never trusts anything from the body
// except the position and the two visibility booleans. ownerId always comes
// from the same server-derived anon_id cookie every draw/erase route already
// trusts -- there is no ownerId or nickname field anywhere in this body that
// could ever be read as one; the nickname shown, if any, is always looked up
// server-side from this owner's own getGuestNickname record, never accepted
// from the client. showCursor:false needs no position at all -- it is the
// explicit "hide my cursor" signal (leaving the canvas, or a user's own
// privacy toggle), broadcasting cursor-hide and nothing else.
function handlePixelCursor(req, res, roomId, width, height) {
  const ownerId = getOrSetAnonId(req, res);
  const { x, y, showCursor, showNickname } = req.body ?? {};

  if (typeof showCursor !== "boolean") {
    res.status(400).json({ error: "showCursor must be a boolean" });
    return;
  }

  if (!showCursor) {
    broadcastPixelEvent(roomId, "cursor-hide", { ownerId });
    res.status(200).json({ ok: true });
    return;
  }

  if (typeof showNickname !== "boolean") {
    res.status(400).json({ error: "showNickname must be a boolean" });
    return;
  }
  if (!isValidCursorCoordinate(x, width) || !isValidCursorCoordinate(y, height)) {
    res.status(400).json({ error: "x and y must be finite numbers within the document bounds" });
    return;
  }

  const cursor = { ownerId, x, y, color: cursorColorForOwner(ownerId) };
  if (showNickname) {
    const nickname = getGuestNickname(ownerId);
    if (nickname) cursor.nickname = nickname; // omitted entirely if this owner has never set one -- never a fabricated name
  }

  broadcastPixelEvent(roomId, "cursor", cursor);
  res.status(200).json({ ok: true });
}

// Persists one pixel-art draw gesture as a single append-only op, under the
// caller's own server-derived ownerId (never the request body -- there is no
// ownerId field in the body at all, identical to handleDraw's own contract).
// Shared by the Public pixel wall and every pixel-art Private studio; width/
// height are the only things that vary, resolved by the caller (never from
// anything a client could supply directly) before this runs.
function handlePixelDraw(req, res, roomId, width, height) {
  const { color, size, points } = req.body ?? {};

  if (typeof color !== "string" || !isValidBrushSize(size) || !pixelPointsValid(points, width, height)) {
    res.status(400).json({
      error:
        `a pixel draw op needs a color, an integer brush size ${MIN_BRUSH_SIZE}-${MAX_BRUSH_SIZE}, ` +
        `and at least one in-bounds integer {x, y} point`,
    });
    return;
  }

  const op = {
    id: randomUUID(),
    ownerId: getOrSetAnonId(req, res),
    kind: "draw",
    color,
    size,
    points,
    createdAt: Date.now(),
    roomId,
    docKind: "pixel",
  };
  const seq = insertOp(op);
  abandonRedoBranch(roomId, op.ownerId, "pixel");
  const persisted = { ...op, seq };
  // Broadcast only after the write has actually committed (insertOp above
  // already returned) -- a request that failed validation above never
  // reaches this line at all, so an invalid/rejected draw can never
  // broadcast. active: true is added for the broadcast only (not the HTTP
  // response below, whose shape predates this step and is left unchanged):
  // every op/undo/redo event this server sends carries the same explicit
  // active flag, so a subscriber never has to guess it from which event name
  // arrived.
  broadcastPixelEvent(roomId, "op", { ...persisted, active: true });
  res.status(201).json(persisted);
}

// Persists one pixel-art erase gesture, symmetric with handlePixelDraw. Erase
// shares the same integer brush-size semantics as draw (public/pixelgrid.js's
// PixelOp.size means the same thing for both kinds) -- unlike the legacy
// freehand erase route, there is no separate "radius" unit here. Ownership is
// enforced entirely by public/pixelgrid.js's replay (an erase only ever
// clears the erasing owner's own latest contribution at a cell); this route
// does no geometry or ownership comparison of its own, exactly like the
// legacy handleErase never has.
function handlePixelErase(req, res, roomId, width, height) {
  const { size, points } = req.body ?? {};

  if (!isValidBrushSize(size) || !pixelPointsValid(points, width, height)) {
    res.status(400).json({
      error: `a pixel erase op needs an integer brush size ${MIN_BRUSH_SIZE}-${MAX_BRUSH_SIZE} and at least one in-bounds integer {x, y} point`,
    });
    return;
  }

  const op = {
    id: randomUUID(),
    ownerId: getOrSetAnonId(req, res),
    kind: "erase",
    color: null,
    size,
    points,
    createdAt: Date.now(),
    roomId,
    docKind: "pixel",
  };
  const seq = insertOp(op);
  abandonRedoBranch(roomId, op.ownerId, "pixel");
  const persisted = { ...op, seq };
  broadcastPixelEvent(roomId, "op", { ...persisted, active: true });
  res.status(201).json(persisted);
}

app.get("/api/pixels", (req, res) => {
  res.json(listOps(null, "pixel"));
});

app.get("/api/pixels/stream", (req, res) => {
  startPixelStream(req, res, null, PUBLIC_PIXEL_WIDTH, PUBLIC_PIXEL_HEIGHT);
});

app.post("/api/pixels/draw", (req, res) => handlePixelDraw(req, res, null, PUBLIC_PIXEL_WIDTH, PUBLIC_PIXEL_HEIGHT));
app.post("/api/pixels/erase", (req, res) => handlePixelErase(req, res, null, PUBLIC_PIXEL_WIDTH, PUBLIC_PIXEL_HEIGHT));

app.post("/api/pixels/cursor", (req, res) =>
  handlePixelCursor(req, res, null, PUBLIC_PIXEL_WIDTH, PUBLIC_PIXEL_HEIGHT),
);

// undo/redo broadcast only when there was actually something to undo/redo --
// a no-op (op === null, nothing left) changes no state and so must never
// broadcast anything, exactly like an invalid draw/erase never does.
app.post("/api/pixels/undo", (req, res) => {
  const ownerId = getOrSetAnonId(req, res);
  const op = undoLatestOwnOp(null, ownerId, "pixel");
  if (op) broadcastPixelEvent(null, "undo", { ...op, active: false });
  res.status(200).json({ op });
});

app.post("/api/pixels/redo", (req, res) => {
  const ownerId = getOrSetAnonId(req, res);
  const op = redoLatestOwnOp(null, ownerId, "pixel");
  if (op) broadcastPixelEvent(null, "redo", { ...op, active: true });
  res.status(200).json({ op });
});

// Undo/redo for the Public Canvas. Same contract as the Private room routes
// below: an empty body -- no opId, ownerId, or roomId field anywhere in the
// request shape -- because there is nothing here for a client to choose.
// ownerId always comes from the same httpOnly anon cookie every draw/erase
// already trusts; the scope is always the Public scope (roomId = null),
// never anything from the request. The op actually affected is found
// entirely from authoritative DB state (undoLatestOwnOp/redoLatestOwnOp,
// server/db.js), scoped to exactly (null, ownerId), so one Public
// participant can never undo another's op, and this can never reach into any
// room's ops. A no-op (nothing left to undo/redo) is not an error: `op` is
// simply null, same status code either way.
app.post("/api/ops/undo", (req, res) => {
  const ownerId = getOrSetAnonId(req, res);
  res.status(200).json({ op: undoLatestOwnOp(null, ownerId, "freehand") });
});

app.post("/api/ops/redo", (req, res) => {
  const ownerId = getOrSetAnonId(req, res);
  res.status(200).json({ op: redoLatestOwnOp(null, ownerId, "freehand") });
});

// Room codes are generated uppercase (server/db.js); normalizing here means a
// code typed or linked in any case still resolves to the one canonical room.
function normalizeRoomCode(raw) {
  return String(raw).toUpperCase();
}

// Only this route ever inserts into `rooms`. No other room-scoped route
// creates one as a side effect of drawing, erasing, or reading. presenceId
// comes from the client (its page-load's crypto.randomUUID(), never
// localStorage/cookies) so the creator's very first presence lease lands in
// the SAME transaction as the room row (see createRoom, server/db.js) --
// there is no window where the room exists but nobody is present in it. A
// client that omits presenceId (the existing spec/rooms.test.ts helper, and
// any other caller that simply doesn't care about presence) still gets a
// working room: the server mints a throwaway id for that one row itself.
// ownerId is never read from the body -- always the same server-derived
// anon cookie every other route already trusts.
// presenceId behaves exactly as before. resolution is new and OPTIONAL: when
// omitted entirely, this creates a legacy freehand room exactly as it always
// has (width/height stay NULL) -- the C8 frontend never sends this field, so
// its existing "Create private room" flow is completely unaffected. When
// present, it must be one of the four supported pixel-art resolutions and
// creates a pixel-art studio fixed at that square resolution forever.
app.post("/api/rooms", (req, res) => {
  const { presenceId, resolution } = req.body ?? {};
  const ownerId = getOrSetAnonId(req, res);

  let width = null;
  let height = null;
  if (resolution !== undefined) {
    if (!PIXEL_RESOLUTIONS.includes(resolution)) {
      res.status(400).json({ error: `resolution must be one of ${PIXEL_RESOLUTIONS.join(", ")}` });
      return;
    }
    width = resolution;
    height = resolution;
  }

  const code = createRoom(
    typeof presenceId === "string" && presenceId.length > 0 ? presenceId : randomUUID(),
    ownerId,
    Date.now(),
    width,
    height,
  );
  res.status(201).json({ code, kind: width === null ? "legacy" : "pixel", width, height });
});

// Existence check only -- 404 for an unknown or expired code, and never
// creates one. getActiveRoom reconciles occupancy and physically deletes the
// room first if it has expired, so an expired code 404s exactly like a code
// that was never issued. kind/width/height are additive beyond the original
// {code}-only response -- room metadata distinguishing a pixel-art studio
// from a legacy freehand room, for whichever future frontend step needs it.
app.get("/api/rooms/:code", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const room = getActiveRoom(code);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  res.json({ code, kind: isPixelRoom(room) ? "pixel" : "legacy", width: room.width, height: room.height });
});

// Explicitly scoped to the freehand replay list, exactly like GET /api/ops
// above -- unchanged contract for the C8 frontend. A pixel-art room has no
// freehand ops at all, so this simply (and correctly) returns an empty list
// for one; see GET /api/rooms/:code/pixels below for the pixel equivalent.
app.get("/api/rooms/:code/ops", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!getActiveRoom(code)) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  res.json(listOps(code, "freehand"));
});

app.post("/api/rooms/:code/ops/draw", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const room = getActiveRoom(code);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  if (isPixelRoom(room)) {
    res.status(400).json({ error: "this room is a pixel-art studio; use /api/rooms/:code/pixels/draw" });
    return;
  }
  handleDraw(req, res, code);
});

app.post("/api/rooms/:code/ops/erase", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const room = getActiveRoom(code);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  if (isPixelRoom(room)) {
    res.status(400).json({ error: "this room is a pixel-art studio; use /api/rooms/:code/pixels/erase" });
    return;
  }
  handleErase(req, res, code);
});

// --- Pixel-art Private studios ----------------------------------------------
// Mirrors the Public pixel routes above, scoped to one room and validated
// against that room's own stored resolution instead of the fixed Public
// 512x288 grid. Gated exactly like the legacy routes above: an unknown or
// expired code 404s first (same getActiveRoom check every other room route
// uses), then a legacy (non-pixel) room is rejected with 400 rather than
// silently accepting freehand-shaped data reinterpreted as pixels.

app.get("/api/rooms/:code/pixels", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!getActiveRoom(code)) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  res.json(listOps(code, "pixel"));
});

app.get("/api/rooms/:code/pixels/stream", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const room = getActiveRoom(code);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  if (!isPixelRoom(room)) {
    res.status(400).json({ error: "this room is a legacy freehand room; it has no pixel stream" });
    return;
  }
  startPixelStream(req, res, code, room.width, room.height);
});

app.post("/api/rooms/:code/pixels/cursor", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const room = getActiveRoom(code);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  if (!isPixelRoom(room)) {
    res.status(400).json({ error: "this room is a legacy freehand room; it has no pixel cursors" });
    return;
  }
  handlePixelCursor(req, res, code, room.width, room.height);
});

app.post("/api/rooms/:code/pixels/draw", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const room = getActiveRoom(code);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  if (!isPixelRoom(room)) {
    res.status(400).json({ error: "this room is a legacy freehand room; use /api/rooms/:code/ops/draw" });
    return;
  }
  handlePixelDraw(req, res, code, room.width, room.height);
});

app.post("/api/rooms/:code/pixels/erase", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const room = getActiveRoom(code);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  if (!isPixelRoom(room)) {
    res.status(400).json({ error: "this room is a legacy freehand room; use /api/rooms/:code/ops/erase" });
    return;
  }
  handlePixelErase(req, res, code, room.width, room.height);
});

app.post("/api/rooms/:code/pixels/undo", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const room = getActiveRoom(code);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  if (!isPixelRoom(room)) {
    res.status(400).json({ error: "this room is a legacy freehand room; use /api/rooms/:code/undo" });
    return;
  }
  const ownerId = getOrSetAnonId(req, res);
  const op = undoLatestOwnOp(code, ownerId, "pixel");
  if (op) broadcastPixelEvent(code, "undo", { ...op, active: false });
  res.status(200).json({ op });
});

app.post("/api/rooms/:code/pixels/redo", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const room = getActiveRoom(code);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  if (!isPixelRoom(room)) {
    res.status(400).json({ error: "this room is a legacy freehand room; use /api/rooms/:code/redo" });
    return;
  }
  const ownerId = getOrSetAnonId(req, res);
  const op = redoLatestOwnOp(code, ownerId, "pixel");
  if (op) broadcastPixelEvent(code, "redo", { ...op, active: true });
  res.status(200).json({ op });
});

// Same contract as the Public /api/ops/undo and /api/ops/redo above, scoped
// to this room instead of the Public scope: roomId comes from the validated
// :code param (post-getActiveRoom, same 404 gate every other room route
// uses), never the request body, so one room can never reach into another
// room's or the Public Canvas's ops.
app.post("/api/rooms/:code/undo", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const room = getActiveRoom(code);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  if (isPixelRoom(room)) {
    res.status(400).json({ error: "this room is a pixel-art studio; use /api/rooms/:code/pixels/undo" });
    return;
  }
  const ownerId = getOrSetAnonId(req, res);
  res.status(200).json({ op: undoLatestOwnOp(code, ownerId, "freehand") });
});

app.post("/api/rooms/:code/redo", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const room = getActiveRoom(code);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  if (isPixelRoom(room)) {
    res.status(400).json({ error: "this room is a pixel-art studio; use /api/rooms/:code/pixels/redo" });
    return;
  }
  const ownerId = getOrSetAnonId(req, res);
  res.status(200).json({ op: redoLatestOwnOp(code, ownerId, "freehand") });
});

// Heartbeat: renews this one tab's presence lease. presenceId is the only
// identity the client supplies -- ownerId always comes from the server-
// derived anon cookie, never the body, so a client can never register a
// lease under someone else's ownerId. Drawing/erasing ops never call this:
// presence is renewed only by the dedicated 30s heartbeat (see
// public/app.js), never as a side effect of drawing. Same not-found
// semantics as every other room route if the room has expired.
app.post("/api/rooms/:code/presence", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const { presenceId } = req.body ?? {};
  if (typeof presenceId !== "string" || presenceId.length === 0) {
    res.status(400).json({ error: "presence requires a presenceId" });
    return;
  }
  const ownerId = getOrSetAnonId(req, res);
  const room = recordHeartbeat(code, presenceId, ownerId);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  res.status(200).json({ ok: true });
});

// Proactive leave: removes exactly this one tab's presence lease before it
// would otherwise go stale, so the room's occupancy (and, if this was the
// last lease, empty_since) reflects an explicit Leave immediately rather
// than only after STALE_TIMEOUT_MS. Optimization only -- the heartbeat
// lease expiring on its own is still the correctness fallback for a closed
// tab, a crash, or a lost network, none of which can call this. Scoped to
// exactly this presenceId, never to ownerId, so one tab leaving never
// affects another tab sharing the same browser/owner.
app.post("/api/rooms/:code/leave", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const { presenceId } = req.body ?? {};
  if (typeof presenceId !== "string" || presenceId.length === 0) {
    res.status(400).json({ error: "leave requires a presenceId" });
    return;
  }
  const room = leavePresence(code, presenceId);
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  res.status(200).json({ ok: true });
});

// Serves the exact same canvas shell express.static would have served at /,
// but only once the room is confirmed to exist -- an unknown or expired code
// gets a 404 instead of a working canvas, and nothing here ever creates a
// room.
app.get("/room/:code", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!getActiveRoom(code)) {
    res.status(404).type("html").send('<!doctype html>\n<meta charset="utf-8" />\n<p>No such room. <a href="/">Back to Public Canvas</a></p>');
    return;
  }
  res.sendFile(join(ROOT, "public", "index.html"));
});

// Serves README.md verbatim, HTML-escaped, so spec/invariants.test.ts can
// find its headings — same contract the placeholder Dockerfile shipped.
app.get("/readme/", (req, res) => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const escaped = readme
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  res.type("html").send(`<!doctype html>\n<meta charset="utf-8" />\n<pre>${escaped}</pre>`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on ${PORT}`);
});
