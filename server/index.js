import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrSetAnonId } from "./anon.js";
import { getStrokesByOwner, insertStroke, listStrokes, replaceStroke } from "./db.js";
import {
  boundingBoxesIntersectWithMargin,
  effectiveRadius,
  eraseFromPolyline,
  segmentBoundingBox,
  strokeBoundingBox,
} from "../public/geometry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = process.env.PORT ?? 8080;

const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, "public")));

app.get("/api/strokes", (req, res) => {
  res.json(listStrokes());
});

// Tells the caller its own anon_id. This doesn't weaken the cookie's
// httpOnly ownership enforcement -- the server never trusts anything the
// client claims about ownership -- it just lets the client's eraser preview
// tell "my strokes" apart from everyone else's, the same distinction the
// server already makes for every erase request.
app.get("/api/me", (req, res) => {
  res.json({ ownerId: getOrSetAnonId(req, res) });
});

app.post("/api/strokes", (req, res) => {
  const { color, width, points } = req.body ?? {};
  const pointsValid =
    Array.isArray(points) &&
    points.length > 0 &&
    points.every((p) => p && typeof p.x === "number" && typeof p.y === "number");
  const widthValid = typeof width === "number" && Number.isFinite(width) && width > 0;

  if (typeof color !== "string" || !widthValid || !pointsValid) {
    res
      .status(400)
      .json({ error: "a stroke needs a color, a positive width, and at least one {x, y} point" });
    return;
  }

  const stroke = {
    id: randomUUID(),
    ownerId: getOrSetAnonId(req, res),
    color,
    width,
    points,
    createdAt: Date.now(),
  };
  insertStroke(stroke);
  res.status(201).json(stroke);
});

function isPoint(value) {
  return value && typeof value.x === "number" && typeof value.y === "number";
}

// A client drags the eraser continuously; rather than one request per raw
// pointer sample, the whole path accumulated since the last animation frame
// is sent as one request (a single point repeated twice represents the very
// first sample: a circle at one point, from === to). Each consecutive pair
// in the path is applied in order against the caller's own strokes, chaining
// through whatever fragments the previous pair in the *same* request already
// produced -- so a stroke split by an earlier segment is correctly re-tested
// against later segments using its current geometry, not its pre-request
// shape. A stroke touched anywhere in the path is persisted exactly once,
// via its original (pre-request) id, even if it ends up fully consumed.
// Ownership is enforced by only ever reading and writing this caller's own
// strokes, not by trusting anything the client claims about stroke ids.
app.post("/api/erase", (req, res) => {
  const { path, radius } = req.body ?? {};
  const pathValid = Array.isArray(path) && path.length >= 2 && path.every(isPoint);
  const radiusValid = typeof radius === "number" && Number.isFinite(radius) && radius > 0;

  if (!pathValid || !radiusValid) {
    res.status(400).json({ error: "erase needs a path of at least two {x, y} points and a positive radius" });
    return;
  }

  const ownerId = getOrSetAnonId(req, res);
  const touchedOriginalIds = new Set();
  let working = getStrokesByOwner(ownerId).map((stroke) => ({ ...stroke, originalId: stroke.id }));

  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    const segmentBox = segmentBoundingBox(from, to);
    const next = [];

    for (const stroke of working) {
      const radiusForStroke = effectiveRadius(radius, stroke.width);
      const strokeBox = (stroke._bbox ??= strokeBoundingBox(stroke.points));
      if (!boundingBoxesIntersectWithMargin(strokeBox, segmentBox, radiusForStroke)) {
        next.push(stroke);
        continue;
      }

      const result = eraseFromPolyline(stroke.points, from, to, radiusForStroke);
      if (!result.changed) {
        next.push(stroke);
        continue;
      }

      touchedOriginalIds.add(stroke.originalId);
      for (const points of result.fragments) {
        next.push({
          id: randomUUID(),
          ownerId: stroke.ownerId,
          color: stroke.color,
          width: stroke.width,
          points,
          createdAt: stroke.createdAt,
          originalId: stroke.originalId,
        });
      }
    }
    working = next;
  }

  const fragmentsByOriginal = new Map();
  for (const id of touchedOriginalIds) fragmentsByOriginal.set(id, []);
  for (const stroke of working) {
    if (fragmentsByOriginal.has(stroke.originalId)) fragmentsByOriginal.get(stroke.originalId).push(stroke);
  }

  const removedStrokeIds = [];
  const fragments = [];
  for (const [originalId, frags] of fragmentsByOriginal) {
    const persisted = frags.map(({ id, ownerId, color, width, points, createdAt }) => ({
      id,
      ownerId,
      color,
      width,
      points,
      createdAt,
    }));
    replaceStroke(originalId, persisted);
    removedStrokeIds.push(originalId);
    fragments.push(...persisted);
  }

  res.json({ removedStrokeIds, fragments });
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
