// @vitest-environment jsdom
//
// Two small UI changes, tested without a browser: (1) the left toolbar order (Pencil, Airbrush, Eraser, Paint
// Bucket, Line, Rectangle, Ellipse) with every button still activating its own tool and the Eyedropper left in the
// Colours panel; (2) Home in a Private Room goes through the existing leave-room confirmation dialog (same dialog,
// destination only differs), while the Back button, Public Canvas and the dialog's Cancel behave as before.
// How the new icons actually look is NOT covered here -- that needs a person looking at them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bodyHtml,
  firePointer,
  flush,
  installCanvasStub,
  installEventSourceStub,
  installFetchMock,
  latestEventSource,
  type PostedRequest,
} from "./app-test-helpers";

const windowListeners: Array<[string, EventListenerOrEventListenerObject, unknown]> = [];
const realAdd = window.addEventListener.bind(window);
const realLocation = window.location;
let posted: PostedRequest[];

beforeEach(() => {
  posted = [];
  localStorage.clear();
  sessionStorage.clear();
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    windowListeners.push([type, listener, options]);
    return realAdd(type, listener, options as AddEventListenerOptions);
  }) as typeof window.addEventListener;
});
afterEach(() => {
  for (const [type, listener, options] of windowListeners.splice(0)) window.removeEventListener(type, listener, options as EventListenerOptions);
  window.addEventListener = realAdd;
  Object.defineProperty(globalThis, "location", { configurable: true, value: realLocation });
  history.pushState(null, "", "/");
});

const $ = (id: string) => document.getElementById(id)!;
const click = (el: Element) => el.dispatchEvent(new Event("click", { bubbles: true }));

async function bootAt(pathname: string) {
  vi.resetModules();
  history.pushState(null, "", pathname);
  document.body.innerHTML = bodyHtml;
  installCanvasStub();
  installEventSourceStub();
  installFetchMock(posted);
  await import("../public/app.js");
  await flush();
  latestEventSource().emit("sync", { docKind: "freehand", ops: [] });
  await flush();
}

