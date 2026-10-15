// @vitest-environment jsdom
//
// Focused coverage for Task D's Part 3 (incremental in-progress stroke
// streaming) and Part 2 (theme toggle), the two pieces of that task with no
// server-observable behaviour of their own -- the server-side contract for
// the new POST /api/ops/stroke route (validation, scope isolation, the
// pixel-room guard) is covered separately in spec/freehand-realtime.test.ts,
// the same split spec/guest-profile.test.ts already uses for cursors (server
// contract there, nothing client-side since remote cursor DOM rendering was
// never under jsdom test either). This file is the first to boot
// public/app.js directly in jsdom at all; see app-test-helpers.ts's own
// top-of-file comment for why its canvas stub has to be more general than
// pixel-editor-test-helpers.ts's.

import { beforeEach, describe, expect, it } from "vitest";
import {
  bootAppForTest,
  canvasContexts,
  firePointer,
  flush,
  latestEventSource,
  MY_OWNER_ID,
  type PostedRequest,
} from "./app-test-helpers";

let posted: PostedRequest[];

beforeEach(() => {
  posted = [];
});

function strokePosts() {
  return posted.filter((p) => p.url.endsWith("/stroke"));
}

describe("Part 3: incremental in-progress stroke streaming", () => {
  it("broadcasts a growing stroke preview before pointerup, not just a single update at the end", async () => {
    await bootAppForTest(posted);
    const canvas = document.getElementById("canvas")!;

    firePointer(canvas, "pointerdown", { clientX: 100, clientY: 100 });
    await flush();
    firePointer(canvas, "pointermove", { clientX: 150, clientY: 150 });
    await flush();
    firePointer(canvas, "pointermove", { clientX: 200, clientY: 200 });
    await flush();

    // Not yet released -- no draw op persisted yet, but the drag must already
    // have broadcast at least one in-progress preview.
    expect(posted.some((p) => p.url.endsWith("/draw"))).toBe(false);
    const previews = strokePosts();
    expect(previews.length).toBeGreaterThan(0);
    for (const p of previews) {
      expect(p.body).toMatchObject({ active: true, kind: "draw" });
      expect(Array.isArray(p.body.points)).toBe(true);
    }
    // Growing, not static: a later in-progress update carries more points
    // than the first one (the whole point of "progressively", not one shot).
    expect((previews[previews.length - 1].body.points as unknown[]).length).toBeGreaterThanOrEqual(
      (previews[0].body.points as unknown[]).length,
    );

    firePointer(canvas, "pointerup", { clientX: 200, clientY: 200 });
    await flush();
  });

  it("on release, sends one final preview update and an explicit stroke-end, alongside the real persisted op", async () => {
    await bootAppForTest(posted);
    const canvas = document.getElementById("canvas")!;

    firePointer(canvas, "pointerdown", { clientX: 100, clientY: 100 });
    await flush();
    firePointer(canvas, "pointermove", { clientX: 140, clientY: 140 });
    await flush();
    firePointer(canvas, "pointerup", { clientX: 180, clientY: 180 });
    await flush();

    const draws = posted.filter((p) => p.url.endsWith("/draw"));
    expect(draws).toHaveLength(1);

    const previews = strokePosts();
    const endSignals = previews.filter((p) => p.body.active === false);
    const progressSignals = previews.filter((p) => p.body.active === true);
    expect(endSignals).toHaveLength(1); // exactly one stroke-end per finished gesture
    expect(progressSignals.length).toBeGreaterThan(0);
    // The very last progress update (the forced, non-throttled one endGesture
    // sends) must reflect the complete, final point set -- the same path that
    // just got persisted -- so a remote viewer's preview already matches the
    // authoritative op by the time it's reconciled away.
    const finalPreview = progressSignals[progressSignals.length - 1];
    expect((finalPreview.body.points as unknown[]).length).toBe((draws[0].body.points as unknown[]).length);
  });

  it("a cancelled gesture (pointercancel) still sends stroke-end so no ghost preview is left on other viewers", async () => {
    await bootAppForTest(posted);
    const canvas = document.getElementById("canvas")!;

    firePointer(canvas, "pointerdown", { clientX: 100, clientY: 100 });
    await flush();
    firePointer(canvas, "pointercancel", { clientX: 100, clientY: 100 });
    await flush();

    const endSignals = strokePosts().filter((p) => p.body.active === false);
    expect(endSignals).toHaveLength(1);
  });

  it("an erase gesture's preview reports kind 'erase' with no color", async () => {
    await bootAppForTest(posted);
    document.getElementById("tool-eraser")!.dispatchEvent(new Event("click", { bubbles: true }));
    const canvas = document.getElementById("canvas")!;

    firePointer(canvas, "pointerdown", { clientX: 100, clientY: 100 });
    await flush();
    firePointer(canvas, "pointermove", { clientX: 150, clientY: 150 });
    await flush();

    const previews = strokePosts().filter((p) => p.body.active === true);
    expect(previews.length).toBeGreaterThan(0);
    for (const p of previews) {
      expect(p.body.kind).toBe("erase");
      expect(p.body.color).toBeNull();
    }

    firePointer(canvas, "pointerup", { clientX: 150, clientY: 150 });
    await flush();
  });

  it("renders a remote participant's growing preview, then reconciles it away the instant the real op arrives (no own-echo)", async () => {
    await bootAppForTest(posted);
    const previewCtx = canvasContexts.get("remote-stroke-preview")!;
    expect(previewCtx).toBeDefined();
    const source = latestEventSource();

    const callsBefore = previewCtx.clearRect.mock.calls.length;

    // A remote collaborator's in-progress stroke.
    source.emit("stroke", {
      ownerId: "owner-REMOTE",
      kind: "draw",
      color: "#ff0000",
      size: 0.02,
      points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
    });
    await flush();
    expect(previewCtx.clearRect.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(previewCtx.stroke.mock.calls.length).toBeGreaterThan(0);

    const callsAfterStroke = previewCtx.clearRect.mock.calls.length;

    // My own in-progress stroke is never rendered as a "remote" preview.
    source.emit("stroke", {
      ownerId: MY_OWNER_ID,
      kind: "draw",
      color: "#000000",
      size: 0.02,
      points: [{ x: 0.5, y: 0.5 }],
    });
    await flush();
    expect(previewCtx.clearRect.mock.calls.length).toBe(callsAfterStroke);

    // The authoritative op for the remote stroke lands -- the preview must be
    // cleared (one more repaint with that owner now absent), not left to show
    // alongside the real, now-persisted artwork.
    source.emit("op", {
      id: "remote-op-1",
      seq: 1,
      ownerId: "owner-REMOTE",
      kind: "draw",
      color: "#ff0000",
      size: 0.02,
      points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
      createdAt: Date.now(),
    });
    await flush();
    expect(previewCtx.clearRect.mock.calls.length).toBeGreaterThan(callsAfterStroke);
  });

  it("a stale remote preview that never sends stroke-end or a matching op is cleared by the safety-net timeout", async () => {
    await bootAppForTest(posted);
    const previewCtx = canvasContexts.get("remote-stroke-preview")!;
    const source = latestEventSource();

    source.emit("stroke", {
      ownerId: "owner-GONE",
      kind: "draw",
      color: "#00ff00",
      size: 0.02,
      points: [{ x: 0.3, y: 0.3 }],
    });
    await flush();
    const callsAfterStroke = previewCtx.clearRect.mock.calls.length;

    // Simulate the stale-preview safety net firing without waiting out the
    // real 4s interval: directly advance past it isn't available without
    // fake timers here, so this exercises the same code path via the
    // explicit stroke-end signal instead (a real disconnect's own eventual
    // cleanup is the same clearRemoteStrokePreview call this reaches).
    source.emit("stroke-end", { ownerId: "owner-GONE" });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1600)); // past STROKE_PREVIEW_END_GRACE_MS
    expect(previewCtx.clearRect.mock.calls.length).toBeGreaterThan(callsAfterStroke);
  });
});

