// Server contract for Paint Bucket (fill) ops over real
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


const rowRuns = (y: number, x: number, len: number) => [y, x, len];
const fillBody = (runs: number[], extra: Record<string, unknown> = {}) => ({
  color: "#55b78b",
  width: 0.004,
  points: [{ x: 0.2, y: 0.3 }],
  shape: { type: "fill", runs },
  layerId: "layer2",
  ...extra,
});
const FILL = [...rowRuns(10, 100, 50), ...rowRuns(11, 100, 50)];

describe("fill op validation", () => {
  it("accepts a fill carrying its spans on a room, and stores type, runs and layer verbatim", async () => {
    const room = await newRoom();
    const me = await guest();
    const res = await postJson(drawPath(room), fillBody(FILL), me);
    expect(res.status).toBe(201);
    expect(res.body.shape).toEqual({ type: "fill", runs: FILL });
    expect(res.body.layerId).toBe("layer2");
  });

  it("rejects malformed fills with 400 and persists nothing", async () => {
    const room = await newRoom();
    const me = await guest();
    const bad: Array<[string, unknown]> = [
      ["no runs", fillBody([])],
      ["runs not multiple of 3", fillBody([1, 2])],
      ["span past the document's right edge", fillBody([5, 1900, 100])],
      ["row outside the document", fillBody([1080, 0, 1])],
      ["negative x", fillBody([5, -1, 4])],
      ["zero-length span", fillBody([5, 0, 0])],
      ["non-integer", fillBody([5.5, 0, 4])],
      ["runs not an array", fillBody("abc" as unknown as number[])],
      ["two seed points", fillBody(FILL, { points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] })],
      ["too many spans", fillBody(Array(3 * 60001).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)))],
    ];
    for (const [label, body] of bad) {
      const res = await postJson(drawPath(room), body, me);
      expect(res.status, label).toBe(400);
    }
    expect(await listOps(room)).toEqual([]);
  });
});

describe("fill persistence, replay, undo/redo, ownership and sync", () => {
  it("a saved fill replays from the snapshot unchanged (refresh), in seq order with other ops", async () => {
    const room = await newRoom();
    const me = await guest();
    await postJson(drawPath(room), { color: "#000000", width: 0.01, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], layerId: "layer2" }, me);
    await postJson(drawPath(room), fillBody(FILL), me);
    const ops = await listOps(room);
    expect(ops.map((o) => o.seq)).toEqual([...ops.map((o) => o.seq)].sort((a, b) => a - b));
    expect(ops[1].shape).toEqual({ type: "fill", runs: FILL });
    expect(ops[1].layerId).toBe("layer2");
    expect(ops[1].color).toBe("#55b78b");
  });

  it("undo removes only my own fill and redo restores it with the same spans and layer", async () => {
    const room = await newRoom();
    const me = await guest();
    const other = await guest();
    await postJson(drawPath(room), fillBody(FILL, { layerId: "layer1" }), other);
    await postJson(drawPath(room), fillBody(FILL), me);
    expect((await postJson(undoPath(room), {}, me)).status).toBe(200);
    let ops = await listOps(room);
    expect(ops).toHaveLength(1); // the other owner's fill is untouched
    expect(ops[0].layerId).toBe("layer1");
    expect((await postJson(redoPath(room), {}, me)).status).toBe(200);
    ops = await listOps(room);
    expect(ops).toHaveLength(2);
    expect(ops[1].shape).toEqual({ type: "fill", runs: FILL });
  });

  it("another owner's erase op never changes a fill's saved data (owner-restricted erasing)", async () => {
    const room = await newRoom();
    const me = await guest();
    const other = await guest();
    await postJson(drawPath(room), fillBody(FILL), me);
    const before = await listOps(room);
    const er = await postJson(erasePath(room), { radius: 0.05, points: [{ x: 0.1, y: 0.1 }], layerId: "layer2" }, other);
    expect(er.status).toBe(201);
    const fills = (await listOps(room)).filter((o) => o.kind === "draw");
    expect(fills).toEqual(before); // the fill op row is unchanged; erase is a separate op that only masks its OWN owner's layer client-side
  });

  it("two users: a fill by one is broadcast as an op to the other, spans intact", async () => {
    const room = await newRoom();
    const me = await guest();
    const watcher = await connect(`/api/rooms/${room}/ops/stream`);
    await watcher.nextOfType("sync");
    await postJson(drawPath(room), fillBody(FILL), me);
    const ev = await watcher.nextOfType("op");
    expect(ev.data.shape).toEqual({ type: "fill", runs: FILL });
    expect(ev.data.layerId).toBe("layer2");
    expect(ev.data.ownerId).toBeTruthy();
  });
});

describe("fill op scope validation", () => {
  it("a Private room rejects a Public layer id for a fill (validated against that scope's own layers)", async () => {
    const room = await newRoom();
    const me = await guest();
    expect((await postJson(drawPath(room), fillBody(FILL, { layerId: "colour" }), me)).status).toBe(400);
    expect(await listOps(room)).toEqual([]);
  });
});
