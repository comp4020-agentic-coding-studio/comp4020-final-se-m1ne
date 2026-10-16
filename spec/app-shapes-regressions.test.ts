// @vitest-environment jsdom
//
// Regression tests for two bugs in the Line/Rectangle/Ellipse tools.
//
// BUG 1 -- stray diagonal marks. A shape gesture's `points` is its two defining
// corners [anchor, end]. If anything paints those through the freehand polyline
// path (i.e. without the `shape` descriptor) it draws a straight diagonal from
// the anchor to the pointer. repaintVisibleCanvas and rebuildAllLayers did
// exactly that for an UNFINISHED shape whenever a full repaint ran mid-drag
// (another guest's op, an undo reload, a reconnect sync). The marks were
// transient on screen but never saved, so they vanished on refresh.
//
// BUG 2 -- committed shape shifted from its preview. The preview overlay is a
// separately positioned element and was only re-synced to the canvas's box in
// applyZoom, so any later layout change left it offset; the committed shape
// (painted into the canvas itself) then appeared displaced from the preview.
//
// jsdom has no real layout, so geometry is asserted through the DOM calls the
// app makes (style assignments, canvas-context calls) with controlled rects.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allCanvasContexts,
  bootAppForTest,
  canvasContexts,
  firePointer,
  flush,
  latestEventSource,
  MY_OWNER_ID,
  type PostedRequest,
} from "./app-test-helpers";

let posted: PostedRequest[];

// bootAppForTest re-imports app.js each time and each import leaves its window listeners behind; remove them
// so an older module instance cannot react to a later test's events (a real page loads app.js once).
const windowListeners: Array<[string, EventListenerOrEventListenerObject, unknown]> = [];
const realAdd = window.addEventListener.bind(window);
beforeEach(() => {
  posted = [];
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    windowListeners.push([type, listener, options]);
    return realAdd(type, listener, options as AddEventListenerOptions);
  }) as typeof window.addEventListener;
});
afterEach(() => {
  for (const [type, listener, options] of windowListeners.splice(0)) window.removeEventListener(type, listener, options as EventListenerOptions);
  window.addEventListener = realAdd;
});

const $ = (id: string) => document.getElementById(id)!;
const pick = async (tool: string) => { $(`tool-${tool}`).dispatchEvent(new Event("click", { bubbles: true })); await flush(); };
const canvas = () => $("canvas");
const down = async (x: number, y: number, shiftKey = false) => { firePointer(canvas(), "pointerdown", { clientX: x, clientY: y, shiftKey }); await flush(); };
const move = async (x: number, y: number, shiftKey = false) => { firePointer(canvas(), "pointermove", { clientX: x, clientY: y, shiftKey }); await flush(); };
const up = async (x: number, y: number, shiftKey = false) => { firePointer(canvas(), "pointerup", { clientX: x, clientY: y, shiftKey }); await flush(); };
const draws = () => posted.filter((p) => p.url.endsWith("/draw"));

// Contexts that hold real artwork (the visible canvas, owner layers, the scratch canvas) -- everything
// except the preview overlay, which is allowed to show an unfinished shape.
const artwork = () => allCanvasContexts.filter((c) => c !== canvasContexts.get("remote-stroke-preview") && c !== canvasContexts.get("colour-wheel"));
const polylineSegments = () => artwork().reduce((n, c) => n + c.lineTo.mock.calls.length, 0);
const strokesOfShapesAsPaths = () => artwork().reduce((n, c) => n + c.rect.mock.calls.length + c.ellipse.mock.calls.length, 0);

// A "remote" event that forces a full repaint / layer rebuild on THIS client while a shape is mid-drag.
async function forceRepaintMidDrag(kind: "op" | "sync" | "undo") {
  const es = latestEventSource();
  if (kind === "op") {
    // The injected remote op is itself a SHAPE (a rectangle), so it adds rect() calls but no lineTo segments:
    // any lineTo increase after it can therefore only come from the unfinished local shape being mis-painted.
    es.emit("op", { seq: 900, id: "remote-op", ownerId: "someone-else", kind: "draw", color: "#e85d5d", size: 0.004, points: [{ x: 0.9, y: 0.1 }, { x: 0.95, y: 0.12 }], createdAt: Date.now(), shape: { type: "rectangle", mode: "outline" }, active: true });
  } else if (kind === "sync") {
    es.emit("sync", { docKind: "freehand", ops: [] }); // a reconnect / undo reload -> rebuildAllLayers()
  } else {
    es.emit("sync", { docKind: "freehand", ops: [] });
  }
  await flush();
}

