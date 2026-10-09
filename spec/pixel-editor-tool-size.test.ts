// @vitest-environment jsdom
//
// Integration-level coverage for the Pencil/Eraser independent-size
// regression fix: this boots the REAL public/pixel-editor.js against the
// REAL public/index.html markup (not a reimplementation or a hand-built DOM
// subset), with only fetch and the canvas 2D context stubbed out -- jsdom
// does not implement actual canvas rendering without the `canvas` native
// package, which this project deliberately does not add (see
// spec/colour-picker-ui.test.ts's own comment), and there is no live HTTP
// server in this file (unlike spec/pixel-api.test.ts), so every network call
// pixel-editor.js makes is captured by a fetch mock instead.
//
// This directly exercises what a pure-function test of createBrushSizeState
// (spec/pixeldoc.test.ts) cannot: that the ACTUAL slider/numeric input
// elements update on tool switch, and that an ACTUAL simulated draw/erase
// gesture sends the correct per-tool size in its real POST request body.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const indexHtmlPath = path.resolve(__dirname, "../public/index.html");
const fullIndexHtml = fs.readFileSync(indexHtmlPath, "utf8");
const bodyHtml = fullIndexHtml.match(/<body>([\s\S]*)<\/body>/)![1];

type PostedRequest = { url: string; body: Record<string, unknown> };

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => data,
    headers: { get: () => null },
  } as unknown as Response;
}

// Mocks exactly the handful of endpoints a Public pixel-editor boot and one
// draw + one erase gesture touch -- everything else 200s with an empty body,
// never reached in this test's own scenarios.
function installFetchMock(posted: PostedRequest[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/me") return jsonResponse({ ownerId: "owner-1", nickname: null });
      if (url === "/api/pixels" && !init) return jsonResponse([]); // GET: authoritative ops list, empty
      if (url === "/api/pixels/draw" || url === "/api/pixels/erase") {
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
      return jsonResponse({});
    }),
  );
}

function installCanvasStub() {
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

async function flush() {
  // Lets the mocked fetch's resolved promises (and the .then chain in
  // bootPixelEditor's loadMe().then(loadOps).then(...)) actually drain.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fireInput(el: Element, value: string) {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function firePointer(el: Element, type: string, props: Partial<PointerEvent>) {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...props }));
}

let posted: PostedRequest[];

beforeEach(async () => {
  vi.resetModules();
  posted = [];
  document.body.innerHTML = bodyHtml;
  installCanvasStub();
  installFetchMock(posted);
  // Boots as the Public pixel wall: location.pathname has no /room/ prefix.
  await import("../public/pixel-editor.js");
  await flush();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Pencil/Eraser independent size -- real DOM, real module", () => {
  it("the shared slider/number restore each tool's own size on switch, never the other tool's", () => {
    const brushButton = document.getElementById("tool-brush")!;
    const eraserButton = document.getElementById("tool-eraser")!;
    const slider = document.getElementById("tool-size-slider") as HTMLInputElement;
    const number = document.getElementById("tool-size-number") as HTMLInputElement;

    brushButton.dispatchEvent(new Event("click", { bubbles: true }));
    fireInput(slider, "5");
    expect(number.value).toBe("5");

    eraserButton.dispatchEvent(new Event("click", { bubbles: true }));
    fireInput(number, "8");
    expect(slider.value).toBe("8");

    brushButton.dispatchEvent(new Event("click", { bubbles: true }));
    expect(slider.value).toBe("5");
    expect(number.value).toBe("5");

    eraserButton.dispatchEvent(new Event("click", { bubbles: true }));
    expect(slider.value).toBe("8");
    expect(number.value).toBe("8");
  });

  it("an actual draw gesture sends the Pencil's own size, and an actual erase gesture sends the Eraser's own size, in the real POST request", async () => {
    const canvas = document.getElementById("canvas")!;
    const brushButton = document.getElementById("tool-brush")!;
    const eraserButton = document.getElementById("tool-eraser")!;
    const slider = document.getElementById("tool-size-slider") as HTMLInputElement;

    brushButton.dispatchEvent(new Event("click", { bubbles: true }));
    fireInput(slider, "5");
    firePointer(canvas, "pointerdown", { clientX: 10, clientY: 10 });
    firePointer(canvas, "pointerup", { clientX: 10, clientY: 10 });
    await flush();

    eraserButton.dispatchEvent(new Event("click", { bubbles: true }));
    fireInput(slider, "8");
    firePointer(canvas, "pointerdown", { clientX: 20, clientY: 20 });
    firePointer(canvas, "pointerup", { clientX: 20, clientY: 20 });
    await flush();

    const draw = posted.find((p) => p.url === "/api/pixels/draw");
    const erase = posted.find((p) => p.url === "/api/pixels/erase");
    expect(draw?.body.size).toBe(5);
    expect(erase?.body.size).toBe(8);
  });

  it("size 100 is stored and reflected in full -- not truncated to '10' at the data level", () => {
    // This covers the DATA half of the reported truncation bug (the input's
    // own .value is the real, full "100", never silently clamped to two
    // digits). The other half -- that "100" is visually fully readable, not
    // clipped by the input box's own width/padding/native spin buttons -- is
    // a CSS/paint concern jsdom cannot render and so cannot verify; that part
    // was fixed by widening #tool-size-number and removing the native
    // spin-button arrows (public/styles.css), and needs a manual visual
    // check (see the project report).
    const slider = document.getElementById("tool-size-slider") as HTMLInputElement;
    const number = document.getElementById("tool-size-number") as HTMLInputElement;

    fireInput(number, "100");
    expect(number.value).toBe("100");
    expect(slider.value).toBe("100");

    fireInput(slider, "100");
    expect(number.value).toBe("100");
    expect(slider.max).toBe("100");
    expect(number.max).toBe("100");
  });
});
