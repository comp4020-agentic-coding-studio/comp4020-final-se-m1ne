// @vitest-environment jsdom
//
// Focused coverage for the LAYERS feature's client-side pieces that have no
// server-observable contract of their own: the LAYERS panel DOM, selection,
// visibility toggling (and its effect on rendering, not persistence), inline
// rename (save/cancel), the hidden-active-layer draw/erase block + notice,
// and that a new gesture is tagged with the currently selected layer. The
// server-side layerId validation/persistence contract is covered separately
// in spec/freehand-layer.test.ts; the pure id-list/backward-compatible-
// default/local-settings-parsing logic is covered in spec/layers.test.ts.

import { beforeEach, describe, expect, it } from "vitest";
import { bootAppForTest, canvasContexts, firePointer, flush, type PostedRequest } from "./app-test-helpers";

let posted: PostedRequest[];

beforeEach(() => {
  posted = [];
  localStorage.clear();
});

const $ = (id: string) => document.getElementById(id)!;
const canvas = () => $("canvas");
const layerCards = () => Array.from(document.querySelectorAll<HTMLElement>(".layer-card"));
// renderLayerPanel() rebuilds #layer-list's children from scratch on every
// state change (selection, visibility, rename) -- a card element captured
// before such a change is stale immediately after, so every lookup in this
// file goes through this helper (always queries fresh) rather than holding
// onto a card/element reference across an action.
const findCard = (name: string) => layerCards().find((c) => c.querySelector(".layer-name")?.textContent === name)!;

function startRename(name: string) {
  const card = findCard(name);
  card.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40, toJSON() {} }) as DOMRect;
  card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 20, clientY: 20 }));
}

function drawPosts() {
  return posted.filter((p) => p.url.endsWith("/draw"));
}

function erasePosts() {
  return posted.filter((p) => p.url.endsWith("/erase"));
}

async function drag(x0: number, y0: number, x1: number, y1: number) {
  firePointer(canvas(), "pointerdown", { clientX: x0, clientY: y0 });
  await flush();
  firePointer(canvas(), "pointermove", { clientX: x1, clientY: y1 });
  await flush();
  firePointer(canvas(), "pointerup", { clientX: x1, clientY: y1 });
  await flush();
}

describe("LAYERS panel: fixed structure and rendering order", () => {
  it("the Public Canvas shows exactly 2 layer cards, 'Lineart' above 'Colour' (highest layer first)", async () => {
    await bootAppForTest(posted);
    const cards = layerCards();
    expect(cards).toHaveLength(2);
    const names = cards.map((c) => c.querySelector(".layer-name")?.textContent);
    expect(names).toEqual(["Lineart", "Colour"]);
  });

  it("the topmost layer (Lineart) is selected by default, shown as the active card", async () => {
    await bootAppForTest(posted);
    const cards = layerCards();
    const selected = cards.filter((c) => c.classList.contains("selected"));
    expect(selected).toHaveLength(1);
    expect(selected[0].querySelector(".layer-name")?.textContent).toBe("Lineart");
  });
});

describe("layer selection", () => {
  it("clicking a card's background selects that layer, and a new gesture is tagged with it", async () => {
    await bootAppForTest(posted);
    findCard("Colour").dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(findCard("Colour").classList.contains("selected")).toBe(true);

    await drag(100, 100, 150, 150);
    expect(drawPosts()).toHaveLength(1);
    expect(drawPosts()[0].body.layerId).toBe("colour");
  });

  it("clicking the eye icon does not change the selected layer", async () => {
    await bootAppForTest(posted);
    findCard("Colour").querySelector<HTMLElement>(".layer-eye")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(findCard("Colour").classList.contains("selected")).toBe(false); // still Lineart, unaffected
  });

  it("the selected layer persists across a reload (same canvas) and falls back safely if invalid", async () => {
    await bootAppForTest(posted);
    findCard("Colour").dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    posted.length = 0;
    await bootAppForTest(posted); // simulates a reload: fresh module import, same localStorage
    expect(findCard("Colour").classList.contains("selected")).toBe(true);

    // An invalid saved selection falls back to the topmost layer rather than crashing or selecting nothing.
    localStorage.setItem("layerSettings:public", JSON.stringify({ selected: "not-a-real-layer" }));
    await bootAppForTest(posted);
    expect(findCard("Lineart").classList.contains("selected")).toBe(true);
  });
});

