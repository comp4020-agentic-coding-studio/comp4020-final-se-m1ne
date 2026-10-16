// @vitest-environment jsdom
//
// Shapes follow the existing artwork lifetime rules, because a shape is an
// ordinary 'draw' op: on the Public Canvas it fades from its ORIGINAL creation
// time over 12.5 hours (and is no longer painted once fully faded); in a
// Private Room it never fades. Also covers remote-op replay through the real
// client renderer, and the toolbar/selector styling for Public and Private.
//
// The jsdom canvas stub records every call, so the opacity a shape is painted
// with is observable as the globalAlpha in effect when paintShape ran.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allCanvasContexts,
  bodyHtml,
  canvasContexts,
  flush,
  installCanvasStub,
  installEventSourceStub,
  installFetchMock,
  latestEventSource,
  MY_OWNER_ID,
  type PostedRequest,
} from "./app-test-helpers";

const FADE_MS = 750 * 60 * 1000;

afterEach(() => {
  history.pushState(null, "", "/");
});

// Boots app.js at an arbitrary path (Public "/" or a Private "/room/CODE") and
// delivers `ops` in the initial sync frame, like a refresh would.
async function bootAt(pathname: string, ops: unknown[], posted: PostedRequest[] = []) {
  vi.resetModules();
  history.pushState(null, "", pathname);
  document.body.innerHTML = bodyHtml;
  installCanvasStub();
  installEventSourceStub();
  installFetchMock(posted);
  await import("../public/app.js");
  await flush();
  latestEventSource().emit("sync", { docKind: "freehand", ops });
  await flush();
}

const shapeOp = (over: Record<string, unknown> = {}) => ({
  seq: 1,
  id: "shape-1",
  ownerId: MY_OWNER_ID,
  kind: "draw",
  color: "#e85d5d",
  size: 0.004,
  points: [{ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.7 }],
  createdAt: Date.now(),
  shape: { type: "rectangle", mode: "filled" },
  ...over,
});

// How many rectangles have been painted by the artwork renderer. A shape is
// painted onto an owner's layer and onto the id-less scratch canvas, then
// composited onto #canvas, so count every context except the remote-preview
// overlay (which is not artwork).
function visibleRectPaints() {
  const overlay = canvasContexts.get("remote-stroke-preview");
  return allCanvasContexts.filter((c) => c !== overlay).reduce((n, c) => n + c.rect.mock.calls.length, 0);
}
const artwork = () => allCanvasContexts.filter((c) => c !== canvasContexts.get("remote-stroke-preview"));
// The scratch canvas: the only context that clips with destination-in, and the one the Public fade
// opacity is applied on. Owner layer masks are permanent and never faded, so fade assertions must look here.
const scratch = () => allCanvasContexts.find((c) => (c as any).compositeWrites?.includes("destination-in"));
const scratchRectPaints = () => (scratch()?.rect.mock.calls.length ?? 0);
const sum = (pick: (c: (typeof allCanvasContexts)[number]) => number) => artwork().reduce((n, c) => n + pick(c), 0);