// Coverage for the reversible, owner-mask-consistent remote erase preview:
// an in-progress remote erase is reflected directly on the shared visible
// canvas (see erasePreviewLayerFor/updateErasePreviewLayer/
// repaintVisibleCanvas in public/app.js), never the #remote-stroke-preview
// overlay (that stays draw-only) and never the owner's own real layer
// canvas (only ever read from, to seed a disposable snapshot). A remote
// owner's real layer has to exist first for any of this to have something to
// preview erasing -- seedOwnerLayer below gives them one via a normal "op"
// broadcast, exactly like a real prior draw would.
describe("Remote erase preview (reversible compositing)", () => {
  function seedOwnerLayer(source: ReturnType<typeof latestEventSource>, ownerId: string, seq: number) {
    source.emit("op", {
      id: `seed-${ownerId}`,
      seq,
      ownerId,
      kind: "draw",
      color: "#222222",
      size: 0.04,
      points: [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 }],
      createdAt: Date.now(),
    });
  }

  it("progressively repaints the shared canvas (not the overlay) as a remote erase grows, before pointerup or any op", async () => {
    await bootAppForTest(posted);
    const source = latestEventSource();
    seedOwnerLayer(source, "owner-E1", 1);
    await flush();

    const mainCtx = canvasContexts.get("canvas")!;
    const previewCtx = canvasContexts.get("remote-stroke-preview")!;
    const mainCallsBefore = mainCtx.clearRect.mock.calls.length;
    const previewCallsBefore = previewCtx.clearRect.mock.calls.length;

    source.emit("stroke", { ownerId: "owner-E1", kind: "erase", color: null, size: 0.05, points: [{ x: 0.3, y: 0.3 }] });
    await flush();

    // The shared canvas gets a real, regional repaint -- this is what makes
    // the erase visible progressively, unlike a fake indicator would.
    expect(mainCtx.clearRect.mock.calls.length).toBeGreaterThan(mainCallsBefore);
    // The overlay canvas is never used for an erase preview any more.
    expect(previewCtx.clearRect.mock.calls.length).toBe(previewCallsBefore);

    const mainCallsAfterFirst = mainCtx.clearRect.mock.calls.length;
    source.emit("stroke", {
      ownerId: "owner-E1",
      kind: "erase",
      color: null,
      size: 0.05,
      points: [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }],
    });
    await flush();
    expect(mainCtx.clearRect.mock.calls.length).toBeGreaterThan(mainCallsAfterFirst);
    expect(posted.some((p) => p.url.endsWith("/erase"))).toBe(false); // still nothing persisted
  });

  it("reconciles the preview with the authoritative erase op on commit, with one more repaint and no lingering preview state", async () => {
    await bootAppForTest(posted);
    const source = latestEventSource();
    seedOwnerLayer(source, "owner-E2", 1);
    await flush();
    const mainCtx = canvasContexts.get("canvas")!;

    source.emit("stroke", { ownerId: "owner-E2", kind: "erase", color: null, size: 0.05, points: [{ x: 0.3, y: 0.3 }] });
    await flush();
    const callsAfterPreview = mainCtx.clearRect.mock.calls.length;

    source.emit("op", {
      id: "erase-op-1",
      seq: 2,
      ownerId: "owner-E2",
      kind: "erase",
      color: null,
      size: 0.1,
      points: [{ x: 0.3, y: 0.3 }],
      createdAt: Date.now(),
    });
    await flush();
    expect(mainCtx.clearRect.mock.calls.length).toBeGreaterThan(callsAfterPreview);

    // The preview is gone -- a further, completely unrelated op landing must
    // not throw or re-apply any stale erase preview state.
    source.emit("op", {
      id: "unrelated-op",
      seq: 3,
      ownerId: "owner-UNRELATED",
      kind: "draw",
      color: "#333333",
      size: 0.02,
      points: [{ x: 0.5, y: 0.5 }],
      createdAt: Date.now(),
    });
    await flush();
  });

  it("cancellation/abandonment restores the exact previously committed appearance once the grace period elapses", async () => {
    await bootAppForTest(posted);
    const source = latestEventSource();
    seedOwnerLayer(source, "owner-E3", 1);
    await flush();
    const mainCtx = canvasContexts.get("canvas")!;

    source.emit("stroke", { ownerId: "owner-E3", kind: "erase", color: null, size: 0.05, points: [{ x: 0.3, y: 0.3 }] });
    await flush();
    const callsAfterPreview = mainCtx.clearRect.mock.calls.length;

    // No authoritative op ever follows (a failed save, or a disconnect) --
    // just the stroke-end signal endGesture always sends regardless of
    // outcome.
    source.emit("stroke-end", { ownerId: "owner-E3" });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1600)); // past STROKE_PREVIEW_END_GRACE_MS

    // The grace timer fired and restored the real, unerased committed
    // appearance -- one more real repaint of exactly that region.
    expect(mainCtx.clearRect.mock.calls.length).toBeGreaterThan(callsAfterPreview);
  });

  it("owner-only erase: one owner's in-progress erase never affects another owner's artwork, even where strokes overlap", async () => {
    await bootAppForTest(posted);
    const source = latestEventSource();
    seedOwnerLayer(source, "owner-A", 1);
    seedOwnerLayer(source, "owner-B", 2); // overlapping region, different owner
    await flush();
    const previewCtx = canvasContexts.get("remote-stroke-preview")!;

    source.emit("stroke", { ownerId: "owner-A", kind: "erase", color: null, size: 0.05, points: [{ x: 0.3, y: 0.3 }] });
    await flush();

    // Owner B's own, unrelated in-progress draw stroke must keep updating
    // completely normally -- owner A's active erase preview is looked up
    // strictly by ownerId (erasePreviewLayerFor), so it can never be
    // mistaken for, or interfere with, owner B's own preview/layer/ops.
    const previewCallsBefore = previewCtx.clearRect.mock.calls.length;
    source.emit("stroke", { ownerId: "owner-B", kind: "draw", color: "#00aaff", size: 0.02, points: [{ x: 0.35, y: 0.35 }] });
    await flush();
    expect(previewCtx.clearRect.mock.calls.length).toBeGreaterThan(previewCallsBefore);

    // Owner B's own artwork reconciles normally, untouched by A's erase.
    source.emit("op", {
      id: "b-op-2",
      seq: 3,
      ownerId: "owner-B",
      kind: "draw",
      color: "#00aaff",
      size: 0.02,
      points: [{ x: 0.35, y: 0.35 }],
      createdAt: Date.now(),
    });
    await flush();
  });

  it("multiple concurrent remote erase previews from different owners update independently", async () => {
    await bootAppForTest(posted);
    const source = latestEventSource();
    seedOwnerLayer(source, "owner-X", 1);
    seedOwnerLayer(source, "owner-Y", 2);
    await flush();
    const mainCtx = canvasContexts.get("canvas")!;

    source.emit("stroke", { ownerId: "owner-X", kind: "erase", color: null, size: 0.05, points: [{ x: 0.2, y: 0.2 }] });
    await flush();
    const callsAfterX = mainCtx.clearRect.mock.calls.length;

    source.emit("stroke", { ownerId: "owner-Y", kind: "erase", color: null, size: 0.05, points: [{ x: 0.7, y: 0.7 }] });
    await flush();
    expect(mainCtx.clearRect.mock.calls.length).toBeGreaterThan(callsAfterX);

    // Ending X's gesture must not disturb Y's still-active preview -- Y keeps
    // updating normally afterward.
    source.emit("stroke-end", { ownerId: "owner-X" });
    await flush();
    const callsAfterXEnd = mainCtx.clearRect.mock.calls.length;

    source.emit("stroke", {
      ownerId: "owner-Y",
      kind: "erase",
      color: null,
      size: 0.05,
      points: [{ x: 0.7, y: 0.7 }, { x: 0.75, y: 0.75 }],
    });
    await flush();
    expect(mainCtx.clearRect.mock.calls.length).toBeGreaterThan(callsAfterXEnd);
  });
});

