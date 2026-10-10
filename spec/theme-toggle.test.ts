// @vitest-environment jsdom
//
// Theme toggle coverage for the "pixel" mode branch (an existing pixel-art
// room, the one remaining page public/pixel-editor.js's own bootPixelEditor
// still runs for -- see public/pixeldoc.js's resolveEditorMode). The matching
// "legacy" branch (Public and every new Private room, which hand off to
// public/app.js) is covered in spec/app-realtime-stroke.test.ts's own "Part 2"
// block. Together these two files are what actually prove the fix: before it,
// BOTH public/pixel-editor.js and public/app.js wired an unconditional,
// top-level click listener onto the same shared #theme-toggle button, so on
// any page that ran both (every "legacy" page, which pixel-editor.js's own
// main() always loads first) the two listeners cancelled each other out on
// every click. Wiring pixel-editor.js's copy inside bootPixelEditor (the
// "pixel" branch only, mutually exclusive with "legacy") is what this file
// checks still works correctly on its own, standalone, now that it's the only
// listener a pixel-mode page ever registers.

import { describe, expect, it } from "vitest";
import { bootPixelEditorForTest, type PostedRequest } from "./pixel-editor-test-helpers.js";

describe("theme toggle (pixel mode)", () => {
  it("clicking the toggle flips the theme and updates the button label immediately", async () => {
    document.documentElement.dataset.theme = "light";
    const posted: PostedRequest[] = [];
    await bootPixelEditorForTest(posted);
    const toggle = document.getElementById("theme-toggle")!;

    expect(toggle.textContent).toBe("Light");
    toggle.dispatchEvent(new Event("click", { bubbles: true }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(toggle.textContent).toBe("Dark");

    toggle.dispatchEvent(new Event("click", { bubbles: true }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(toggle.textContent).toBe("Light");
  });

  it("never persists a manual choice to localStorage", async () => {
    document.documentElement.dataset.theme = "dark";
    const posted: PostedRequest[] = [];
    await bootPixelEditorForTest(posted);
    document.getElementById("theme-toggle")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("theme")).toBeNull();
  });
});
