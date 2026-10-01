import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

type Stroke = {
  id: string;
  ownerId: string;
  color: string;
  width: number;
  points: { x: number; y: number }[];
  createdAt: number;
};

async function postStroke(stroke: { color: string; width: number; points: { x: number; y: number }[] }) {
  const res = await fetch(new URL("/api/strokes", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stroke),
  });
  const body = await res.json();
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  return { id: body.id as string, cookie };
}

// A client sends one erase request per animation frame carrying the whole
// path accumulated since the last one, not one request per raw pointer
// sample -- see server/index.js. `postErase` takes the two-endpoint shape
// most tests need; `postEraseAlongPath` exposes the general multi-point form.
async function postEraseAlongPath(path: { x: number; y: number }[], radius: number, cookie?: string) {
  const res = await fetch(new URL("/api/erase", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ path, radius }),
  });
  return res.json() as Promise<{ removedStrokeIds: string[]; fragments: Stroke[] }>;
}

async function postErase(
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
  cookie?: string,
) {
  return postEraseAlongPath([from, to], radius, cookie);
}

function getStrokes(cookie?: string) {
  return fetch(new URL("/api/strokes", baseUrl), {
    headers: cookie ? { Cookie: cookie } : {},
  }).then((r) => r.json() as Promise<Stroke[]>);
}

// The eraser must genuinely cut geometry, not delete whole strokes: passing
// a small eraser circle over the middle of a straight stroke should remove
// only the intersected sub-segment and leave two surviving fragments whose
// endpoints sit exactly on the circle's boundary -- not just "two fragments
// exist somewhere". A second, larger pass over a single-point stroke checks
// the other end of the same code path: full consumption down to zero
// fragments, which must also persist.
it("partially erasing a stroke splits it into fragments with precise boundary endpoints, and persists", async () => {
  const width = 0.02; // half-width 0.01
  const { id, cookie } = await postStroke({
    color: "#1e88e5",
    width,
    points: [
      { x: 0.1, y: 0.5 },
      { x: 0.9, y: 0.5 },
    ],
  });

  // effective radius = eraser radius (0.04) + half the stroke width (0.01) = 0.05
  const erased = await postErase({ x: 0.3, y: 0.5 }, { x: 0.3, y: 0.5 }, 0.04, cookie);

  expect(erased.removedStrokeIds).toEqual([id]);
  expect(erased.fragments).toHaveLength(2);

  const [left, right] = [...erased.fragments].sort((a, b) => a.points[0].x - b.points[0].x);

  expect(left.color).toBe("#1e88e5");
  expect(left.width).toBe(width);
  expect(left.points).toHaveLength(2);
  expect(left.points[0].x).toBeCloseTo(0.1, 5);
  expect(left.points[0].y).toBeCloseTo(0.5, 5);
  expect(left.points[1].x).toBeCloseTo(0.25, 5); // 0.3 - 0.05
  expect(left.points[1].y).toBeCloseTo(0.5, 5);

  expect(right.color).toBe("#1e88e5");
  expect(right.width).toBe(width);
  expect(right.points).toHaveLength(2);
  expect(right.points[0].x).toBeCloseTo(0.35, 5); // 0.3 + 0.05
  expect(right.points[0].y).toBeCloseTo(0.5, 5);
  expect(right.points[1].x).toBeCloseTo(0.9, 5);
  expect(right.points[1].y).toBeCloseTo(0.5, 5);

  const afterPartial = await getStrokes(cookie);
  expect(afterPartial.some((s) => s.id === id)).toBe(false);
  expect(afterPartial.some((s) => s.id === left.id)).toBe(true);
  expect(afterPartial.some((s) => s.id === right.id)).toBe(true);

  // Fully consuming a stroke (a tap, erased by a wide pass dead-center)
  // must leave zero fragments, and that removal must persist too.
  const { id: tapId, cookie: tapCookie } = await postStroke({
    color: "#43a047",
    width: 0.01,
    points: [{ x: 0.6, y: 0.6 }],
  });
  const fullyErased = await postErase({ x: 0.6, y: 0.6 }, { x: 0.6, y: 0.6 }, 0.1, tapCookie);
  expect(fullyErased.removedStrokeIds).toEqual([tapId]);
  expect(fullyErased.fragments).toEqual([]);

  const afterFull = await getStrokes(tapCookie);
  expect(afterFull.some((s) => s.id === tapId)).toBe(false);
});

// Ownership is enforced by only ever reading and writing the caller's own
// strokes (scoped by the anon_id cookie), never by trusting a stroke id the
// client sends: a stranger's erase pass directly over someone else's stroke
// must be a complete no-op, leaving that stroke byte-for-byte unchanged.
it("erasing only ever affects the caller's own strokes, never another participant's", async () => {
  const original = {
    color: "#e53935",
    width: 0.02,
    points: [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
    ],
  };
  const { id, cookie: ownerCookie } = await postStroke(original);

  // No cookie sent: a different anonymous participant, directly over the owner's stroke.
  const strangerErase = await postErase({ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.2 }, 0.1);
  expect(strangerErase.removedStrokeIds).toEqual([]);
  expect(strangerErase.fragments).toEqual([]);

  const strokesAfter = await getStrokes(ownerCookie);
  const stillThere = strokesAfter.find((s) => s.id === id);
  expect(stillThere).toBeTruthy();
  expect(stillThere).toEqual({
    id,
    ownerId: stillThere!.ownerId,
    color: original.color,
    width: original.width,
    points: original.points,
    createdAt: stillThere!.createdAt,
  });
});

// A single erase request now carries a whole frame's accumulated path, which
// can have more than two points (more than one swept segment). Every
// consecutive pair must contribute, not just the first -- a second segment
// that reaches further than the first must still take effect, chaining
// through the fragments the first segment already produced.
it("a single request erases along every segment of a multi-point path, not just the first", async () => {
  const width = 0.02; // half-width 0.01
  const { id, cookie } = await postStroke({
    color: "#8e24aa",
    width,
    points: [
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
    ],
  });

  // effective radius = eraser radius (0.02) + half the stroke width (0.01) = 0.03
  // segment 1: 0.3 -> 0.5, covers [0.27, 0.53]
  // segment 2: 0.5 -> 0.7, covers [0.47, 0.73]
  // combined (continuous) sweep removes [0.27, 0.73]; a buggy implementation
  // that only applied the first segment would instead leave [0.53, 1] intact.
  const erased = await postEraseAlongPath(
    [
      { x: 0.3, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.7, y: 0.5 },
    ],
    0.02,
    cookie,
  );

  expect(erased.removedStrokeIds).toEqual([id]);
  expect(erased.fragments).toHaveLength(2);

  const [left, right] = [...erased.fragments].sort((a, b) => a.points[0].x - b.points[0].x);

  expect(left.points).toHaveLength(2);
  expect(left.points[0].x).toBeCloseTo(0, 5);
  expect(left.points[1].x).toBeCloseTo(0.27, 5);

  expect(right.points).toHaveLength(2);
  expect(right.points[0].x).toBeCloseTo(0.73, 5);
  expect(right.points[1].x).toBeCloseTo(1, 5);

  const after = await getStrokes(cookie);
  expect(after.some((s) => s.id === id)).toBe(false);
  expect(after.some((s) => s.id === left.id)).toBe(true);
  expect(after.some((s) => s.id === right.id)).toBe(true);
});