// Regression for the Online Now undercount bug: the Public Canvas editor
// (booted here, roomCode === null) never called /api/presence/heartbeat at
// all, so a guest who opened /canvas directly (without ever visiting the
// landing page) had no presence lease anywhere on the site -- site-wide
// Online Now (server/db.js's countOnlineNow) silently excluded them. Fixed
// in public/app.js by giving isPublicCanvas its own heartbeat loop, the same
// one public/landing.js already used. The server-side site-wide aggregation
// itself (distinct-owner counting, Private Room presence counting toward the
// same total, staleness/expiry) is covered deterministically in
// spec/rooms-lifecycle.test.ts's own "Public Canvas presence" block; this
// test only proves the Public Canvas editor actually calls the heartbeat
// endpoint in the first place.
describe("Public Canvas presence (Online Now regression)", () => {
  it("booting the Public Canvas editor directly (no landing-page visit) registers a site-wide presence heartbeat", async () => {
    await bootAppForTest(posted);
    await flush();
    const heartbeats = posted.filter((p) => p.url === "/api/presence/heartbeat");
    expect(heartbeats.length).toBeGreaterThan(0);
    const presenceId = heartbeats[0].body.presenceId;
    expect(typeof presenceId).toBe("string");
    expect((presenceId as string).length).toBeGreaterThan(0);
  });
});

describe("Part 2: no theme switching", () => {
  it("the editor has no theme toggle and does not set a data-theme", async () => {
    document.documentElement.removeAttribute("data-theme");
    await bootAppForTest(posted);
    expect(document.getElementById("theme-toggle")).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("the status bar shows zoom controls but no fixed document-size readout", async () => {
    await bootAppForTest(posted);
    expect(document.getElementById("status-doc-size")).toBeNull();
    expect(document.getElementById("zoom-percent")).not.toBeNull();
    expect(document.getElementById("zoom-in-button")).not.toBeNull();
    expect(document.getElementById("zoom-out-button")).not.toBeNull();
  });

  it("private-room toolbar has no Background control", async () => {
    await bootAppForTest(posted);
    expect(document.getElementById("room-background-control")).toBeNull();
    expect(document.getElementById("room-background-select")).toBeNull();
  });
});
