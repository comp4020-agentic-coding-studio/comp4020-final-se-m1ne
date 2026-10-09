import { afterEach, describe, expect, it } from "vitest";
import { inject } from "vitest";

const baseUrl = inject("baseUrl");

// --- Minimal hand-rolled SSE client ------------------------------------------
// No new dependency: Node's global fetch (undici) already returns a Response
// whose .body is a standard web ReadableStream, which is all an SSE client
// needs -- read bytes, split on blank lines, parse "event:"/"data:" fields.
// AbortController is what lets a test close/disconnect a stream on demand,
// which is also what server-side disconnect cleanup is tested against below.
//
// All spec/*.test.ts files share ONE spawned server process (see
// spec/global-setup.ts) and run concurrently, so the Public pixel scope is
// NOT exclusive to this file -- spec/pixel-api.test.ts also posts to
// /api/pixels/* while this file runs. Private pixel rooms, by contrast, get a
// cryptographically random code per test and are never touched by any other
// file, so most tests below exercise the exact same shared handler code
// (handlePixelDraw/handlePixelErase/handlePixelCursor/startPixelStream all
// take roomId as a parameter; Public is just roomId = null) against a room
// instead of Public, specifically to get a scope no other file can inject
// noise into. The handful of tests that must specifically prove something
// about Public (its own 512x288 identity, or true cross-scope isolation)
// are written to tolerate interleaved noise from other files rather than
// assume exclusive access to the stream.

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
      if (raw.length === 0 || raw.startsWith(":")) continue; // a bare heartbeat comment line, not an event

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

  async expectNoEventWithin(ms = 400): Promise<void> {
    await expect(this.next(ms)).rejects.toThrow();
  }

  // Tolerant collection, for scopes that are NOT exclusive to this test (i.e.
  // Public, shared with other concurrently-running spec files): drains
  // whatever arrives within the window, if anything, instead of requiring
  // silence. Used to prove a SPECIFIC id/event never arrives, without
  // asserting nothing else ever does.
  async collectWithin(ms: number): Promise<SseEvent[]> {
    const collected: SseEvent[] = [];
    const deadline = Date.now() + ms;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        collected.push(await this.next(remaining));
      } catch {
        break;
      }
    }
    return collected;
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

// --- HTTP helpers (mirroring spec/pixel-api.test.ts's own style) -----------

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

async function createPixelRoom(resolution = 32) {
  const created = await postJson("/api/rooms", { resolution });
  return created.body.code as string;
}

const PIXEL_DRAW = { color: "#1d1d1d", size: 2, points: [{ x: 5, y: 5 }] };

// --- 2. Snapshot-first behaviour ---------------------------------------------

describe("snapshot-first behaviour", () => {
  it("the Public pixel stream's first event is a sync snapshot reporting Public's own 512x288 grid and every existing pixel op in seq order", async () => {
    const a = await postJson("/api/pixels/draw", PIXEL_DRAW);
    const b = await postJson("/api/pixels/draw", { ...PIXEL_DRAW, points: [{ x: 6, y: 6 }] }, a.cookie);

    const stream = await connect("/api/pixels/stream");
    const first = await stream.next();
    expect(first.event).toBe("sync");
    expect(first.data.docKind).toBe("pixel");
    expect(first.data.width).toBe(512);
    expect(first.data.height).toBe(288);
    const ids = first.data.ops.map((op: any) => op.id);
    expect(ids).toContain(a.body.id);
    expect(ids).toContain(b.body.id);
    expect(ids.indexOf(a.body.id)).toBeLessThan(ids.indexOf(b.body.id)); // authoritative seq order
  });

  it("a Private pixel room's stream snapshot reports that room's own resolution and only its own ops", async () => {
    const code = await createPixelRoom(64);
    const posted = await postJson(`/api/rooms/${code}/pixels/draw`, PIXEL_DRAW);

    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    const first = await stream.next();
    expect(first.event).toBe("sync");
    expect(first.data).toMatchObject({ docKind: "pixel", width: 64, height: 64 });
    expect(first.data.ops.map((op: any) => op.id)).toEqual([posted.body.id]);
  });

  it("a late subscriber receives prior history only via the snapshot, not as replayed individual op events", async () => {
    const code = await createPixelRoom(32);
    await postJson(`/api/rooms/${code}/pixels/draw`, PIXEL_DRAW);
    await postJson(`/api/rooms/${code}/pixels/draw`, { ...PIXEL_DRAW, points: [{ x: 7, y: 7 }] });

    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    const first = await stream.next();
    expect(first.event).toBe("sync");
    expect(first.data.ops.length).toBe(2);
    await stream.expectNoEventWithin(); // this room is exclusive to this test -- truly nothing else arrives
  });

  it("reconnecting (a fresh connection to the same stream) receives a fresh snapshot reflecting everything written since the first connection", async () => {
    const code = await createPixelRoom(32);
    const first = await connect(`/api/rooms/${code}/pixels/stream`);
    await first.next(); // initial sync
    const posted = await postJson(`/api/rooms/${code}/pixels/draw`, PIXEL_DRAW);
    const live = await first.next(); // the live op event on the first connection
    expect(live.data.id).toBe(posted.body.id);
    first.close();

    const reconnected = await connect(`/api/rooms/${code}/pixels/stream`);
    const snapshot = await reconnected.next();
    expect(snapshot.event).toBe("sync");
    expect(snapshot.data.ops.some((op: any) => op.id === posted.body.id)).toBe(true);
  });
});

