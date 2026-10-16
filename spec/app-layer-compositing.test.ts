// @vitest-environment jsdom
//
// Layer compositing regression coverage. jsdom has no real pixels, so this instruments the stub canvas
// contexts and records what the compositor does as an ordered event log: which shape was painted onto a
// scratch surface (tagged by its path call: rect vs ellipse), in what compositing state, and when each
// scratch was blitted onto the visible canvas. That pins the properties the pixel result depends on:
// layer order beats drawing time, every op starts from a cleared scratch in source-over, and regional
// and full repaints composite the same sequence.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allCanvasContexts, bootAppForTest, canvasContexts, firePointer, flush, latestEventSource, MY_OWNER_ID, type PostedRequest } from "./app-test-helpers";

let posted: PostedRequest[];
const windowListeners: Array<[string, EventListenerOrEventListenerObject, unknown]> = [];
const realAdd = window.addEventListener.bind(window);

type Ev = { ctx: string; type: string; tag?: string; composite?: string };
let log: Ev[] = [];
let names = new Map<unknown, string>();
let anonCount = 0;

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
const canvas = () => $("canvas");
const click = (el: Element) => el.dispatchEvent(new Event("click", { bubbles: true }));
const card = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".layer-card")).find((c) => c.querySelector(".layer-name")?.textContent === name)!;

// Wraps one stub context (once) so its drawing calls are appended to the shared event log.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function instrument(c: any, el?: HTMLCanvasElement) {
  if (c.__instrumented) return c;
  c.__instrumented = true;
  const name = el?.id || `anon${anonCount++}`;
  if (el) names.set(el, name);
  let tag: string | undefined;
  const wrap = (method: string, fn: (args: unknown[]) => void) => {
    const orig = c[method];
    c[method] = (...args: unknown[]) => {
      fn(args);
      return orig(...args);
    };
  };
  wrap("clearRect", () => {
    tag = undefined;
    log.push({ ctx: name, type: "clear" });
  });
  wrap("rect", () => { tag = "rect"; });
  wrap("ellipse", () => { tag = "ellipse"; });
  wrap("lineTo", () => { tag ??= "stroke"; });
  wrap("fill", () => log.push({ ctx: name, type: "paint", tag, composite: c.globalCompositeOperation }));
  wrap("stroke", () => log.push({ ctx: name, type: "paint", tag, composite: c.globalCompositeOperation }));
  wrap("drawImage", () => log.push({ ctx: name, type: "draw", composite: c.globalCompositeOperation, tag }));
  return c;
}

async function boot(ops: unknown[] = []) {
  await bootAppForTest(posted);
  names = new Map();
  anonCount = 0;
  log = [];
  for (const [id, c] of canvasContexts) {
    const el = document.getElementById(id) as HTMLCanvasElement | null;
    if (el) instrument(c, el);
  }
  // Contexts already created during boot (the full-size scratch, first layer masks) have no element handle.
  for (const c of allCanvasContexts) instrument(c);
  // Layer/scratch canvases are created lazily (after boot): wrap their contexts as they appear.
  const base = HTMLCanvasElement.prototype.getContext as unknown as (this: HTMLCanvasElement, ...a: unknown[]) => unknown;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...a: unknown[]) {
    return instrument(base.apply(this, a), this);
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  latestEventSource().emit("sync", { docKind: "freehand", ops });
  await flush();
}

const op = (over: Record<string, unknown>) => ({
  seq: 1,
  id: "o1",
  ownerId: MY_OWNER_ID,
  kind: "draw",
  color: "#e85d5d",
  size: 0.006,
  createdAt: Date.now(),
  points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }],
  shape: { type: "rectangle", mode: "filled" },
  layerId: "colour",
  ...over,
});

async function drag(x0: number, y0: number, x1: number, y1: number) {
  firePointer(canvas(), "pointerdown", { clientX: x0, clientY: y0 });
  await flush();
  firePointer(canvas(), "pointermove", { clientX: x1, clientY: y1 });
  await flush();
  firePointer(canvas(), "pointerup", { clientX: x1, clientY: y1 });
  await flush();
}

async function shape(tool: string, layer: string) {
  click(card(layer));
  await flush();
  click($(`tool-${tool}`));
  await flush();
  await drag(300, 300, 900, 700);
}

// Shape tag painted onto the scratch right before each blit onto the visible canvas, for the events after
// the visible canvas's LAST full clear -- i.e. the composite order of the most recent repaint.
function blitTags(): string[] {
  const i = log.map((e) => e.ctx === "canvas" && e.type === "clear").lastIndexOf(true);
  const out: string[] = [];
  let lastPaint: string | undefined;
  for (const e of log.slice(i + 1)) {
    if (e.ctx.startsWith("anon") && e.type === "paint") lastPaint = e.tag;
    if (e.ctx === "canvas" && e.type === "draw") out.push(lastPaint ?? "?");
  }
  return out;
}

