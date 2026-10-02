import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrSetAnonId } from "./anon.js";
import { createRoom, insertOp, listOps, roomExists } from "./db.js";

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
  res.status(201).json({ ...op, seq });
}

app.post("/api/ops/draw", (req, res) => handleDraw(req, res, null));
app.post("/api/ops/erase", (req, res) => handleErase(req, res, null));

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
