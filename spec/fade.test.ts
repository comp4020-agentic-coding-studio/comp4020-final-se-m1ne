import { expect, it } from "vitest";
import { effectiveOpacity, FADE_DURATION_MS, fadeOpacity } from "../public/fade.js";

const MINUTE = 60 * 1000;
const NOW = 1_000_000_000; // arbitrary fixed instant; fadeOpacity only ever depends on (now - createdAt)

it("a draw op's opacity is 1 at age 0", () => {
  expect(fadeOpacity(NOW, NOW)).toBe(1);
});

// A single interior point (far from both endpoints) establishes that decay is
// continuous and linear, not a 15-minute step: 15 minutes is exactly one
// 2-percentage-point increment, so opacity here must be the first increment
// down from 1, not still 1 and not already further along.
it("a draw op's opacity is approximately 0.98 at age 15 minutes, establishing continuous linear decay rather than only the endpoints", () => {
  expect(fadeOpacity(NOW - 15 * MINUTE, NOW)).toBeCloseTo(0.98, 5);
});

it("a draw op's opacity is approximately 0.5 at age 375 minutes, half the fade duration", () => {
  expect(fadeOpacity(NOW - 375 * MINUTE, NOW)).toBeCloseTo(0.5, 5);
});

it("a draw op's opacity is 0 at age 750 minutes, exactly the full fade duration", () => {
  expect(fadeOpacity(NOW - 750 * MINUTE, NOW)).toBe(0);
});

it("a draw op's opacity stays 0 (never negative) for ages older than 750 minutes", () => {
  expect(fadeOpacity(NOW - 1000 * MINUTE, NOW)).toBe(0);
});

it("FADE_DURATION_MS is exactly 750 minutes in milliseconds", () => {
  expect(FADE_DURATION_MS).toBe(750 * MINUTE);
});

// The one gate between Public fading and Private permanence: isPublicCanvas
// is the only thing effectiveOpacity branches on. An op created far older
// than FADE_DURATION_MS -- old enough that fadeOpacity itself would already
// be clamped to 0 -- must still render at full opacity on a Private Room
// page, proving Private bypasses the fade calculation entirely rather than
// merely producing a very slow fade.
it("effectiveOpacity stays exactly 1 for a Private op regardless of age, even far past FADE_DURATION_MS", () => {
  const ancientCreatedAt = NOW - 10_000 * MINUTE;
  const op = { createdAt: ancientCreatedAt };
  expect(fadeOpacity(ancientCreatedAt, NOW)).toBe(0); // sanity: this age would be fully faded on Public
  expect(effectiveOpacity(op, NOW, false)).toBe(1);
});

it("effectiveOpacity on the Public Canvas matches fadeOpacity exactly", () => {
  const createdAt = NOW - 375 * MINUTE;
  const op = { createdAt };
  expect(effectiveOpacity(op, NOW, true)).toBe(fadeOpacity(createdAt, NOW));
});