// --- 4. Scope isolation -------------------------------------------------------

describe("scope isolation", () => {
  it("a Private room's pixel op never reaches Public's stream or a different room's stream", async () => {
    const roomA = await createPixelRoom(32);
    const roomB = await createPixelRoom(32);

    const publicStream = await connect("/api/pixels/stream");
    const streamA = await connect(`/api/rooms/${roomA}/pixels/stream`);
    const streamB = await connect(`/api/rooms/${roomB}/pixels/stream`);
    await publicStream.next();
    await streamA.next();
    await streamB.next();

    const posted = await postJson(`/api/rooms/${roomA}/pixels/draw`, PIXEL_DRAW);

    const onA = await streamA.next();
    expect(onA.event).toBe("op");
    expect(onA.data.id).toBe(posted.body.id);

    // roomB is exclusive to this test -- a true silence check is valid here.
    await streamB.expectNoEventWithin();

    // Public is shared with other concurrently-running spec files, so a
    // silence check would be flaky; instead, prove this SPECIFIC op's id
    // never appears among whatever (if anything) does arrive there.
    const publicNoise = await publicStream.collectWithin(400);
    expect(publicNoise.some((ev) => ev.data?.id === posted.body.id)).toBe(false);
  });

  it("GET /api/rooms/:code/pixels/stream 404s for an unknown room and 400s for a legacy freehand room", async () => {
    const unknown = await fetch(new URL("/api/rooms/ZZZZZZ/pixels/stream", baseUrl));
    expect(unknown.status).toBe(404);

    const legacy = await postJson("/api/rooms", {});
    const legacyStream = await fetch(new URL(`/api/rooms/${legacy.body.code}/pixels/stream`, baseUrl));
    expect(legacyStream.status).toBe(400);
  });
});

// --- 3. Draw / erase / undo / redo propagation, and no broadcast on failure --
// Every test below uses its own fresh private pixel room so a strict,
// exact-next-event assertion (and a true silence check for the "no
// broadcast" cases) is never at risk of cross-file interference -- this
// exercises the identical handlePixelDraw/handlePixelErase/undo/redo +
// broadcastPixelEvent code Public also runs, just parameterized by a room's
// roomId instead of null.

