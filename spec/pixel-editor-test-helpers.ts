// Shared jsdom test scaffolding for public/pixel-editor.js, used by every
// spec/pixel-editor-*.test.ts file that boots the REAL module against the
// REAL public/index.html markup. jsdom implements neither real canvas
// rendering nor EventSource at all (confirmed: `typeof new JSDOM().window
// .EventSource === "undefined"`), so both are stubbed here -- the stubs are
// deliberately minimal (just enough to not throw and to let a test control
// what "arrives"), never a reimplementation of real SSE/canvas semantics.

import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const indexHtmlPath = path.resolve(__dirname, "../public/index.html");
const fullIndexHtml = fs.readFileSync(indexHtmlPath, "utf8");
export const bodyHtml = fullIndexHtml.match(/<body>([\s\S]*)<\/body>/)![1];

export type PostedRequest = { url: string; body: Record<string, unknown> };

export function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => data,
    headers: { get: () => null },
  } as unknown as Response;
}

// A minimal fake EventSource: records every instance (tests grab the latest
// one to simulate server frames via .emit), and supports exactly the two
// methods public/pixel-editor.js actually calls (addEventListener, close).
// Never fires anything on its own -- every "sync"/"op"/"undo"/"redo" frame in
// a test is an explicit, deliberate .emit() call, so a test's behaviour is
// never dependent on real network/timer scheduling.
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  private listeners: Record<string, Array<(event: { data: string }) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: { data: string }) => void) {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener(type: string, handler: (event: { data: string }) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const handler of this.listeners[type] ?? []) handler({ data: JSON.stringify(data) });
  }
}

export function latestEventSource(): FakeEventSource {
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!source) throw new Error("no EventSource was constructed yet");
  return source;
}

export function installEventSourceStub() {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
}

// Mocks exactly the handful of plain (non-stream) endpoints a pixel-editor
// boot and a draw/erase/undo/redo gesture touch -- everything else 200s with
// an empty body, never reached in these tests' own scenarios. The initial
// ops list is no longer fetched over HTTP at all (see public/pixel-editor.js:
// the EventSource's own `sync` frame is now the only source for it), so
// there is deliberately no GET /api/pixels branch here any more.
export function installFetchMock(posted: PostedRequest[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/me") return jsonResponse({ ownerId: "owner-1", nickname: null });
      if (url.endsWith("/draw") || url.endsWith("/erase")) {
        const body = JSON.parse(String(init!.body));
        posted.push({ url, body });
        return jsonResponse(
          {
            id: `op-${posted.length}`,
            ownerId: "owner-1",
            kind: url.endsWith("draw") ? "draw" : "erase",
            color: body.color ?? null,
            size: body.size,
            points: body.points,
            createdAt: Date.now(),
            seq: posted.length,
            docKind: "pixel",
            active: true,
          },
          201,
        );
      }
      if (url.endsWith("/undo") || url.endsWith("/redo")) {
        return jsonResponse({ op: null }); // no-op by default; a test overrides this mock when it needs otherwise
      }
      return jsonResponse({});
    }),
  );
}

export function installCanvasStub() {
  // jsdom returns null from getContext("2d") without the native `canvas`
  // package; pixel-editor.js's own #canvas ctx calls have no null-guard
  // (unlike colour-picker-ui.js's colour-wheel canvas, which already guards
  // every drawing call specifically so it degrades gracefully under this
  // exact jsdom limitation -- see spec/colour-picker-ui.test.ts), so #canvas
  // alone gets a real, minimally-callable stub here; every OTHER canvas
  // (the colour wheel included) keeps jsdom's real `null`, exercising
  // colour-picker-ui.js's own already-tested defensive path instead of
  // papering over it with a second, more elaborate fake context.
  const stub = {
    fillStyle: "",
    fillRect: () => {},
    clearRect: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    return this.id === "canvas" ? stub : null;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  // jsdom does not implement pointer capture at all (setPointerCapture is
  // undefined); pixel-editor.js calls it unconditionally on pointerdown.
  HTMLCanvasElement.prototype.setPointerCapture = HTMLCanvasElement.prototype.setPointerCapture ?? (() => {});
}

export async function flush() {
  // Lets the mocked fetch's resolved promises (and the .then chain in
  // bootPixelEditor's loadMe().then(...)) actually drain.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function firePointer(el: Element, type: string, props: Partial<PointerEvent>) {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...props }));
}

// Boots public/pixel-editor.js fresh (as the Public pixel wall: jsdom's
// default location has no /room/ prefix) with every stub installed, and
// immediately delivers an empty `sync` frame -- the same "document has no
// ops yet" starting point spec/pixel-editor-tool-size.test.ts and
// spec/pixel-editor-grid.test.ts both already assumed before SSE replaced
// the old GET-based initial load.
export async function bootPixelEditorForTest(posted: PostedRequest[]) {
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  installCanvasStub();
  installEventSourceStub();
  installFetchMock(posted);
  await import("../public/pixel-editor.js");
  await flush();
  latestEventSource().emit("sync", { docKind: "pixel", width: 2048, height: 1152, ops: [] });
  await flush();
}
