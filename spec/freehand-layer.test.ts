// HTTP contract for the new layerId field on freehand draw/erase ops --
// validation against the fixed per-canvas id list (server/index.js's
// normalizeLayerId), persistence, and backward compatibility for a request
// that omits it entirely (every pre-layer-system client). Same lightweight
// postDraw/postErase/getOps style as spec/ops.test.ts (Public) and
// spec/rooms.test.ts (Private room), not the SSE harness -- this is a plain
// request/response contract, no streaming involved.

import { expect, it } from "vitest";
import { inject } from "vitest";

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
  layerId: string | null;
};

async function postDraw(draw: Record<string, unknown>, cookie?: string) {
  const res = await fetch(new URL("/api/ops/draw", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(draw),
  });
  const body = await res.json();
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: body as Op, cookie: cookie ?? setCookie!.split(";")[0] };
}

async function postErase(erase: Record<string, unknown>, cookie?: string) {
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

async function createRoom(): Promise<string> {
  const res = await fetch(new URL("/api/rooms", baseUrl), { method: "POST" });
  const body = (await res.json()) as { code: string };
  expect(res.status).toBe(201);
  return body.code;
}

async function postRoomDraw(code: string, draw: Record<string, unknown>, cookie?: string) {
  const res = await fetch(new URL(`/api/rooms/${code}/ops/draw`, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(draw),
  });
  const body = await res.json();
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: body as Op, cookie: cookie ?? setCookie!.split(";")[0] };
}

it("a Public draw op with a valid layerId ('colour' or 'lineart') persists and round-trips it", async () => {
  const posted = await postDraw({
    color: "#1e88e5",
    width: 0.015,
    points: [{ x: 0.1, y: 0.1 }],
    layerId: "lineart",
  });
  expect(posted.status).toBe(201);
  expect(posted.body.layerId).toBe("lineart");

  const later = await getOps();
  expect(later.find((op) => op.id === posted.body.id)?.layerId).toBe("lineart");
});

it("a Public draw op with no layerId at all (a pre-layer-system client) persists with layerId: null", async () => {
  const posted = await postDraw({ color: "#1e88e5", width: 0.015, points: [{ x: 0.2, y: 0.2 }] });
  expect(posted.status).toBe(201);
  expect(posted.body.layerId).toBeNull();
});

it("a Public draw op with a layerId that isn't one of Public's own two ids is rejected with 400, and nothing is persisted", async () => {
  // An established cookie first: a rejected (400) request never reaches
  // getOrSetAnonId, so it never sets one of its own -- the same reason every
  // other 400-path test in this file passes an already-known cookie rather
  // than reading one off the rejected response itself.
  const { cookie } = await postDraw({ color: "#1e88e5", width: 0.015, points: [{ x: 0.25, y: 0.25 }] });
  // A specific, uniquely identifiable point rather than a raw array-length
  // comparison -- the Public Canvas ops table is shared across every spec
  // file running in this process, so a length diff could spuriously pass or
  // fail depending on unrelated concurrent activity; searching for this
  // exact marker point cannot be confused with anything another test posts.
  const marker = { x: 0.301234, y: 0.301234 };
  const posted = await postDraw(
    {
      color: "#1e88e5",
      width: 0.015,
      points: [marker],
      layerId: "layer1", // a Private-room-shaped id, never valid for Public
    },
    cookie,
  );
  expect(posted.status).toBe(400);

  const after = await getOps();
  expect(after.some((op) => op.points.some((p) => p.x === marker.x && p.y === marker.y))).toBe(false);
});

it("a Public erase op's layerId is validated and persisted the same way a draw op's is", async () => {
  const posted = await postErase({ radius: 0.02, points: [{ x: 0.4, y: 0.4 }], layerId: "colour" });
  expect(posted.status).toBe(201);
  expect(posted.body.layerId).toBe("colour");

  const invalid = await postErase({ radius: 0.02, points: [{ x: 0.4, y: 0.4 }], layerId: "bogus" }, posted.cookie);
  expect(invalid.status).toBe(400);
});

it("a Private Room draw op accepts its own 4 layer ids ('layer1'..'layer4'), not Public's", async () => {
  const code = await createRoom();
  const posted = await postRoomDraw(code, {
    color: "#43a047",
    width: 0.02,
    points: [{ x: 0.5, y: 0.5 }],
    layerId: "layer3",
  });
  expect(posted.status).toBe(201);
  expect(posted.body.layerId).toBe("layer3");

  // Public's own ids are not valid in a Private Room's scope.
  const rejected = await postRoomDraw(
    code,
    { color: "#43a047", width: 0.02, points: [{ x: 0.5, y: 0.5 }], layerId: "lineart" },
    posted.cookie,
  );
  expect(rejected.status).toBe(400);
});