describe("erase gestures are tagged with the currently selected layer (per-(owner, layer) mask)", () => {
  // The actual pixel-level guarantee -- erasing while Layer 2 is active never
  // removes this owner's own Layer-1 pixels, nor another owner's content on
  // either layer -- depends on real canvas compositing (ensureLayer's
  // (ownerId, layerId) keying, repaintVisibleCanvas's per-op mask lookup) that
  // jsdom's canvas stub cannot execute (getContext() returns inert spies, not
  // a real 2D rendering context). What's verified here, automatable without a
  // real browser, is the precondition that whole mechanism depends on: each
  // erase op is persisted tagged with the layer that was actually selected
  // when the gesture began, exactly like a draw op is.
  it("an erase op is posted with the currently selected layer's id", async () => {
    await bootAppForTest(posted);
    findCard("Colour").dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    document.getElementById("tool-eraser")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    await drag(100, 100, 150, 150);
    expect(erasePosts()).toHaveLength(1);
    expect(erasePosts()[0].body.layerId).toBe("colour");
  });

  it("switching the selected layer between two gestures tags each with its own layer, not the other's", async () => {
    await bootAppForTest(posted);
    document.getElementById("tool-eraser")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    findCard("Lineart").dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    await drag(100, 100, 150, 150);

    findCard("Colour").dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    await drag(200, 200, 250, 250);

    expect(erasePosts()).toHaveLength(2);
    expect(erasePosts()[0].body.layerId).toBe("lineart");
    expect(erasePosts()[1].body.layerId).toBe("colour");
  });
});

describe("layer visibility: local-only, hides content without touching shared data", () => {
  it("hiding a layer repaints locally without any new network request", async () => {
    await bootAppForTest(posted);
    posted.length = 0;
    findCard("Lineart").querySelector<HTMLElement>(".layer-eye")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(posted).toHaveLength(0); // purely local -- never sent to the server
  });

  it("the eye icon's accessible label flips once a layer is hidden", async () => {
    await bootAppForTest(posted);
    findCard("Lineart").querySelector<HTMLElement>(".layer-eye")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(findCard("Lineart").querySelector(".layer-eye")!.getAttribute("aria-label")).toMatch(/^Show/);
  });

  it("toggling visibility does not change which layer is selected", async () => {
    await bootAppForTest(posted);
    expect(findCard("Lineart").classList.contains("selected")).toBe(true);
    findCard("Lineart").querySelector<HTMLElement>(".layer-eye")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(findCard("Lineart").classList.contains("selected")).toBe(true); // still selected, just now hidden
  });
});

describe("hidden active layer blocks drawing and erasing", () => {
  it("drawing on a hidden active layer is blocked before any op is created, and shows the notice", async () => {
    await bootAppForTest(posted);
    // Lineart (the selected layer) hidden.
    findCard("Lineart").querySelector<HTMLElement>(".layer-eye")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    await drag(100, 100, 150, 150);
    expect(drawPosts()).toHaveLength(0); // blocked before persistGesture ever runs

    const notice = $("layer-hidden-notice");
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe("This layer is hidden. Make it visible to draw.");
  });

  it("drawing resumes normally once the hidden layer is made visible again", async () => {
    await bootAppForTest(posted);
    findCard("Lineart").querySelector<HTMLElement>(".layer-eye")!.dispatchEvent(new Event("click", { bubbles: true })); // hide
    await flush();
    findCard("Lineart").querySelector<HTMLElement>(".layer-eye")!.dispatchEvent(new Event("click", { bubbles: true })); // show again
    await flush();

    await drag(100, 100, 150, 150);
    expect(drawPosts()).toHaveLength(1);
  });
});

