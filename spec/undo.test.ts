import { expect, inject, it } from "vitest";
import { fadeOpacity } from "../public/fade.js";

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

async function createRoom(): Promise<string> {
  const res = await fetch(new URL("/api/rooms", baseUrl), { method: "POST" });
  const body = (await res.json()) as { code: string };
  return body.code;
}

function getRoomOps(code: string) {
  return fetch(new URL(`/api/rooms/${code}/ops`, baseUrl)).then((r) => r.json() as Promise<Op[]>);
}

async function postRoomDraw(
  code: string,
  draw: { color: string; width: number; points: { x: number; y: number }[] },
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

async function postRoomUndo(code: string, cookie?: string) {
  const res = await fetch(new URL(`/api/rooms/${code}/undo`, baseUrl), {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
  });
  const body = (await res.json()) as { op: Op | null };
  return { status: res.status, body };
}

async function postRoomRedo(code: string, cookie?: string) {
  const res = await fetch(new URL(`/api/rooms/${code}/redo`, baseUrl), {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
  });
  const body = (await res.json()) as { op: Op | null };
  return { status: res.status, body };
}

const DRAW_A = { color: "#1d1d1d", width: 0.02, points: [{ x: 0.1, y: 0.1 }] };
const DRAW_B = { color: "#e53935", width: 0.02, points: [{ x: 0.2, y: 0.2 }] };
const DRAW_C = { color: "#1e88e5", width: 0.02, points: [{ x: 0.3, y: 0.3 }] };
const ERASE_A = { radius: 0.05, points: [{ x: 0.1, y: 0.1 }] };

// (15) and (16) from the implementation mandate -- "existing Public/Private
// isolation tests remain green" and "all existing drawing/fade tests remain
// green" -- are deliberately not duplicated here: they are already fully
// covered by spec/rooms.test.ts, spec/ops.test.ts, and spec/fade.test.ts,
// none of which this feature's additive migration or its listOps/active
// filtering change in any observable way. Running `pnpm test` runs all of
// them together; a regression there would show up as a failure in those
// files, not a gap in this one.

// (1) + (2): Undo removes the owner's own latest op from the active (replay)
// set it would otherwise appear in -- the direct, observable meaning of
// "undone" from outside the server, since there is no endpoint that lists
// inactive ops directly.
it("Undo removes the owner's own latest active op from the active (replay) set", async () => {
  const code = await createRoom();
  const posted = await postRoomDraw(code, DRAW_A);

  const undone = await postRoomUndo(code, posted.cookie);
  expect(undone.status).toBe(200);
  expect(undone.body.op?.id).toBe(posted.body.id);

  const ops = await getRoomOps(code);
  expect(ops.find((op) => op.id === posted.body.id)).toBeFalsy();
});

// Proves the undone row is reactivated, not recreated: a fresh insert would
// get a new id and a new (higher) seq, so an exact id+seq+content match after
// redo is only possible if the original row was preserved throughout, never
// deleted.
it("a redone op is the exact same row -- same id, seq, and content -- not a freshly inserted one", async () => {
  const code = await createRoom();
  const posted = await postRoomDraw(code, DRAW_A);
  await postRoomUndo(code, posted.cookie);

  const redone = await postRoomRedo(code, posted.cookie);
  expect(redone.body.op?.id).toBe(posted.body.id);
  expect(redone.body.op?.seq).toBe(posted.body.seq);

  const ops = await getRoomOps(code);
  const row = ops.find((op) => op.id === posted.body.id);
  expect(row).toEqual(posted.body);
});

// (3): ownership isolation -- Undo is always scoped to the caller's own anon
// cookie, so a different owner (fresh cookie jar, nothing of their own to
// undo) gets a no-op, and the original owner's op is completely untouched.
it("Undo only ever targets the caller's own latest op, never another owner's", async () => {
  const code = await createRoom();
  const a = await postRoomDraw(code, DRAW_A);

  const strangerUndo = await postRoomUndo(code); // separate fresh cookie jar
  expect(strangerUndo.body.op).toBeNull();

  const ops = await getRoomOps(code);
  expect(ops.find((op) => op.id === a.body.id)).toBeTruthy();
});

// (4): room isolation -- the same owner undoing in the wrong room finds
// nothing of theirs there to undo, and room A's op is unaffected.
it("Undo/redo are scoped to one room: acting in room B never affects room A's ops", async () => {
  const roomA = await createRoom();
  const roomB = await createRoom();
  const a = await postRoomDraw(roomA, DRAW_A);

  const wrongRoomUndo = await postRoomUndo(roomB, a.cookie); // same owner, wrong room
  expect(wrongRoomUndo.body.op).toBeNull();

  const opsA = await getRoomOps(roomA);
  expect(opsA.find((op) => op.id === a.body.id)).toBeTruthy();
});

// (5): there is no bare, unscoped /api/undo or /api/redo -- only the two
// scoped families (/api/ops/undo|redo for Public, /api/rooms/:code/undo|redo
// for a room). /api/ops/undo and /api/ops/redo are deliberately NOT asserted
// 404 here: the Public Canvas Undo/Redo extension (see the "Public (n)"
// tests below) gives them a real, 200-returning implementation.
it("there is no bare, unscoped /api/undo or /api/redo endpoint", async () => {
  for (const path of ["/api/undo", "/api/redo"]) {
    const res = await fetch(new URL(path, baseUrl), { method: "POST" });
    expect(res.status).toBe(404);
  }
});

// (6): multiple Undos walk backward through only this owner's own ops, most
// recent seq first, never touching another owner's history (there is none in
// this room to confuse it with, but the ordering itself is the contract).
it("multiple Undos walk backward through the owner's own ops in reverse seq order", async () => {
  const code = await createRoom();
  const a = await postRoomDraw(code, DRAW_A);
  const b = await postRoomDraw(code, DRAW_B, a.cookie);
  const c = await postRoomDraw(code, DRAW_C, a.cookie);

  expect((await postRoomUndo(code, a.cookie)).body.op?.id).toBe(c.body.id);
  expect((await postRoomUndo(code, a.cookie)).body.op?.id).toBe(b.body.id);
  expect((await postRoomUndo(code, a.cookie)).body.op?.id).toBe(a.body.id);
  expect((await postRoomUndo(code, a.cookie)).body.op).toBeNull(); // nothing left

  const ops = await getRoomOps(code);
  expect(ops.length).toBe(0);
});

// (7) + (8): the core worked example for deterministic, non-timestamp LIFO
// ordering. C is undone, then B is undone (B is now the *most recently*
// undone op, even though C has the higher seq) -- Redo must bring B back
// first. These three requests are issued back-to-back with no delay between
// them, deliberately: if redo order were derived from wall-clock timestamps
// instead of the server-assigned undo_order counter, requests this close
// together could tie or misorder on some systems' clock resolution. Getting
// the right answer here demonstrates correctness does not depend on any gap
// between requests.
it("Redo is LIFO by undo recency (a deterministic counter), not by seq order or timing", async () => {
  const code = await createRoom();
  const a = await postRoomDraw(code, DRAW_A);
  const b = await postRoomDraw(code, DRAW_B, a.cookie);
  const c = await postRoomDraw(code, DRAW_C, a.cookie);

  await postRoomUndo(code, a.cookie); // undoes C
  await postRoomUndo(code, a.cookie); // undoes B -- now the most recently undone

  const r1 = await postRoomRedo(code, a.cookie);
  expect(r1.body.op?.id).toBe(b.body.id); // B redoes first, even though C has the higher seq
  const r2 = await postRoomRedo(code, a.cookie);
  expect(r2.body.op?.id).toBe(c.body.id);
});

// (9): undoing an ERASE needs no special-casing server-side -- it is simply
// omitted from the active set like any other undone op -- and the draw it
// would have erased is unaffected either way.
it("undoing an ERASE removes it from the active set; the draw underneath it is unaffected", async () => {
  const code = await createRoom();
  const draw = await postRoomDraw(code, DRAW_A);
  const erase = await postRoomErase(code, ERASE_A, draw.cookie);

  let ops = await getRoomOps(code);
  expect(ops.find((op) => op.id === erase.body.id)).toBeTruthy();

  const undone = await postRoomUndo(code, draw.cookie);
  expect(undone.body.op?.id).toBe(erase.body.id);

  ops = await getRoomOps(code);
  expect(ops.find((op) => op.id === erase.body.id)).toBeFalsy();
  expect(ops.find((op) => op.id === draw.body.id)).toBeTruthy();
});

// (10): redo reactivates the op at its *original* seq -- its original
// position in the global replay order -- even after another owner inserted a
// new op while it was undone. A naive "append on redo" implementation would
// instead give it a new, later seq and reorder it after that intervening op.
it("redo restores an op at its original seq, even after another owner's op was inserted while it was undone", async () => {
  const code = await createRoom();
  const a = await postRoomDraw(code, DRAW_A); // owner A
  const bFirst = await postRoomDraw(code, DRAW_B); // owner B, separate cookie jar, seq after A's

  await postRoomUndo(code, a.cookie); // A's op undone
  await postRoomDraw(code, DRAW_C, bFirst.cookie); // B draws again while A's op is undone

  const redone = await postRoomRedo(code, a.cookie);
  expect(redone.body.op?.id).toBe(a.body.id);
  expect(redone.body.op?.seq).toBe(a.body.seq); // exact original seq, not appended at the end

  const ops = await getRoomOps(code);
  const seqs = ops.map((op) => op.seq);
  expect(seqs).toEqual([...seqs].sort((x, y) => x - y)); // still a valid total seq order
  expect(ops.find((op) => op.id === a.body.id)?.seq).toBe(a.body.seq);
});

// (11): a fresh DRAW after an Undo abandons that owner's remaining redo
// branch -- the undone op's row is still there (never deleted) but can never
// be redone again.
it("a new DRAW after an Undo abandons that owner's redo branch", async () => {
  const code = await createRoom();
  const a = await postRoomDraw(code, DRAW_A);
  await postRoomUndo(code, a.cookie);
  await postRoomDraw(code, DRAW_B, a.cookie); // a fresh edit

  const redone = await postRoomRedo(code, a.cookie);
  expect(redone.body.op).toBeNull(); // nothing left to redo -- A's undone draw was abandoned

  const ops = await getRoomOps(code);
  expect(ops.find((op) => op.id === a.body.id)).toBeFalsy(); // still not active
});

// (12): the same abandonment rule applies to a fresh ERASE, not just DRAW --
// both write paths call the same abandonRedoBranch.
it("a new ERASE after an Undo also abandons that owner's redo branch", async () => {
  const code = await createRoom();
  const a = await postRoomDraw(code, DRAW_A);
  await postRoomUndo(code, a.cookie);
  await postRoomErase(code, ERASE_A, a.cookie);

  const redone = await postRoomRedo(code, a.cookie);
  expect(redone.body.op).toBeNull();
});

// (13): abandonment is scoped to (room, owner) -- another owner drawing
// something new must never clear my own redo branch.
it("another owner's new edit never abandons my own redo branch", async () => {
  const code = await createRoom();
  const a = await postRoomDraw(code, DRAW_A);
  await postRoomUndo(code, a.cookie);
  await postRoomDraw(code, DRAW_B); // a different owner, fresh cookie jar

  const redone = await postRoomRedo(code, a.cookie);
  expect(redone.body.op?.id).toBe(a.body.id); // still redoable
});

// (14): undo/redo state lives in the database, not in any per-request or
// in-memory session state -- repeated, independent GETs after an Undo keep
// reflecting it identically.
it("undo state is persisted, not request-scoped: repeated GETs after an Undo keep reflecting it", async () => {
  const code = await createRoom();
  const a = await postRoomDraw(code, DRAW_A);
  await postRoomUndo(code, a.cookie);

  const first = await getRoomOps(code);
  const second = await getRoomOps(code);
  expect(second).toEqual(first);
  expect(first.find((op) => op.id === a.body.id)).toBeFalsy();
});

// --- Public Canvas Undo/Redo -----------------------------------------------
//
// Same DB helpers (undoLatestOwnOp/redoLatestOwnOp/abandonRedoBranch, see
// server/db.js) as every Private-Room test above, called with roomId = null
// instead of a room code -- there is no separate Public implementation to
// test. Every case below has a direct Private-Room analogue above; what's
// actually new here is the `room_id IS ?` NULL-scope fix (without it, every
// one of these would have been a silent, permanent no-op) and the two new
// cross-scope isolation cases (9, 10), which have no Private-only analogue at
// all since Phase D never had two scopes to isolate between.
//
// (15) and (16) from the implementation mandate: "existing Private
// Undo/Redo tests remain green" is every test above this section (none of
// their behaviour changed; only the `=` -> `IS` fix made the Public section
// below possible); "existing fade, ownership, room-isolation and persistence
// tests remain green" is spec/rooms.test.ts, spec/ops.test.ts, and
// spec/fade.test.ts, none of which this change touches.

async function postPublicDraw(
  draw: { color: string; width: number; points: { x: number; y: number }[] },
  cookie?: string,
) {
  const res = await fetch(new URL("/api/ops/draw", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(draw),
  });
  const body = await res.json();
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: body as Op, cookie: cookie ?? setCookie!.split(";")[0] };
}

