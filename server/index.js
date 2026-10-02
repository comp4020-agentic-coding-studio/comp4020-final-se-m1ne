import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrSetAnonId } from "./anon.js";
import {
  abandonRedoBranch,
  createRoom,
  insertOp,
  listOps,
  redoLatestOwnOp,
  roomExists,
  undoLatestOwnOp,
} from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = process.env.PORT ?? 8080;

const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, "public")));

app.get("/api/ops", (req, res) => {
  res.json(listOps(null));
});

// Tells the caller its own anon_id. This doesn't weaken the cookie's
// httpOnly ownership enforcement -- the server never trusts anything the
// client claims about ownership -- it just lets the client group ops into
// "my layer" vs "everyone else's layer" for rendering, the same distinction
// the server already makes by stamping every posted op with this same id.
// The cookie is Path=/, so the same anon_id already applies in every room --
// no room-scoped identity is introduced.
app.get("/api/me", (req, res) => {
  res.json({ ownerId: getOrSetAnonId(req, res) });
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
  };
  const seq = insertOp(op);
  // A fresh edit abandons this owner's own remaining redo branch in this
  // scope (conventional editor behaviour: undo, undo, then draw something new
  // means the undone-but-not-yet-redone step is gone for good). Runs for
  // Public (roomId null) exactly the same as for a room -- abandonRedoBranch
  // scopes by `room_id IS ?`, so this can never reach into a different scope.
  abandonRedoBranch(roomId, op.ownerId);
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
  };
  const seq = insertOp(op);
  // See the matching comment in handleDraw: a fresh edit abandons this
  // owner's own remaining redo branch in this scope, Public and room alike.
  abandonRedoBranch(roomId, op.ownerId);
  res.status(201).json({ ...op, seq });
}

app.post("/api/ops/draw", (req, res) => handleDraw(req, res, null));
app.post("/api/ops/erase", (req, res) => handleErase(req, res, null));

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
  res.status(200).json({ op: undoLatestOwnOp(null, ownerId) });
});

app.post("/api/ops/redo", (req, res) => {
  const ownerId = getOrSetAnonId(req, res);
  res.status(200).json({ op: redoLatestOwnOp(null, ownerId) });
});

// Room codes are generated uppercase (server/db.js); normalizing here means a
// code typed or linked in any case still resolves to the one canonical room.
function normalizeRoomCode(raw) {
  return String(raw).toUpperCase();
}

// Only this route ever inserts into `rooms`. No other room-scoped route
// creates one as a side effect of drawing, erasing, or reading.
app.post("/api/rooms", (req, res) => {
  const code = createRoom();
  res.status(201).json({ code });
});

// Existence check only -- 404 for an unknown code, and never creates one.
app.get("/api/rooms/:code", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!roomExists(code)) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  res.json({ code });
});

app.get("/api/rooms/:code/ops", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!roomExists(code)) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  res.json(listOps(code));
});

app.post("/api/rooms/:code/ops/draw", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!roomExists(code)) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  handleDraw(req, res, code);
});

app.post("/api/rooms/:code/ops/erase", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!roomExists(code)) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  handleErase(req, res, code);
});

// Same contract as the Public /api/ops/undo and /api/ops/redo above, scoped
// to this room instead of the Public scope: roomId comes from the validated
// :code param (post-roomExists, same 404 gate every other room route uses),
// never the request body, so one room can never reach into another room's or
// the Public Canvas's ops.
app.post("/api/rooms/:code/undo", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!roomExists(code)) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  const ownerId = getOrSetAnonId(req, res);
  res.status(200).json({ op: undoLatestOwnOp(code, ownerId) });
});

app.post("/api/rooms/:code/redo", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!roomExists(code)) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  const ownerId = getOrSetAnonId(req, res);
  res.status(200).json({ op: redoLatestOwnOp(code, ownerId) });
});

// Serves the exact same canvas shell express.static would have served at /,
// but only once the room is confirmed to exist -- an unknown code gets a 404
// instead of a working canvas, and nothing here ever creates a room.
app.get("/room/:code", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!roomExists(code)) {
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
