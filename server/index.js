import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrSetAnonId } from "./anon.js";
import { insertOp, listOps } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = process.env.PORT ?? 8080;

const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, "public")));

app.get("/api/ops", (req, res) => {
  res.json(listOps());
});

// Tells the caller its own anon_id. This doesn't weaken the cookie's
// httpOnly ownership enforcement -- the server never trusts anything the
// client claims about ownership -- it just lets the client group ops into
// "my layer" vs "everyone else's layer" for rendering, the same distinction
// the server already makes by stamping every posted op with this same id.
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
// for a client to spoof.
app.post("/api/ops/draw", (req, res) => {
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
  };
  const seq = insertOp(op);
  res.status(201).json({ ...op, seq });
});

// Persists one eraser gesture's full dragged path as a single append-only
// op, under the caller's own server-derived ownerId. Nothing is read,
// matched, or deleted here -- there is no stroke geometry to intersect
// against. An owner's erase op is only ever replayed (client-side, see
// public/app.js) onto that same owner's own raster layer, so there is no
// code path, here or in the renderer, by which one owner's erase could ever
// touch another owner's pixels.
app.post("/api/ops/erase", (req, res) => {
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
  };
  const seq = insertOp(op);
  res.status(201).json({ ...op, seq });
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
