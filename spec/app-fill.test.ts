// @vitest-environment jsdom
//
// Paint Bucket client behaviour that does not need real pixels: the tool is wired like the other tools, a click
// commits exactly one persisted fill op on the SELECTED layer (carrying its spans), a hidden layer blocks it,
// the size slider is disabled, and replaying a saved fill paints through the normal compositor. What the fill
// actually covers (four-connected, per-layer sampling) is covered on real data in floodfill.test.ts and, with
// real canvas pixels, by the browser run described in the commit message.

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
async function clickCanvas(x: number, y: number) {
  firePointer($("canvas"), "pointerdown", { clientX: x, clientY: y });
  await flush();
  firePointer($("canvas"), "pointerup", { clientX: x, clientY: y });
  await flush();
}

describe("Paint Bucket tool", () => {
  it("is in the tool ribbon and selecting it gives the standard selected styling and disables the size slider", async () => {
    await bootAppForTest(posted);
    expect(document.querySelector("#tool-group #tool-fill")).toBeTruthy();
    click($("tool-fill"));
    await flush();
    expect($("tool-fill").classList.contains("selected")).toBe(true);
    expect($("tool-fill").getAttribute("aria-pressed")).toBe("true");
    expect($("tool-brush").classList.contains("selected")).toBe(false);
    expect(($("tool-size-slider") as HTMLInputElement).disabled).toBe(true);
    click($("tool-brush"));
    await flush();
    expect($("tool-fill").classList.contains("selected")).toBe(false);
    expect(($("tool-size-slider") as HTMLInputElement).disabled).toBe(false);
  });

  it("one click on an empty layer persists exactly one fill op on the SELECTED layer, carrying its spans", async () => {
    await bootAppForTest(posted);
    click(card("Colour"));
    await flush();
    click($("tool-fill"));
    await flush();
    await clickCanvas(500, 400);
    const posts = drawPosts();
    expect(posts).toHaveLength(1);
    const body = posts[0].body as { layerId: string; shape: { type: string; runs: number[] }; points: unknown[] };
    expect(body.layerId).toBe("colour");
    expect(body.shape.type).toBe("fill");
    expect(body.points).toHaveLength(1);
    expect(body.shape.runs.length % 3).toBe(0);
  });

  it("a fill on the upper layer and one on the lower layer each keep their own layer", async () => {
    await bootAppForTest(posted);
    click($("tool-fill"));
    await flush();
    for (const layer of ["Lineart", "Colour", "Lineart"]) {
      click(card(layer));
      await flush();
      await clickCanvas(300, 300);
    }
    expect(drawPosts().map((p) => p.body.layerId)).toEqual(["lineart", "colour", "lineart"]);
  });

  it("a hidden layer cannot be filled (same notice as the other tools), and nothing is posted", async () => {
    await bootAppForTest(posted);
    click($("tool-fill"));
    await flush();
    click(card("Lineart").querySelector(".layer-eye")!); // hide the selected (top) layer
    await flush();
    await clickCanvas(500, 400);
    expect(drawPosts()).toHaveLength(0);
    expect(($("layer-hidden-notice") as HTMLElement).hidden).toBe(false);
  });

  it("filling never produces a freehand/erase request and never touches other layers' data", async () => {
    await bootAppForTest(posted);
    click($("tool-fill"));
    await flush();
    await clickCanvas(500, 400);
    expect(posted.filter((p) => p.url.endsWith("/erase"))).toHaveLength(0);
    expect(drawPosts()).toHaveLength(1);
  });

  it("a saved fill replays on refresh through the normal compositor (painted via fillRect, on its own layer)", async () => {
    await bootAppForTest(posted);
    allCanvasContexts.forEach((c) => c.fillRect.mockClear());
    latestEventSource().emit("sync", {
      docKind: "freehand",
      ops: [
        {
          seq: 1, id: "f1", ownerId: MY_OWNER_ID, kind: "draw", color: "#55b78b", size: 0.004, createdAt: Date.now(),
          points: [{ x: 0.2, y: 0.3 }], layerId: "colour", shape: { type: "fill", runs: [10, 100, 50, 11, 100, 50] },
        },
      ],
    });
    await flush();
    const rects = allCanvasContexts.reduce((n, c) => n + c.fillRect.mock.calls.length, 0);
    expect(rects).toBeGreaterThan(0);
    expect(canvasContexts.get("canvas")!.fillRect.mock.calls.length).toBe(0); // never painted straight onto the visible canvas
  });
});
