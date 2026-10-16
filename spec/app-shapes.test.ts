// @vitest-environment jsdom
//
// Client behaviour of the Line / Rectangle / Ellipse tools in
// public/app.js, booted for real in jsdom: toolbar layout and selection, the
// Outline/Filled selector, gestures (down/move/up), all four drag directions,
// live Shift press/release, the geometry that gets committed, cancellation
// (Escape, pointercancel, lost capture, tool switch, a click), that nothing
// is saved or broadcast as a final op until pointer-up, and that previews are
// painted on the overlay rather than the real canvas.
//
// jsdom has no layout: app-test-helpers.ts fixes #canvas's rect at 1920x1080,
// so a client coordinate maps 1:1 to a document pixel and
// normalised = clientX/1920, clientY/1080.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootAppForTest, canvasContexts, firePointer, flush, type PostedRequest } from "./app-test-helpers";

const DOC_W = 1920;
const DOC_H = 1080;

let posted: PostedRequest[];

// bootAppForTest re-imports public/app.js for every test, and each import adds
// its own window keydown/keyup listeners that are never removed (a real page
// loads app.js exactly once). Track and remove them after each test so an old
// module instance cannot react to a later test's Escape/Shift.
const windowListeners: Array<[string, EventListenerOrEventListenerObject, unknown]> = [];
const realAddEventListener = window.addEventListener.bind(window);

beforeEach(() => {
  posted = [];
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    windowListeners.push([type, listener, options]);
    return realAddEventListener(type, listener, options as AddEventListenerOptions);
  }) as typeof window.addEventListener;
});

afterEach(() => {
  for (const [type, listener, options] of windowListeners.splice(0)) {
    window.removeEventListener(type, listener, options as EventListenerOptions);
  }
  window.addEventListener = realAddEventListener;
});

const $ = (id: string) => document.getElementById(id)!;
const click = (id: string) => $(id).dispatchEvent(new Event("click", { bubbles: true }));
const canvas = () => $("canvas");
const draws = () => posted.filter((p) => p.url.endsWith("/draw"));
const strokePosts = () => posted.filter((p) => p.url.endsWith("/stroke"));

async function down(x: number, y: number, shiftKey = false) {
  firePointer(canvas(), "pointerdown", { clientX: x, clientY: y, shiftKey });
  await flush();
}
async function move(x: number, y: number, shiftKey = false) {
  firePointer(canvas(), "pointermove", { clientX: x, clientY: y, shiftKey });
  await flush();
}
async function up(x: number, y: number, shiftKey = false) {
  firePointer(canvas(), "pointerup", { clientX: x, clientY: y, shiftKey });
  await flush();
}
async function key(type: "keydown" | "keyup", k: string) {
  window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }));
  await flush();
}
async function dragShape(x0: number, y0: number, x1: number, y1: number, shiftKey = false) {
  await down(x0, y0, shiftKey);
  await move((x0 + x1) / 2, (y0 + y1) / 2, shiftKey);
  await move(x1, y1, shiftKey);
  await up(x1, y1, shiftKey);
}

// the corner points the app POSTed, in document pixels
function postedCornersPx(i = draws().length - 1) {
  const pts = draws()[i].body.points as Array<{ x: number; y: number }>;
  return pts.map((p) => ({ x: p.x * DOC_W, y: p.y * DOC_H }));
}

async function pick(tool: string) {
  click(`tool-${tool}`);
  await flush();
}