describe("a shape op replays from the server snapshot (refresh / remote)", () => {
  it("renders on the visible canvas: a rectangle, an ellipse, a line and a STORED (legacy) triangle each through their own path", async () => {
    const ops = [
      shapeOp({ id: "r", seq: 1, shape: { type: "rectangle", mode: "outline" } }),
      shapeOp({ id: "e", seq: 2, shape: { type: "ellipse", mode: "filled" } }),
      shapeOp({ id: "t", seq: 3, shape: { type: "triangle", mode: "outline" } }), // saved before the tool was removed
      shapeOp({ id: "l", seq: 4, shape: { type: "line" } }),
    ];
    await bootAt("/", ops);
    expect(sum((c) => c.rect.mock.calls.length)).toBeGreaterThan(0);
    expect(sum((c) => c.ellipse.mock.calls.length)).toBeGreaterThan(0);
    expect(sum((c) => c.closePath.mock.calls.length)).toBeGreaterThan(0); // the stored triangle still renders
    expect(sum((c) => c.fill.mock.calls.length)).toBeGreaterThan(0); // the filled ellipse
    expect(sum((c) => c.stroke.mock.calls.length)).toBeGreaterThan(0); // outlines and the line
  });

  it("a stored filled triangle still fills, in Public and in a Private Room (existing artwork is never lost)", async () => {
    for (const where of ["/", "/room/ABC123"]) {
      await bootAt(where, [shapeOp({ id: "legacy-t", shape: { type: "triangle", mode: "filled" } })]);
      expect(sum((c) => c.closePath.mock.calls.length), where).toBeGreaterThan(0);
      expect(sum((c) => c.fill.mock.calls.length), where).toBeGreaterThan(0);
    }
  });

  it("a stored triangle's geometry still comes from its two stored corners (apex centred on the far edge)", async () => {
    await bootAt("/", [shapeOp({ shape: { type: "triangle", mode: "outline" }, points: [{ x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }] })]);
    const lineTos = artwork().flatMap((c) => c.lineTo.mock.calls as number[][]);
    const moveTos = artwork().flatMap((c) => c.moveTo.mock.calls as number[][]);
    // vertices in document pixels: base (480,270)-(960,270), apex (720,540)
    expect(moveTos.some(([x, y]) => Math.abs(x - 480) < 1e-6 && Math.abs(y - 270) < 1e-6)).toBe(true);
    expect(lineTos.some(([x, y]) => Math.abs(x - 960) < 1e-6 && Math.abs(y - 270) < 1e-6)).toBe(true);
    expect(lineTos.some(([x, y]) => Math.abs(x - 720) < 1e-6 && Math.abs(y - 540) < 1e-6)).toBe(true);
  });

  it("a remote collaborator's live 'op' event paints the shape without a refresh", async () => {
    await bootAt("/", []);
    const before = visibleRectPaints();
    latestEventSource().emit("op", { ...shapeOp({ id: "remote-1", ownerId: "someone-else" }), active: true });
    await flush();
    expect(visibleRectPaints()).toBeGreaterThan(before);
  });

  it("geometry comes from the op: the rectangle is painted at the stored corners in document pixels", async () => {
    await bootAt("/", [shapeOp({ points: [{ x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }] })]);
    const calls = artwork().flatMap((c) => c.rect.mock.calls as number[][]);
    const [x, y, w, h] = calls.at(-1)!;
    expect(x).toBeCloseTo(480, 6);
    expect(y).toBeCloseTo(270, 6);
    expect(w).toBeCloseTo(480, 6);
    expect(h).toBeCloseTo(270, 6);
  });

  it("an erase op cannot remove a shape from the replay list (ownership is enforced by the layer mask, not deletion)", async () => {
    const erase = { seq: 2, id: "erase-1", ownerId: "other-guest", kind: "erase", color: null, size: 0.05, points: [{ x: 0.3, y: 0.5 }], createdAt: Date.now() };
    await bootAt("/", [shapeOp(), erase]);
    expect(visibleRectPaints()).toBeGreaterThan(0); // the other guest's erase never hides MY shape
  });
});

