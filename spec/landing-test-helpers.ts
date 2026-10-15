// jsdom test scaffolding for public/landing.js, mirroring spec/app-test-
// helpers.ts's own approach (boot the REAL module against the REAL markup,
// stub fetch/EventSource/canvas) but against public/landing.html instead.
// Reuses that file's generic canvas stub and FakeEventSource directly rather
// than redefining them -- they were already written generically (no
// app.js-specific assumptions), so there is exactly one implementation of
// each, not two.

import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  FakeEventSource,
  canvasContexts,
  firePointer,
  installCanvasStub,
  installEventSourceStub,
  jsonResponse,
  latestEventSource,
} from "./app-test-helpers";

export { canvasContexts, installEventSourceStub, latestEventSource, FakeEventSource, firePointer };

const indexHtmlPath = path.resolve(__dirname, "../public/landing.html");
const fullHtml = fs.readFileSync(indexHtmlPath, "utf8");
export const landingBodyHtml = fullHtml.match(/<body>([\s\S]*)<\/body>/)![1];

export type PostedRequest = { url: string; body: Record<string, unknown> };

// me: the GET /api/me response this boot should answer with -- the one
// thing that decides whether landing.js shows onboarding (nickname: null) or
// treats this as a returning visitor (nickname set).
export function installLandingFetchMock(posted: PostedRequest[], me: { nickname: string | null; cursorColor: string | null }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/me") return jsonResponse({ ownerId: "owner-1", ...me });
      if (url === "/api/me/profile") {
        const body = JSON.parse(String(init!.body));
        posted.push({ url, body });
        return jsonResponse({ ownerId: "owner-1", nickname: body.nickname, cursorColor: body.cursorColor.toLowerCase() });
      }
      if (url === "/api/presence/heartbeat" || url === "/api/presence/leave") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        posted.push({ url, body });
        return jsonResponse({ ok: true, onlineCount: 1, totalVisitors: 1 });
      }
      return jsonResponse({});
    }),
  );
}

export async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function bootLandingForTest(
  posted: PostedRequest[],
  me: { nickname: string | null; cursorColor: string | null } = { nickname: null, cursorColor: null },
) {
  vi.resetModules();
  history.pushState(null, "", "/");
  document.body.innerHTML = landingBodyHtml;
  installCanvasStub();
  installEventSourceStub();
  installLandingFetchMock(posted, me);
  await import("../public/landing.js");
  await flush();
  latestEventSource().emit("sync", { docKind: "freehand", ops: [], onlineCount: 3, totalVisitors: 5 });
  await flush();
}