describe("toolbar", () => {
  it("has exactly Brush, Eraser, Line, Rectangle, Ellipse, in that order, in one column", async () => {
    await bootAppForTest(posted);
    const ids = [...document.querySelectorAll("#tool-group > button")].map((b) => b.id);
    expect(ids).toEqual(["tool-brush", "tool-eraser", "tool-line", "tool-rectangle", "tool-ellipse"]);
    expect(document.querySelectorAll("#tool-ribbon #tool-group").length).toBe(1); // no second toolbar
  });

  it("has no Triangle tool: no button, no label, no way to select it", async () => {
    await bootAppForTest(posted);
    expect(document.getElementById("tool-triangle")).toBeNull();
    expect(document.querySelector('[aria-label="Triangle"], [title="Triangle"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/triangle/i);
  });

  it("all six use the one existing .tool-button style, each with an icon and an accessible name", async () => {
    await bootAppForTest(posted);
    for (const b of document.querySelectorAll<HTMLButtonElement>("#tool-group > button")) {
      expect(b.classList.contains("tool-button")).toBe(true);
      expect(b.querySelector("svg")).not.toBeNull();
      expect(b.getAttribute("aria-label")).toBeTruthy();
      expect(b.getAttribute("aria-pressed")).toMatch(/true|false/);
    }
  });

  it("only one tool is selected at a time", async () => {
    await bootAppForTest(posted);
    for (const t of ["line", "rectangle", "ellipse", "eraser", "brush"]) {
      await pick(t);
      const selected = [...document.querySelectorAll("#tool-group > button.selected")].map((b) => b.id);
      expect(selected).toEqual([`tool-${t}`]);
      for (const b of document.querySelectorAll("#tool-group > button")) {
        expect(b.getAttribute("aria-pressed")).toBe(String(b.id === `tool-${t}`));
      }
    }
  });

  it("Eyedropper stays out of the toolbar, and Undo/Redo stay out of it", async () => {
    await bootAppForTest(posted);
    expect(document.querySelector("#tool-ribbon #tool-eyedropper")).toBeNull();
    expect(document.querySelector("#tool-ribbon #undo-button, #tool-ribbon #redo-button")).toBeNull();
  });
});

describe("Outline / Filled selector", () => {
  it("is hidden for Brush, Eraser and Line and shown for Rectangle and Ellipse", async () => {
    await bootAppForTest(posted);
    const control = $("shape-mode-control") as HTMLElement;
    for (const t of ["brush", "eraser", "line"]) {
      await pick(t);
      expect(control.hidden, t).toBe(true);
    }
    for (const t of ["rectangle", "ellipse"]) {
      await pick(t);
      expect(control.hidden, t).toBe(false);
    }
  });

  it("defaults to Outline, is one shared setting across Rectangle and Ellipse, and is one compact control (two buttons)", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    expect($("shape-mode-outline").classList.contains("selected")).toBe(true);
    expect($("shape-mode-filled").classList.contains("selected")).toBe(false);
    expect(document.querySelectorAll("#shape-mode-control button")).toHaveLength(2);

    click("shape-mode-filled");
    for (const t of ["ellipse", "rectangle"]) {
      await pick(t);
      expect($("shape-mode-filled").classList.contains("selected"), t).toBe(true);
      expect($("shape-mode-filled").getAttribute("aria-pressed")).toBe("true");
    }
  });

  it("the chosen mode is what gets committed (outline, then filled)", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await dragShape(100, 100, 300, 220);
    click("shape-mode-filled");
    await dragShape(400, 100, 600, 220);
    expect(draws().map((d) => d.body.shape)).toEqual([
      { type: "rectangle", mode: "outline" },
      { type: "rectangle", mode: "filled" },
    ]);
  });

  it("a line carries no mode even if Filled is selected", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    click("shape-mode-filled");
    await pick("line");
    await dragShape(100, 100, 300, 220);
    expect(draws()[0].body.shape).toEqual({ type: "line" });
  });
});