// jsdom cannot navigate. Wrap location so an assignment to href is recorded instead of attempted.
function captureNavigation() {
  const navigations: string[] = [];
  const wrapped = new Proxy(realLocation, {
    set(target, prop, value) {
      if (prop === "href") {
        navigations.push(String(value));
        return true;
      }
      return Reflect.set(target, prop, value);
    },
    get(target, prop) {
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  Object.defineProperty(globalThis, "location", { configurable: true, value: wrapped });
  return navigations;
}

async function drag(x0: number, y0: number, x1: number, y1: number) {
  firePointer($("canvas"), "pointerdown", { clientX: x0, clientY: y0 });
  await flush();
  firePointer($("canvas"), "pointermove", { clientX: x1, clientY: y1 });
  await flush();
  firePointer($("canvas"), "pointerup", { clientX: x1, clientY: y1 });
  await flush();
}
const drawPosts = () => posted.filter((p) => p.url.endsWith("/draw"));
const erasePosts = () => posted.filter((p) => p.url.endsWith("/erase"));

describe("toolbar order and icons", () => {
  it("the left toolbar is exactly Pencil, Airbrush, Eraser, Paint Bucket, Line, Rectangle, Ellipse", async () => {
    await bootAt("/");
    expect([...document.querySelectorAll("#tool-group > button")].map((b) => b.id)).toEqual([
      "tool-brush", "tool-airbrush", "tool-eraser", "tool-fill", "tool-line", "tool-rectangle", "tool-ellipse",
    ]);
    expect([...document.querySelectorAll("#tool-group > button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "Brush", "Airbrush", "Eraser", "Paint Bucket", "Line", "Rectangle", "Ellipse",
    ]);
  });

  it("the Eyedropper stays in the Colours panel (not in the left toolbar), right next to the colour button", async () => {
    await bootAt("/");
    expect(document.querySelector("#tool-ribbon #tool-eyedropper")).toBeNull();
    expect($("colour-group").contains($("tool-eyedropper"))).toBe(true);
    expect($("edit-colour-button").nextElementSibling?.id).toBe("tool-eyedropper");
  });

  it("every tool button keeps its size class, a single SVG icon drawn in currentColor, and its accessible name", async () => {
    await bootAt("/");
    for (const id of ["tool-brush", "tool-airbrush", "tool-eraser", "tool-fill", "tool-line", "tool-rectangle", "tool-ellipse", "tool-eyedropper"]) {
      const b = $(id);
      expect(b.classList.contains("tool-button"), id).toBe(true);
      const svgs = b.querySelectorAll("svg");
      expect(svgs, id).toHaveLength(1);
      expect(svgs[0].getAttribute("viewBox"), id).toBe("0 0 24 24");
      expect(svgs[0].getAttribute("width"), id).toBe("22");
      expect(svgs[0].innerHTML, id).toContain("currentColor");
      expect(svgs[0].innerHTML, id).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i); // theme colours only, no hard-coded colours
      expect(b.getAttribute("aria-label"), id).toBeTruthy();
    }
  });

  it("the Paint Bucket and Colour Palette icons are untouched", async () => {
    await bootAt("/");
    expect($("tool-fill").querySelector("svg")!.innerHTML).toContain("M5 11 L11 5 L18 12 L12 18 Z");
    expect($("tool-fill").querySelector("svg")!.innerHTML).toContain("M20 15 C20 15 22 17.6 22 19");
    expect($("edit-colour-button").querySelector("svg")!.innerHTML).toContain("M12 3 C6.5 3 2 6.8 2 11.5");
  });
});

describe("every toolbar button still activates its own tool", () => {
  const selectedIds = () => [...document.querySelectorAll("#tool-ribbon .tool-button.selected, #colour-group .tool-button.selected")].map((b) => b.id);

  it("clicking each button selects exactly that button (aria-pressed follows)", async () => {
    await bootAt("/");
    for (const id of ["tool-brush", "tool-airbrush", "tool-eraser", "tool-fill", "tool-line", "tool-rectangle", "tool-ellipse", "tool-eyedropper"]) {
      click($(id));
      await flush();
      expect(selectedIds(), id).toEqual([id]);
      expect($(id).getAttribute("aria-pressed"), id).toBe("true");
    }
  });

  it("each button drives its own behaviour: pencil/airbrush/eraser/bucket/line/rectangle/ellipse post the right op", async () => {
    await bootAt("/");
    // pencil: plain draw, no shape
    click($("tool-brush"));
    await flush();
    await drag(300, 300, 700, 500);
    expect(drawPosts().at(-1)!.body.shape).toBeUndefined();
    // airbrush: draw tagged airbrush
    click($("tool-airbrush"));
    await flush();
    await drag(300, 300, 700, 500);
    expect((drawPosts().at(-1)!.body.shape as { type: string }).type).toBe("airbrush");
    // eraser: an erase request
    click($("tool-eraser"));
    await flush();
    await drag(300, 300, 700, 500);
    expect(erasePosts()).toHaveLength(1);
    // paint bucket: a fill op
    click($("tool-fill"));
    await flush();
    firePointer($("canvas"), "pointerdown", { clientX: 500, clientY: 400 });
    await flush();
    firePointer($("canvas"), "pointerup", { clientX: 500, clientY: 400 });
    await flush();
    expect((drawPosts().at(-1)!.body.shape as { type: string }).type).toBe("fill");
    // line / rectangle / ellipse: their own shape types
    for (const tool of ["line", "rectangle", "ellipse"]) {
      click($(`tool-${tool}`));
      await flush();
      await drag(300, 300, 700, 500);
      expect((drawPosts().at(-1)!.body.shape as { type: string }).type, tool).toBe(tool);
    }
  });
});

describe("Private Room: Home asks for confirmation through the existing leave dialog", () => {
  const ROOM = "ABC123";
  const dialogOpen = () => !$("leave-room-overlay").hidden;

  it("clicking Home does not navigate: it opens the same dialog showing this room's code, and is not left unprevented", async () => {
    await bootAt(`/room/${ROOM}`);
    const navigations = captureNavigation();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    $("home-link").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); // the link's own navigation is stopped
    expect(dialogOpen()).toBe(true);
    expect($("leave-room-message").textContent).toContain(`Save room code ${ROOM}`);
    expect(navigations).toEqual([]);
  });

  it("there is still exactly one leave dialog in the page", async () => {
    await bootAt(`/room/${ROOM}`);
    expect(document.querySelectorAll("#leave-room-overlay")).toHaveLength(1);
    expect(document.querySelectorAll("#leave-room-dialog")).toHaveLength(1);
  });

  it("Cancel closes the dialog and stays in the room: no navigation, same URL", async () => {
    await bootAt(`/room/${ROOM}`);
    const navigations = captureNavigation();
    $("home-link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(dialogOpen()).toBe(true);
    click($("leave-room-cancel"));
    expect(dialogOpen()).toBe(false);
    expect(navigations).toEqual([]);
    expect(location.pathname).toBe(`/room/${ROOM}`);
    // and Escape closes it too, as before
    $("home-link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialogOpen()).toBe(false);
  });

  it("Home and Back leave the very same navigation mark when clicked (the page's own link-click marking, unchanged)", async () => {
    // installNavigationMarking marks any same-origin link click in the capture phase, before the dialog handlers run.
    // That is existing behaviour for Back; Home is an ordinary link too, so it behaves identically. The mark is
    // short-lived (see presence-handoff.js), and confirming rewrites it with a fresh one for the real navigation.
    await bootAt(`/room/${ROOM}`);
    $("back-to-public").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const afterBack = JSON.parse(sessionStorage.getItem("presenceHandoff")!);
    sessionStorage.clear();
    $("home-link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const afterHome = JSON.parse(sessionStorage.getItem("presenceHandoff")!);
    expect(afterHome.scope).toBe(afterBack.scope);
    expect(afterHome.presenceId).toBe(afterBack.presenceId);
  });

  it("Cancel leaves the drawing state alone: a stroke can still be drawn right after", async () => {
    await bootAt(`/room/${ROOM}`);
    $("home-link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    click($("leave-room-cancel"));
    await drag(300, 300, 700, 500);
    expect(drawPosts()).toHaveLength(1);
  });

  it("Confirm after Home navigates to Home (the landing page), closes the dialog and hands this room's lease off", async () => {
    await bootAt(`/room/${ROOM}`);
    const navigations = captureNavigation();
    $("home-link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    click($("leave-room-confirm"));
    expect(navigations).toEqual(["/"]);
    expect(dialogOpen()).toBe(false);
    const mark = JSON.parse(sessionStorage.getItem("presenceHandoff")!);
    expect(mark.scope).toBe(ROOM); // the destination page releases this room's lease via /api/presence/handoff
    expect(typeof mark.presenceId).toBe("string");
    expect(mark.presenceId.length).toBeGreaterThan(0);
  });

  it("the existing Back button is unchanged: it opens the same dialog, and Confirm goes to /canvas (not Home)", async () => {
    await bootAt(`/room/${ROOM}`);
    const navigations = captureNavigation();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    $("back-to-public").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(dialogOpen()).toBe(true);
    expect($("leave-room-message").textContent).toContain(`Save room code ${ROOM}`);
    click($("leave-room-confirm"));
    expect(navigations).toEqual(["/canvas"]);
    expect(JSON.parse(sessionStorage.getItem("presenceHandoff")!).scope).toBe(ROOM);
  });

  it("the destination follows the LAST button used: Home then Cancel then Back confirms to /canvas, and vice versa", async () => {
    await bootAt(`/room/${ROOM}`);
    const navigations = captureNavigation();
    $("home-link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    click($("leave-room-cancel"));
    $("back-to-public").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    click($("leave-room-confirm"));
    expect(navigations).toEqual(["/canvas"]);
  });

  it("a second confirm of the Home path again goes Home (the destination is not sticky from a previous Back)", async () => {
    await bootAt(`/room/${ROOM}`);
    const navigations = captureNavigation();
    $("back-to-public").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    click($("leave-room-cancel"));
    $("home-link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    click($("leave-room-confirm"));
    expect(navigations).toEqual(["/"]);
  });
});

describe("Home elsewhere is unchanged", () => {
  it("on the Public Canvas Home is a plain link: not intercepted, no dialog", async () => {
    await bootAt("/");
    let prevented: boolean | null = null;
    const spy = (e: Event) => {
      prevented = e.defaultPrevented; // read after the app's own handlers ran, then stop jsdom from trying to navigate
      e.preventDefault();
    };
    document.addEventListener("click", spy);
    $("home-link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    document.removeEventListener("click", spy);
    expect(prevented).toBe(false);
    expect($("leave-room-overlay").hidden).toBe(true);
    expect($("home-link").getAttribute("href")).toBe("/");
  });
});
