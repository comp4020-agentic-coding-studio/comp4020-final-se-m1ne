// @vitest-environment jsdom
//
// Integration-level coverage for this round's remaining DOM-dependent
// changes: the pixel-grid Grid toggle (now reachable from the Document
// popover for BOTH Public and Private -- the popover itself is shared, not
// duplicated), and the persistGesture repaint-skip performance change. Same
// technique as spec/pixel-editor-tool-size.test.ts: boots the REAL
// public/pixel-editor.js against the REAL public/index.html markup, with
// fetch, EventSource, and the canvas 2D context stubbed out
// (spec/pixel-editor-test-helpers.ts) -- this file keeps its own local
// canvas stub (not the shared one) so it can record clearRect calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PostedRequest,
  bodyHtml,
  firePointer,
  flush,
  installEventSourceStub,
  installFetchMock,
  jsonResponse,
  latestEventSource,
} from "./pixel-editor-test-helpers.js";

let clearRectCalls: { x: number; y: number; w: number; h: number }[];

function installCanvasStub() {
  const stub = {
    fillStyle: "",
    fillRect: () => {},
    clearRect: (x: number, y: number, w: number, h: number) => {
      clearRectCalls.push({ x, y, w, h });
    },
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    return this.id === "canvas" ? stub : null;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.setPointerCapture = HTMLCanvasElement.prototype.setPointerCapture ?? (() => {});
  // jsdom never performs real layout, so the real getBoundingClientRect
  // always reports zeros -- that's fine for every other test here, but the
  // grid-alignment fix specifically derives its spacing from THIS rect (see
  // public/pixel-editor.js's updateGridOverlay), so a test that wants to
  // verify that formula needs a rect proportional to what a real browser
  // would report: #canvas's own declared CSS size (the same string
  // applyZoom itself just wrote to canvas.style.width/height).
  HTMLCanvasElement.prototype.getBoundingClientRect = function (this: HTMLCanvasElement) {
    const width = this.id === "canvas" ? parseFloat(this.style.width) || 0 : 0;
    const height = this.id === "canvas" ? parseFloat(this.style.height) || 0 : 0;
    return { width, height, left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
}

let posted: PostedRequest[];

beforeEach(async () => {
  vi.resetModules();
  posted = [];
  clearRectCalls = [];
  localStorage.clear();
  document.body.innerHTML = bodyHtml;
  installCanvasStub();
  installEventSourceStub();
  installFetchMock(posted);
  await import("../public/pixel-editor.js"); // boots as Public: no /room/ prefix in jsdom's default location
  await flush();
  latestEventSource().emit("sync", { docKind: "pixel", width: 2048, height: 1152, ops: [] });
  await flush();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Document popover is shared by Public too", () => {
  it("#document-settings-button is revealed and opens a popover containing the Grid toggle and dimensions, for Public", () => {
    const button = document.getElementById("document-settings-button") as HTMLButtonElement;
    const popover = document.getElementById("document-settings-popover") as HTMLElement;
    expect(button.hidden).toBe(false);
    expect(popover.hidden).toBe(true);

    button.dispatchEvent(new Event("click", { bubbles: true }));
    expect(popover.hidden).toBe(false);
    expect(document.getElementById("document-dimensions")!.textContent).toBe("2048 × 1152");
    expect(document.getElementById("grid-toggle")).toBeTruthy();

    document.getElementById("document-settings-close")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(popover.hidden).toBe(true);
  });
});

describe("Grid toggle", () => {
  it("defaults to ON", () => {
    const toggle = document.getElementById("grid-toggle") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toBe("On");
  });

  it("clicking flips the preference, label, and aria-pressed, and persists it", () => {
    const toggle = document.getElementById("grid-toggle") as HTMLButtonElement;
    toggle.dispatchEvent(new Event("click", { bubbles: true }));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toBe("Off");
    expect(localStorage.getItem("pixelGridOn")).toBe("false");

    toggle.dispatchEvent(new Event("click", { bubbles: true }));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toBe("On");
    expect(localStorage.getItem("pixelGridOn")).toBe("true");
  });

  it("the grid stays visible at an ordinary LOW zoom when the preference is ON -- the previous bug hid it below 8x entirely", () => {
    const overlay = document.getElementById("pixel-grid-overlay") as HTMLElement;
    // Zoom OUT via the button -- a direct, synchronous applyZoom call (the
    // slider/wheel path is deferred to the next animation frame via
    // scheduleZoom, which a synchronous test like this one never flushes;
    // firing it here would just leave `hidden` at its last real value and
    // silently prove nothing).
    for (let i = 0; i < 10; i++) {
      document.getElementById("zoom-out-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    }
    expect(overlay.hidden).toBe(false);
  });

  it("the grid's line spacing adapts between an ordinary low zoom and a high zoom -- coarser, not hidden, at low zoom", () => {
    const overlay = document.getElementById("pixel-grid-overlay") as HTMLElement;
    for (let i = 0; i < 10; i++) {
      document.getElementById("zoom-out-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    }
    expect(overlay.hidden).toBe(false);
    const lowZoomBackgroundSize = overlay.style.backgroundSize;

    for (let i = 0; i < 20; i++) {
      document.getElementById("zoom-in-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    }
    expect(overlay.hidden).toBe(false); // still visible -- individual logical pixel boundaries now, not hidden either
    expect(overlay.style.backgroundSize).not.toBe(lowZoomBackgroundSize);
  });

  it("turning the preference OFF hides the grid even at a zoom level that would otherwise show it", () => {
    const overlay = document.getElementById("pixel-grid-overlay") as HTMLElement;
    document.getElementById("zoom-in-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(overlay.hidden).toBe(false); // confirms we actually reached a state where it would show

    document.getElementById("grid-toggle")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(overlay.hidden).toBe(true);
  });

  it("toggling the grid never touches the draw/erase request body -- grid state is purely visual", async () => {
    const canvas = document.getElementById("canvas")!;
    document.getElementById("grid-toggle")!.dispatchEvent(new Event("click", { bubbles: true })); // OFF
    firePointer(canvas, "pointerdown", { clientX: 10, clientY: 10 });
    firePointer(canvas, "pointerup", { clientX: 10, clientY: 10 });
    await flush();

    const draw = posted.find((p) => p.url === "/api/pixels/draw");
    expect(draw).toBeTruthy();
    expect(draw!.body).not.toHaveProperty("grid");
    expect(draw!.body).not.toHaveProperty("showGrid");
    expect(Object.keys(draw!.body).sort()).toEqual(["color", "points", "size"].sort());
  });
});

describe("persistGesture repaint-skip performance optimization", () => {
  it("a successful draw does NOT trigger a second full-canvas clearRect beyond the gesture's own incremental rendering", async () => {
    clearRectCalls = []; // discard the initial boot-time loadOps() full repaint -- only the gesture's own effect is under test
    const canvas = document.getElementById("canvas")!;
    firePointer(canvas, "pointerdown", { clientX: 10, clientY: 10 });
    firePointer(canvas, "pointerup", { clientX: 10, clientY: 10 });
    await flush();

    // A full repaint always calls clearRect(0, 0, gridWidth, gridHeight) --
    // Public's own 2048x1152. On success this must never happen (the
    // gesture's own paintDeltaCells already painted the correct final
    // pixels); it's reserved for the failure-rollback path only.
    const fullCanvasClears = clearRectCalls.filter((c) => c.x === 0 && c.y === 0 && c.w === 2048 && c.h === 1152);
    expect(fullCanvasClears).toHaveLength(0);
  });

  it("a FAILED persist still triggers the full repaint, to roll back the optimistic rendering", async () => {
    // Override the mock for this one test: every draw/erase 400s.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/me") return jsonResponse({ ownerId: "owner-1", nickname: null });
        if (url === "/api/pixels" && !init) return jsonResponse([]);
        if (url === "/api/pixels/draw" || url === "/api/pixels/erase") return jsonResponse({ error: "rejected" }, 400);
        return jsonResponse({});
      }),
    );
    document.getElementById("tool-brush")!.dispatchEvent(new Event("click", { bubbles: true }));
    clearRectCalls = []; // discard the initial boot-time loadOps() full repaint

    const canvas = document.getElementById("canvas")!;
    firePointer(canvas, "pointerdown", { clientX: 10, clientY: 10 });
    firePointer(canvas, "pointerup", { clientX: 10, clientY: 10 });
    await flush();

    const fullCanvasClears = clearRectCalls.filter((c) => c.x === 0 && c.y === 0 && c.w === 2048 && c.h === 1152);
    expect(fullCanvasClears.length).toBeGreaterThanOrEqual(1);
  });
});

// --- Pixquare-referenced chrome: structure preserved after the visual pass ----
// jsdom does no real layout, so none of this can confirm actual rendered
// pixel widths or visual similarity to the reference -- only that every
// control is still present, still correctly wired, and still carries an
// accessible name after #edit-colour-button's text was replaced with an icon.

describe("Edit Colour button restyled as an icon button, still functional", () => {
  it("has no visible text content but keeps an accessible name, and still opens the colour popover", () => {
    const button = document.getElementById("edit-colour-button") as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("");
    expect(button.getAttribute("aria-label")).toBe("Edit colour");
    expect(button.querySelector("svg")).toBeTruthy();

    const popover = document.getElementById("colour-popover") as HTMLElement;
    expect(popover.hidden).toBe(true);
    button.dispatchEvent(new Event("click", { bubbles: true }));
    expect(popover.hidden).toBe(false);
  });
});

describe("Shared controls remain reachable after flattening the top toolbar into one row", () => {
  it("Pencil, Eraser, Eyedropper, palette swatches, and Edit Colour are all still present and clickable", () => {
    for (const id of ["tool-brush", "tool-eraser", "tool-eyedropper", "edit-colour-button"]) {
      const el = document.getElementById(id);
      expect(el, `#${id} should exist`).toBeTruthy();
    }
    const swatches = document.querySelectorAll("#palette .swatch");
    expect(swatches.length).toBeGreaterThan(0);

    const eraserButton = document.getElementById("tool-eraser") as HTMLButtonElement;
    eraserButton.dispatchEvent(new Event("click", { bubbles: true }));
    expect(eraserButton.classList.contains("selected")).toBe(true);
    expect(eraserButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("the now-redundant group labels (Tools/Colours/Size) are not visible text in the toolbar", () => {
    // #size-group is hidden entirely (existing behaviour); #tool-group and
    // #colour-group stay in the DOM (display: contents) but their own
    // .group-label text must not render -- see the .studio-layout
    // #tool-group/#colour-group .group-label rule in styles.css.
    for (const groupId of ["tool-group", "colour-group"]) {
      const label = document.querySelector(`#${groupId} .group-label`);
      expect(label, `#${groupId} .group-label should still exist in the DOM`).toBeTruthy();
    }
    expect(document.getElementById("size-group")!.hidden).toBe(true);
  });
});