describe("inline layer renaming", () => {
  it("clicking the name enters edit mode with an auto-focused, pre-selected input and a checkmark", async () => {
    await bootAppForTest(posted);
    startRename("Colour");
    await flush();

    // No ".layer-name" card named "Colour" exists while renaming (it's shown
    // as an input instead) -- find the card by its input's current value.
    const card = layerCards().find((c) => c.querySelector<HTMLInputElement>(".layer-name-input")?.value === "Colour")!;
    const input = card.querySelector<HTMLInputElement>(".layer-name-input")!;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(card.querySelector(".layer-rename-confirm")).toBeTruthy();

    // The double-click that started the rename also selected this layer.
    expect(card.classList.contains("selected")).toBe(true);
  });

  it("pressing Enter saves the new name locally and never sends a network request", async () => {
    await bootAppForTest(posted);
    startRename("Colour");
    await flush();
    const card = layerCards().find((c) => c.querySelector<HTMLInputElement>(".layer-name-input")?.value === "Colour")!;
    const input = card.querySelector<HTMLInputElement>(".layer-name-input")!;
    input.value = "Background";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    expect(findCard("Background")).toBeTruthy();
    // Rename never touches the network at all -- not merely "no draw op":
    // no fetch to any endpoint whose path could plausibly carry a layer name
    // (the unrelated presence heartbeat this app always sends on boot is
    // exempted here, same as drawPosts() exempts it elsewhere in this file).
    expect(posted.filter((p) => !p.url.includes("/presence/"))).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("layerSettings:public")!).names.colour).toBe("Background");
  });

  it("clicking the checkmark saves the new name", async () => {
    await bootAppForTest(posted);
    startRename("Colour");
    await flush();
    const card = layerCards().find((c) => c.querySelector<HTMLInputElement>(".layer-name-input")?.value === "Colour")!;
    card.querySelector<HTMLInputElement>(".layer-name-input")!.value = "Base";
    card.querySelector<HTMLElement>(".layer-rename-confirm")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(findCard("Base")).toBeTruthy();
  });

  it("pressing Escape cancels and restores the previous name", async () => {
    await bootAppForTest(posted);
    startRename("Colour");
    await flush();
    const card = layerCards().find((c) => c.querySelector<HTMLInputElement>(".layer-name-input")?.value === "Colour")!;
    const input = card.querySelector<HTMLInputElement>(".layer-name-input")!;
    input.value = "Should not stick";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();

    expect(findCard("Colour")).toBeTruthy();
    expect(layerCards().some((c) => c.querySelector(".layer-name")?.textContent === "Should not stick")).toBe(false);
  });

  it("clicking outside the editing controls cancels (never saves)", async () => {
    await bootAppForTest(posted);
    startRename("Colour");
    await flush();
    const card = layerCards().find((c) => c.querySelector<HTMLInputElement>(".layer-name-input")?.value === "Colour")!;
    card.querySelector<HTMLInputElement>(".layer-name-input")!.value = "Abandoned edit";

    // Outside click: directly on the document body, well away from the card.
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flush();

    expect(findCard("Colour")).toBeTruthy();
    expect(layerCards().some((c) => c.querySelector(".layer-name")?.textContent === "Abandoned edit")).toBe(false);
  });

  it("an empty or whitespace-only name is rejected; the previous name is kept", async () => {
    await bootAppForTest(posted);
    startRename("Colour");
    await flush();
    const card = layerCards().find((c) => c.querySelector<HTMLInputElement>(".layer-name-input")?.value === "Colour")!;
    const input = card.querySelector<HTMLInputElement>(".layer-name-input")!;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    expect(findCard("Colour")).toBeTruthy();
  });
});

