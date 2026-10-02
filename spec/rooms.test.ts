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

// The one alphabet randomRoomCode() draws from (server/db.js): no 0/O, 1/I/L,
// so a generated code can never be mistaken for a different one by eye.
const ROOM_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

async function createRoom(): Promise<string> {
  const res = await fetch(new URL("/api/rooms", baseUrl), { method: "POST" });
  const body = (await res.json()) as { code: string };
  expect(res.status).toBe(201);
  return body.code;
}

function getRoom(code: string) {
  return fetch(new URL(`/api/rooms/${code}`, baseUrl));
}

function getRoomOps(code: string) {
  return fetch(new URL(`/api/rooms/${code}/ops`, baseUrl)).then((r) => r.json() as Promise<Op[]>);
}

function getRoomPage(code: string) {
  return fetch(new URL(`/room/${code}`, baseUrl));
}

async function postRoomDraw(
  code: string,
  draw: { color: string; width: number; points: { x: number; y: number }[] } & Record<string, unknown>,
  cookie?: string,
) {
  const res = await fetch(new URL(`/api/rooms/${code}/ops/draw`, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(draw),
  });
  const body = await res.json();
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: body as Op, cookie: cookie ?? setCookie!.split(";")[0] };
}

async function postRoomErase(
  code: string,
  erase: { radius: number; points: { x: number; y: number }[] },
  cookie?: string,
) {
  const res = await fetch(new URL(`/api/rooms/${code}/ops/erase`, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(erase),
  });
  const body = await res.json();
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: body as Op, cookie: cookie ?? setCookie!.split(";")[0] };
}

function getPublicOps() {
  return fetch(new URL("/api/ops", baseUrl)).then((r) => r.json() as Promise<Op[]>);
}

async function postPublicDraw(draw: { color: string; width: number; points: { x: number; y: number }[] }) {
  const res = await fetch(new URL("/api/ops/draw", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draw),
  });
  return (await res.json()) as Op;
}

it("a created room's code is a 6-character string drawn from the unambiguous alphabet", async () => {
  const code = await createRoom();
  expect(code).toMatch(ROOM_CODE_PATTERN);
});

it("two created rooms are distinct", async () => {
  const a = await createRoom();
  const b = await createRoom();
  expect(a).not.toBe(b);
});

it("GET /api/rooms/:code for an unknown code returns 404 and never creates the room", async () => {
  const res = await getRoom("ZZZZZZ");
  expect(res.status).toBe(404);
  // Confirming non-creation this way (not just asserting 404 once) matters
  // because GET must never have a creating side effect -- a second GET must
  // still 404, not suddenly succeed because the first GET implicitly made it.
  const again = await getRoom("ZZZZZZ");
  expect(again.status).toBe(404);
});

it("GET /api/rooms/:code/ops and POST draw/erase for an unknown room all return 404", async () => {
  const rawOps = await fetch(new URL("/api/rooms/NOPE42/ops", baseUrl));
  expect(rawOps.status).toBe(404);

  const drawRes = await fetch(new URL("/api/rooms/NOPE42/ops/draw", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ color: "#000000", width: 0.01, points: [{ x: 0.1, y: 0.1 }] }),
  });
  expect(drawRes.status).toBe(404);

  const eraseRes = await fetch(new URL("/api/rooms/NOPE42/ops/erase", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ radius: 0.02, points: [{ x: 0.1, y: 0.1 }] }),
  });
  expect(eraseRes.status).toBe(404);
});

it("GET /room/:code for an unknown code returns 404 and never serves the canvas shell", async () => {
  const res = await getRoomPage("BADCOD");
  expect(res.status).toBe(404);
  const body = await res.text();
  expect(body).not.toContain('id="canvas"');

  // No implicit creation: the API still reports this code as unknown afterward.
  const after = await getRoom("BADCOD");
  expect(after.status).toBe(404);
});

it("GET /room/:code for a real room serves the shared canvas shell", async () => {
  const code = await createRoom();
  const res = await getRoomPage(code);
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('id="canvas"');
});

it("a room's posted op persists across repeated, independent GETs (same-room persistence)", async () => {
  const code = await createRoom();
  const draw = { color: "#1e88e5", width: 0.015, points: [{ x: 0.2, y: 0.2 }] };
  const posted = await postRoomDraw(code, draw);
  expect(posted.status).toBe(201);

  const first = await getRoomOps(code);
  const second = await getRoomOps(code);
  expect(second).toEqual(first);
  expect(first.find((op) => op.id === posted.body.id)).toBeTruthy();
});