describe("gesture: preview, commit, stroke width and colour", () => {
  it("nothing is saved on pointer-down or while dragging; pointer-up commits exactly one op", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await down(100, 100);
    await move(200, 160);
    await move(300, 220);
    expect(draws()).toHaveLength(0); // intermediate preview frames are never saved
    await up(300, 220);
    expect(draws()).toHaveLength(1);
  });

  it("commits {shape, two corners, colour, brush size as stroke width}", async () => {
    await bootAppForTest(posted);
    await pick("ellipse");
    await dragShape(100, 100, 300, 220);
    const body = draws()[0].body;
    expect(body.shape).toEqual({ type: "ellipse", mode: "outline" });
    expect(body.points).toHaveLength(2);
    expect(body.color).toBe("#1d1d1d"); // the current drawing colour
    expect(body.width).toBeCloseTo(6 / DOC_W, 9); // the brush-size setting (6px default) as stroke width
  });

  it("uses the current drawing colour and the current brush-size setting", async () => {
    await bootAppForTest(posted);
    (document.querySelector('#palette .swatch[data-color="#E85D5D"]') as HTMLElement).click();
    const slider = $("tool-size-slider") as HTMLInputElement;
    await pick("line");
    slider.value = "20";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await dragShape(100, 100, 400, 300);
    expect(draws()[0].body.color).toBe("#e85d5d");
    expect(draws()[0].body.width).toBeCloseTo(20 / DOC_W, 9);
  });

  it("the shape tools share the Brush size (switching Brush <-> shape keeps the number)", async () => {
    await bootAppForTest(posted);
    const slider = $("tool-size-slider") as HTMLInputElement;
    slider.value = "17";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    for (const t of ["rectangle", "ellipse", "brush"]) {
      await pick(t);
      expect(slider.value, t).toBe("17");
      expect(slider.disabled).toBe(false);
    }
  });

  it("the live preview is painted on the overlay canvas, not on the real canvas, until commit", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    const realCanvas = canvasContexts.get("canvas")!;
    const overlay = canvasContexts.get("remote-stroke-preview")!;
    const realRectsBefore = realCanvas.rect.mock.calls.length;
    const overlayRectsBefore = overlay.rect.mock.calls.length;
    const realDrawsBefore = realCanvas.drawImage.mock.calls.length;
    await down(100, 100);
    await move(300, 220);
    expect(overlay.rect.mock.calls.length).toBeGreaterThan(overlayRectsBefore); // previewed on the overlay
    expect(realCanvas.rect.mock.calls.length).toBe(realRectsBefore); // the real canvas is untouched mid-drag
    await up(300, 220);
    // Committed shapes reach the real canvas only through the layer compositor (blitted from a scratch), never as a
    // direct path on #canvas -- that is what keeps them at their own layer's position.
    expect(realCanvas.rect.mock.calls.length).toBe(realRectsBefore);
    expect(realCanvas.drawImage.mock.calls.length).toBeGreaterThan(realDrawsBefore);
  });

  it("broadcasts the live preview (carrying the shape) over the existing stroke route, then a stroke-end", async () => {
    await bootAppForTest(posted);
    await pick("ellipse");
    await dragShape(100, 100, 300, 220);
    const active = strokePosts().filter((p) => p.body.active === true);
    expect(active.length).toBeGreaterThan(0);
    for (const p of active) expect(p.body.shape).toEqual({ type: "ellipse", mode: "outline" });
    expect(strokePosts().filter((p) => p.body.active === false)).toHaveLength(1);
  });

  it("a committed shape is added to the replay history, so Undo becomes available", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await dragShape(100, 100, 300, 220);
    await flush();
    expect(($("undo-button") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("geometry in all four drag directions", () => {
  const dirs: Array<[string, number, number]> = [
    ["down-right", 1, 1],
    ["down-left", -1, 1],
    ["up-right", 1, -1],
    ["up-left", -1, -1],
  ];

  for (const tool of ["line", "rectangle", "ellipse"]) {
    for (const [name, sx, sy] of dirs) {
      it(`${tool} ${name}: anchored at pointer-down, other corner at the pointer`, async () => {
        await bootAppForTest(posted);
        await pick(tool);
        const ax = 900;
        const ay = 500;
        await dragShape(ax, ay, ax + sx * 240, ay + sy * 140);
        const [a, b] = postedCornersPx();
        expect(a.x).toBeCloseTo(ax, 6);
        expect(a.y).toBeCloseTo(ay, 6);
        expect(b.x).toBeCloseTo(ax + sx * 240, 6);
        expect(b.y).toBeCloseTo(ay + sy * 140, 6);
      });
    }
  }
});

describe("Shift constraints at pointer-up", () => {
  const dirs: Array<[string, number, number]> = [
    ["down-right", 1, 1],
    ["down-left", -1, 1],
    ["up-right", 1, -1],
    ["up-left", -1, -1],
  ];

  for (const tool of ["rectangle", "ellipse"]) {
    for (const [name, sx, sy] of dirs) {
      it(`Shift ${tool} ${name}: a perfect ${tool === "rectangle" ? "square" : "circle"} anchored at pointer-down`, async () => {
        await bootAppForTest(posted);
        await pick(tool);
        await dragShape(900, 500, 900 + sx * 300, 500 + sy * 170, true);
        const [a, b] = postedCornersPx();
        expect(a).toEqual({ x: 900, y: 500 });
        expect(Math.abs(b.x - a.x)).toBeCloseTo(Math.abs(b.y - a.y), 6);
        expect(Math.abs(b.x - a.x)).toBeCloseTo(170, 6); // fits inside the dragged region
        expect(Math.sign(b.x - a.x)).toBe(sx);
        expect(Math.sign(b.y - a.y)).toBe(sy);
      });
    }
  }

  it("a line is not constrained by Shift", async () => {
    await bootAppForTest(posted);
    await pick("line");
    await dragShape(900, 500, 1100, 560, true);
    const [, b] = postedCornersPx();
    expect(b.x).toBeCloseTo(1100, 6);
    expect(b.y).toBeCloseTo(560, 6);
  });

  it("without Shift the same drag stays free (rectangle 300x170)", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await dragShape(900, 500, 1200, 670, false);
    const [a, b] = postedCornersPx();
    expect(Math.abs(b.x - a.x)).toBeCloseTo(300, 6);
    expect(Math.abs(b.y - a.y)).toBeCloseTo(170, 6);
  });
});

describe("dynamic Shift during a drag", () => {
  // What the local preview has just painted on the overlay: the last rect() the
  // overlay received, as {width, height} in document pixels. This is what must
  // update immediately; the network broadcast of it is throttled like any other
  // stroke preview.
  const lastOverlayRect = () => {
    const ctx = canvasContexts.get("remote-stroke-preview")!;
    const rect = ctx.rect.mock.calls.at(-1) as number[] | undefined; // rect(x, y, w, h)
    const ellipse = ctx.ellipse.mock.calls.at(-1) as number[] | undefined; // ellipse(cx, cy, rx, ry, ...)
    if (ellipse && (!rect || ctx.ellipse.mock.invocationCallOrder.at(-1)! > ctx.rect.mock.invocationCallOrder.at(-1)!)) {
      return { width: ellipse[2] * 2, height: ellipse[3] * 2 };
    }
    return { width: Math.abs(rect![2]), height: Math.abs(rect![3]) };
  };
  const previewCornersPx = () => {
    const r = lastOverlayRect();
    return [{ x: 0, y: 0 }, { x: r.width, y: r.height }];
  };

  it("pressing Shift mid-drag squares the preview at once, without the pointer moving", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await down(900, 500);
    await move(1200, 670); // free: 300 x 170
    let [a, b] = previewCornersPx();
    expect(Math.abs(b.x - a.x)).toBeCloseTo(300, 6);
    expect(Math.abs(b.y - a.y)).toBeCloseTo(170, 6);

    await key("keydown", "Shift"); // no pointermove
    [a, b] = previewCornersPx();
    expect(Math.abs(b.x - a.x)).toBeCloseTo(170, 6);
    expect(Math.abs(b.y - a.y)).toBeCloseTo(170, 6);
    expect(draws()).toHaveLength(0);
    firePointer(canvas(), "pointercancel", {});
  });

  it("releasing Shift mid-drag restores the free preview at once", async () => {
    await bootAppForTest(posted);
    await pick("ellipse");
    await down(900, 500);
    await move(1200, 670, true);
    await key("keydown", "Shift");
    let [a, b] = previewCornersPx();
    expect(Math.abs(b.x - a.x)).toBeCloseTo(170, 6);

    await key("keyup", "Shift");
    [a, b] = previewCornersPx();
    expect(Math.abs(b.x - a.x)).toBeCloseTo(300, 6);
    expect(Math.abs(b.y - a.y)).toBeCloseTo(170, 6);
    firePointer(canvas(), "pointercancel", {});
  });

  it("the final geometry uses the Shift state at pointer-up: held at release -> constrained", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await down(900, 500);
    await move(1200, 670); // dragged free the whole way
    await up(1200, 670, true); // ...but Shift is held at release
    const [a, b] = postedCornersPx();
    expect(Math.abs(b.x - a.x)).toBeCloseTo(Math.abs(b.y - a.y), 6);
  });

  it("the final geometry uses the Shift state at pointer-up: released before release -> unconstrained", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await down(900, 500, true);
    await move(1200, 670, true); // dragged with Shift the whole way
    await up(1200, 670, false); // ...but Shift is up at release
    const [a, b] = postedCornersPx();
    expect(Math.abs(b.x - a.x)).toBeCloseTo(300, 6);
    expect(Math.abs(b.y - a.y)).toBeCloseTo(170, 6);
  });

  it("Shift pressed and released several times during one drag does not restart or break it", async () => {
    await bootAppForTest(posted);
    await pick("ellipse");
    await down(900, 500);
    await move(1200, 800);
    await key("keydown", "Shift");
    await key("keyup", "Shift");
    await key("keydown", "Shift");
    await up(1200, 800, true);
    expect(draws()).toHaveLength(1);
    const [a, b] = postedCornersPx();
    expect(a).toEqual({ x: 900, y: 500 });
    expect(Math.abs(b.y - a.y)).toBeCloseTo(Math.abs(b.x - a.x), 6); // Shift held at release -> a circle
  });
});

