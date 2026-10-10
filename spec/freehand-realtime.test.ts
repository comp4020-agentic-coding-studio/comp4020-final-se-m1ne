// Essential, real-HTTP+SSE coverage for the NEW freehand real-time streams
// (/api/ops/stream, /api/rooms/:code/ops/stream) -- generalized server-side
// from the pixel editor's own already-tested SSE machinery (see
// spec/pixel-realtime.test.ts, whose SseClient this file's own is copied
// from verbatim). Freehand is the restored C8 drawing model and is now
// Public's own live experience again (see public/pixeldoc.js's
// resolveEditorMode); this file proves the NEW stream wiring specifically,
// not a second copy of pixelgrid.js/replay correctness (freehand has no
// such replay engine at all -- layers compositing is the whole model).

import { afterEach, describe, expect, it } from "vitest";
import { inject } from "vitest";

const baseUrl = inject("baseUrl");

type SseEvent = { event: string; data: any };

class SseClient {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private queue: SseEvent[] = [];
  private waiters: Array<(ev: SseEvent) => void> = [];
  private controller: AbortController;
  closed = false;

  private constructor(reader: ReadableStreamDefaultReader<Uint8Array>, controller: AbortController) {
    this.reader = reader;
    this.controller = controller;
    this.pump();
  }

