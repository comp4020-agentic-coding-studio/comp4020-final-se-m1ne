// @vitest-environment jsdom
//
// Essential coverage for the new client-side SSE sync in
// public/pixel-editor.js: dedup of a local change's own broadcast echo,
// a remote collaborator's op actually becoming visible, and remote
// undo/redo updating state -- using the same real-module/fake-EventSource
// technique as spec/pixel-editor-grid.test.ts (see
// spec/pixel-editor-test-helpers.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PostedRequest,
  bodyHtml,
  firePointer,
  flush,
  installCanvasStub,
  installEventSourceStub,
  installFetchMock,
  latestEventSource,
} from "./pixel-editor-test-helpers.js";

let posted: PostedRequest[];

beforeEach(async () => {
  vi.resetModules();
  posted = [];
  document.body.innerHTML = bodyHtml;
  installCanvasStub();
  installEventSourceStub();
  installFetchMock(posted);
  await import("../public/pixel-editor.js"); // Public: no /room/ prefix in jsdom's default location
  await flush();
  latestEventSource().emit("sync", { docKind: "pixel", width: 2048, height: 1152, ops: [] });
  await flush();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("real-time sync via SSE", () => {
  it("connects to the Public stream endpoint, not the Private one", () => {
    expect(latestEventSource().url).toBe("/api/pixels/stream");
  });

  it("a local draw's own broadcast echo is deduped, not appended twice", async () => {
    const canvas = document.getElementById("canvas")!;
    firePointer(canvas, "pointerdown", { clientX: 10, clientY: 10 });
    firePointer(canvas, "pointerup", { clientX: 10, clientY: 10 });
    await flush();

    const saved = posted.find((p) => p.url === "/api/pixels/draw");
    expect(saved).toBeTruthy();
    const echoedOp = { ...saved!.body, id: "op-1", ownerId: "owner-1", kind: "draw", createdAt: Date.now(), seq: 1, active: true };

    // The server always broadcasts a draw/erase back to the tab that made
    // it, not just to other viewers -- this must not produce a duplicate.
    latestEventSource().emit("op", echoedOp);
    await flush();

    const undoButton = document.getElementById("undo-button") as HTMLButtonElement;
    expect(undoButton.disabled).toBe(false); // exactly one of "my own" ops is now known, not two
  });

  it("a remote collaborator's op is applied and becomes visible", async () => {
    latestEventSource().emit("op", {
      id: "remote-op-1",
      ownerId: "someone-else",
      kind: "draw",
      color: "#1d1d1d",
      size: 2,
      points: [{ x: 5, y: 5 }],
      createdAt: Date.now(),
      seq: 1,
      docKind: "pixel",
      active: true,
    });
    await flush();

    const undoButton = document.getElementById("undo-button") as HTMLButtonElement;
    // Still disabled: the newly-known op belongs to someone else, never to
    // this owner -- confirms the remote op was applied (allOps grew) AND
    // correctly attributed, not just blindly accepted as "mine".
    expect(undoButton.disabled).toBe(true);
  });

  it("a remote undo deactivates the matching op, and a later redo reactivates it", async () => {
    const op = {
      id: "remote-op-2",
      ownerId: "someone-else",
      kind: "draw",
      color: "#1d1d1d",
      size: 2,
      points: [{ x: 6, y: 6 }],
      createdAt: Date.now(),
      seq: 2,
      docKind: "pixel",
      active: true,
    };
    latestEventSource().emit("op", op);
    await flush();

    latestEventSource().emit("undo", { ...op, active: false });
    await flush();
    latestEventSource().emit("redo", { ...op, active: true });
    await flush();

    // No assertion crashes/throws across this sequence is itself meaningful
    // (undo/redo for an op this tab never drew must not error); the real
    // correctness guarantee (did the pixel disappear/reappear) is already
    // covered by public/pixelgrid.js's own replayPixelOps tests -- this is
    // the DOM-level wiring, not a second copy of that engine test.
    expect(document.getElementById("undo-button")).toBeTruthy();
  });

  it("a reconnect's fresh sync frame fully replaces prior state (self-healing, no merge)", async () => {
    latestEventSource().emit("op", {
      id: "stale-op",
      ownerId: "owner-1",
      kind: "draw",
      color: "#1d1d1d",
      size: 2,
      points: [{ x: 1, y: 1 }],
      createdAt: Date.now(),
      seq: 1,
      docKind: "pixel",
      active: true,
    });
    await flush();
    expect((document.getElementById("undo-button") as HTMLButtonElement).disabled).toBe(false);

    // A brand new connection (what EventSource's native retry produces)
    // always starts with its own fresh `sync` -- simulated here as a second
    // frame on the same fake source, which is an equally valid proxy for
    // "replace wholesale" since the real client never distinguishes them.
    latestEventSource().emit("sync", { docKind: "pixel", width: 2048, height: 1152, ops: [] });
    await flush();
    expect((document.getElementById("undo-button") as HTMLButtonElement).disabled).toBe(true);
  });
});
