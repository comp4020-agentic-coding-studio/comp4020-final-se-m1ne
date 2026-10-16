// Server contract for shape ops (Line/Rectangle/Ellipse) over real
// HTTP+SSE, against the shared test server: validation, persistence and
// replay, ordering, owner-specific undo/redo, owner-specific erasing, Public
// vs Private room isolation, the live-preview route, and the realtime "op"
// broadcast. Client-side behaviour (gestures, Shift, cancel) is covered in
// spec/app-shapes.test.ts; the pure geometry in spec/shapes.test.ts.

import { afterEach, describe, expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

type SseEvent = { event: string; data: any };

class SseClient {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private queue: SseEvent[] = [];
  private waiters: Array<(ev: SseEvent) => void> = [];
  private controller: AbortController;

  private constructor(reader: ReadableStreamDefaultReader<Uint8Array>, controller: AbortController) {
    this.reader = reader;
    this.controller = controller;
    this.pump();
  }

  static async connect(path: string): Promise<SseClient> {
    const controller = new AbortController();
    const res = await fetch(new URL(path, baseUrl), { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE connect to ${path} failed with status ${res.status}`);
    return new SseClient(res.body.getReader(), controller);
  }

  private async pump() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += this.decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
          const raw = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 2);
          if (raw.length === 0 || raw.startsWith(":")) continue;
          let event = "message";
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          const ev: SseEvent = { event, data: JSON.parse(data) };
          const waiter = this.waiters.shift();
          if (waiter) waiter(ev);
          else this.queue.push(ev);
        }
      }
    } catch {
      // aborted or dropped
    }
  }

  next(timeoutMs = 2500): Promise<SseEvent> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for an SSE event")), timeoutMs);
      this.waiters.push((ev) => {
        clearTimeout(timer);
        resolve(ev);
      });
    });
  }

  async nextOfType(type: string, timeoutMs = 2500): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ev = await this.next(deadline - Date.now());
      if (ev.event === type) return ev;
    }
    throw new Error(`no "${type}" event within ${timeoutMs}ms`);
  }

  close() {
    this.controller.abort();
  }
}

const open: SseClient[] = [];
async function connect(path: string) {
  const c = await SseClient.connect(path);
  open.push(c);
  return c;
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

async function postJson(path: string, body: unknown, cookie?: string) {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: json, cookie: cookie ?? setCookie?.split(";")[0] };
}

async function newRoom(): Promise<string> {
  return (await postJson("/api/rooms", {})).body.code as string;
}

async function guest(): Promise<string> {
  const res = await fetch(new URL("/api/me", baseUrl));
  return res.headers.get("set-cookie")!.split(";")[0];
}

async function listOps(scope: string | null): Promise<any[]> {
  const path = scope ? `/api/rooms/${scope}/ops` : "/api/ops";
  return (await fetch(new URL(path, baseUrl))).json();
}

const drawPath = (scope: string | null) => (scope ? `/api/rooms/${scope}/ops/draw` : "/api/ops/draw");
const erasePath = (scope: string | null) => (scope ? `/api/rooms/${scope}/ops/erase` : "/api/ops/erase");
const undoPath = (scope: string | null) => (scope ? `/api/rooms/${scope}/undo` : "/api/ops/undo");
const redoPath = (scope: string | null) => (scope ? `/api/rooms/${scope}/redo` : "/api/ops/redo");

const CORNERS = [
  { x: 0.2, y: 0.3 },
  { x: 0.5, y: 0.7 },
];
const shapeBody = (shape: unknown, extra: Record<string, unknown> = {}) => ({
  color: "#e85d5d",
  width: 0.004,
  points: CORNERS,
  shape,
  ...extra,
});

describe("shape op validation", () => {
  it("accepts line, rectangle and ellipse in Outline and Filled mode (a line has none), on a room", async () => {
    const room = await newRoom();
    const me = await guest();
    const cases: unknown[] = [
      { type: "line" },
      { type: "rectangle", mode: "outline" },
      { type: "rectangle", mode: "filled" },
      { type: "ellipse", mode: "outline" },
      { type: "ellipse", mode: "filled" },
    ];
    for (const shape of cases) {
      const res = await postJson(drawPath(room), shapeBody(shape), me);
      expect(res.status, JSON.stringify(shape)).toBe(201);
      expect(res.body.kind).toBe("draw");
      expect(res.body.shape).toEqual(shape);
    }
  });

  it("rejects malformed or unsupported shape ops with 400 and persists nothing", async () => {
    const room = await newRoom();
    const me = await guest();
    const bad: Array<[string, unknown]> = [
      ["unknown type", shapeBody({ type: "star", mode: "filled" })],
      ["triangle (removed tool) outline", shapeBody({ type: "triangle", mode: "outline" })],
      ["triangle (removed tool) filled", shapeBody({ type: "triangle", mode: "filled" })],
      ["missing mode on a closed shape", shapeBody({ type: "rectangle" })],
      ["unknown mode", shapeBody({ type: "ellipse", mode: "stripey" })],
      ["a filled line", shapeBody({ type: "line", mode: "filled" })],
      ["shape is not an object", shapeBody("rectangle")],
      ["null shape", shapeBody(null)],
      ["one corner only", shapeBody({ type: "line" }, { points: [CORNERS[0]] })],
      ["three points", shapeBody({ type: "line" }, { points: [...CORNERS, CORNERS[0]] })],
      ["no points", shapeBody({ type: "line" }, { points: [] })],
      ["non-finite coordinate (null)", shapeBody({ type: "line" }, { points: [CORNERS[0], { x: null, y: 0.2 }] })],
      ["absurd coordinate", shapeBody({ type: "line" }, { points: [CORNERS[0], { x: 1e12, y: 0.2 }] })],
      ["string coordinate", shapeBody({ type: "line" }, { points: [CORNERS[0], { x: "0.2", y: 0.2 }] })],
      ["colour not #rrggbb", shapeBody({ type: "line" }, { color: "red" })],
      ["zero width", shapeBody({ type: "line" }, { width: 0 })],
      ["negative width", shapeBody({ type: "line" }, { width: -1 })],
      ["NaN-ish width", shapeBody({ type: "line" }, { width: "0.1" })],
    ];
    for (const [label, body] of bad) {
      const res = await postJson(drawPath(room), body, me);
      expect(res.status, label).toBe(400);
    }
    expect(await listOps(room)).toHaveLength(0);
  });

  it("a plain brush stroke (no shape field) is unaffected and has no shape key", async () => {
    const room = await newRoom();
    const res = await postJson(drawPath(room), { color: "#1d1d1d", width: 0.01, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }] });
    expect(res.status).toBe(201);
    expect("shape" in res.body).toBe(false);
    expect("shape" in (await listOps(room))[0]).toBe(false);
  });

  it("a client cannot choose the owner: ownerId in a shape body is ignored", async () => {
    const room = await newRoom();
    const me = await guest();
    const res = await postJson(drawPath(room), { ...shapeBody({ type: "line" }), ownerId: "someone-else" }, me);
    expect(res.status).toBe(201);
    expect(res.body.ownerId).not.toBe("someone-else");
  });

  it("the shape route does not exist for a missing room (404) and does not leak into other rooms", async () => {
    const res = await postJson(drawPath("ZZZZZZ"), shapeBody({ type: "line" }));
    expect(res.status).toBe(404);
  });
});

describe("persistence, ordering and replay", () => {
  it("a shape round-trips exactly: type, mode, colour, width and corner geometry", async () => {
    const room = await newRoom();
    const me = await guest();
    const saved = await postJson(drawPath(room), shapeBody({ type: "ellipse", mode: "filled" }, { color: "#355c9a", width: 0.0125 }), me);
    const [op] = await listOps(room);
    expect(op.id).toBe(saved.body.id);
    expect(op.shape).toEqual({ type: "ellipse", mode: "filled" });
    expect(op.color).toBe("#355c9a");
    expect(op.size).toBe(0.0125);
    expect(op.points).toEqual(CORNERS);
    expect(op.kind).toBe("draw");
    expect(op.ownerId).toBe(saved.body.ownerId);
    expect(typeof op.createdAt).toBe("number");
  });

  it("shapes and brush strokes interleave in server-assigned seq order, identically on every read (refresh)", async () => {
    const room = await newRoom();
    const me = await guest();
    await postJson(drawPath(room), shapeBody({ type: "rectangle", mode: "filled" }), me);
    await postJson(drawPath(room), { color: "#1d1d1d", width: 0.01, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }] }, me);
    await postJson(drawPath(room), shapeBody({ type: "ellipse", mode: "outline" }), me);
    const first = await listOps(room);
    const second = await listOps(room);
    expect(second).toEqual(first);
    expect(first.map((o) => !!o.shape)).toEqual([true, false, true]);
    const seqs = first.map((o) => o.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);
  });

  it("Public shapes keep a server createdAt (the fade clock) and Private shapes are listed with theirs", async () => {
    const before = Date.now();
    const pub = await postJson(drawPath(null), shapeBody({ type: "line" }));
    const priv = await postJson(drawPath(await newRoom()), shapeBody({ type: "line" }));
    const after = Date.now();
    for (const r of [pub, priv]) {
      expect(r.body.createdAt).toBeGreaterThanOrEqual(before);
      expect(r.body.createdAt).toBeLessThanOrEqual(after);
    }
  });
});

describe("room isolation", () => {
  it("a shape in one room never appears in another room or on Public", async () => {
    const a = await newRoom();
    const b = await newRoom();
    const res = await postJson(drawPath(a), shapeBody({ type: "rectangle", mode: "filled" }));
    expect(await listOps(b)).toHaveLength(0);
    expect((await listOps(null)).some((o) => o.id === res.body.id)).toBe(false);
    expect((await listOps(a)).map((o) => o.id)).toEqual([res.body.id]);
  });

  it("a Public shape never appears in a room", async () => {
    const room = await newRoom();
    const res = await postJson(drawPath(null), shapeBody({ type: "ellipse", mode: "outline" }));
    expect((await listOps(room)).some((o) => o.id === res.body.id)).toBe(false);
    expect((await listOps(null)).some((o) => o.id === res.body.id)).toBe(true);
  });
});

describe("owner-specific undo / redo of shapes", () => {
  it("undo removes only the caller's own newest op and redo restores the very same shape row", async () => {
    const room = await newRoom();
    const me = await guest();
    const draw = await postJson(drawPath(room), shapeBody({ type: "ellipse", mode: "filled" }), me);
    const undone = await postJson(undoPath(room), {}, me);
    expect(undone.body.op.id).toBe(draw.body.id);
    expect(await listOps(room)).toHaveLength(0);
    const redone = await postJson(redoPath(room), {}, me);
    expect(redone.body.op.id).toBe(draw.body.id);
    expect(redone.body.op.shape).toEqual({ type: "ellipse", mode: "filled" });
    const [op] = await listOps(room);
    expect(op.id).toBe(draw.body.id);
    expect(op.seq).toBe(draw.body.seq); // original position in the replay order
    expect(op.createdAt).toBe(draw.body.createdAt); // undo/redo never restarts the fade clock
  });

  it("one guest's undo and redo never touch another guest's shape", async () => {
    const room = await newRoom();
    const alice = await guest();
    const bob = await guest();
    const bobShape = await postJson(drawPath(room), shapeBody({ type: "ellipse", mode: "outline" }), bob);
    for (let i = 0; i < 3; i++) await postJson(undoPath(room), {}, alice); // alice has nothing to undo
    expect(await postJson(undoPath(room), {}, alice).then((r) => r.body.op)).toBeNull();
    expect((await listOps(room)).map((o) => o.id)).toEqual([bobShape.body.id]);
    expect(await postJson(redoPath(room), {}, alice).then((r) => r.body.op)).toBeNull();
  });

  it("a new shape abandons only that owner's own redo branch", async () => {
    const room = await newRoom();
    const alice = await guest();
    const bob = await guest();
    await postJson(drawPath(room), shapeBody({ type: "line" }), alice);
    await postJson(drawPath(room), shapeBody({ type: "line" }), bob);
    await postJson(undoPath(room), {}, alice);
    await postJson(undoPath(room), {}, bob);
    await postJson(drawPath(room), shapeBody({ type: "rectangle", mode: "outline" }), alice); // alice's redo branch dies
    expect(await postJson(redoPath(room), {}, alice).then((r) => r.body.op)).toBeNull();
    expect(await postJson(redoPath(room), {}, bob).then((r) => r.body.op)).not.toBeNull(); // bob's survives
  });
});

describe("owner-specific erasing of shapes", () => {
  it("an erase op is just the eraser's own append-only op: it never edits, removes or reassigns a shape", async () => {
    const room = await newRoom();
    const alice = await guest();
    const bob = await guest();
    const bobShape = await postJson(drawPath(room), shapeBody({ type: "rectangle", mode: "filled" }), bob);
    const before = (await listOps(room))[0];
    const erase = await postJson(erasePath(room), { radius: 0.05, points: [{ x: 0.3, y: 0.5 }, { x: 0.4, y: 0.5 }] }, alice);
    expect(erase.status).toBe(201);
    expect(erase.body.ownerId).not.toBe(bobShape.body.ownerId); // Alice's eraser is stamped with Alice's id, never Bob's
    const after = await listOps(room);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before); // Bob's shape row is byte-identical
    expect(after[1].kind).toBe("erase");
    expect(after[1].ownerId).toBe(erase.body.ownerId); // stamped with the ERASER's id, so it can only ever mask their own layer
  });

  it("partial erasing is an erase op over a region, not whole-shape deletion", async () => {
    const room = await newRoom();
    const me = await guest();
    const shape = await postJson(drawPath(room), shapeBody({ type: "rectangle", mode: "filled" }), me);
    await postJson(erasePath(room), { radius: 0.02, points: [{ x: 0.3, y: 0.5 }] }, me);
    const ops = await listOps(room);
    expect(ops.map((o) => o.kind)).toEqual(["draw", "erase"]);
    expect(ops[0].id).toBe(shape.body.id); // the shape itself is still stored, untouched
    expect(ops[0].shape).toEqual({ type: "rectangle", mode: "filled" });
  });

  it("undoing an erase restores the shape's pixels (the shape row is never deleted by erasing)", async () => {
    const room = await newRoom();
    const me = await guest();
    await postJson(drawPath(room), shapeBody({ type: "ellipse", mode: "filled" }), me);
    await postJson(erasePath(room), { radius: 0.02, points: [{ x: 0.3, y: 0.5 }] }, me);
    expect((await postJson(undoPath(room), {}, me)).body.op.kind).toBe("erase");
    const ops = await listOps(room);
    expect(ops.map((o) => o.kind)).toEqual(["draw"]);
  });
});

describe("realtime: shape ops and live previews", () => {
  it("a committed shape is broadcast as a normal 'op' event to another viewer of the same room", async () => {
    const room = await newRoom();
    const viewer = await connect(`/api/rooms/${room}/ops/stream`);
    await viewer.nextOfType("sync");
    const res = await postJson(drawPath(room), shapeBody({ type: "ellipse", mode: "outline" }));
    const ev = await viewer.nextOfType("op");
    expect(ev.data.id).toBe(res.body.id);
    expect(ev.data.shape).toEqual({ type: "ellipse", mode: "outline" });
    expect(ev.data.points).toEqual(CORNERS);
    expect(ev.data.active).toBe(true);
  });

  it("a viewer who connects later gets the shape in its sync snapshot (refresh/reconnect recovery)", async () => {
    const room = await newRoom();
    await postJson(drawPath(room), shapeBody({ type: "rectangle", mode: "filled" }));
    const late = await connect(`/api/rooms/${room}/ops/stream`);
    const sync = await late.nextOfType("sync");
    expect(sync.data.ops).toHaveLength(1);
    expect(sync.data.ops[0].shape).toEqual({ type: "rectangle", mode: "filled" });
  });

  it("a room's shape is never delivered to another room's stream", async () => {
    const a = await newRoom();
    const b = await newRoom();
    const viewerB = await connect(`/api/rooms/${b}/ops/stream`);
    await viewerB.nextOfType("sync");
    await postJson(drawPath(a), shapeBody({ type: "line" }));
    await expect(viewerB.nextOfType("op", 700)).rejects.toThrow();
  });

  it("a live shape preview is broadcast as an ephemeral 'stroke' (carrying the shape) and is never persisted", async () => {
    const room = await newRoom();
    const viewer = await connect(`/api/rooms/${room}/ops/stream`);
    await viewer.nextOfType("sync");
    const me = await guest();
    const res = await postJson(`/api/rooms/${room}/ops/stroke`, { active: true, kind: "draw", color: "#e85d5d", size: 0.004, points: CORNERS, shape: { type: "ellipse", mode: "filled" } }, me);
    expect(res.status).toBe(200);
    const ev = await viewer.nextOfType("stroke");
    expect(ev.data.shape).toEqual({ type: "ellipse", mode: "filled" });
    expect(ev.data.points).toEqual(CORNERS);
    expect(await listOps(room)).toHaveLength(0); // a preview is never saved
  });

  it("a malformed shape preview is rejected", async () => {
    const room = await newRoom();
    const me = await guest();
    const bad = [
      { active: true, kind: "draw", color: "#e85d5d", size: 0.004, points: CORNERS, shape: { type: "star", mode: "filled" } },
      { active: true, kind: "draw", color: "#e85d5d", size: 0.004, points: CORNERS, shape: { type: "triangle", mode: "outline" } },
      { active: true, kind: "draw", color: "#e85d5d", size: 0.004, points: [CORNERS[0]], shape: { type: "line" } },
      { active: true, kind: "erase", color: null, size: 0.004, points: CORNERS, shape: { type: "line" } },
    ];
    for (const body of bad) expect((await postJson(`/api/rooms/${room}/ops/stroke`, body, me)).status).toBe(400);
  });
});