describe("op/undo/redo broadcast", () => {
  it("a draw and an erase each broadcast exactly one 'op' event, carrying the persisted op's id/seq/ownerId/createdAt and active: true", async () => {
    const code = await createPixelRoom(32);
    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    await stream.next(); // sync

    const drawRes = await postJson(`/api/rooms/${code}/pixels/draw`, PIXEL_DRAW);
    const drawEvent = await stream.next();
    expect(drawEvent.event).toBe("op");
    expect(drawEvent.data).toMatchObject({
      id: drawRes.body.id,
      seq: drawRes.body.seq,
      ownerId: drawRes.body.ownerId,
      createdAt: drawRes.body.createdAt,
      kind: "draw",
      active: true,
    });

    const eraseRes = await postJson(
      `/api/rooms/${code}/pixels/erase`,
      { size: 2, points: [{ x: 5, y: 5 }] },
      drawRes.cookie,
    );
    const eraseEvent = await stream.next();
    expect(eraseEvent.event).toBe("op");
    expect(eraseEvent.data).toMatchObject({ id: eraseRes.body.id, kind: "erase", active: true });
  });

  it("undo broadcasts an 'undo' event (active: false) and redo broadcasts a 'redo' event (active: true) for the same id/seq", async () => {
    const code = await createPixelRoom(32);
    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    await stream.next(); // sync
    const posted = await postJson(`/api/rooms/${code}/pixels/draw`, PIXEL_DRAW);
    await stream.next(); // the draw's own op event

    const undone = await postJson(`/api/rooms/${code}/pixels/undo`, {}, posted.cookie);
    const undoEvent = await stream.next();
    expect(undoEvent.event).toBe("undo");
    expect(undoEvent.data).toMatchObject({ id: posted.body.id, seq: posted.body.seq, active: false });
    expect(undone.body.op.id).toBe(posted.body.id);

    const redone = await postJson(`/api/rooms/${code}/pixels/redo`, {}, posted.cookie);
    const redoEvent = await stream.next();
    expect(redoEvent.event).toBe("redo");
    expect(redoEvent.data).toMatchObject({ id: posted.body.id, seq: posted.body.seq, active: true });
    expect(redone.body.op.seq).toBe(posted.body.seq); // same row, not a fresh insert
  });

  it("an owner with nothing to undo/redo triggers no broadcast at all", async () => {
    const code = await createPixelRoom(32);
    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    await stream.next(); // sync
    const noop = await postJson(`/api/rooms/${code}/pixels/undo`, {}); // a fresh owner, nothing of theirs exists
    expect(noop.body.op).toBeNull();
    await stream.expectNoEventWithin();
  });

  it("an invalid/rejected pixel draw never broadcasts", async () => {
    const code = await createPixelRoom(32);
    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    await stream.next(); // sync

    const badSize = await postJson(`/api/rooms/${code}/pixels/draw`, {
      color: "#1d1d1d",
      size: 99,
      points: [{ x: 1, y: 1 }],
    });
    expect(badSize.status).toBe(400);
    const outOfBounds = await postJson(`/api/rooms/${code}/pixels/draw`, {
      color: "#1d1d1d",
      size: 1,
      points: [{ x: 9999, y: 1 }],
    });
    expect(outOfBounds.status).toBe(400);

    await stream.expectNoEventWithin();
  });

  it("an invalid/rejected pixel erase never broadcasts", async () => {
    const code = await createPixelRoom(32);
    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    await stream.next(); // sync
    const bad = await postJson(`/api/rooms/${code}/pixels/erase`, { size: 0, points: [{ x: 1, y: 1 }] });
    expect(bad.status).toBe(400);
    await stream.expectNoEventWithin();
  });
});

// --- 6. Cursors ---------------------------------------------------------------
// Also run against a dedicated private pixel room per test, for the same
// interference-free reason as the op/undo/redo tests above -- handlePixelCursor
// is the exact same function for Public and a room.