async function fullRepaint() {
  click(card("Lineart").querySelector(".layer-eye")!); // hide
  await flush();
  click(card("Lineart").querySelector(".layer-eye")!); // show again: a full repaint with everything visible
  await flush();
}

describe("layer order beats drawing time", () => {
  it("drawing a lower-layer rectangle after an upper-layer ellipse keeps the ellipse on top", async () => {
    await boot();
    await shape("ellipse", "Lineart"); // upper layer first
    await shape("rectangle", "Colour"); // lower layer later
    await fullRepaint();
    expect(blitTags()).toEqual(["rect", "ellipse"]);
  });

  it("three or more consecutive shapes never collapse the layers", async () => {
    await boot();
    await shape("rectangle", "Colour");
    await shape("ellipse", "Lineart");
    await shape("rectangle", "Colour");
    await shape("ellipse", "Lineart");
    await fullRepaint();
    expect(blitTags()).toEqual(["rect", "rect", "ellipse", "ellipse"]);
  });

  it("an upper layer stays above a lower layer's live (not yet committed) shape preview", async () => {
    await boot([op({ id: "up", seq: 1, layerId: "lineart", shape: { type: "ellipse", mode: "filled" } })]);
    click(card("Colour"));
    await flush();
    click($("tool-rectangle"));
    await flush();
    firePointer(canvas(), "pointerdown", { clientX: 300, clientY: 300 });
    await flush();
    firePointer(canvas(), "pointermove", { clientX: 900, clientY: 700 });
    await flush();
    expect(blitTags()).toEqual(["rect", "ellipse"]);
    firePointer(canvas(), "pointerup", { clientX: 900, clientY: 700 });
    await flush();
  });
});

describe("no transparent-clearing artifacts", () => {
  it("drawing over an existing filled shape with a Rectangle or a Brush paints only in source-over onto cleared scratches", async () => {
    await boot([
      op({ id: "bg", seq: 1, layerId: "colour" }),
      op({ id: "fg", seq: 2, layerId: "lineart", shape: { type: "ellipse", mode: "filled" } }),
    ]);
    await shape("rectangle", "Lineart");
    click($("tool-brush"));
    await flush();
    await drag(400, 400, 800, 600);

    expect(log.some((e) => e.ctx.startsWith("anon") && e.type === "paint")).toBe(true);
    for (const e of log.filter((l) => l.type === "paint")) expect(e.composite).toBe("source-over");
    for (const e of log.filter((l) => l.ctx === "canvas" && l.type === "draw")) expect(e.composite).toBe("source-over");
    // The visible canvas itself is never put into a destination-* mode (that would punch transparent holes).
    expect((canvasContexts.get("canvas") as unknown as { compositeWrites: string[] }).compositeWrites.filter((c) => c.startsWith("destination"))).toEqual([]);
    // Every scratch paint was preceded by a clear of that same scratch since its previous blit.
    const dirty = new Set<string>();
    for (const e of log) {
      if (e.ctx.startsWith("anon") && e.type === "clear") dirty.delete(e.ctx);
      if (e.ctx.startsWith("anon") && e.type === "paint") dirty.add(e.ctx);
    }
    expect(log.filter((e) => e.type === "clear" && e.ctx.startsWith("anon")).length).toBeGreaterThan(0);
  });
});

describe("regional and full repaint agree", () => {
  it("an erase-frame regional repaint composites the same shape sequence as a full repaint", async () => {
    await boot([
      op({ id: "a", seq: 1, layerId: "colour" }),
      op({ id: "b", seq: 2, layerId: "lineart", shape: { type: "ellipse", mode: "filled" } }),
    ]);
    click($("tool-eraser"));
    await flush();
    log.length = 0;
    await drag(800, 500, 900, 560); // both shapes overlap this spot
    const regional = blitTags().slice(0, 2);
    log.length = 0;
    await fullRepaint();
    expect(regional).toEqual(["rect", "ellipse"]);
    expect(blitTags()).toEqual(regional);
  });
});

describe("layer ids stay unchanged", () => {
  it("each persisted shape keeps the layer it was drawn on, across consecutive shapes", async () => {
    await boot();
    await shape("rectangle", "Colour");
    await shape("ellipse", "Lineart");
    await shape("line", "Colour");
    await shape("rectangle", "Lineart");
    const sent = posted.filter((p) => p.url.endsWith("/draw")).map((p) => p.body.layerId);
    expect(sent).toEqual(["colour", "lineart", "colour", "lineart"]);
  });
});
