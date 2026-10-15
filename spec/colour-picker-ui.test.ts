// @vitest-environment jsdom
//
// jsdom (already a devDependency, used here for the first time) gives this
// module the real DOM APIs it needs -- querySelector, event listeners,
// element properties -- without a browser. jsdom does not implement actual
// canvas 2D rendering (getContext("2d") returns null without the separate
// `canvas` native package, which this project deliberately does not add --
// "no third-party dependencies"), so public/colour-picker-ui.js guards every
// canvas-drawing call against a null context; this test exercises everything
// else (colour state, swatches, sliders, popover visibility, onChange), which
// is also the part shared identically by both editors and worth protecting
// against a regression in either one.

import { beforeEach, describe, expect, it } from "vitest";
import { initColourPicker } from "../public/colour-picker-ui.js";

function buildColourDom(): void {
  document.body.innerHTML = `
    <div id="colour-current"></div>
    <div id="palette">
      <button class="swatch selected" data-color="#1d1d1d"></button>
      <button class="swatch" data-color="#e53935"></button>
      <button class="swatch" data-color="#1e88e5"></button>
    </div>
    <button id="edit-colour-button" aria-expanded="false"></button>
    <div id="colour-popover" hidden>
      <button id="colour-popover-close"></button>
      <canvas id="colour-wheel" width="180" height="180"></canvas>
      <div id="colour-preview-swatch"></div>
      <span id="colour-preview-hex"></span>
      <input type="range" id="rgb-r-slider" min="0" max="255" />
      <input type="number" id="rgb-r-number" />
      <input type="range" id="rgb-g-slider" min="0" max="255" />
      <input type="number" id="rgb-g-number" />
      <input type="range" id="rgb-b-slider" min="0" max="255" />
      <input type="number" id="rgb-b-number" />
      <input type="range" id="hsv-h-slider" min="0" max="360" />
      <input type="number" id="hsv-h-number" />
      <input type="range" id="hsv-s-slider" min="0" max="100" />
      <input type="number" id="hsv-s-number" />
      <input type="range" id="hsv-v-slider" min="0" max="100" />
      <input type="number" id="hsv-v-number" />
    </div>
  `;
}

function fireInput(el: HTMLElement, value: string): void {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  buildColourDom();
});

describe("initColourPicker: initial sync", () => {
  it("syncs the current-colour swatch, preview, and RGB/HSV fields to the initial colour", () => {
    initColourPicker({ initialColor: "#1e88e5" });
    const current = document.getElementById("colour-current") as HTMLElement;
    const previewHex = document.getElementById("colour-preview-hex") as HTMLElement;
    expect(current.style.background).toBe("rgb(30, 136, 229)"); // jsdom normalizes #1e88e5 -> rgb()
    expect(previewHex.textContent).toBe("#1e88e5");
    expect((document.getElementById("rgb-r-slider") as HTMLInputElement).value).toBe("30");
    expect((document.getElementById("rgb-g-slider") as HTMLInputElement).value).toBe("136");
    expect((document.getElementById("rgb-b-slider") as HTMLInputElement).value).toBe("229");
  });

  it("marks the matching preset swatch as selected when the initial colour matches one", () => {
    initColourPicker({ initialColor: "#e53935" });
    const swatches = Array.from(document.querySelectorAll(".swatch")) as HTMLElement[];
    expect(swatches.find((s) => s.dataset.color === "#e53935")!.classList.contains("selected")).toBe(true);
    expect(swatches.find((s) => s.dataset.color === "#1d1d1d")!.classList.contains("selected")).toBe(false);
  });
});

describe("initColourPicker: presets", () => {
  it("clicking a preset swatch updates the colour, calls onChange, and marks it selected", () => {
    const changes: string[] = [];
    initColourPicker({ initialColor: "#1d1d1d", onChange: (hex) => changes.push(hex) });

    const blueSwatch = document.querySelector('.swatch[data-color="#1e88e5"]') as HTMLElement;
    blueSwatch.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(changes).toEqual(["#1e88e5"]);
    expect(blueSwatch.classList.contains("selected")).toBe(true);
    const previewHex = document.getElementById("colour-preview-hex") as HTMLElement;
    expect(previewHex.textContent).toBe("#1e88e5");
  });
});