describe("ephemeral cursors", () => {
  it("a visible cursor with showNickname:false broadcasts position and a deterministic colour, with no nickname field", async () => {
    const code = await createPixelRoom(32);
    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    await stream.next(); // sync

    const res = await postJson(`/api/rooms/${code}/pixels/cursor`, { x: 10, y: 20, showCursor: true, showNickname: false });
    expect(res.status).toBe(200);

    const cursor = await stream.next();
    expect(cursor.event).toBe("cursor");
    expect(cursor.data.x).toBe(10);
    expect(cursor.data.y).toBe(20);
    expect(typeof cursor.data.color).toBe("string");
    expect(cursor.data.color.length).toBeGreaterThan(0);
    expect(cursor.data.nickname).toBeUndefined();
  });

  it("showCursor:false broadcasts cursor-hide and nothing else, needing no position at all", async () => {
    const code = await createPixelRoom(32);
    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    await stream.next(); // sync
    const res = await postJson(`/api/rooms/${code}/pixels/cursor`, { showCursor: false });
    expect(res.status).toBe(200);

    const hide = await stream.next();
    expect(hide.event).toBe("cursor-hide");
    expect(typeof hide.data.ownerId).toBe("string");
    expect(hide.data.x).toBeUndefined();
  });

  it("cursor colour is deterministic for the same owner across multiple updates, never client-controlled", async () => {
    const code = await createPixelRoom(32);
    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    await stream.next(); // sync

    const first = await postJson(`/api/rooms/${code}/pixels/cursor`, {
      x: 1, y: 1, showCursor: true, showNickname: false, color: "red",
    });
    const firstEvent = await stream.next();
    await postJson(
      `/api/rooms/${code}/pixels/cursor`,
      { x: 2, y: 2, showCursor: true, showNickname: false, color: "blue" },
      first.cookie,
    );
    const secondEvent = await stream.next();

    expect(firstEvent.data.color).toBe(secondEvent.data.color); // same owner -> same colour every time
    expect(firstEvent.data.color).not.toBe("red"); // the client-supplied colour was never honoured
    expect(secondEvent.data.color).not.toBe("blue");
  });

  it("nickname visibility: shown only when showNickname is true AND the owner has actually set one; never a spoofed value", async () => {
    const code = await createPixelRoom(32);
    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    await stream.next(); // sync

    const named = await postJson("/api/me/nickname", { nickname: "Casey" });
    await postJson(`/api/rooms/${code}/pixels/cursor`, { x: 1, y: 1, showCursor: true, showNickname: true }, named.cookie);
    const withNickname = await stream.next();
    expect(withNickname.data.nickname).toBe("Casey");
    expect(withNickname.data.ownerId).toBe(named.body.ownerId);

    await postJson(`/api/rooms/${code}/pixels/cursor`, { x: 2, y: 2, showCursor: true, showNickname: false }, named.cookie);
    const nicknameHidden = await stream.next();
    expect(nicknameHidden.data.nickname).toBeUndefined();

    // showNickname: true but a spoofed nickname field and no real one set for THIS (different, fresh) owner
    await postJson(`/api/rooms/${code}/pixels/cursor`, {
      x: 3, y: 3, showCursor: true, showNickname: true, nickname: "FAKE",
    });
    const spoofed = await stream.next();
    expect(spoofed.data.nickname).toBeUndefined(); // no real nickname on file -- the spoofed one is never used
    expect(spoofed.data.ownerId).not.toBe(named.body.ownerId);
  });

  it("cursor identity always comes from the cookie, never a client-supplied ownerId", async () => {
    const code = await createPixelRoom(32);
    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    await stream.next(); // sync
    const res = await postJson(`/api/rooms/${code}/pixels/cursor`, {
      x: 1, y: 1, showCursor: true, showNickname: false, ownerId: "someone-else-entirely",
    });
    expect(res.status).toBe(200);
    const cursor = await stream.next();
    expect(cursor.data.ownerId).not.toBe("someone-else-entirely");
  });

  it("cursor validation rejects out-of-bounds, non-finite, and missing/malformed fields, broadcasting nothing", async () => {
    const code = await createPixelRoom(32); // 32x32: valid coordinates are [0,32)
    const stream = await connect(`/api/rooms/${code}/pixels/stream`);
    await stream.next(); // sync

    const cases = [
      { x: 32, y: 0, showCursor: true, showNickname: false },
      { x: 0, y: 32, showCursor: true, showNickname: false },
      { x: -1, y: 0, showCursor: true, showNickname: false },
      { x: NaN, y: 0, showCursor: true, showNickname: false },
      { x: "5", y: 0, showCursor: true, showNickname: false },
      { x: 1, y: 1, showCursor: "yes", showNickname: false },
      { x: 1, y: 1, showCursor: true, showNickname: "no" },
      { x: 1, y: 1 }, // showCursor missing entirely
    ];
    for (const body of cases) {
      const res = await postJson(`/api/rooms/${code}/pixels/cursor`, body);
      expect(res.status).toBe(400);
    }
    await stream.expectNoEventWithin();
  });

  it("a Private pixel room's cursor is validated against its own resolution and never leaks to Public", async () => {
    const code = await createPixelRoom(32);
    const streamA = await connect(`/api/rooms/${code}/pixels/stream`);
    const publicStream = await connect("/api/pixels/stream");
    await streamA.next();
    await publicStream.next();

    const outOfBoundsForRoom = await postJson(`/api/rooms/${code}/pixels/cursor`, {
      x: 40, // valid on Public's 512-wide grid, but out of bounds for a 32x32 room
      y: 0,
      showCursor: true,
      showNickname: false,
    });
    expect(outOfBoundsForRoom.status).toBe(400);

    const valid = await postJson(`/api/rooms/${code}/pixels/cursor`, { x: 10, y: 10, showCursor: true, showNickname: false });
    expect(valid.status).toBe(200);
    const onRoom = await streamA.next();
    expect(onRoom.event).toBe("cursor");

    const publicNoise = await publicStream.collectWithin(400);
    expect(publicNoise.some((ev) => ev.event === "cursor" && ev.data?.ownerId === onRoom.data.ownerId)).toBe(false);
  });

  it("legacy rooms reject the pixel cursor route", async () => {
    const legacy = await postJson("/api/rooms", {});
    const res = await postJson(`/api/rooms/${legacy.body.code}/pixels/cursor`, {
      x: 1, y: 1, showCursor: true, showNickname: false,
    });
    expect(res.status).toBe(400);
  });
});

// --- Disconnect cleanup (testable black-box property) ------------------------

describe("disconnect cleanup", () => {
  it("closing one subscriber's connection does not disrupt broadcasting to another subscriber in the same scope", async () => {
    const code = await createPixelRoom(32);
    const toClose = await connect(`/api/rooms/${code}/pixels/stream`);
    const survivor = await connect(`/api/rooms/${code}/pixels/stream`);
    await toClose.next();
    await survivor.next();

    toClose.close();
    // Give the server a brief moment to observe the close before the next write.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const posted = await postJson(`/api/rooms/${code}/pixels/draw`, PIXEL_DRAW);
    const event = await survivor.next();
    expect(event.event).toBe("op");
    expect(event.data.id).toBe(posted.body.id);
  });
});
