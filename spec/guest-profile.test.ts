// Essential coverage for the new guest profile (nickname + cursor colour)
// and its effect on broadcast cursor colour -- POST /api/me/profile and its
// read-back via GET /api/me. Nickname-only behaviour (POST /api/me/nickname)
// is already covered by spec/pixel-api.test.ts; this file only covers what's
// new this round.

import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

function withCookie(cookie?: string): Record<string, string> {
  return cookie ? { Cookie: cookie } : {};
}

async function postJson(path: string, body: unknown, cookie?: string) {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...withCookie(cookie) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: json, cookie: cookie ?? setCookie?.split(";")[0] };
}

function getJson(path: string, cookie?: string) {
  return fetch(new URL(path, baseUrl), { headers: withCookie(cookie) }).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => undefined),
  }));
}

it("GET /api/me reports cursorColor null before a profile is ever saved", async () => {
  const me = await getJson("/api/me");
  expect(me.body.nickname).toBeNull();
  expect(me.body.cursorColor).toBeNull();
});

it("POST /api/me/profile sets nickname and cursor colour together, and GET /api/me reflects both afterward", async () => {
  const cookie = (await fetch(new URL("/api/me", baseUrl))).headers.get("set-cookie")?.split(";")[0];
  const saved = await postJson("/api/me/profile", { nickname: "Robin", cursorColor: "#AB12CD" }, cookie);
  expect(saved.status).toBe(200);
  expect(saved.body.nickname).toBe("Robin");
  expect(saved.body.cursorColor).toBe("#ab12cd"); // normalized lowercase

  const after = await getJson("/api/me", cookie);
  expect(after.body.nickname).toBe("Robin");
  expect(after.body.cursorColor).toBe("#ab12cd");
});

it("rejects an invalid cursor colour without changing anything already saved", async () => {
  const cookie = (await fetch(new URL("/api/me", baseUrl))).headers.get("set-cookie")?.split(";")[0];
  await postJson("/api/me/profile", { nickname: "Sam", cursorColor: "#112233" }, cookie);

  const bad = await postJson("/api/me/profile", { nickname: "Sam", cursorColor: "not-a-colour" }, cookie);
  expect(bad.status).toBe(400);

  const after = await getJson("/api/me", cookie);
  expect(after.body.cursorColor).toBe("#112233"); // unchanged
});

it("rejects an empty or overlong nickname, same validation as the nickname-only route", async () => {
  const cookie = (await fetch(new URL("/api/me", baseUrl))).headers.get("set-cookie")?.split(";")[0];
  for (const nickname of ["", "   ", "x".repeat(25)]) {
    const res = await postJson("/api/me/profile", { nickname, cursorColor: "#1e88e5" }, cookie);
    expect(res.status).toBe(400);
  }
});

it("a Public cursor broadcast uses this owner's own saved cursor colour, not the hash fallback", async () => {
  const cookie = (await fetch(new URL("/api/me", baseUrl))).headers.get("set-cookie")?.split(";")[0];
  await postJson("/api/me/profile", { nickname: "Casey", cursorColor: "#334455" }, cookie);

  const res = await fetch(new URL("/api/ops/stream", baseUrl), { headers: withCookie(cookie) });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function nextFrame(): Promise<{ event: string; data: any }> {
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value, { stream: true });
    }
    const idx = buffer.indexOf("\n\n");
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    let event = "message";
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    return { event, data: JSON.parse(data) };
  }

  await nextFrame(); // sync
  await postJson("/api/ops/cursor", { x: 0.1, y: 0.1, showCursor: true, showNickname: true }, cookie);
  const cursorEvent = await nextFrame();
  expect(cursorEvent.event).toBe("cursor");
  expect(cursorEvent.data.color).toBe("#334455");
  expect(cursorEvent.data.nickname).toBe("Casey");

  reader.cancel();
});