describe("initColourPicker: RGB/HSV sliders and numeric inputs", () => {
  it("editing the R slider updates the colour (holding G/B) and calls onChange", () => {
    const changes: string[] = [];
    initColourPicker({ initialColor: "#000000", onChange: (hex) => changes.push(hex) });
    fireInput(document.getElementById("rgb-r-slider")!, "255");
    expect(changes).toEqual(["#ff0000"]);
  });

  it("editing a numeric RGB input works identically to its paired slider", () => {
    const changes: string[] = [];
    initColourPicker({ initialColor: "#000000", onChange: (hex) => changes.push(hex) });
    fireInput(document.getElementById("rgb-g-number")!, "128");
    expect(changes).toEqual(["#008000"]);
  });

  it("editing the HSV Value slider to 0 produces black regardless of hue/saturation", () => {
    const changes: string[] = [];
    initColourPicker({ initialColor: "#1e88e5", onChange: (hex) => changes.push(hex) });
    fireInput(document.getElementById("hsv-v-slider")!, "0");
    expect(changes.at(-1)).toBe("#000000");
  });

  it("an HSV Hue edit at full saturation/value walks around the colour wheel", () => {
    const changes: string[] = [];
    initColourPicker({ initialColor: "#ff0000", onChange: (hex) => changes.push(hex) }); // pure red, h=0, s=100, v=100
    fireInput(document.getElementById("hsv-h-slider")!, "120"); // pure green
    expect(changes.at(-1)).toBe("#00ff00");
  });
});

