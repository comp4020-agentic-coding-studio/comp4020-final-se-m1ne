// @vitest-environment jsdom
//
// Client-side coverage for public/landing.js: the Welcome dialog now shown
// on every "Enter Canvas" click (first-time AND returning visitor alike --
// see public/landing.js's handleEnterCanvas), read-only behaviour (no
// drawing/erasing network calls ever originate from this page, regardless of
// pointer input), and live-background compatibility with the exact same
// "sync"/"op" SSE events public/app.js's own editor consumes. The
// server-side routing/presence contract this page depends on is covered in
// spec/landing.test.ts; this file is the first (and only) one to boot
// public/landing.js itself.

import { describe, expect, it } from "vitest";
import { bootLandingForTest, firePointer, flush, latestEventSource, type PostedRequest } from "./landing-test-helpers";

let posted: PostedRequest[];

describe("Welcome dialog", () => {
  it("a first-time visitor (no nickname yet) sees the Welcome dialog with an empty nickname and a 'Start Drawing' action", async () => {
    posted = [];
    await bootLandingForTest(posted, { nickname: null, cursorColor: null });
    const enterButton = document.getElementById("enter-canvas-button")!;
    const overlay = document.getElementById("onboarding-overlay")! as HTMLElement;
    expect(overlay.hidden).toBe(true);

    enterButton.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(overlay.hidden).toBe(false);
    // Reuses the shared about copy (public/about-content.js) -- the same
    // wording the editor's own Help/About entry shows later.
    expect(document.getElementById("onboarding-about")!.textContent).toContain("Welcome to our canvas!");
    expect((document.getElementById("onboarding-nickname-input") as HTMLInputElement).value).toBe("");
    expect(document.getElementById("onboarding-start-button")!.textContent).toBe("Start Drawing");
  });

  it("completing the dialog as a first-time visitor saves the profile via the existing guest-profile endpoint", async () => {
    posted = [];
    await bootLandingForTest(posted, { nickname: null, cursorColor: null });
    document.getElementById("enter-canvas-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    const nicknameInput = document.getElementById("onboarding-nickname-input") as HTMLInputElement;
    const colourInput = document.getElementById("onboarding-colour-input") as HTMLInputElement;
    nicknameInput.value = "Riley";
    colourInput.value = "#ab12cd";
    document.getElementById("onboarding-start-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    const profilePost = posted.find((p) => p.url === "/api/me/profile");
    expect(profilePost?.body).toMatchObject({ nickname: "Riley", cursorColor: "#ab12cd" });
  });

  it("a returning visitor (nickname already set) still sees the Welcome dialog, pre-filled, with a 'Continue Drawing' action", async () => {
    posted = [];
    await bootLandingForTest(posted, { nickname: "Morgan", cursorColor: "#1e88e5" });
    const overlay = document.getElementById("onboarding-overlay")! as HTMLElement;
    document.getElementById("enter-canvas-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(overlay.hidden).toBe(false);
    expect(document.getElementById("onboarding-about")!.textContent).toContain("Welcome to our canvas!");
    expect((document.getElementById("onboarding-nickname-input") as HTMLInputElement).value).toBe("Morgan");
    expect((document.getElementById("onboarding-colour-input") as HTMLInputElement).value).toBe("#1e88e5");
    expect(document.getElementById("onboarding-start-button")!.textContent).toBe("Continue Drawing");
  });

  it("a returning visitor who changes nothing never triggers a profile overwrite, and still reaches the editor", async () => {
    posted = [];
    await bootLandingForTest(posted, { nickname: "Morgan", cursorColor: "#1e88e5" });
    document.getElementById("enter-canvas-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    document.getElementById("onboarding-start-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(posted.some((p) => p.url === "/api/me/profile")).toBe(false); // no second guest identity, no unnecessary overwrite
  });

  it("a returning visitor who does change their nickname/colour saves the update (same guest identity, no duplicate)", async () => {
    posted = [];
    await bootLandingForTest(posted, { nickname: "Morgan", cursorColor: "#1e88e5" });
    document.getElementById("enter-canvas-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    (document.getElementById("onboarding-nickname-input") as HTMLInputElement).value = "MorganV2";
    document.getElementById("onboarding-start-button")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    const profilePosts = posted.filter((p) => p.url === "/api/me/profile");
    expect(profilePosts).toHaveLength(1);
    expect(profilePosts[0].body).toMatchObject({ nickname: "MorganV2" });
  });
});

describe("read-only background", () => {
  it("pointer interaction with the live canvas never posts a draw/erase request", async () => {
    posted = [];
    await bootLandingForTest(posted);
    const canvas = document.getElementById("landing-canvas")!;

    firePointer(canvas, "pointerdown", { clientX: 50, clientY: 50 });
    firePointer(canvas, "pointermove", { clientX: 80, clientY: 80 });
    firePointer(canvas, "pointerup", { clientX: 80, clientY: 80 });
    await flush();

    expect(posted.some((p) => p.url.endsWith("/draw") || p.url.endsWith("/erase") || p.url.endsWith("/stroke"))).toBe(false);
  });
});

describe("live background compatibility with existing realtime events", () => {
  it("renders a sync snapshot and a subsequent 'op' without throwing, and shows the live onlineCount and totalVisitors", async () => {
    posted = [];
    await bootLandingForTest(posted);
    const source = latestEventSource();

    source.emit("op", {
      id: "op-1",
      seq: 1,
      ownerId: "owner-REMOTE",
      kind: "draw",
      color: "#336699",
      size: 0.02,
      points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }],
      createdAt: Date.now(),
    });
    await flush();

    expect(document.getElementById("online-count")!.textContent).toBe("3"); // from the sync frame's onlineCount
    expect(document.getElementById("total-visitors-count")!.textContent).toBe("5"); // from the sync frame's totalVisitors

    source.emit("presence", { onlineCount: 7, totalVisitors: 9 });
    await flush();
    expect(document.getElementById("online-count")!.textContent).toBe("7");
    expect(document.getElementById("total-visitors-count")!.textContent).toBe("9");
  });
});