describe("Public shapes fade like strokes; Private shapes do not", () => {
  it("a fresh Public shape is painted", async () => {
    await bootAt("/", [shapeOp({ createdAt: Date.now() })]);
    expect(visibleRectPaints()).toBeGreaterThan(0);
  });

  it("a Public shape older than 12.5 hours is fully faded and no longer painted (its mask stays permanent)", async () => {
    await bootAt("/", [shapeOp({ createdAt: Date.now() - FADE_MS - 60_000 })]);
    expect(scratchRectPaints()).toBe(0); // skipped outright by the fade check, never reaches the visible canvas
  });

  it("the faded op's owner-layer mask is still built (so erasing a faded shape works and nothing reappears)", async () => {
    await bootAt("/", [shapeOp({ createdAt: Date.now() - FADE_MS - 60_000 })]);
    expect(visibleRectPaints()).toBeGreaterThan(0); // painted onto the permanent layer mask only
    expect(scratchRectPaints()).toBe(0);
  });

  it("a Public shape partway through its life is painted dimmed, from its ORIGINAL creation time", async () => {
    await bootAt("/", [shapeOp({ createdAt: Date.now() - FADE_MS / 2 })]);
    expect(scratchRectPaints()).toBeGreaterThan(0);
    const alphas = (scratch() as any).alphaWrites as number[];
    const faded = alphas.filter((a) => a > 0 && a < 1);
    expect(faded.length).toBeGreaterThan(0);
    expect(faded[0]).toBeCloseTo(0.5, 2); // half of 12.5h elapsed since the ORIGINAL creation time
  });

  it("the same shape painted fresh uses full opacity, so the dimming above is the fade and nothing else", async () => {
    await bootAt("/", [shapeOp({ createdAt: Date.now() })]);
    const alphas = (scratch() as any).alphaWrites as number[];
    expect(Math.max(...alphas)).toBeCloseTo(1, 3);
    expect(alphas.some((a) => a > 0 && a < 0.99)).toBe(false);
  });

  it("a Private Room shape never fades, however old (painted at full opacity)", async () => {
    await bootAt("/room/ABC123", [shapeOp({ createdAt: Date.now() - 10 * FADE_MS })]);
    expect(scratchRectPaints()).toBeGreaterThan(0);
    const alphas = (scratch() as any).alphaWrites as number[];
    expect(alphas.every((a) => a === 1)).toBe(true);
  });

  it("undo/redo does not restart the fade: a redone op keeps its original createdAt and is judged by it", async () => {
    // A redo re-delivers the SAME op (same id, seq and createdAt). An aged one is still fully faded.
    const aged = shapeOp({ createdAt: Date.now() - FADE_MS - 1000 });
    await bootAt("/", [aged]);
    const before = scratchRectPaints();
    latestEventSource().emit("sync", { docKind: "freehand", ops: [aged] }); // what a redo reload produces
    await flush();
    expect(scratchRectPaints()).toBe(before);
    expect(before).toBe(0);
  });
});

describe("Public and Private toolbar styling and responsive layout (source)", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../public/styles.css"), "utf8");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\}`));
    expect(m, `expected a ${selector} rule`).toBeTruthy();
    return m![0];
  };

  it("all five tools share the one 48x48 rounded-square style, in one 10px-spaced column", () => {
    expect(rule("#tool-group .tool-button")).toMatch(/width:\s*48px/);
    expect(rule("#tool-group .tool-button")).toMatch(/height:\s*48px/);
    expect(rule("#tool-group")).toMatch(/flex-direction:\s*column/);
    expect(rule("#tool-group")).toMatch(/gap:\s*10px/);
    // no per-tool size or shape overrides
    for (const id of ["line", "rectangle", "ellipse"]) expect(css).not.toMatch(new RegExp(`#tool-${id}\\s*\\{`));
  });

  it("the selected-tool accent is the room's accent variable: sage by default, lavender in a Private Room", () => {
    expect(rule("#tool-group .tool-button.selected")).toMatch(/var\(--workspace-accent\)/);
    expect(rule("#tool-group .tool-button.selected")).toMatch(/var\(--selected-tool-bg\)/);
    expect(css).toMatch(/--workspace-accent:\s*#93a97e/);
    expect(css).toMatch(/#workspace\.is-private\s*\{[^}]*--workspace-accent:\s*#a18ab5/);
  });

  it("the Outline/Filled selector uses the same room accent for its selected button and is hidden by default", () => {
    expect(rule("#workspace .shape-mode-control .app-button.selected")).toMatch(/var\(--workspace-accent\)/);
    expect(rule(".shape-mode-control[hidden]")).toMatch(/display:\s*none/);
  });

  it("on narrow screens the tool group becomes a row so all six tools stay reachable", () => {
    const narrow = css.slice(css.indexOf("@media (max-width: 900px)"));
    expect(narrow).toMatch(/#tool-group\s*\{[^}]*flex-direction:\s*row/);
    expect(narrow).toMatch(/#tool-ribbon\s*\{[^}]*padding/);
  });

  it("the tool settings row lets brush size and the mode selector wrap instead of overflowing", () => {
    expect(rule("#tool-settings")).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe("the landing page's read-only renderer also draws shapes", () => {
  it("landing-canvas.js paints shape ops through the same shared geometry", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../public/landing-canvas.js"), "utf8");
    expect(src).toMatch(/import \{ paintShape \} from "\.\/shapes\.js"/);
    expect(src).toMatch(/op\.shape/);
  });
});
