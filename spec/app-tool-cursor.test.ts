// @vitest-environment jsdom
//
// Regression coverage for the Brush/Eraser circular cursor overlay
// (#tool-cursor): it must be repositioned via `transform: translate(...)`
// only, never left/top, so the browser can move it on the compositor thread
// alone (no layout/paint forced on its `position: fixed` box every
// pointermove) -- see the fix for the idle cursor freeze-then-jump stutter.

import { beforeEach, describe, expect, it } from "vitest";
import { bootAppForTest, firePointer, flush, type PostedRequest } from "./app-test-helpers";

let posted: PostedRequest[];

beforeEach(() => {
  posted = [];
});

describe("circular cursor overlay positioning", () => {
  it("pointermove sets a transform, not left/top, and tracks the pointer", async () => {
    await bootAppForTest(posted);
    const canvas = document.getElementById("canvas")!;
    const toolCursor = document.getElementById("tool-cursor")!;

    firePointer(canvas, "pointerenter", { clientX: 40, clientY: 60 });
    await flush();
    expect(toolCursor.style.left).toBe("");
    expect(toolCursor.style.top).toBe("");
    expect(toolCursor.style.transform).toBe("translate(40px, 60px) translate(-50%, -50%)");

    firePointer(canvas, "pointermove", { clientX: 123, clientY: 456 });
    await flush();
    expect(toolCursor.style.left).toBe("");
    expect(toolCursor.style.top).toBe("");
    expect(toolCursor.style.transform).toBe("translate(123px, 456px) translate(-50%, -50%)");
  });
});
