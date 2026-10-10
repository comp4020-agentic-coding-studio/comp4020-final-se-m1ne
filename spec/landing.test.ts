// Coverage for the landing page feature: routing (/ vs /canvas vs /room/:code),
// the onboarding/returning-visitor split, editor-refresh stability, read-only
// structural guarantees, and the Public "Online Now" presence counter's HTTP/
// SSE contract. Client-side rendering details (the read-only canvas renderer,
// the onboarding modal's own DOM wiring) have no jsdom harness of their own
// here -- this file verifies what's actually observable over real HTTP,
// matching this project's established split between server-contract tests
// (here) and client-behaviour tests (a dedicated jsdom file, where one
// exists -- see spec/app-realtime-stroke.test.ts for that pattern elsewhere
// in this suite). Presence staleness/cleanup and historical-vs-active
// counting are covered deterministically (via injected `now`, no real
// waiting) in spec/rooms-lifecycle.test.ts's own "Public Canvas presence"
// block instead of here, where only Date.now()-driven real time is
// available.

import { afterEach, expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

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

// A minimal SSE client, same shape as spec/freehand-realtime.test.ts's own
// SseClient (copied from there rather than reimplemented): reads one frame
// at a time off a single persistent connection, which is what lets this
// file read Public's "sync" frame and then a later "presence" broadcast off
// the exact same stream, in order.
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
        this.drain();
      }
    } catch {
      // aborted (close()) or the connection dropped -- either way, done.
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
      const ev: SseEvent = { event, data: JSON.parse(data) };
      const waiter = this.waiters.shift();
      if (waiter) waiter(ev);
      else this.queue.push(ev);
    }
  }

  next(timeoutMs = 2000): Promise<SseEvent> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for an SSE event")), timeoutMs);
      this.waiters.push((ev) => {
        clearTimeout(timer);
        resolve(ev);
      });
    });
  }

  close() {
    this.controller.abort();
  }
}

const openClients: SseClient[] = [];
async function connect(path: string): Promise<SseClient> {
  const client = await SseClient.connect(path);
  openClients.push(client);
  return client;
}
afterEach(() => {
  while (openClients.length > 0) openClients.pop()!.close();
});

