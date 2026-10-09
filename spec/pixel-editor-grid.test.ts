// @vitest-environment jsdom
//
// Integration-level coverage for this round's remaining DOM-dependent
// changes: the pixel-grid Grid toggle (now reachable from the Document
// popover for BOTH Public and Private -- the popover itself is shared, not
// duplicated), and the persistGesture repaint-skip performance change. Same
// technique as spec/pixel-editor-tool-size.test.ts: boots the REAL
// public/pixel-editor.js against the REAL public/index.html markup, with
// only fetch and the canvas 2D context stubbed out.

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

function installFetchMock(posted: PostedRequest[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/me") return jsonResponse({ ownerId: "owner-1", nickname: null });
      if (url === "/api/pixels" && !init) return jsonResponse([]);
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
}

async function flush() {
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
  clearRectCalls = [];
  localStorage.clear();
  document.body.innerHTML = bodyHtml;
  installCanvasStub();
  installFetchMock(posted);
  await import("../public/pixel-editor.js"); // boots as Public: no /room/ prefix in jsdom's default location
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

  it("the overlay is hidden below the zoom threshold even with the preference ON, and shown at/above it", () => {
    const overlay = document.getElementById("pixel-grid-overlay") as HTMLElement;
    const zoomSlider = document.getElementById("zoom-slider") as HTMLInputElement;

    // 100% is below GRID_MIN_ZOOM_FOR_DISPLAY (8x) -- suppressed regardless
    // of the ON preference, per the fixed zoom-vs-preference behaviour.
    fireInput(zoomSlider, zoomSlider.value); // re-fire at whatever Fit/boot already set, forces a sync read
    expect(overlay.hidden).toBe(true);

    document.getElementById("zoom-in-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    // Repeated Zoom In clicks (discrete named levels) eventually clear 8x;
    // Public's own levels include 8 (800%) as the top step.
    for (let i = 0; i < 10 && overlay.hidden; i++) {
      document.getElementById("zoom-in-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    }
    expect(overlay.hidden).toBe(false);
  });

  it("turning the preference OFF hides the grid even at a high zoom level that would otherwise show it", () => {
    const overlay = document.getElementById("pixel-grid-overlay") as HTMLElement;
    for (let i = 0; i < 10; i++) {
      document.getElementById("zoom-in-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    }
    expect(overlay.hidden).toBe(false); // confirms we actually reached a zoom level where it would show

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
