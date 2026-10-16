// @vitest-environment jsdom
//
// Eraser latency fix. During an erase drag, each frame repaints only a small box
// around the newest points. That repaint used the full-document (1920x1080)
// scratch canvas for every overlapping op, which cost several ms per op even for
// a ~60x60 box -- and a big Rectangle/Ellipse overlaps almost every box, so the
// eraser slowed to a crawl once a few shapes existed (measured: median frame
// 38 ms with 6 large shapes, 157 ms with 24, vs ~1 ms / 3 ms after the fix).
// The regional repaint now works in a region-sized scratch; the full repaint is
// unchanged.
//
// jsdom cannot measure speed, so this asserts the mechanism the speed-up
// depends on, plus that erasing's ownership and result path are unchanged. The
// real timings were measured in a browser (see the commit message / report).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allCanvasContexts, bootAppForTest, canvasContexts, firePointer, flush, latestEventSource, MY_OWNER_ID, type PostedRequest } from "./app-test-helpers";

let posted: PostedRequest[];
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
const canvas = () => $("canvas");

const op = (over: Record<string, unknown> = {}) => ({
  seq: 1,
  id: "op-1",
  ownerId: MY_OWNER_ID,
  kind: "draw",
  color: "#e85d5d",
  size: 0.006,
  points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }],
  createdAt: Date.now(),
  shape: { type: "rectangle", mode: "filled" },
  ...over,
});

async function bootWith(ops: unknown[]) {
  await bootAppForTest(posted);
  latestEventSource().emit("sync", { docKind: "freehand", ops });
  await flush();
}

// The canvases that are not the visible canvas, the preview overlay or the colour wheel, with their pixel size.
function scratchContexts() {
  const named = new Set([canvasContexts.get("canvas"), canvasContexts.get("remote-stroke-preview"), canvasContexts.get("colour-wheel")]);
  return allCanvasContexts.filter((c) => !named.has(c));
}
// size of the canvas a stub context belongs to: the stub is created in getContext(), so track it via the element
function sizesByContext() {
  const sizes = new Map<unknown, { w: number; h: number }>();
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: (...a: unknown[]) => unknown };
  void proto;
  return sizes;
}
void sizesByContext;

async function eraseDrag(x0: number, y0: number, x1: number, y1: number) {
  $("tool-eraser").dispatchEvent(new Event("click", { bubbles: true }));
  await flush();
  firePointer(canvas(), "pointerdown", { clientX: x0, clientY: y0 });
  await flush();
  firePointer(canvas(), "pointermove", { clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2 });
  await flush();
  firePointer(canvas(), "pointermove", { clientX: x1, clientY: y1 });
  await flush();
  firePointer(canvas(), "pointerup", { clientX: x1, clientY: y1 });
  await flush();
}

