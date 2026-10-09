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
  docKind: "freehand" | "pixel";
};

function withCookie(cookie?: string): Record<string, string> {
  return cookie ? { Cookie: cookie } : {};
}

async function postJson(path: string, body: unknown, cookie?: string) {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...withCookie(cookie) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: json, cookie: cookie ?? setCookie?.split(";")[0] };
}

function getJson(path: string, cookie?: string) {
  return fetch(new URL(path, baseUrl), { headers: withCookie(cookie) }).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => undefined),
  }));
}

async function createRoom(resolution?: number) {
  return postJson("/api/rooms", resolution === undefined ? {} : { resolution });
}

const PIXEL_DRAW = { color: "#1d1d1d", size: 2, points: [{ x: 5, y: 5 }] };

// --- 1. All four Private pixel resolutions ----------------------------------

for (const resolution of [32, 64, 128, 256]) {
  it(`creating a Private room with resolution ${resolution} produces a pixel-art studio at exactly that square size`, async () => {
    const created = await createRoom(resolution);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: "pixel", width: resolution, height: resolution });

    const fetched = await getJson(`/api/rooms/${created.body.code}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ kind: "pixel", width: resolution, height: resolution });
  });
}

// --- 2. Invalid room resolutions ---------------------------------------------

it("creating a Private room with an unsupported resolution is rejected (400) and creates nothing", async () => {
  for (const bad of [0, 1, 16, 100, 512, -32, 64.5, "64", null]) {
    const res = await postJson("/api/rooms", { resolution: bad });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/resolution must be one of/);
  }
});

// --- 3. Legacy room compatibility (no resolution field at all) --------------

it("creating a Private room with no resolution field still produces a legacy freehand room, unchanged from the existing contract", async () => {
  const created = await postJson("/api/rooms", { presenceId: "tab-1" });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ kind: "legacy", width: null, height: null });

  const code = created.body.code;
  const draw = await postJson(`/api/rooms/${code}/ops/draw`, {
    color: "#1e88e5",
    width: 0.02,
    points: [{ x: 0.2, y: 0.2 }],
  });
  expect(draw.status).toBe(201);

  const ops = await getJson(`/api/rooms/${code}/ops`);
  expect(ops.status).toBe(200);
  expect((ops.body as Op[]).some((op) => op.id === draw.body.id)).toBe(true);
});

it("a legacy room rejects the pixel-mode routes (400), and a pixel-art room rejects the legacy freehand routes (400)", async () => {
  const legacy = await createRoom();
  const pixelDraw = await postJson(`/api/rooms/${legacy.body.code}/pixels/draw`, PIXEL_DRAW);
  expect(pixelDraw.status).toBe(400);
  expect(pixelDraw.body.error).toMatch(/legacy freehand room/);

  const pixelRoom = await createRoom(64);
  const freehandDraw = await postJson(`/api/rooms/${pixelRoom.body.code}/ops/draw`, {
    color: "#1d1d1d",
    width: 0.02,
    points: [{ x: 0.2, y: 0.2 }],
  });
  expect(freehandDraw.status).toBe(400);
  expect(freehandDraw.body.error).toMatch(/pixel-art studio/);
});

// --- 4. Public pixel operation validation -----------------------------------

it("Public pixel draw accepts an in-bounds integer point and a brush size 1-8", async () => {
  const posted = await postJson("/api/pixels/draw", PIXEL_DRAW);
  expect(posted.status).toBe(201);
  expect(posted.body.kind).toBe("draw");
  expect(posted.body.docKind).toBe("pixel");
  expect(posted.body.points).toEqual(PIXEL_DRAW.points);

  const ops = await getJson("/api/pixels");
  expect((ops.body as Op[]).some((op) => op.id === posted.body.id)).toBe(true);
});

it("Public pixel erase accepts an in-bounds integer point and a brush size 1-8, with no color field required", async () => {
  const { cookie } = await postJson("/api/pixels/draw", PIXEL_DRAW);
  const erased = await postJson("/api/pixels/erase", { size: 2, points: [{ x: 5, y: 5 }] }, cookie);
  expect(erased.status).toBe(201);
  expect(erased.body.kind).toBe("erase");
  expect(erased.body.color).toBeNull();
});

it("Public pixel draw rejects a non-integer point, an out-of-bounds point, and an invalid brush size, writing nothing to the database", async () => {
  const before = await getJson("/api/pixels");

  const nonInteger = await postJson("/api/pixels/draw", { color: "#1d1d1d", size: 1, points: [{ x: 5.5, y: 5 }] });
  expect(nonInteger.status).toBe(400);

  const outOfBounds = await postJson("/api/pixels/draw", {
    color: "#1d1d1d",
    size: 1,
    points: [{ x: 512, y: 0 }], // Public is 512 wide: valid x is 0..511
  });
  expect(outOfBounds.status).toBe(400);

  const negative = await postJson("/api/pixels/draw", { color: "#1d1d1d", size: 1, points: [{ x: -1, y: 0 }] });
  expect(negative.status).toBe(400);

  for (const badSize of [0, 9, -1, 2.5, "3", null, undefined]) {
    const res = await postJson("/api/pixels/draw", { color: "#1d1d1d", size: badSize, points: [{ x: 1, y: 1 }] });
    expect(res.status).toBe(400);
  }

  const missingColor = await postJson("/api/pixels/draw", { size: 1, points: [{ x: 1, y: 1 }] });
  expect(missingColor.status).toBe(400);

  const after = await getJson("/api/pixels");
  expect((after.body as Op[]).length).toBe((before.body as Op[]).length); // nothing was written
});

it("Public pixel erase rejects the same malformed shapes as draw, writing nothing", async () => {
  const before = await getJson("/api/pixels");
  for (const badSize of [0, 9, -1, 2.5]) {
    const res = await postJson("/api/pixels/erase", { size: badSize, points: [{ x: 1, y: 1 }] });
    expect(res.status).toBe(400);
  }
  const outOfBounds = await postJson("/api/pixels/erase", { size: 1, points: [{ x: 0, y: 288 }] }); // height is 288: valid y is 0..287
  expect(outOfBounds.status).toBe(400);
  const after = await getJson("/api/pixels");
  expect((after.body as Op[]).length).toBe((before.body as Op[]).length);
});

it("a client-supplied ownerId or seq in a pixel draw body is silently ignored, never trusted", async () => {
  const posted = await postJson("/api/pixels/draw", {
    ...PIXEL_DRAW,
    ownerId: "someone-else-entirely",
    seq: 999999,
  });
  expect(posted.status).toBe(201);
  expect(posted.body.ownerId).not.toBe("someone-else-entirely");
  expect(posted.body.seq).not.toBe(999999);
  expect(typeof posted.body.ownerId).toBe("string");
});

// --- 5. Private pixel room validation against ITS OWN stored resolution -----

it("a Private pixel room validates points against its own resolution, not Public's", async () => {
  const room = await createRoom(32);
  const code = room.body.code;

  const atEdge = await postJson(`/api/rooms/${code}/pixels/draw`, {
    color: "#1d1d1d",
    size: 1,
    points: [{ x: 31, y: 31 }], // last valid cell in a 32x32 grid
  });
  expect(atEdge.status).toBe(201);

  const outOfBounds = await postJson(`/api/rooms/${code}/pixels/draw`, {
    color: "#1d1d1d",
    size: 1,
    points: [{ x: 32, y: 0 }], // out of bounds for 32x32, though it would be valid on a 64x64 or Public grid
  });
  expect(outOfBounds.status).toBe(400);
});

// --- 6. Public/Private isolation for pixel ops -------------------------------

it("Public pixel ops and a Private pixel room's ops never leak into each other", async () => {
  const room = await createRoom(64);
  const code = room.body.code;

  const publicOp = await postJson("/api/pixels/draw", PIXEL_DRAW);
  const roomOp = await postJson(`/api/rooms/${code}/pixels/draw`, PIXEL_DRAW);

  const publicOps = await getJson("/api/pixels");
  const roomOps = await getJson(`/api/rooms/${code}/pixels`);

  expect((publicOps.body as Op[]).some((op) => op.id === roomOp.body.id)).toBe(false);
  expect((roomOps.body as Op[]).some((op) => op.id === publicOp.body.id)).toBe(false);
  expect((publicOps.body as Op[]).some((op) => op.id === publicOp.body.id)).toBe(true);
  expect((roomOps.body as Op[]).some((op) => op.id === roomOp.body.id)).toBe(true);
});

it("two Private pixel rooms are isolated from each other", async () => {
  const roomA = await createRoom(32);
  const roomB = await createRoom(32);
  const posted = await postJson(`/api/rooms/${roomA.body.code}/pixels/draw`, PIXEL_DRAW);

  const opsA = await getJson(`/api/rooms/${roomA.body.code}/pixels`);
  const opsB = await getJson(`/api/rooms/${roomB.body.code}/pixels`);
  expect((opsA.body as Op[]).some((op) => op.id === posted.body.id)).toBe(true);
  expect((opsB.body as Op[]).some((op) => op.id === posted.body.id)).toBe(false);
});

// --- 8. Preservation and retrieval of historical Public freehand operations -

it("a historical (freehand) Public op and a new pixel Public op coexist, each retrievable only from its own endpoint, neither reinterpreted as the other", async () => {
  const freehandDraw = await postJson("/api/ops/draw", {
    color: "#8e24aa",
    width: 0.02,
    points: [{ x: 0.3, y: 0.3 }],
  });
  expect(freehandDraw.status).toBe(201);

  const pixelDraw = await postJson("/api/pixels/draw", PIXEL_DRAW);
  expect(pixelDraw.status).toBe(201);

  const freehandOps = await getJson("/api/ops");
  const pixelOps = await getJson("/api/pixels");

  const foundFreehand = (freehandOps.body as Op[]).find((op) => op.id === freehandDraw.body.id);
  expect(foundFreehand).toBeTruthy();
  expect(foundFreehand!.points).toEqual(freehandDraw.body.points); // unchanged, not reinterpreted as integer cells
  expect((freehandOps.body as Op[]).some((op) => op.id === pixelDraw.body.id)).toBe(false);

  const foundPixel = (pixelOps.body as Op[]).find((op) => op.id === pixelDraw.body.id);
  expect(foundPixel).toBeTruthy();
  expect((pixelOps.body as Op[]).some((op) => op.id === freehandDraw.body.id)).toBe(false);
});

// --- 9. Nickname setup/update and validation --------------------------------

it("GET /api/me reports nickname null before one is ever set, then reflects it after POST /api/me/nickname, then reflects an update", async () => {
  const me = await getJson("/api/me");
  expect(me.status).toBe(200);
  expect(me.body.nickname).toBeNull();
  const cookie = (await fetch(new URL("/api/me", baseUrl))).headers.get("set-cookie")?.split(";")[0];

  const set = await postJson("/api/me/nickname", { nickname: "Casey" }, cookie);
  expect(set.status).toBe(200);
  expect(set.body.nickname).toBe("Casey");

  const after = await getJson("/api/me", cookie);
  expect(after.body.nickname).toBe("Casey");

  const updated = await postJson("/api/me/nickname", { nickname: "Jordan" }, cookie);
  expect(updated.status).toBe(200);
  expect(updated.body.nickname).toBe("Jordan");

  const afterUpdate = await getJson("/api/me", cookie);
  expect(afterUpdate.body.nickname).toBe("Jordan"); // updated in place, not duplicated
});

it("a nickname is trimmed of surrounding whitespace", async () => {
  const set = await postJson("/api/me/nickname", { nickname: "  Alex  " });
  expect(set.status).toBe(200);
  expect(set.body.nickname).toBe("Alex");
});

it("nickname validation rejects empty, whitespace-only, overlong, control-character, and non-string values", async () => {
  const cases: unknown[] = ["", "   ", "x".repeat(25), "bad\u0000name", 42, null, undefined, ["Casey"]];
  for (const nickname of cases) {
    const res = await postJson("/api/me/nickname", { nickname });
    expect(res.status).toBe(400);
  }
});

it("a 24-character nickname is accepted (boundary)", async () => {
  const res = await postJson("/api/me/nickname", { nickname: "x".repeat(24) });
  expect(res.status).toBe(200);
});

// --- 10. Nickname spoofing has no effect on ownership -----------------------

it("setting (or spoofing) a nickname never authorizes drawing, erasing, or undoing as another owner", async () => {
  const victimDraw = await postJson("/api/pixels/draw", PIXEL_DRAW); // owner A, fresh cookie jar
  await postJson("/api/me/nickname", { nickname: "Attacker" }); // a different, fresh cookie jar -- owner B

  // Owner B's own undo must find nothing of theirs -- having set a nickname
  // (even the same displayed name an attacker might pick) has no bearing on
  // whose op is targeted; undo is still scoped by the httpOnly ownerId alone.
  const strangerUndo = await postJson("/api/pixels/undo", {});
  expect(strangerUndo.body.op).toBeNull();

  const ops = await getJson("/api/pixels");
  expect((ops.body as Op[]).some((op) => op.id === victimDraw.body.id)).toBe(true); // untouched

  // A nickname field smuggled into the erase body is not even a recognized
  // field -- ownership is still derived purely from the caller's own cookie.
  const strangerErase = await postJson("/api/pixels/erase", {
    size: 2,
    points: PIXEL_DRAW.points,
    nickname: "Attacker",
    ownerId: victimDraw.body.ownerId,
  });
  expect(strangerErase.status).toBe(201);
  expect(strangerErase.body.ownerId).not.toBe(victimDraw.body.ownerId);
});

// --- 11. Undo/redo behaviour for pixel ops mirrors the existing contract ----

it("Public pixel undo/redo: an owner can undo then redo their own latest pixel op, exactly like the freehand contract", async () => {
  const posted = await postJson("/api/pixels/draw", PIXEL_DRAW);

  const undone = await postJson("/api/pixels/undo", {}, posted.cookie);
  expect(undone.status).toBe(200);
  expect(undone.body.op.id).toBe(posted.body.id);
  expect((await getJson("/api/pixels")).body.some((op: Op) => op.id === posted.body.id)).toBe(false);

  const redone = await postJson("/api/pixels/redo", {}, posted.cookie);
  expect(redone.body.op.id).toBe(posted.body.id);
  expect(redone.body.op.seq).toBe(posted.body.seq); // same row, not a fresh insert
  expect((await getJson("/api/pixels")).body.some((op: Op) => op.id === posted.body.id)).toBe(true);
});

it("Private pixel room undo/redo is scoped to that room and that owner, exactly like the freehand contract", async () => {
  const room = await createRoom(64);
  const code = room.body.code;
  const posted = await postJson(`/api/rooms/${code}/pixels/draw`, PIXEL_DRAW);

  const strangerUndo = await postJson(`/api/rooms/${code}/pixels/undo`, {});
  expect(strangerUndo.body.op).toBeNull();

  const undone = await postJson(`/api/rooms/${code}/pixels/undo`, {}, posted.cookie);
  expect(undone.body.op.id).toBe(posted.body.id);

  const redone = await postJson(`/api/rooms/${code}/pixels/redo`, {}, posted.cookie);
  expect(redone.body.op.id).toBe(posted.body.id);
  expect(redone.body.op.seq).toBe(posted.body.seq);
});

it("a Public pixel undo never reaches into this same owner's Public freehand redo branch, and vice versa", async () => {
  const freehandDraw = await postJson("/api/ops/draw", {
    color: "#1d1d1d",
    width: 0.02,
    points: [{ x: 0.1, y: 0.1 }],
  });
  await postJson("/api/ops/undo", {}, freehandDraw.cookie); // freehand op undone, now redoable

  await postJson("/api/pixels/draw", PIXEL_DRAW, freehandDraw.cookie);
  await postJson("/api/pixels/undo", {}, freehandDraw.cookie);
  await postJson("/api/pixels/draw", { ...PIXEL_DRAW, points: [{ x: 6, y: 6 }] }, freehandDraw.cookie); // would abandon a pixel redo branch, if any existed

  const freehandRedo = await postJson("/api/ops/redo", {}, freehandDraw.cookie);
  expect(freehandRedo.body.op.id).toBe(freehandDraw.body.id); // still redoable, untouched by pixel activity
});