  static async connect(path: string, cookie?: string): Promise<SseClient> {
    const controller = new AbortController();
    const res = await fetch(new URL(path, baseUrl), {
      headers: cookie ? { Cookie: cookie } : {},
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE connect to ${path} failed with status ${res.status}`);
    }
    return new SseClient(res.body.getReader(), controller);
  }

  private async pump() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += this.decoder.decode(value, { stream: true });
        this.drain();
      }
    } catch {
      // aborted (close()) or the connection dropped -- either way, done.
    } finally {
      this.closed = true;
    }
  }

  private drain() {
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = data;
      }
      const ev: SseEvent = { event, data: parsed };
      const waiter = this.waiters.shift();
      if (waiter) waiter(ev);
      else this.queue.push(ev);
    }
  }

  next(timeoutMs = 2000): Promise<SseEvent> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(onEvent);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error("timed out waiting for an SSE event"));
      }, timeoutMs);
      const onEvent = (ev: SseEvent) => {
        clearTimeout(timer);
        resolve(ev);
      };
      this.waiters.push(onEvent);
    });
  }

  close() {
    this.controller.abort();
  }
}

const openClients: SseClient[] = [];
async function connect(path: string, cookie?: string): Promise<SseClient> {
  const client = await SseClient.connect(path, cookie);
  openClients.push(client);
  return client;
}

afterEach(() => {
  while (openClients.length > 0) openClients.pop()!.close();
});

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

async function createFreehandRoom(): Promise<string> {
  const created = await postJson("/api/rooms", {}); // no width/height/resolution -- a plain C8-shaped freehand room
  return created.body.code as string;
}

const FREEHAND_DRAW = { color: "#1d1d1d", width: 0.02, points: [{ x: 0.2, y: 0.2 }] };

it("a Private freehand room's stream sends an authoritative sync frame first, then an op broadcast on draw", async () => {
  const code = await createFreehandRoom();
  const stream = await connect(`/api/rooms/${code}/ops/stream`);
  const sync = await stream.next();
  expect(sync.event).toBe("sync");
  expect(sync.data).toMatchObject({ docKind: "freehand", ops: [] });

  const posted = await postJson(`/api/rooms/${code}/ops/draw`, FREEHAND_DRAW);
  expect(posted.status).toBe(201);
  const opEvent = await stream.next();
  expect(opEvent.event).toBe("op");
  expect(opEvent.data).toMatchObject({ id: posted.body.id, kind: "draw", active: true });
});

it("undo broadcasts an 'undo' event for the matching op", async () => {
  const code = await createFreehandRoom();
  const stream = await connect(`/api/rooms/${code}/ops/stream`);
  await stream.next(); // sync
  const posted = await postJson(`/api/rooms/${code}/ops/draw`, FREEHAND_DRAW);
  await stream.next(); // op

  const undone = await postJson(`/api/rooms/${code}/undo`, {}, posted.cookie);
  expect(undone.status).toBe(200);
  const undoEvent = await stream.next();
  expect(undoEvent.event).toBe("undo");
  expect(undoEvent.data).toMatchObject({ id: posted.body.id, active: false });
});

it("two Private freehand rooms are isolated from each other's streams", async () => {
  const codeA = await createFreehandRoom();
  const codeB = await createFreehandRoom();
  const streamB = await connect(`/api/rooms/${codeB}/ops/stream`);
  await streamB.next(); // sync for B

  await postJson(`/api/rooms/${codeA}/ops/draw`, FREEHAND_DRAW);
  await expect(streamB.next(300)).rejects.toThrow(); // A's draw never reaches B's stream
});

it("a pixel-art room rejects the freehand stream route (400), directing to its own pixel stream", async () => {
  const created = await postJson("/api/rooms", { resolution: 32 });
  const code = created.body.code as string;
  const res = await fetch(new URL(`/api/rooms/${code}/ops/stream`, baseUrl));
  expect(res.status).toBe(400);
});

it("the Public freehand stream and a Private freehand room's stream never leak into each other", async () => {
  const code = await createFreehandRoom();
  const publicStream = await connect("/api/ops/stream");
  await publicStream.next(); // sync
  const roomStream = await connect(`/api/rooms/${code}/ops/stream`);
  await roomStream.next(); // sync

  const roomDraw = await postJson(`/api/rooms/${code}/ops/draw`, FREEHAND_DRAW);
  const roomEvent = await roomStream.next();
  expect(roomEvent.data.id).toBe(roomDraw.body.id);

  // Public's own stream must not have received the room's draw -- give it a
  // short, bounded window rather than asserting total silence (other spec
  // files draw on Public concurrently; see spec/pixel-realtime.test.ts's own
  // comment on this exact tradeoff), then confirm that specific id never
  // shows up even if something else did.
  let sawRoomOpOnPublic = false;
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    try {
      const ev = await publicStream.next(deadline - Date.now());
      if (ev.event === "op" && ev.data.id === roomDraw.body.id) sawRoomOpOnPublic = true;
    } catch {
      break;
    }
  }
  expect(sawRoomOpOnPublic).toBe(false);
});

describe("ephemeral freehand cursors", () => {
  it("a visible cursor broadcasts position and a colour, with no nickname field when showNickname is false", async () => {
    const code = await createFreehandRoom();
    const stream = await connect(`/api/rooms/${code}/ops/stream`);
    await stream.next(); // sync

    const res = await postJson(`/api/rooms/${code}/ops/cursor`, { x: 0.3, y: 0.6, showCursor: true, showNickname: false });
    expect(res.status).toBe(200);

    const cursor = await stream.next();
    expect(cursor.event).toBe("cursor");
    expect(cursor.data.x).toBe(0.3);
    expect(cursor.data.y).toBe(0.6);
    expect(typeof cursor.data.color).toBe("string");
    expect(cursor.data.nickname).toBeUndefined();
  });

  it("showCursor:false broadcasts cursor-hide and needs no position", async () => {
    const code = await createFreehandRoom();
    const stream = await connect(`/api/rooms/${code}/ops/stream`);
    await stream.next();
    const res = await postJson(`/api/rooms/${code}/ops/cursor`, { showCursor: false });
    expect(res.status).toBe(200);
    const ev = await stream.next();
    expect(ev.event).toBe("cursor-hide");
  });

  it("a pixel-art room rejects the freehand cursor route (400)", async () => {
    const created = await postJson("/api/rooms", { resolution: 32 });
    const code = created.body.code as string;
    const res = await postJson(`/api/rooms/${code}/ops/cursor`, { showCursor: false });
    expect(res.status).toBe(400);
  });
});

describe("ephemeral in-progress stroke previews", () => {
  const PREVIEW = { active: true, kind: "draw", color: "#ff8800", size: 0.03, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] };

  it("broadcasts incremental preview updates before any op is ever posted -- a stroke can be streamed in full before pointerup", async () => {
    const code = await createFreehandRoom();
    const stream = await connect(`/api/rooms/${code}/ops/stream`);
    await stream.next(); // sync

    const first = await postJson(`/api/rooms/${code}/ops/stroke`, PREVIEW);
    expect(first.status).toBe(200);
    const firstEvent = await stream.next();
    expect(firstEvent.event).toBe("stroke");
    expect(firstEvent.data).toMatchObject({ kind: "draw", color: "#ff8800", size: 0.03 });
    expect(firstEvent.data.points).toHaveLength(2);

    // A second, later update with more points -- the growing-stroke case.
    const grown = { ...PREVIEW, points: [...PREVIEW.points, { x: 0.3, y: 0.3 }] };
    await postJson(`/api/rooms/${code}/ops/stroke`, grown, first.cookie);
    const secondEvent = await stream.next();
    expect(secondEvent.event).toBe("stroke");
    expect(secondEvent.data.points).toHaveLength(3);

    // Still nothing persisted -- this is purely ephemeral broadcast traffic.
    const ops = await fetch(new URL(`/api/rooms/${code}/ops`, baseUrl)).then((r) => r.json());
    expect(ops).toHaveLength(0);
  });

  it("an erase preview reports kind 'erase' with color normalized to null", async () => {
    const code = await createFreehandRoom();
    const stream = await connect(`/api/rooms/${code}/ops/stream`);
    await stream.next();

    await postJson(`/api/rooms/${code}/ops/stroke`, { active: true, kind: "erase", size: 0.05, points: [{ x: 0.4, y: 0.4 }] });
    const ev = await stream.next();
    expect(ev.event).toBe("stroke");
    expect(ev.data.kind).toBe("erase");
    expect(ev.data.color).toBeNull();
  });

  it("active:false broadcasts stroke-end -- the final-reconciliation/cancellation signal, needing no other fields", async () => {
    const code = await createFreehandRoom();
    const stream = await connect(`/api/rooms/${code}/ops/stream`);
    await stream.next();

    const res = await postJson(`/api/rooms/${code}/ops/stroke`, { active: false });
    expect(res.status).toBe(200);
    const ev = await stream.next();
    expect(ev.event).toBe("stroke-end");
    expect(typeof ev.data.ownerId).toBe("string");
  });

  it("a preview is never mistaken for the real thing: the authoritative 'op' still follows normally after one", async () => {
    const code = await createFreehandRoom();
    const stream = await connect(`/api/rooms/${code}/ops/stream`);
    await stream.next();

    const preview = await postJson(`/api/rooms/${code}/ops/stroke`, PREVIEW);
    await stream.next(); // stroke
    const draw = await postJson(`/api/rooms/${code}/ops/draw`, FREEHAND_DRAW, preview.cookie);
    expect(draw.status).toBe(201);
    const opEvent = await stream.next();
    expect(opEvent.event).toBe("op");
    expect(opEvent.data).toMatchObject({ id: draw.body.id, kind: "draw", active: true });
  });

  it("rejects a malformed preview (missing points, bad kind, non-positive size, or a draw with no color)", async () => {
    const code = await createFreehandRoom();
    for (const body of [
      { active: true, kind: "draw", color: "#000", size: 0.02, points: [] },
      { active: true, kind: "sparkle", color: "#000", size: 0.02, points: [{ x: 0, y: 0 }] },
      { active: true, kind: "draw", color: "#000", size: -1, points: [{ x: 0, y: 0 }] },
      { active: true, kind: "draw", size: 0.02, points: [{ x: 0, y: 0 }] },
    ]) {
      const res = await postJson(`/api/rooms/${code}/ops/stroke`, body);
      expect(res.status).toBe(400);
    }
  });

  it("two Private freehand rooms' stroke previews are isolated from each other", async () => {
    const codeA = await createFreehandRoom();
    const codeB = await createFreehandRoom();
    const streamB = await connect(`/api/rooms/${codeB}/ops/stream`);
    await streamB.next();

    await postJson(`/api/rooms/${codeA}/ops/stroke`, PREVIEW);
    await expect(streamB.next(300)).rejects.toThrow();
  });

  it("a pixel-art room rejects the freehand stroke route (400)", async () => {
    const created = await postJson("/api/rooms", { resolution: 32 });
    const code = created.body.code as string;
    const res = await postJson(`/api/rooms/${code}/ops/stroke`, { active: false });
    expect(res.status).toBe(400);
  });
});