it("two rooms are isolated from each other: an op posted in room A never appears in room B's ops", async () => {
  const roomA = await createRoom();
  const roomB = await createRoom();
  const posted = await postRoomDraw(roomA, { color: "#e53935", width: 0.02, points: [{ x: 0.3, y: 0.3 }] });

  const opsA = await getRoomOps(roomA);
  const opsB = await getRoomOps(roomB);
  expect(opsA.find((op) => op.id === posted.body.id)).toBeTruthy();
  expect(opsB.find((op) => op.id === posted.body.id)).toBeFalsy();
});

it("Public Canvas and a Private Room are isolated in both directions", async () => {
  const code = await createRoom();
  const publicOp = await postPublicDraw({ color: "#43a047", width: 0.02, points: [{ x: 0.4, y: 0.4 }] });
  const roomOp = await postRoomDraw(code, { color: "#fdd835", width: 0.02, points: [{ x: 0.5, y: 0.5 }] });

  const publicOps = await getPublicOps();
  const roomOps = await getRoomOps(code);

  expect(publicOps.find((op) => op.id === roomOp.body.id)).toBeFalsy();
  expect(roomOps.find((op) => op.id === publicOp.id)).toBeFalsy();
  expect(publicOps.find((op) => op.id === publicOp.id)).toBeTruthy();
  expect(roomOps.find((op) => op.id === roomOp.body.id)).toBeTruthy();
});

it("a room's op history is stably ordered across repeated GETs", async () => {
  const code = await createRoom();
  const { cookie } = await postRoomDraw(code, { color: "#000000", width: 0.01, points: [{ x: 0.1, y: 0.1 }] });
  await postRoomDraw(code, { color: "#111111", width: 0.01, points: [{ x: 0.2, y: 0.2 }] }, cookie);
  await postRoomErase(code, { radius: 0.02, points: [{ x: 0.3, y: 0.3 }] }, cookie);

  const first = await getRoomOps(code);
  const second = await getRoomOps(code);
  expect(second).toEqual(first);
  const seqs = first.map((op) => op.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
});

// Mirrors ops.test.ts's "client-supplied createdAt is ignored" contract, but
// for ownerId: there is no ownerId field accepted in either request body at
// all (handleDraw/handleErase, shared by Public and every room, only ever
// read color/width/points or radius/points), so a client attempting to
// smuggle one in has no server path that reads it -- ownerId always comes
// from the caller's own httpOnly anon cookie.
it("a room draw op's owner identity is always server-assigned, never client-suppliable, even if the client tries", async () => {
  const code = await createRoom();
  const posted = await postRoomDraw(code, {
    color: "#3949ab",
    width: 0.02,
    points: [{ x: 0.15, y: 0.15 }],
    ownerId: "someone-else-entirely", // not a real field; must be silently ignored, not honored
  });
  expect(posted.status).toBe(201);
  expect(posted.body.ownerId).not.toBe("someone-else-entirely");
  expect(typeof posted.body.ownerId).toBe("string");
  expect(posted.body.ownerId.length).toBeGreaterThan(0);
});

// The real contract correction (#4): proving owner-only erase is NOT "Owner
// A's draw row still exists after Owner B erases nearby" (true of any
// append-only store regardless of ownership enforcement). Instead this
// mirrors ops.test.ts's strongest applicable Public contract, scoped to one
// room: two distinct, server-assigned owners posting in the very same room
// remain distinct in the room's replay data, Owner B's erase op is
// attributed to Owner B (never to Owner A, and never requested to be), and
// Owner A's own draw op row is completely unmodified by it -- not just
// "still present", but byte-for-byte equal to what Owner A originally posted.
it("in the same room, two distinct owners remain distinct, and one owner's erase never attributes to or modifies another owner's draw op", async () => {
  const code = await createRoom();
  const ownerADraw = {
    color: "#8e24aa",
    width: 0.02,
    points: [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
    ],
  };
  const a = await postRoomDraw(code, ownerADraw); // owner A: fresh cookie jar (none sent)
  const bErase = await postRoomErase(code, { radius: 0.5, points: [{ x: 0.5, y: 0.2 }] }); // owner B: separate fresh cookie jar

  expect(a.body.ownerId).not.toBe(bErase.body.ownerId); // two distinct server-assigned owners in one room
  expect(bErase.body.ownerId).not.toBe(""); // and B's erase is attributed to B, not left blank or defaulted to A

  const roomOps = await getRoomOps(code);
  const aRow = roomOps.find((op) => op.id === a.body.id);
  const bRow = roomOps.find((op) => op.id === bErase.body.id);

  expect(aRow).toEqual(a.body); // A's draw row is byte-for-byte unchanged by B's erase
  expect(aRow!.ownerId).toBe(a.body.ownerId);
  expect(bRow!.ownerId).toBe(bErase.body.ownerId);
  expect(bRow!.ownerId).not.toBe(aRow!.ownerId); // replay data keeps A and B distinct, not merged or reattributed
});
