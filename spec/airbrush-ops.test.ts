// Server contract for Airbrush ops over real
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



const PATH = [
  { x: 0.2, y: 0.3 },
  { x: 0.25, y: 0.32 },
  { x: 0.31, y: 0.4 },
  { x: 0.4, y: 0.41 },
];
const airBody = (extra: Record<string, unknown> = {}) => ({
  color: "#7b3fe4",
  width: 0.02,
  points: PATH,
  shape: { type: "airbrush" },
  layerId: "layer3",
  ...extra,
});

describe("airbrush op validation", () => {
  it("accepts an airbrush path of any length on a room and stores type, points, width and layer verbatim", async () => {
    const room = await newRoom();
    const me = await guest();
    const res = await postJson(drawPath(room), airBody(), me);
    expect(res.status).toBe(201);
    expect(res.body.shape).toEqual({ type: "airbrush" });
    expect(res.body.points).toEqual(PATH);
    expect(res.body.size).toBe(0.02);
    expect(res.body.layerId).toBe("layer3");
    const one = await postJson(drawPath(room), airBody({ points: [PATH[0]] }), me); // a tap
    expect(one.status).toBe(201);
  });

  it("drops any extra descriptor fields, rejects bad paths, and persists nothing for a rejected request", async () => {
    const room = await newRoom();
    const me = await guest();
    const stripped = await postJson(drawPath(room), airBody({ shape: { type: "airbrush", runs: [1, 2, 3], evil: true } }), me);
    expect(stripped.status).toBe(201);
    expect(stripped.body.shape).toEqual({ type: "airbrush" });
    const bad: Array<[string, unknown]> = [
      ["no points", airBody({ points: [] })],
      ["non-finite coordinate", airBody({ points: [{ x: null, y: 0.2 }] })],
      ["string coordinate", airBody({ points: [{ x: "0.1", y: 0.2 }] })],
      ["points not an array", airBody({ points: "abc" })],
      ["zero width", airBody({ width: 0 })],
      ["a Public layer id in a Private room", airBody({ layerId: "colour" })],
    ];
    for (const [label, body] of bad) expect((await postJson(drawPath(room), body, me)).status, label).toBe(400);
    expect(await listOps(room)).toHaveLength(1); // only the one valid stroke above
  });
});

describe("airbrush persistence, undo/redo, ownership and realtime", () => {
  it("a saved stroke replays from the snapshot unchanged (refresh), after an ordinary stroke, in seq order", async () => {
    const room = await newRoom();
    const me = await guest();
    await postJson(drawPath(room), { color: "#000000", width: 0.01, points: PATH.slice(0, 2), layerId: "layer1" }, me);
    await postJson(drawPath(room), airBody(), me);
    const ops = await listOps(room);
    expect(ops.map((o) => o.seq)).toEqual([...ops.map((o) => o.seq)].sort((a, b) => a - b));
    expect(ops[0].shape).toBeUndefined(); // the plain brush op is untouched by the new descriptor
    expect(ops[1]).toMatchObject({ kind: "draw", color: "#7b3fe4", size: 0.02, layerId: "layer3", shape: { type: "airbrush" }, points: PATH });
  });

  it("undo removes only my own airbrush stroke and redo restores it identically", async () => {
    const room = await newRoom();
    const me = await guest();
    const other = await guest();
    await postJson(drawPath(room), airBody({ layerId: "layer1" }), other);
    await postJson(drawPath(room), airBody(), me);
    expect((await postJson(undoPath(room), {}, me)).status).toBe(200);
    let ops = await listOps(room);
    expect(ops).toHaveLength(1);
    expect(ops[0].layerId).toBe("layer1"); // the other owner's stroke is untouched
    expect((await postJson(redoPath(room), {}, me)).status).toBe(200);
    ops = await listOps(room);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ shape: { type: "airbrush" }, points: PATH, layerId: "layer3", size: 0.02 });
  });

  it("another owner's erase never changes a stored airbrush stroke (ownership-restricted erasing)", async () => {
    const room = await newRoom();
    const me = await guest();
    const other = await guest();
    await postJson(drawPath(room), airBody(), me);
    const before = await listOps(room);
    const er = await postJson(erasePath(room), { radius: 0.05, points: [{ x: 0.25, y: 0.32 }], layerId: "layer3" }, other);
    expect(er.status).toBe(201);
    expect((await listOps(room)).filter((o) => o.kind === "draw")).toEqual(before);
  });

  it("two users: a stroke by one is broadcast as an op to the other with its shape, points and layer intact", async () => {
    const room = await newRoom();
    const me = await guest();
    const watcher = await connect(`/api/rooms/${room}/ops/stream`);
    await watcher.nextOfType("sync");
    await postJson(drawPath(room), airBody(), me);
    const ev = await watcher.nextOfType("op");
    expect(ev.data).toMatchObject({ shape: { type: "airbrush" }, points: PATH, layerId: "layer3", size: 0.02, color: "#7b3fe4" });
  });

  it("the live-preview route relays an in-progress airbrush stroke to the other session, shape included", async () => {
    const room = await newRoom();
    const me = await guest();
    const watcher = await connect(`/api/rooms/${room}/ops/stream`);
    await watcher.nextOfType("sync");
    const res = await postJson(`/api/rooms/${room}/ops/stroke`, { active: true, kind: "draw", color: "#7b3fe4", size: 0.02, points: PATH, layerId: "layer3", shape: { type: "airbrush" } }, me);
    expect(res.status).toBe(200);
    const ev = await watcher.nextOfType("stroke");
    expect(ev.data).toMatchObject({ kind: "draw", shape: { type: "airbrush" }, layerId: "layer3" });
    expect(ev.data.points).toHaveLength(PATH.length);
  });
});
