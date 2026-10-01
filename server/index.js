import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrSetAnonId } from "./anon.js";
import { insertStroke, listStrokes } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = process.env.PORT ?? 8080;

const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, "public")));

app.get("/api/strokes", (req, res) => {
  res.json(listStrokes());
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