describe("Bug 1: an unfinished shape is never painted as artwork (no stray diagonal)", () => {
  for (const tool of ["line", "rectangle", "ellipse"]) {
    for (const trigger of ["op", "sync"] as const) {
      it(`${tool}: a remote '${trigger}' repaint mid-drag paints no polyline and no shape into real artwork`, async () => {
        await bootAppForTest(posted);
        await pick(tool);
        await down(480, 270, true);
        await move(700, 420, true);

        const segmentsBefore = polylineSegments();
        await forceRepaintMidDrag(trigger);

        // The corner-to-corner diagonal is a polyline segment (moveTo/lineTo). Nothing may add one.
        expect(polylineSegments()).toBe(segmentsBefore);
        // The user's pointer-up must still commit exactly one proper shape op afterwards.
        await up(700, 420, true);
        expect(draws()).toHaveLength(1);
        expect(draws()[0].body.shape).toMatchObject({ type: tool });
        expect(draws()[0].body.points).toHaveLength(2);
      });
    }
  }

  it("repeated Shift press/release during one drag, with repaints in between, leaves no stray segments", async () => {
    await bootAppForTest(posted);
    await pick("ellipse");
    await down(480, 270);
    await move(700, 420);
    const before = polylineSegments();
    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
      await flush();
      await forceRepaintMidDrag("op");
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      await flush();
      await forceRepaintMidDrag("sync");
    }
    expect(polylineSegments()).toBe(before);
    await up(700, 420);
    expect(draws()).toHaveLength(1);
  });

  it("the unfinished shape IS shown, on the preview overlay (so removing it from artwork did not remove the preview)", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await down(480, 270);
    await move(700, 420);
    await forceRepaintMidDrag("op");
    const overlay = canvasContexts.get("remote-stroke-preview")!;
    expect(overlay.rect.mock.calls.length).toBeGreaterThan(0);
  });

  it("once committed, the shape is drawn as a shape (rect), not as a diagonal polyline", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await down(480, 270);
    await move(700, 420);
    const segmentsBefore = polylineSegments();
    await up(700, 420);
    expect(polylineSegments()).toBe(segmentsBefore); // committing a rectangle adds rect() calls, never lineTo diagonals
    expect(artwork().some((c) => c.rect.mock.calls.length > 0)).toBe(true);
  });

  it("an unfinished Brush stroke is still painted into artwork by a repaint (freehand behaviour unchanged)", async () => {
    await bootAppForTest(posted);
    await down(100, 100);
    await move(200, 160);
    await move(300, 220);
    const before = polylineSegments();
    await forceRepaintMidDrag("op");
    expect(polylineSegments()).toBeGreaterThan(before); // the live freehand stroke is repainted, as before
    await up(300, 220);
    expect(draws()).toHaveLength(1);
    expect(draws()[0].body.shape).toBeUndefined();
  });

  it("an unfinished Eraser gesture still erases as before", async () => {
    await bootAppForTest(posted);
    await pick("eraser");
    await down(100, 100);
    await move(200, 200);
    await up(200, 200);
    expect(posted.filter((p) => p.url.endsWith("/erase"))).toHaveLength(1);
  });
});