describe("cancellation and accidental shapes", () => {
  const stopSignals = () => strokePosts().filter((p) => p.body.active === false);

  it("Escape cancels an unfinished shape: nothing saved, and a later pointer-up does not commit it", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await down(900, 500);
    await move(1100, 640);
    await key("keydown", "Escape");
    expect(stopSignals()).toHaveLength(1); // other viewers are told the preview ended
    await up(1100, 640);
    expect(draws()).toHaveLength(0);
  });

  it("pointercancel drops the shape without committing", async () => {
    await bootAppForTest(posted);
    await pick("ellipse");
    await down(900, 500);
    await move(1100, 640);
    firePointer(canvas(), "pointercancel", {});
    await flush();
    expect(draws()).toHaveLength(0);
    expect(stopSignals()).toHaveLength(1);
  });

  it("lost pointer capture drops the shape without committing", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await down(900, 500);
    await move(1100, 640);
    canvas().dispatchEvent(new Event("lostpointercapture", { bubbles: true }));
    await flush();
    expect(draws()).toHaveLength(0);
  });

  it("switching tools mid-drag cancels the preview and saves nothing", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await down(900, 500);
    await move(1100, 640);
    click("tool-brush");
    await flush();
    expect(stopSignals()).toHaveLength(1);
    await up(1100, 640);
    expect(draws()).toHaveLength(0);
  });

  it("a click with no movement creates no shape, for every shape tool", async () => {
    await bootAppForTest(posted);
    for (const t of ["line", "rectangle", "ellipse"]) {
      await pick(t);
      await down(900, 500);
      await up(900, 500);
    }
    expect(draws()).toHaveLength(0);
  });

  it("a tiny jitter (under the threshold) creates no shape", async () => {
    await bootAppForTest(posted);
    await pick("line");
    await down(900, 500);
    await move(901, 501);
    await up(901, 501);
    expect(draws()).toHaveLength(0);
  });

  it("a perfectly horizontal or vertical drag creates no invisible closed shape, but does create a line", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await dragShape(900, 500, 1100, 500);
    await pick("ellipse");
    await dragShape(900, 500, 900, 700);
    expect(draws()).toHaveLength(0);
    await pick("line");
    await dragShape(900, 500, 1100, 500);
    expect(draws()).toHaveLength(1);
  });

  it("Escape with no shape in progress is harmless and Brush strokes still work", async () => {
    await bootAppForTest(posted);
    await key("keydown", "Escape");
    await down(100, 100);
    await move(200, 200);
    await up(200, 200);
    expect(draws()).toHaveLength(1);
    expect(draws()[0].body.shape).toBeUndefined();
  });
});

