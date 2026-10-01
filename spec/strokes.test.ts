import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

// A POST followed by an independent GET (a fresh request, no cookie carried
// over) proves the stroke lives in shared persistent state on the server —
// visible to anyone who asks, not just held in the posting request's memory.
// This is the crit 8 bar: a public stroke survives and is visible later.
it("a posted stroke, including its brush width, is visible to a later, independent request", async () => {
  const stroke = {
    color: "#1e88e5",
    width: 0.015,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.2 },
    ],
  };

  const posted = await fetch(new URL("/api/strokes", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stroke),
  });
  expect(posted.status).toBe(201);
  const { id, width: postedWidth } = await posted.json();
  expect(postedWidth).toBe(stroke.width);

  const later = await fetch(new URL("/api/strokes", baseUrl));
  expect(later.status).toBe(200);
  const strokes = await later.json();
  const found = strokes.find((s: { id: string }) => s.id === id);
  expect(found).toBeTruthy();
  expect(found.width).toBe(stroke.width);
});