describe("initColourPicker: popover visibility", () => {
  it("Edit colour opens the popover and sets aria-expanded; the close button closes it", () => {
    initColourPicker({ initialColor: "#1d1d1d" });
    const editButton = document.getElementById("edit-colour-button") as HTMLButtonElement;
    const popover = document.getElementById("colour-popover") as HTMLElement;
    expect(popover.hidden).toBe(true);

    editButton.click();
    expect(popover.hidden).toBe(false);
    expect(editButton.getAttribute("aria-expanded")).toBe("true");

    (document.getElementById("colour-popover-close") as HTMLButtonElement).click();
    expect(popover.hidden).toBe(true);
    expect(editButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes an open popover", () => {
    initColourPicker({ initialColor: "#1d1d1d" });
    (document.getElementById("edit-colour-button") as HTMLButtonElement).click();
    expect((document.getElementById("colour-popover") as HTMLElement).hidden).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect((document.getElementById("colour-popover") as HTMLElement).hidden).toBe(true);
  });

  it("a pointerdown outside the popover and the Edit colour button closes it", () => {
    initColourPicker({ initialColor: "#1d1d1d" });
    (document.getElementById("edit-colour-button") as HTMLButtonElement).click();
    expect((document.getElementById("colour-popover") as HTMLElement).hidden).toBe(false);

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect((document.getElementById("colour-popover") as HTMLElement).hidden).toBe(true);
  });
});

describe("initColourPicker: external setColor (the Eyedropper's own integration point)", () => {
  it("setColor updates every control exactly like a swatch click would, and fires onChange once", () => {
    const changes: string[] = [];
    const picker = initColourPicker({ initialColor: "#1d1d1d", onChange: (hex) => changes.push(hex) });
    picker.setColor("#43a047");
    expect(changes).toEqual(["#43a047"]);
    expect((document.getElementById("colour-preview-hex") as HTMLElement).textContent).toBe("#43a047");
  });

  it("setColor with a malformed hex is ignored, leaving the live colour and onChange untouched", () => {
    const changes: string[] = [];
    const picker = initColourPicker({ initialColor: "#1d1d1d", onChange: (hex) => changes.push(hex) });
    picker.setColor("not-a-colour");
    expect(changes).toEqual([]);
    expect((document.getElementById("colour-preview-hex") as HTMLElement).textContent).toBe("#1d1d1d");
  });
});

describe("initColourPicker: two independent instances never share state", () => {
  it("is a factory, not a singleton: each call wires its own closure state against the live DOM", () => {
    const changesA: string[] = [];
    const pickerA = initColourPicker({ initialColor: "#1d1d1d", onChange: (hex) => changesA.push(hex) });
    pickerA.setColor("#e53935");
    expect(changesA).toEqual(["#e53935"]);

    // A second instance against a freshly rebuilt DOM (as a second page load
    // of either editor would have) starts from its own initial colour,
    // unaffected by the first instance's prior state.
    buildColourDom();
    const changesB: string[] = [];
    const pickerB = initColourPicker({ initialColor: "#1e88e5", onChange: (hex) => changesB.push(hex) });
    expect((document.getElementById("colour-preview-hex") as HTMLElement).textContent).toBe("#1e88e5");
    pickerB.setColor("#fdd835");
    expect(changesB).toEqual(["#fdd835"]);
  });
});

// The real Colours sidebar markup from public/index.html: 16 drawing presets
// wired through the same initColourPicker state as everything else.
describe("the 16-colour drawing palette in public/index.html", () => {
  const PRESETS = [
    "#FFFFFF", "#1D1D1D", "#808080", "#C9C9C9",
    "#E85D5D", "#F29A58", "#F4D35E", "#A9C96B",
    "#55B78B", "#54BFC5", "#579BDD", "#7976D2",
    "#B77BCB", "#E59BB8", "#986747", "#D6B58A",
  ];

  beforeEach(async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
    document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1];
  });

  const swatch = (hex: string) => document.querySelector(`.swatch[data-color="${hex}"]`) as HTMLElement;
  const selected = () => Array.from(document.querySelectorAll(".swatch.selected")) as HTMLElement[];

  it("has exactly the 16 specified colours in order, each with an accessible name", () => {
    const swatches = Array.from(document.querySelectorAll("#palette .swatch")) as HTMLElement[];
    expect(swatches.map((s) => s.dataset.color)).toEqual(PRESETS);
    for (const s of swatches) {
      expect(s.getAttribute("aria-label")).toBeTruthy();
      expect(s.tagName).toBe("BUTTON"); // keyboard-focusable
    }
  });

  it("clicking each preset sets exactly that drawing colour and selects only it", () => {
    const changes: string[] = [];
    initColourPicker({ initialColor: "#1d1d1d", onChange: (hex) => changes.push(hex) });
    for (const hex of PRESETS) {
      swatch(hex).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(changes.at(-1)).toBe(hex.toLowerCase());
      expect((document.getElementById("colour-preview-hex") as HTMLElement).textContent).toBe(hex.toLowerCase());
      expect(selected()).toEqual([swatch(hex)]);
    }
  });

  it("a custom colour matching no preset leaves every preset unselected, and reselecting a preset highlights it again", () => {
    initColourPicker({ initialColor: "#1d1d1d" });
    fireInput(document.getElementById("rgb-r-number")!, "201");
    expect(selected()).toHaveLength(0);
    swatch("#E85D5D").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selected()).toEqual([swatch("#E85D5D")]);
  });

  it("opening and closing the popup never resets the active colour or its selection", () => {
    initColourPicker({ initialColor: "#1d1d1d" });
    swatch("#579BDD").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const popover = document.getElementById("colour-popover") as HTMLElement;
    document.getElementById("edit-colour-button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(popover.hidden).toBe(false);
    document.getElementById("colour-popover-close")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(popover.hidden).toBe(true);
    expect((document.getElementById("colour-preview-hex") as HTMLElement).textContent).toBe("#579bdd");
    expect(selected()).toEqual([swatch("#579BDD")]);

    fireInput(document.getElementById("rgb-g-number")!, "7"); // now custom
    document.getElementById("edit-colour-button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.getElementById("colour-popover-close")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selected()).toHaveLength(0);
    expect((document.getElementById("rgb-g-number") as HTMLInputElement).value).toBe("7");
  });

  it("choosing a preset does not change the selected tool", () => {
    initColourPicker({ initialColor: "#1d1d1d" });
    const eraser = document.getElementById("tool-eraser")!;
    eraser.classList.add("selected");
    swatch("#F4D35E").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(eraser.classList.contains("selected")).toBe(true);
    expect(document.getElementById("tool-brush")!.classList.contains("selected")).toBe(true); // markup default, untouched
  });
});