describe("shape previews stay aligned under zoom and pan", () => {
  it("corner points are document-normalised, so the same drag commits the same geometry at any zoom", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await dragShape(480, 270, 960, 540); // 1920x1080 box at 1x -> normalised (0.25,0.25)-(0.5,0.5)
    const [a1, b1] = (draws()[0].body.points as Array<{ x: number; y: number }>);
    expect(a1.x).toBeCloseTo(0.25, 9);
    expect(a1.y).toBeCloseTo(0.25, 9);
    expect(b1.x).toBeCloseTo(0.5, 9);
    expect(b1.y).toBeCloseTo(0.5, 9);

    // Zoom the canvas box: the CSS rect (what pointer maths divides by) doubles in size.
    const zoomedRect = { x: 0, y: 0, top: 0, left: 0, right: 3840, bottom: 2160, width: 3840, height: 2160, toJSON() {} } as DOMRect;
    HTMLCanvasElement.prototype.getBoundingClientRect = function () {
      return zoomedRect;
    };
    await dragShape(960, 540, 1920, 1080); // same document area at 2x
    const [a2, b2] = (draws()[1].body.points as Array<{ x: number; y: number }>);
    expect(a2.x).toBeCloseTo(a1.x, 9);
    expect(a2.y).toBeCloseTo(a1.y, 9);
    expect(b2.x).toBeCloseTo(b1.x, 9);
    expect(b2.y).toBeCloseTo(b1.y, 9);
  });

  it("a panned canvas (rect offset) still maps the pointer to the same document geometry", async () => {
    await bootAppForTest(posted);
    HTMLCanvasElement.prototype.getBoundingClientRect = function () {
      return { x: -300, y: -200, top: -200, left: -300, right: 1620, bottom: 880, width: 1920, height: 1080, toJSON() {} } as DOMRect;
    };
    await pick("ellipse");
    await dragShape(180, 70, 660, 340); // client coords -> document (480,270)-(960,540)
    const [a, b] = (draws()[0].body.points as Array<{ x: number; y: number }>);
    expect(a.x).toBeCloseTo(0.25, 9);
    expect(a.y).toBeCloseTo(0.25, 9);
    expect(b.x).toBeCloseTo(0.5, 9);
    expect(b.y).toBeCloseTo(0.5, 9);
  });

  it("the Shift constraint is measured in document pixels, so a square is square on the 16:9 document", async () => {
    await bootAppForTest(posted);
    await pick("rectangle");
    await dragShape(100, 100, 500, 500, true);
    const [a, b] = (draws()[0].body.points as Array<{ x: number; y: number }>);
    expect(Math.abs(b.x - a.x) * DOC_W).toBeCloseTo(Math.abs(b.y - a.y) * DOC_H, 6); // equal in pixels...
    expect(Math.abs(b.x - a.x)).not.toBeCloseTo(Math.abs(b.y - a.y), 3); // ...not equal in the normalised [0,1] space
  });
});

describe("existing tools are unchanged", () => {
  it("a Brush drag still commits one freehand stroke with many points and no shape", async () => {
    await bootAppForTest(posted);
    await down(100, 100);
    await move(150, 160);
    await move(200, 220);
    await up(200, 220);
    expect(draws()).toHaveLength(1);
    expect(draws()[0].body.shape).toBeUndefined();
    expect((draws()[0].body.points as unknown[]).length).toBeGreaterThan(2);
  });

  it("the Eraser still commits an erase op", async () => {
    await bootAppForTest(posted);
    await pick("eraser");
    await down(100, 100);
    await move(200, 200);
    await up(200, 200);
    expect(posted.filter((p) => p.url.endsWith("/erase"))).toHaveLength(1);
    expect(draws()).toHaveLength(0);
  });
});
