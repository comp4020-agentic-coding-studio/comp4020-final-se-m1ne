// @vitest-environment jsdom
//
// Integration-level coverage for the Pencil/Eraser independent-size
// regression fix: this boots the REAL public/pixel-editor.js against the
// REAL public/index.html markup (not a reimplementation or a hand-built DOM
// subset), with only fetch, EventSource, and the canvas 2D context stubbed
// out (spec/pixel-editor-test-helpers.ts) -- jsdom implements neither real
// canvas rendering nor EventSource, and there is no live HTTP/SSE server in
// this file (unlike spec/pixel-api.test.ts/spec/pixel-realtime.test.ts).
//
// This directly exercises what a pure-function test of createBrushSizeState
// (spec/pixeldoc.test.ts) cannot: that the ACTUAL slider/numeric input
// elements update on tool switch, and that an ACTUAL simulated draw/erase
// gesture sends the correct per-tool size in its real POST request body.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PostedRequest, bootPixelEditorForTest, firePointer, flush } from "./pixel-editor-test-helpers.js";

function fireInput(el: Element, value: string) {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

let posted: PostedRequest[];

beforeEach(async () => {
  posted = [];
  await bootPixelEditorForTest(posted);
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
