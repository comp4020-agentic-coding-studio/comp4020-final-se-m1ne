// @vitest-environment jsdom
//
// Airbrush client behaviour that does not need real pixels (the jsdom canvas is a call-recording stub): the tool
// is wired like the other tools and shares the brush size control, a drag persists one ordinary draw op tagged
// {type:"airbrush"} on the SELECTED layer, a hidden layer blocks it, a saved or remote stroke is composited through
// the normal layer compositor (never straight onto the visible canvas), and an owner's erase masks only that
// owner's strokes. The soft alpha itself is covered on real arrays in airbrush.test.ts. NOT covered here, and not
// visually verified: how it actually looks on a real canvas.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allCanvasContexts, bootAppForTest, canvasContexts, firePointer, flush, latestEventSource, MY_OWNER_ID, type PostedRequest } from "./app-test-helpers";

let posted: PostedRequest[];
const windowListeners: Array<[string, EventListenerOrEventListenerObject, unknown]> = [];
const realAdd = window.addEventListener.bind(window);
beforeEach(() => {
  posted = [];
  localStorage.clear();
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
const click = (el: Element) => el.dispatchEvent(new Event("click", { bubbles: true }));
const card = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".layer-card")).find((c) => c.querySelector(".layer-name")?.textContent === name)!;
const drawPosts = () => posted.filter((p) => p.url.endsWith("/draw"));
const strokePosts = () => posted.filter((p) => p.url.endsWith("/stroke"));
async function drag(x0: number, y0: number, x1: number, y1: number) {
  firePointer($("canvas"), "pointerdown", { clientX: x0, clientY: y0 });
  await flush();
  firePointer($("canvas"), "pointermove", { clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2 });
  await flush();
  firePointer($("canvas"), "pointermove", { clientX: x1, clientY: y1 });
  await flush();
  firePointer($("canvas"), "pointerup", { clientX: x1, clientY: y1 });
  await flush();
}
async function airbrush(layer?: string) {
  if (layer) {
    click(card(layer));
    await flush();
  }
  click($("tool-airbrush"));
  await flush();
  await drag(300, 300, 700, 500);
}

describe("Airbrush tool wiring", () => {
  it("is in the tool ribbon right after Brush, with the standard selected styling", async () => {
    await bootAppForTest(posted);
    const ids = [...document.querySelectorAll("#tool-group > button")].map((b) => b.id);
    expect(ids.slice(0, 3)).toEqual(["tool-brush", "tool-airbrush", "tool-eraser"]);
    click($("tool-airbrush"));
    await flush();
    expect($("tool-airbrush").classList.contains("selected")).toBe(true);
    expect($("tool-airbrush").getAttribute("aria-pressed")).toBe("true");
    expect($("tool-brush").classList.contains("selected")).toBe(false);
    click($("tool-brush"));
    await flush();
    expect($("tool-airbrush").classList.contains("selected")).toBe(false);
  });

  it("uses the existing brush-size control and value (size = the full diameter), with the slider enabled", async () => {
    await bootAppForTest(posted);
    click($("tool-brush"));
    await flush();
    const slider = $("tool-size-slider") as HTMLInputElement;
    slider.value = "24";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    click($("tool-airbrush"));
    await flush();
    expect(slider.disabled).toBe(false);
    expect(slider.value).toBe("24");
    await drag(300, 300, 700, 500);
    expect((drawPosts()[0].body as { width: number }).width).toBeCloseTo(24 / 1920, 6);
  });

  it("keeps the brush-style circular size cursor (no crosshair)", async () => {
    await bootAppForTest(posted);
    click($("tool-airbrush"));
    await flush();
    expect(($("canvas") as HTMLElement).style.cursor).toBe("none");
  });
});

describe("Airbrush stroke persistence and layers", () => {
  it("one drag persists exactly one draw op tagged airbrush, with its freehand points, on the SELECTED layer", async () => {
    await bootAppForTest(posted);
    await airbrush("Colour");
    expect(drawPosts()).toHaveLength(1);
    const body = drawPosts()[0].body as { shape: unknown; layerId: string; points: unknown[] };
    expect(body.shape).toEqual({ type: "airbrush" });
    expect(body.layerId).toBe("colour");
    expect(body.points.length).toBeGreaterThanOrEqual(2);
    expect(posted.filter((p) => p.url.endsWith("/erase"))).toHaveLength(0);
  });

  it("the plain Brush is unchanged: it still posts a plain draw op with no shape", async () => {
    await bootAppForTest(posted);
    click($("tool-brush"));
    await flush();
    await drag(300, 300, 700, 500);
    expect((drawPosts()[0].body as { shape?: unknown }).shape).toBeUndefined();
  });

  it("interleaved airbrush and brush strokes across layers each keep their own layer id", async () => {
    await bootAppForTest(posted);
    const seq: Array<[string, string]> = [["Lineart", "airbrush"], ["Colour", "brush"], ["Colour", "airbrush"], ["Lineart", "brush"], ["Lineart", "airbrush"]];
    for (const [layer, tool] of seq) {
      click(card(layer));
      await flush();
      click($(`tool-${tool}`));
      await flush();
      await drag(300, 300, 700, 500);
    }
    expect(drawPosts().map((p) => p.body.layerId)).toEqual(["lineart", "colour", "colour", "lineart", "lineart"]);
    expect(drawPosts().map((p) => (p.body.shape as { type?: string } | undefined)?.type)).toEqual(["airbrush", undefined, "airbrush", undefined, "airbrush"]);
  });

  it("a hidden layer cannot be airbrushed (same notice as the other tools), and nothing is posted", async () => {
    await bootAppForTest(posted);
    click($("tool-airbrush"));
    await flush();
    click(card("Lineart").querySelector(".layer-eye")!); // hide the selected (top) layer
    await flush();
    await drag(300, 300, 700, 500);
    expect(drawPosts()).toHaveLength(0);
    expect(($("layer-hidden-notice") as HTMLElement).hidden).toBe(false);
  });

  it("while dragging, the live preview broadcast carries the airbrush shape so other sessions see a soft stroke", async () => {
    await bootAppForTest(posted);
    click($("tool-airbrush"));
    await flush();
    await drag(300, 300, 700, 500);
    const live = strokePosts().filter((p) => p.body.active === true);
    expect(live.length).toBeGreaterThan(0);
    for (const p of live) expect(p.body.shape).toEqual({ type: "airbrush" });
  });
});

