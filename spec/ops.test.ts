import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

type Op = {
  seq: number;
  id: string;
  ownerId: string;
  kind: "draw" | "erase";
  color: string | null;
  size: number;
  points: { x: number; y: number }[];
  createdAt: number;
};

async function postDraw(draw: { color: string; width: number; points: { x: number; y: number }[] }, cookie?: string) {
  const res = await fetch(new URL("/api/ops/draw", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(draw),
  });
  const body = await res.json();
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: body as Op, cookie: cookie ?? setCookie!.split(";")[0] };
}

async function postErase(erase: { radius: number; points: { x: number; y: number }[] }, cookie?: string) {
  const res = await fetch(new URL("/api/ops/erase", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(erase),
  });
  const body = await res.json();
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: body as Op, cookie: cookie ?? setCookie!.split(";")[0] };
}

function getOps() {
  return fetch(new URL("/api/ops", baseUrl)).then((r) => r.json() as Promise<Op[]>);
}

// The append-only replacement for the old destructive fragmentation model:
// a draw op is stored and replayed exactly as posted, never rewritten.
it("a posted draw op, including its width, is visible to a later, independent request", async () => {
  const draw = {
    color: "#1e88e5",
    width: 0.015,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.2 },
    ],
  };
  const posted = await postDraw(draw);
  expect(posted.status).toBe(201);
  expect(posted.body.kind).toBe("draw");
  expect(posted.body.size).toBe(draw.width);

  const later = await getOps();
  const found = later.find((op) => op.id === posted.body.id);
  expect(found).toBeTruthy();
  expect(found!.kind).toBe("draw");
  expect(found!.color).toBe(draw.color);
  expect(found!.size).toBe(draw.width);
  expect(found!.points).toEqual(draw.points);
});

// Symmetric with draw: an erase op is just another append-only op (no
// color, a radius-derived size, nothing read or rewritten server-side) and
// it persists and replays exactly like one.
it("a posted erase op, including its radius, is visible to a later, independent request", async () => {
  const erase = {
    radius: 0.04,
    points: [
      { x: 0.3, y: 0.5 },
      { x: 0.4, y: 0.5 },
    ],
  };
  const posted = await postErase(erase);
  expect(posted.status).toBe(201);
  expect(posted.body.kind).toBe("erase");
  expect(posted.body.color).toBeNull();
  expect(posted.body.size).toBe(erase.radius * 2);

  const later = await getOps();
  const found = later.find((op) => op.id === posted.body.id);
  expect(found).toBeTruthy();
  expect(found!.kind).toBe("erase");
  expect(found!.points).toEqual(erase.points);
});

// Deterministic ordering is the whole point of the `seq` column: draw and
// erase are not commutative for the same owner (draw-then-erase and
// erase-then-draw can leave different pixels), so replay order must be
// fixed by the server at the moment each op is actually inserted -- not by
// which HTTP request happens to arrive first. Posting several ops back to
// back must yield strictly increasing seq values in exactly posting order,
// and GET /api/ops must always return them in that same seq order.
it("operation ordering is deterministic: seq strictly increases in actual insert order and replay matches it", async () => {
  const { cookie } = await postDraw({ color: "#000000", width: 0.01, points: [{ x: 0.05, y: 0.05 }] });
  const a = await postDraw({ color: "#111111", width: 0.01, points: [{ x: 0.06, y: 0.06 }] }, cookie);
  const b = await postErase({ radius: 0.02, points: [{ x: 0.07, y: 0.07 }] }, cookie);
  const c = await postDraw({ color: "#222222", width: 0.01, points: [{ x: 0.08, y: 0.08 }] }, cookie);

  expect(a.body.seq).toBeLessThan(b.body.seq);
  expect(b.body.seq).toBeLessThan(c.body.seq);

  const all = await getOps();
  const seqs = all.map((op) => op.seq);
  const sorted = [...seqs].sort((x, y) => x - y);
  expect(seqs).toEqual(sorted); // already in seq order, as returned

  const ids = all.map((op) => op.id);
  const ai = ids.indexOf(a.body.id);
  const bi = ids.indexOf(b.body.id);
  const ci = ids.indexOf(c.body.id);
  expect(ai).toBeLessThan(bi);
  expect(bi).toBeLessThan(ci);
});

// Ownership is enforced by stamping every op with a server-derived owner id
// (from the httpOnly anon cookie) that the client never supplies and so can
// never spoof -- there is no ownerId field anywhere in either request body.
// Under the per-owner-raster-layer rendering model this is what makes
// cross-owner erasure structurally impossible: an erase op is always
// attributed to its real caller, so it can only ever be replayed onto that
// caller's own layer. At the API level, the observable guarantee is that no
// erase request -- regardless of whose artwork its path overlaps -- ever
// reads, modifies, or removes any other owner's existing op row.
it("erasing never reads, modifies, or removes another owner's draw op, regardless of path overlap", async () => {
  const original = {
    color: "#e53935",
    width: 0.02,
    points: [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
    ],
  };
  const { body: ownerDraw } = await postDraw(original);

  // No cookie sent: a different anonymous participant, erasing directly over
  // the owner's stroke.
  const stranger = await postErase({ radius: 0.5, points: [{ x: 0.5, y: 0.2 }] });
  expect(stranger.status).toBe(201);
  expect(stranger.body.ownerId).not.toBe(ownerDraw.ownerId);

  const after = await getOps();
  const stillThere = after.find((op) => op.id === ownerDraw.id);
  expect(stillThere).toEqual(ownerDraw);
});

// "Partial-width erasing" is a rendering-architecture property (see
// public/app.js: destination-out stroking a raster layer), not something
// the server computes -- there is no server-side geometry at all to test
// here. What the model-level contract still must guarantee is that an
// erase op's size is recorded independently of any draw op's width, with
// no width-aware trimming or clamping -- the structural precondition for
// the eraser to be able to shave only part of a thick stroke's width, which
// a capsule-radius model (effectiveRadius = eraserRadius + strokeWidth / 2)
// could not do without erasing the stroke's full cross-section. Genuine
// pixel-level verification belongs to the manual test plan, not here.
it("an erase op's size is stored independently of any draw op's width (no width-aware trimming)", async () => {
  const thick = await postDraw({
    color: "#43a047",
    width: 0.1,
    points: [
      { x: 0.1, y: 0.5 },
      { x: 0.9, y: 0.5 },
    ],
  });
  const narrowErase = await postErase(
    { radius: 0.01, points: [{ x: 0.5, y: 0.47 }] }, // smaller than the stroke's half-width, touching only one edge
    thick.cookie,
  );
  expect(narrowErase.body.size).toBe(0.02);

  const after = await getOps();
  const drawStillIntact = after.find((op) => op.id === thick.body.id);
  expect(drawStillIntact).toEqual(thick.body); // the draw op itself is never rewritten or trimmed
});

// Refresh must reproduce the same picture: two independent GETs of the full
// history return byte-for-byte identical, identically-ordered op lists --
// the server holds no per-request state, so replay is a pure function of
// what's been persisted.
it("refresh reproduces the same operation history", async () => {
  await postDraw({ color: "#8e24aa", width: 0.02, points: [{ x: 0.33, y: 0.33 }] });
  const first = await getOps();
  const second = await getOps();
  expect(second).toEqual(first);
});