async function postPublicErase(erase: { radius: number; points: { x: number; y: number }[] }, cookie?: string) {
  const res = await fetch(new URL("/api/ops/erase", baseUrl), {
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

async function postPublicUndo(cookie?: string) {
  const res = await fetch(new URL("/api/ops/undo", baseUrl), {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
  });
  const body = (await res.json()) as { op: Op | null };
  return { status: res.status, body };
}

async function postPublicRedo(cookie?: string) {
  const res = await fetch(new URL("/api/ops/redo", baseUrl), {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
  });
  const body = (await res.json()) as { op: Op | null };
  return { status: res.status, body };
}

// (1) + (2)
it("Public (1,2): a Public owner can undo, then redo, their own latest DRAW", async () => {
  const posted = await postPublicDraw(DRAW_A);

  const undone = await postPublicUndo(posted.cookie);
  expect(undone.status).toBe(200);
  expect(undone.body.op?.id).toBe(posted.body.id);
  expect((await getPublicOps()).find((op) => op.id === posted.body.id)).toBeFalsy();

  const redone = await postPublicRedo(posted.cookie);
  expect(redone.body.op?.id).toBe(posted.body.id);
  expect((await getPublicOps()).find((op) => op.id === posted.body.id)).toBeTruthy();
});

// (3): a stranger (fresh cookie jar, nothing of their own posted) gets a
// no-op, and the original owner's Public op is completely untouched.
it("Public (3): a Public owner cannot undo another owner's operation", async () => {
  const a = await postPublicDraw(DRAW_A);

  const strangerUndo = await postPublicUndo();
  expect(strangerUndo.body.op).toBeNull();
  expect((await getPublicOps()).find((op) => op.id === a.body.id)).toBeTruthy();
});

// (4): same reverse-seq walk as the Private-Room case, scoped by owner alone
// since the Public Canvas has no room to additionally scope by.
it("Public (4): multiple Public undos walk backward through the owner's own ops in reverse seq order", async () => {
  const a = await postPublicDraw(DRAW_A);
  const b = await postPublicDraw(DRAW_B, a.cookie);
  const c = await postPublicDraw(DRAW_C, a.cookie);

  expect((await postPublicUndo(a.cookie)).body.op?.id).toBe(c.body.id);
  expect((await postPublicUndo(a.cookie)).body.op?.id).toBe(b.body.id);
  expect((await postPublicUndo(a.cookie)).body.op?.id).toBe(a.body.id);
});

// (5): same deterministic undo_order LIFO worked example as the Private-Room
// case -- C undone, then B undone (B is now most-recently-undone despite
// having the lower seq of the two) -- Redo must bring B back first.
it("Public (5): Public redo is LIFO by undo recency (undo_order), not by seq order", async () => {
  const a = await postPublicDraw(DRAW_A);
  const b = await postPublicDraw(DRAW_B, a.cookie);
  const c = await postPublicDraw(DRAW_C, a.cookie);

  await postPublicUndo(a.cookie); // undoes C
  await postPublicUndo(a.cookie); // undoes B -- now the most recently undone

  expect((await postPublicRedo(a.cookie)).body.op?.id).toBe(b.body.id);
  expect((await postPublicRedo(a.cookie)).body.op?.id).toBe(c.body.id);
});

// (6): a fresh Public DRAW abandons that owner's remaining Public redo branch.
it("Public (6): a new Public DRAW abandons only that owner's own Public redo branch", async () => {
  const a = await postPublicDraw(DRAW_A);
  await postPublicUndo(a.cookie);
  await postPublicDraw(DRAW_B, a.cookie); // fresh edit

  expect((await postPublicRedo(a.cookie)).body.op).toBeNull();
});

// (7): the same abandonment rule applies to a fresh Public ERASE.
it("Public (7): a new Public ERASE also abandons that owner's own Public redo branch", async () => {
  const a = await postPublicDraw(DRAW_A);
  await postPublicUndo(a.cookie);
  await postPublicErase(ERASE_A, a.cookie);

  expect((await postPublicRedo(a.cookie)).body.op).toBeNull();
});

// (8): abandonment is scoped to (Public, owner) -- another owner's new Public
// edit must never clear my own Public redo branch.
it("Public (8): another Public owner's new edit never abandons my own Public redo branch", async () => {
  const a = await postPublicDraw(DRAW_A);
  await postPublicUndo(a.cookie);
  await postPublicDraw(DRAW_B); // a different owner, fresh cookie jar

  expect((await postPublicRedo(a.cookie)).body.op?.id).toBe(a.body.id); // still redoable
});

// (9): the new cross-scope case with no Private-only analogue. Same owner
// (same cookie) has an active, redoable Private-Room branch; doing unrelated
// Public undo/draw/redo activity -- including a fresh Public DRAW, which
// abandons this owner's *Public* branch -- must never reach into, or abandon,
// that same owner's Private-Room branch. Only `room_id IS ?` scoping by the
// actual room code (not just the owner) makes this true.
it("Public (9): Public undo/redo activity never affects this owner's Private Room redo branch", async () => {
  const code = await createRoom();
  const roomDraw = await postRoomDraw(code, DRAW_A);
  await postRoomUndo(code, roomDraw.cookie); // room op undone, now redoable in the room

  await postPublicDraw(DRAW_B, roomDraw.cookie);
  await postPublicUndo(roomDraw.cookie);
  await postPublicDraw(DRAW_C, roomDraw.cookie); // would abandon a Public branch, if any existed

  const roomRedone = await postRoomRedo(code, roomDraw.cookie);
  expect(roomRedone.body.op?.id).toBe(roomDraw.body.id); // still redoable in the room, untouched
});

// (10): the mirror image of (9) -- this owner's Private-Room undo/draw/redo
// activity in one room must never reach into, or abandon, that same owner's
// Public redo branch.
it("Public (10): Private Room undo/redo activity never affects this owner's Public redo branch", async () => {
  const publicDraw = await postPublicDraw(DRAW_A);
  await postPublicUndo(publicDraw.cookie); // Public op undone, now redoable

  const code = await createRoom();
  await postRoomDraw(code, DRAW_B, publicDraw.cookie);
  await postRoomUndo(code, publicDraw.cookie);
  await postRoomDraw(code, DRAW_C, publicDraw.cookie); // would abandon a room branch, if any existed

  const publicRedone = await postPublicRedo(publicDraw.cookie);
  expect(publicRedone.body.op?.id).toBe(publicDraw.body.id); // still redoable on Public, untouched
});

// (11) + (12) + (13): Public redo reactivates the exact same row -- same id,
// seq, and createdAt -- never a freshly inserted one. A new insert would get
// a new id and a new (higher) seq, and createdAt would be the moment of the
// redo call rather than the original draw -- none of which is observed here.
it("Public (11,12,13): Public redo preserves the original op's id, seq, and createdAt", async () => {
  const posted = await postPublicDraw(DRAW_A);
  await postPublicUndo(posted.cookie);

  const redone = await postPublicRedo(posted.cookie);
  expect(redone.body.op?.id).toBe(posted.body.id); // (11)
  expect(redone.body.op?.seq).toBe(posted.body.seq); // (12)
  expect(redone.body.op?.createdAt).toBe(posted.body.createdAt); // (13)

  const row = (await getPublicOps()).find((op) => op.id === posted.body.id);
  expect(row).toEqual(posted.body);
});

// (14): the fade-interaction requirement, verified in terms of fade age
// itself rather than just field equality -- redo must never refresh it. The
// worked example from the mandate (drawn at 10:00, undone at 10:05, redone at
// 10:30, fade age still measured from 10:00) is reproduced here as "undo/redo
// happen immediately, then a much later instant is asked for the opacity at":
// since createdAt is never touched by either undoOpStmt or redoOpStmt
// (server/db.js), the gap between the real draw and the real undo/redo calls
// doesn't change the result -- only the preserved createdAt does.
it("Public (14): redo does not refresh fade age -- opacity at any later instant still depends only on the original createdAt", async () => {
  const posted = await postPublicDraw(DRAW_A);
  const originalCreatedAt = posted.body.createdAt;

  await postPublicUndo(posted.cookie);
  const redone = await postPublicRedo(posted.cookie);
  expect(redone.body.op?.createdAt).toBe(originalCreatedAt);

  const muchLater = originalCreatedAt + 375 * 60 * 1000; // 375 minutes later: half of FADE_DURATION_MS
  const expectedOpacity = fadeOpacity(originalCreatedAt, muchLater);
  const actualOpacity = fadeOpacity(redone.body.op!.createdAt, muchLater);
  expect(actualOpacity).toBe(expectedOpacity); // identical: createdAt itself never moved
});