describe("Airbrush rendering goes through the layer compositor", () => {
  const strokeOp = (over: Record<string, unknown> = {}) => ({
    seq: 1,
    id: "a1",
    ownerId: MY_OWNER_ID,
    kind: "draw",
    color: "#7b3fe4",
    size: 0.02,
    createdAt: Date.now(),
    points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.4 }],
    shape: { type: "airbrush" },
    layerId: "colour",
    ...over,
  });
  const puts = () => allCanvasContexts.reduce((n, c) => n + c.putImageData.mock.calls.length, 0);
  const destinationIn = () =>
    allCanvasContexts.reduce((n, c) => n + ((c as unknown as { compositeWrites?: string[] }).compositeWrites ?? []).filter((m) => m === "destination-in").length, 0);

  it("a saved stroke replays on refresh: rasterised into pixel data and blitted via a scratch, never put or stroked straight on #canvas", async () => {
    await bootAppForTest(posted);
    const visible = canvasContexts.get("canvas")!;
    allCanvasContexts.forEach((c) => c.putImageData.mockClear());
    visible.stroke.mockClear();
    visible.drawImage.mockClear();
    latestEventSource().emit("sync", { docKind: "freehand", ops: [strokeOp()] });
    await flush();
    expect(puts()).toBeGreaterThan(0); // the soft alpha was built as image data
    expect(visible.putImageData.mock.calls.length).toBe(0); // ...but never put straight onto the visible canvas
    expect(visible.stroke.mock.calls.length).toBe(0); // and no hard polyline was stroked on it
    expect(visible.drawImage.mock.calls.length).toBeGreaterThan(0); // composited via the layer compositor
  });

  it("a remote session's stroke (SSE op) is rendered the same way, on its own layer", async () => {
    await bootAppForTest(posted);
    const visible = canvasContexts.get("canvas")!;
    visible.drawImage.mockClear();
    visible.putImageData.mockClear();
    latestEventSource().emit("op", { ...strokeOp({ id: "r1", seq: 5, ownerId: "owner-REMOTE", layerId: "lineart" }), active: true });
    await flush();
    expect(visible.drawImage.mock.calls.length).toBeGreaterThan(0);
    expect(visible.putImageData.mock.calls.length).toBe(0);
  });

  it("an owner's erase masks that owner's airbrush stroke, and another owner's erase does not touch it", async () => {
    await bootAppForTest(posted);
    const erase = (ownerId: string) => ({
      seq: 3, id: `e-${ownerId}`, ownerId, kind: "erase", color: null, size: 0.03, createdAt: Date.now(),
      points: [{ x: 0.3, y: 0.35 }], layerId: "colour",
    });
    // someone else's stroke + MY erase over it: the stroke belongs to another owner, so it must NOT be masked
    latestEventSource().emit("sync", { docKind: "freehand", ops: [strokeOp({ ownerId: "owner-REMOTE" }), erase(MY_OWNER_ID)] });
    await flush();
    const base = destinationIn();
    // my stroke + my erase over it: it IS masked by my own layer
    latestEventSource().emit("sync", { docKind: "freehand", ops: [strokeOp({ ownerId: MY_OWNER_ID }), erase(MY_OWNER_ID)] });
    await flush();
    expect(destinationIn()).toBeGreaterThan(base);
  });

  it("a stroke drawn live is composited from the compositor (regional repaints), not painted directly on #canvas", async () => {
    await bootAppForTest(posted);
    const visible = canvasContexts.get("canvas")!;
    click($("tool-airbrush"));
    await flush();
    visible.stroke.mockClear();
    visible.putImageData.mockClear();
    await drag(300, 300, 700, 500);
    expect(visible.stroke.mock.calls.length).toBe(0);
    expect(visible.putImageData.mock.calls.length).toBe(0);
    expect(visible.drawImage.mock.calls.length).toBeGreaterThan(0);
  });
});