it("the root URL serves the landing page, never the editor", async () => {
  const res = await fetch(new URL("/", baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('id="landing-canvas"');
  expect(html).toContain("Enter Canvas");
  // Structurally read-only: the landing page never loads either of the
  // interactive editor's own entry scripts, so there is no code path here at
  // all by which it could become drawable/erasable/pannable.
  expect(html).not.toContain("pixel-editor.js");
  expect(html).not.toContain('src="/app.js"');
});

it("/canvas serves the editor shell directly (Public, no onboarding gate of its own)", async () => {
  const res = await fetch(new URL("/canvas", baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('id="canvas"');
  expect(html).toContain("pixel-editor.js");
  expect(html).not.toContain('id="landing-canvas"');
});

it("refreshing /canvas keeps the user in the editor every time, not back on the landing page", async () => {
  const first = await fetch(new URL("/canvas", baseUrl));
  const second = await fetch(new URL("/canvas", baseUrl));
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const [firstHtml, secondHtml] = await Promise.all([first.text(), second.text()]);
  expect(firstHtml).toContain('id="canvas"');
  expect(secondHtml).toContain('id="canvas"');
});

it("an unknown room's 404 page points back to the editor (/canvas), not the landing page", async () => {
  const res = await fetch(new URL("/room/ZZZZZZ", baseUrl));
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(html).toContain('href="/canvas"');
});

it("a real Private Room still serves the editor shell at /room/:code, landing page untouched", async () => {
  const created = await postJson("/api/rooms", {});
  const code = created.body.code as string;
  const res = await fetch(new URL(`/room/${code}`, baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('id="canvas"');
});

it("the editor shell's own 'Back to Public Canvas' link returns to /canvas, not the landing page", async () => {
  const created = await postJson("/api/rooms", {});
  const code = created.body.code as string;
  const res = await fetch(new URL(`/room/${code}`, baseUrl));
  const html = await res.text();
  expect(html).toContain('href="/canvas" id="back-to-public"');
});

it("GET /api/me distinguishes a new visitor (nickname null) from a returning one, same contract the Welcome dialog's pre-fill/button-label relies on", async () => {
  const fresh = await fetch(new URL("/api/me", baseUrl));
  const freshBody = await fresh.json();
  expect(freshBody.nickname).toBeNull();
  const cookie = fresh.headers.get("set-cookie")?.split(";")[0];

  await postJson("/api/me/profile", { nickname: "Avery", cursorColor: "#1e88e5" }, cookie);

  const returning = await fetch(new URL("/api/me", baseUrl), { headers: withCookie(cookie) });
  const returningBody = await returning.json();
  expect(returningBody.nickname).toBe("Avery"); // the Welcome dialog would pre-fill this, not leave it blank
});

it("re-saving a profile under the same cookie updates the same guest identity, never creating a second one", async () => {
  const fresh = await fetch(new URL("/api/me", baseUrl));
  const ownerId = (await fresh.json()).ownerId as string;
  const cookie = fresh.headers.get("set-cookie")?.split(";")[0];

  await postJson("/api/me/profile", { nickname: "Jamie", cursorColor: "#112233" }, cookie);
  const afterFirst = await postJson("/api/me/profile", { nickname: "JamieV2", cursorColor: "#445566" }, cookie);
  expect(afterFirst.body.ownerId).toBe(ownerId); // same identity throughout, no new cookie/owner minted

  const me = await fetch(new URL("/api/me", baseUrl), { headers: withCookie(cookie) }).then((r) => r.json());
  expect(me.ownerId).toBe(ownerId);
  expect(me.nickname).toBe("JamieV2"); // the one record was updated in place, not duplicated
});

it("Public's SSE sync frame reports a numeric onlineCount, and a heartbeat broadcasts an updated 'presence' event on the same stream", async () => {
  const stream = await connect("/api/ops/stream");
  const sync = await stream.next();
  expect(sync.event).toBe("sync");
  expect(typeof sync.data.onlineCount).toBe("number");

  const hb = await postJson("/api/presence/heartbeat", { presenceId: crypto.randomUUID() });
  expect(hb.status).toBe(200);
  expect(typeof hb.body.count).toBe("number");

  // Public's own stream is shared with every other concurrently-running spec
  // file in this suite (draws, cursors, other heartbeats) -- same documented
  // tradeoff spec/freehand-realtime.test.ts's own Public-isolation test
  // notes, so this looks for a "presence" event within a bounded window
  // rather than asserting it is literally the very next frame.
  let sawPresence = false;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !sawPresence) {
    const ev = await stream.next(deadline - Date.now());
    if (ev.event === "presence") {
      expect(typeof ev.data.count).toBe("number");
      sawPresence = true;
    }
  }
  expect(sawPresence).toBe(true);
});

it("/api/presence/heartbeat and /leave both require a presenceId", async () => {
  const hb = await postJson("/api/presence/heartbeat", {});
  expect(hb.status).toBe(400);
  const leave = await postJson("/api/presence/leave", {});
  expect(leave.status).toBe(400);
});

it("leaving Public presence is reflected in the next heartbeat's count, same shape as joining", async () => {
  const idA = crypto.randomUUID();
  const idB = crypto.randomUUID();
  const after1 = await postJson("/api/presence/heartbeat", { presenceId: idA });
  const after2 = await postJson("/api/presence/heartbeat", { presenceId: idB });
  expect(after2.body.count).toBeGreaterThanOrEqual(after1.body.count);

  const afterLeave = await postJson("/api/presence/leave", { presenceId: idB });
  expect(afterLeave.body.count).toBeLessThan(after2.body.count);
});
