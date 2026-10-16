// Shared jsdom test scaffolding for public/app.js, booted as the Public
// Canvas (the restored C8 freehand model -- see public/pixeldoc.js's
// resolveEditorMode). No prior spec file boots public/app.js directly in
// jsdom at all (every existing freehand test exercises the server's HTTP+SSE
// contract only, see spec/freehand-realtime.test.ts); this exists
// specifically for the pieces of Task D's Part 3 (incremental stroke
// streaming) and Part 2 (theme) that only live client-side and have no
// server-observable behaviour of their own.
//
// Unlike spec/pixel-editor-test-helpers.ts's canvas stub (which special-cases
// just `#canvas`, because pixel-editor.js only ever touches that one canvas),
// public/app.js creates a new, id-less <canvas> per collaborator layer plus a
// scratch canvas (see ensureLayer/ensureScratch) -- so this stub answers
// getContext("2d") for EVERY canvas, tracking the returned stub by element id
// (where one exists) so a test can still reach the specific context it cares
// about (e.g. #remote-stroke-preview) without needing app.js to export its
// internal module state.

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

export const MY_OWNER_ID = "owner-1";

// A stub 2D context generic enough for every canvas app.js ever creates (the
// shared #canvas, every per-owner layer, the scratch canvas, and
// #remote-stroke-preview) -- every drawing method is a no-op spy, every
// property a plain writable field, so renderPathOnLayer/repaintVisibleCanvas/
// repaintRemoteStrokePreviews can all run for real without jsdom's "canvas
// package not installed" getContext(null) crashing them.
function makeStubContext() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    setTransform: vi.fn(),
    arc: vi.fn(),
    rect: vi.fn(),
    ellipse: vi.fn(),
    closePath: vi.fn(),
    translate: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    getImageData: vi.fn((_x?: number, _y?: number, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })),
    putImageData: vi.fn(),
    createImageData: vi.fn((w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  };
}

// Wraps a stub context so every globalCompositeOperation / globalAlpha write is
// recorded. The scratch canvas is the only one that ever sets "destination-in"
// (it clips each op against its owner's mask), and it is also where the Public
// fade opacity is applied, so recording both lets a test observe exactly what
// opacity an op was painted with.
export function recordStyleWrites<T extends ReturnType<typeof makeStubContext>>(stub: T) {
  const alphas: number[] = [];
  const composites: string[] = [];
  let alpha = stub.globalAlpha;
  let composite = stub.globalCompositeOperation;
  Object.defineProperty(stub, "globalAlpha", {
    get: () => alpha,
    set: (v: number) => { alpha = v; alphas.push(v); },
  });
  Object.defineProperty(stub, "globalCompositeOperation", {
    get: () => composite,
    set: (v: string) => { composite = v; composites.push(v); },
  });
  return Object.assign(stub, { alphaWrites: alphas, compositeWrites: composites });
}

// element id -> the stub context returned for it (only elements that have an
// id are tracked; the dynamically-created per-owner layer/scratch canvases
// never need individual inspection from a test, only #canvas and
// #remote-stroke-preview do).
export const canvasContexts = new Map<string, ReturnType<typeof makeStubContext>>();

// Every context the stub handed out since the last installCanvasStub(), id-less
// layer/scratch canvases included, in creation order -- for tests that need to
// know whether SOMETHING painted (e.g. a shape rendered onto a layer or the
// scratch canvas before being composited onto #canvas).
export const allCanvasContexts: Array<ReturnType<typeof makeStubContext>> = [];

export function installCanvasStub() {
  canvasContexts.clear();
  allCanvasContexts.length = 0;
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    const stub = recordStyleWrites(makeStubContext());
    if (this.id) canvasContexts.set(this.id, stub);
    allCanvasContexts.push(stub);
    return stub;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.setPointerCapture = HTMLCanvasElement.prototype.setPointerCapture ?? (() => {});
  // jsdom has no real layout: getBoundingClientRect always reports 0, which
  // would make every toNormalized() point map to the same place. Only the
  // size matters for this file's own tests (coordinate precision isn't what
  // they're checking), so a fixed, non-zero box is enough.
  HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, toJSON() {} } as DOMRect;
  };
}

export function installFetchMock(posted: PostedRequest[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/me") return jsonResponse({ ownerId: MY_OWNER_ID, nickname: "Tester", cursorColor: "#1e88e5" });
      if (url.endsWith("/draw") || url.endsWith("/erase")) {
        const body = JSON.parse(String(init!.body));
        posted.push({ url, body });
        return jsonResponse(
          {
            id: `op-${posted.filter((p) => p.url === url).length}`,
            ownerId: MY_OWNER_ID,
            kind: url.endsWith("draw") ? "draw" : "erase",
            color: body.color ?? null,
            size: body.width ?? body.radius * 2,
            points: body.points,
            createdAt: Date.now(),
            seq: posted.length,
            ...(body.shape ? { shape: body.shape } : {}),
          },
          201,
        );
      }
      if (url.endsWith("/stroke") || url.endsWith("/cursor")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        posted.push({ url, body });
        return jsonResponse({ ok: true });
      }
      if (url.endsWith("/undo") || url.endsWith("/redo")) {
        return jsonResponse({ op: null });
      }
      if (url === "/api/presence/heartbeat" || url === "/api/presence/leave" || url.endsWith("/presence") || url.endsWith("/leave")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        posted.push({ url, body });
        return jsonResponse({ ok: true, onlineCount: 1, totalVisitors: 1 });
      }
      return jsonResponse({});
    }),
  );
}

export async function flush() {
  // Two microtask/timer drains, plus one real animation frame -- app.js's own
  // queueFrame (appendToGesture's per-move render scheduling) defers its work
  // via requestAnimationFrame, not a promise or a timer, so a test that drives
  // a drag via firePointer needs this to actually observe renderCurrentDelta
  // (and the stroke-preview send it now triggers) having run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function firePointer(el: Element, type: string, props: Partial<PointerEvent>) {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...props }));
}

// Boots public/app.js fresh as the Public Canvas (location path "/", so
// roomCode resolves to null, matching public/app.js's own isPublicCanvas
// derivation). Immediately delivers an empty `sync` frame, same starting
// point bootPixelEditorForTest uses for the pixel editor.
export async function bootAppForTest(posted: PostedRequest[]) {
  vi.resetModules();
  history.pushState(null, "", "/");
  document.body.innerHTML = bodyHtml;
  installCanvasStub();
  installEventSourceStub();
  installFetchMock(posted);
  await import("../public/app.js");
  await flush();
  latestEventSource().emit("sync", { docKind: "freehand", ops: [] });
  await flush();
}