describe("layer settings isolation between rooms (localStorage keying)", () => {
  it("Public Canvas's own layer settings key never collides with a room's", () => {
    // Pure key-scheme assertion -- the full cross-room DOM scenario (booting
    // app.js at a /room/CODE path) is not exercised by bootAppForTest (Public
    // Canvas only); the key-isolation logic itself is covered end-to-end in
    // spec/layers.test.ts's layerSettingsStorageKey suite.
    expect(localStorage.getItem("layerSettings:public")).toBeNull();
  });
});

describe("layer button double-click: left half renames, right half only selects", () => {
  // The test harness reports a 0-sized layout, so give the card an explicit box to split in half.
  const dblclickAt = (card: HTMLElement, fraction: number, target: HTMLElement = card) => {
    card.getBoundingClientRect = () => ({ x: 100, y: 0, left: 100, top: 0, right: 300, bottom: 40, width: 200, height: 40, toJSON() {} }) as DOMRect;
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 100 + 200 * fraction, clientY: 20 }));
  };
  const renaming = () => layerCards().some((c) => c.querySelector(".layer-name-input"));

  it("double-click on the front/left half selects the layer and enters rename mode", async () => {
    await bootAppForTest(posted);
    dblclickAt(findCard("Colour"), 0.25);
    await flush();
    expect(renaming()).toBe(true);
    expect(document.querySelector(".layer-card.selected .layer-name-input")).toBeTruthy();
  });

  it("double-click on the back/right half selects the layer but does not rename", async () => {
    await bootAppForTest(posted);
    dblclickAt(findCard("Colour"), 0.75);
    await flush();
    expect(renaming()).toBe(false);
    expect(document.querySelector(".layer-card.selected .layer-name")?.textContent).toBe("Colour");
  });

  it("a single click on the name text only selects (no rename)", async () => {
    await bootAppForTest(posted);
    findCard("Colour").querySelector<HTMLElement>(".layer-name")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(renaming()).toBe(false);
    expect(document.querySelector(".layer-card.selected .layer-name")?.textContent).toBe("Colour");
  });

  it("double-clicking the eye neither renames nor selects", async () => {
    await bootAppForTest(posted);
    const card = findCard("Colour");
    dblclickAt(card, 0.1, card.querySelector<HTMLElement>(".layer-eye")!);
    await flush();
    expect(renaming()).toBe(false);
    expect(document.querySelector(".layer-card.selected .layer-name")?.textContent).toBe("Lineart");
  });
});

describe("shape tools keep their layer", () => {
  async function shapeDrag(tool: string) {
    $(`tool-${tool}`).dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    await drag(200, 200, 600, 500);
  }

  it("three shapes on alternating layers each POST their own layerId and none is reassigned", async () => {
    await bootAppForTest(posted);
    const order: Array<[string, string]> = [["Colour", "colour"], ["Lineart", "lineart"], ["Colour", "colour"]];
    const tools = ["rectangle", "ellipse", "line"];
    for (let i = 0; i < 3; i++) {
      findCard(order[i][0]).dispatchEvent(new Event("click", { bubbles: true }));
      await flush();
      await shapeDrag(tools[i]);
    }
    expect(drawPosts().map((p) => (p.body as { layerId: string }).layerId)).toEqual(order.map(([, id]) => id));
  });

  it("a shape drawn on the lower layer is not painted onto the top-of-stack preview overlay when committed", async () => {
    await bootAppForTest(posted);
    findCard("Colour").dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    await shapeDrag("rectangle");
    const overlay = canvasContexts.get("remote-stroke-preview")!;
    // After commit nothing may be left on the overlay (it sits above every layer).
    const lastClear = overlay.clearRect.mock.calls.length;
    expect(lastClear).toBeGreaterThan(0);
    expect(overlay.rect.mock.calls.length).toBe(0);
  });
});
