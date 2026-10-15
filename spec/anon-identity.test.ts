import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

type Me = { ownerId: string };

async function me(cookie?: string) {
  const res = await fetch(new URL("/api/me", baseUrl), { headers: cookie ? { Cookie: cookie } : {} });
  const body = (await res.json()) as Me;
  return { body, setCookie: res.headers.get("set-cookie") };
}

async function post(path: string, cookie: string, body: unknown = {}) {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

it("the identity cookie is signed (<id>.<signature>), httpOnly, and carries the guest id", async () => {
  const first = await me();
  expect(first.setCookie).toMatch(/^anon_id=[^.;]+\.[^;]+;/);
  expect(first.setCookie).toContain("HttpOnly");
  const value = first.setCookie!.split(";")[0].slice("anon_id=".length);
  expect(value.startsWith(first.body.ownerId + ".")).toBe(true);
});

it("a valid signed cookie preserves the same guest identity and is not re-issued", async () => {
  const first = await me();
  const cookie = first.setCookie!.split(";")[0];
  const again = await me(cookie);
  expect(again.body.ownerId).toBe(first.body.ownerId);
  expect(again.setCookie).toBeNull();
});

it("a legacy unsigned anon_id cookie is not accepted: it gets a fresh identity", async () => {
  const victim = await me();
  const forged = await me(`anon_id=${victim.body.ownerId}`);
  expect(forged.body.ownerId).not.toBe(victim.body.ownerId);
  expect(forged.setCookie).not.toBeNull();
});

it("a tampered signature or a swapped id is rejected with a fresh identity", async () => {
  const victim = await me();
  const attacker = await me();
  const victimValue = victim.setCookie!.split(";")[0].slice("anon_id=".length);
  const attackerValue = attacker.setCookie!.split(";")[0].slice("anon_id=".length);

  const badSig = await me(`anon_id=${victim.body.ownerId}.${"A".repeat(43)}`);
  expect(badSig.body.ownerId).not.toBe(victim.body.ownerId);

  // attacker's valid signature attached to the victim's id
  const attackerSig = attackerValue.slice(attackerValue.lastIndexOf(".") + 1);
  const swapped = await me(`anon_id=${victim.body.ownerId}.${attackerSig}`);
  expect(swapped.body.ownerId).not.toBe(victim.body.ownerId);

  // truncated real cookie
  const truncated = await me(`anon_id=${victimValue.slice(0, -4)}`);
  expect(truncated.body.ownerId).not.toBe(victim.body.ownerId);
});

it("a forged cookie cannot undo or redo another guest's operations", async () => {
  const victim = await me();
  const victimCookie = victim.setCookie!.split(";")[0];
  const draw = await post("/api/ops/draw", victimCookie, { color: "#112233", width: 0.01, points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }] });
  expect(draw.status).toBe(201);
  expect(draw.body.ownerId).toBe(victim.body.ownerId);

  const forgedCookie = `anon_id=${victim.body.ownerId}`; // owner ids are public via /api/me and op lists
  const undo = await post("/api/ops/undo", forgedCookie);
  expect(undo.status).toBe(200);
  expect(undo.body.op).toBeNull();

  const ops = (await (await fetch(new URL("/api/ops", baseUrl))).json()) as { id: string }[];
  expect(ops.some((op) => op.id === draw.body.id)).toBe(true); // the victim's op is still active

  const realUndo = await post("/api/ops/undo", victimCookie);
  expect(realUndo.body.op?.id).toBe(draw.body.id); // the real owner still can
});