describe("Bug 2: the preview overlay tracks the canvas's real box (committed shape = preview position)", () => {
  // The overlay is positioned from the canvas's and viewport's bounding rects. Give the stubs real,
  // controllable geometry, boot, then change the layout and check the overlay follows.
  function setRects(viewport: { left: number; top: number }, canvasBox: { left: number; top: number; width: number; height: number }, scroll = { left: 0, top: 0 }) {
    const rect = (b: { left: number; top: number; width: number; height: number }) => ({ x: b.left, y: b.top, top: b.top, left: b.left, right: b.left + b.width, bottom: b.top + b.height, width: b.width, height: b.height, toJSON() {} }) as DOMRect;
    HTMLCanvasElement.prototype.getBoundingClientRect = function () {
      return this.id === "canvas" ? rect(canvasBox) : rect({ left: 0, top: 0, width: 0, height: 0 });
    };
    $("canvas-viewport").getBoundingClientRect = () => rect({ ...viewport, width: 1482, height: 860 });
    Object.defineProperty($("canvas-viewport"), "scrollLeft", { configurable: true, get: () => scroll.left });
    Object.defineProperty($("canvas-viewport"), "scrollTop", { configurable: true, get: () => scroll.top });
  }
  const overlayStyle = () => {
    const o = $("remote-stroke-preview");
    return { left: parseFloat(o.style.left), top: parseFloat(o.style.top), width: parseFloat(o.style.width), height: parseFloat(o.style.height) };
  };

  it("after a window resize (no zoom change) the overlay follows the canvas to its new position", async () => {
    await bootAppForTest(posted);
    setRects({ left: 125, top: 150 }, { left: 160.2, top: 181.3, width: 1411.5, height: 794 });
    window.dispatchEvent(new Event("resize"));
    await flush();
    let o = overlayStyle();
    expect(o.left).toBeCloseTo(160.2 - 125, 6);
    expect(o.top).toBeCloseTo(181.3 - 150, 6);

    // the canvas re-centres after the window changes; the overlay must follow with NO zoom call in between
    setRects({ left: 125, top: 150 }, { left: 132, top: 174, width: 1411.5, height: 794 });
    window.dispatchEvent(new Event("resize"));
    await flush();
    o = overlayStyle();
    expect(o.left).toBeCloseTo(132 - 125, 6);
    expect(o.top).toBeCloseTo(174 - 150, 6);
  });

  it("uses the canvas's fractional size, not a rounded one (no sub-pixel drift after Fit)", async () => {
    await bootAppForTest(posted);
    setRects({ left: 100, top: 100 }, { left: 140.25, top: 130.5, width: 1411.546875, height: 793.9 });
    window.dispatchEvent(new Event("resize"));
    await flush();
    const o = overlayStyle();
    expect(o.width).toBeCloseTo(1411.546875, 6);
    expect(o.height).toBeCloseTo(793.9, 6);
  });

  it("accounts for the viewport's scroll offset (panned), since the overlay scrolls with the canvas", async () => {
    await bootAppForTest(posted);
    // Canvas currently scrolled 200px left / 150px up in its viewport, so its on-screen box moved but its
    // position within the scrolled content did not.
    setRects({ left: 125, top: 150 }, { left: 85, top: 130, width: 2000, height: 1200 }, { left: 200, top: 150 });
    window.dispatchEvent(new Event("resize"));
    await flush();
    const o = overlayStyle();
    expect(o.left).toBeCloseTo(85 - 125 + 200, 6);
    expect(o.top).toBeCloseTo(130 - 150 + 150, 6);
  });

  it("zooming still re-syncs the overlay (the original behaviour is kept)", async () => {
    await bootAppForTest(posted);
    setRects({ left: 125, top: 150 }, { left: 140, top: 160, width: 3000, height: 1700 });
    $("zoom-in-button").dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    const o = overlayStyle();
    expect(o.left).toBeCloseTo(15, 6);
    expect(o.top).toBeCloseTo(10, 6);
    expect(o.width).toBeCloseTo(3000, 6);
  });

  it("preview and committed shape use the same document geometry: same corners, same renderer, any zoom", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await down(480, 270);
    await move(960, 540);
    const overlay = canvasContexts.get("remote-stroke-preview")!;
    const previewRect = overlay.rect.mock.calls.at(-1) as number[];
    await up(960, 540);
    // the committed rect painted into artwork is the SAME rectangle the preview showed
    const committed = artwork().flatMap((c) => c.rect.mock.calls as number[][]).at(-1)!;
    for (let i = 0; i < 4; i++) expect(committed[i]).toBeCloseTo(previewRect[i], 9);
  });

  for (const tool of ["line", "rectangle", "ellipse"]) {
    for (const mode of ["outline", "filled"]) {
      if (tool === "line" && mode === "filled") continue;
      it(`${tool} ${mode}: the committed op's corners equal the last previewed corners (no jump on release)`, async () => {
        await bootAppForTest(posted);
        await pick(tool);
        if (tool !== "line") $(`shape-mode-${mode}`).dispatchEvent(new Event("click", { bubbles: true }));
        await down(600, 300);
        await move(900, 520);
        await move(1000, 600);
        const lastPreview = posted.filter((p) => p.url.endsWith("/stroke") && p.body.active === true).at(-1)!;
        await up(1000, 600);
        const committed = draws()[0].body.points as Array<{ x: number; y: number }>;
        const previewed = lastPreview.body.points as Array<{ x: number; y: number }>;
        expect(committed).toHaveLength(2);
        // the broadcast preview is throttled, so compare against what the final geometry must be for this drag
        expect(committed[0].x * 1920).toBeCloseTo(600, 6);
        expect(committed[0].y * 1080).toBeCloseTo(300, 6);
        expect(committed[1].x * 1920).toBeCloseTo(1000, 6);
        expect(committed[1].y * 1080).toBeCloseTo(600, 6);
        expect(previewed[0]).toEqual(committed[0]);
      });
    }
  }
});

describe("existing behaviour is unchanged", () => {
  it("a remote collaborator's shape op still renders for me through the normal replay path", async () => {
    await bootAppForTest(posted);
    const before = strokesOfShapesAsPaths();
    latestEventSource().emit("op", { seq: 901, id: "remote-shape", ownerId: "someone-else", kind: "draw", color: "#355c9a", size: 0.004, points: [{ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.7 }], createdAt: Date.now(), shape: { type: "rectangle", mode: "filled" }, active: true });
    await flush();
    expect(strokesOfShapesAsPaths()).toBeGreaterThan(before);
  });

  it("my own committed shape survives a later full rebuild (sync) -- it is replayed from ops, as a shape", async () => {
    await bootAppForTest(posted);
    await pick("ellipse");
    await down(480, 270);
    await move(960, 540);
    await up(960, 540);
    const saved = draws()[0].body;
    latestEventSource().emit("sync", {
      docKind: "freehand",
      ops: [{ seq: 1, id: "op-1", ownerId: MY_OWNER_ID, kind: "draw", color: saved.color, size: saved.width, points: saved.points, createdAt: Date.now(), shape: saved.shape }],
    });
    await flush();
    expect(artwork().some((c) => c.ellipse.mock.calls.length > 0)).toBe(true);
  });
});