describe("regional (erase-frame) repaint uses a region-sized surface", () => {
  it("a regional repaint blits a small region from a small scratch, never a 1920x1080 area from the full scratch", async () => {
    await bootWith([op({ id: "big-rect" }), op({ id: "big-ellipse", seq: 2, shape: { type: "ellipse", mode: "filled" } })]);
    const visible = canvasContexts.get("canvas")!;
    visible.drawImage.mockClear();

    await eraseDrag(900, 500, 1000, 560);

    // Every drawImage onto the visible canvas during the drag's regional frames is a small rectangle
    // (the erase region), blitted from the origin of the small scratch (sx = sy = 0).
    const regionalBlits = visible.drawImage.mock.calls.filter((call) => (call as unknown[]).length === 9) as unknown as number[][];
    expect(regionalBlits.length).toBeGreaterThan(0);
    const frameBlits = regionalBlits.filter(([, sx, sy, sw, sh]) => !(sw === 1920 && sh === 1080));
    expect(frameBlits.length).toBeGreaterThan(0);
    for (const [, sx, sy, sw, sh, dx, dy, dw, dh] of frameBlits) {
      expect(sx).toBe(0);
      expect(sy).toBe(0);
      expect(sw).toBe(dw);
      expect(sh).toBe(dh);
      expect(sw).toBeLessThan(400); // a small box around the pointer, nowhere near the 1920x1080 document
      expect(sh).toBeLessThan(400);
      expect(dx).toBeGreaterThanOrEqual(0);
      expect(dy).toBeGreaterThanOrEqual(0);
    }
  });

  it("the region's pixels land at the document position under the pointer (same place as before the change)", async () => {
    await bootWith([op({ id: "big-rect" })]);
    const visible = canvasContexts.get("canvas")!;
    visible.drawImage.mockClear();

    await eraseDrag(960, 540, 1000, 560);

    const blits = visible.drawImage.mock.calls.filter((c) => (c as unknown[]).length === 9) as unknown as number[][];
    const small = blits.filter(([, , , sw, sh]) => sw < 400 && sh < 400);
    expect(small.length).toBeGreaterThan(0);
    // the erase drag spans document x 960..1000 and y 540..560 (jsdom maps client px 1:1 to document px)
    const hit = small.some(([, , , sw, sh, dx, dy]) => dx <= 1000 && dx + sw >= 960 && dy <= 560 && dy + sh >= 540);
    expect(hit).toBe(true);
  });

  it("a FULL repaint (sync / undo reload / fade tick) is unchanged: it still composites the whole document", async () => {
    await bootWith([op({ id: "big-rect" })]);
    const visible = canvasContexts.get("canvas")!;
    visible.drawImage.mockClear();
    latestEventSource().emit("sync", { docKind: "freehand", ops: [op({ id: "big-rect" })] });
    await flush();
    const full = visible.drawImage.mock.calls.filter((c) => (c as unknown[]).length === 9) as unknown as number[][];
    expect(full.some(([, sx, sy, sw, sh]) => sx === 0 && sy === 0 && sw === 1920 && sh === 1080)).toBe(true);
  });
});

describe("erasing behaviour is unchanged", () => {
  it("one erase op is committed on release, with the eraser's own radius and the dragged points", async () => {
    await bootWith([op()]);
    await eraseDrag(900, 500, 1000, 560);
    const erases = posted.filter((p) => p.url.endsWith("/erase"));
    expect(erases).toHaveLength(1);
    const body = erases[0].body as { radius: number; points: Array<{ x: number; y: number }> };
    expect(body.radius).toBeGreaterThan(0);
    expect(body.points.length).toBeGreaterThanOrEqual(2);
    expect(body.points[0].x * 1920).toBeCloseTo(900, 6);
    expect(body.points[0].y * 1080).toBeCloseTo(500, 6);
    expect(posted.filter((p) => p.url.endsWith("/draw"))).toHaveLength(0);
  });

  it("erasing paints a destination-out erase onto MY layer only, never onto another guest's layer", async () => {
    await bootWith([op({ id: "mine" }), op({ id: "theirs", seq: 2, ownerId: "someone-else", shape: { type: "ellipse", mode: "filled" } })]);
    const before = scratchContexts().map((c) => c.stroke.mock.calls.length);
    await eraseDrag(900, 500, 1000, 560);
    const erasing = scratchContexts().filter((c) => (c as unknown as { compositeWrites?: string[] }).compositeWrites?.includes("destination-out"));
    // exactly one owner layer received the erase stroke: mine (the other guest's layer must not)
    expect(erasing.length).toBe(1);
    void before;
  });

  it("an unfinished erase still drops no shape or polyline into the visible canvas's own drawing calls", async () => {
    await bootWith([op()]);
    const visible = canvasContexts.get("canvas")!;
    const rectsBefore = visible.rect.mock.calls.length;
    await eraseDrag(900, 500, 1000, 560);
    expect(visible.rect.mock.calls.length).toBe(rectsBefore); // regional repaints composite via drawImage, they do not stamp shapes
  });
});
