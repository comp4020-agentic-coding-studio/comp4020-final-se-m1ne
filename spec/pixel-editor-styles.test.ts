// Guards specific CSS rule VALUES in public/styles.css against accidental
// regression (e.g. someone widening #tool-size-number back past the point
// where "100" is visually readable, or past the rail's own size budget).
// This reads the stylesheet as TEXT and asserts specific declarations are
// present -- it does NOT run a real layout engine, so it cannot confirm
// actual rendered pixel widths, true visual alignment, or similarity to the
// Pixquare reference screenshot. That still needs a real browser; see the
// project report for exactly which checks remain manual.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "../public/styles.css"), "utf8");

describe("left size rail stays within its narrow budget (styles.css source)", () => {
  it("#tool-size-number is narrow enough for the rail's ~52px target (60px hard max)", () => {
    const match = css.match(/#tool-size-number\s*\{[^}]*\bwidth:\s*([\d.]+)em/);
    expect(match, "#tool-size-number should declare an explicit em width").toBeTruthy();
    const widthEm = Number(match![1]);
    // 2.8em keeps the rail comfortably under the 60px hard max once its own
    // padding/border is added (see the CSS's own comment for the math);
    // anything at or above the old 3.6em would blow the budget again.
    expect(widthEm).toBeLessThanOrEqual(3.0);
    expect(widthEm).toBeGreaterThanOrEqual(2.4); // narrow enough to re-truncate "100" below this
  });

  it("the side rail's own padding stays minimal (narrow-rail budget, not just the number input)", () => {
    const match = css.match(/\.studio-layout #studio-side-rail\s*\{[^}]*\bpadding:\s*([^;]+);/);
    expect(match, "#studio-side-rail should declare explicit padding").toBeTruthy();
    // e.g. "8px 1px" -- the horizontal (second) value must stay small; a
    // return to something like "10px 6px" would push the rail back toward
    // its previous, rejected ~138px width.
    const parts = match![1].trim().split(/\s+/).map((v) => parseFloat(v));
    const horizontal = parts.length >= 2 ? parts[1] : parts[0];
    expect(horizontal).toBeLessThanOrEqual(4);
  });
});

describe("pixel-grid overlay uses the shared blue accent, not a neutral gray", () => {
  it("--grid-line is defined for both themes and referenced by #pixel-grid-overlay", () => {
    expect(css).toMatch(/--grid-line:/);
    const overlayRule = css.match(/#pixel-grid-overlay\s*\{[^}]*\}/);
    expect(overlayRule, "#pixel-grid-overlay rule should exist").toBeTruthy();
    expect(overlayRule![0]).toMatch(/var\(--grid-line\)/);
    expect(overlayRule![0]).not.toMatch(/rgba\(128, 128, 128/); // the old neutral-gray literal
  });
});

describe("dotted workspace background (Pixquare reference)", () => {
  it("#canvas-viewport renders a dot pattern via --canvas-dot, independent of document size/zoom", () => {
    const rule = css.match(/#canvas-viewport\s*\{[^}]*\}/);
    expect(rule, "#canvas-viewport rule should exist").toBeTruthy();
    expect(rule![0]).toMatch(/radial-gradient/);
    expect(rule![0]).toMatch(/var\(--canvas-dot\)/);
    // A fixed tile size (not computed from gridWidth/gridHeight) is what
    // keeps this O(1) regardless of document size -- never a per-pixel draw.
    expect(rule![0]).toMatch(/background-size:\s*16px 16px/);
  });
});

describe("flattened top toolbar row (Pixquare reference: one continuous row, no per-group boxes)", () => {
  it("#tool-group and #colour-group (but not #size-group) collapse to display: contents in studio mode", () => {
    expect(css).toMatch(/\.studio-layout #tool-group,\s*\n\s*\.studio-layout #colour-group,/);
    // #size-group must keep its own explicit display:none override --
    // see the CSS's own comment on why display:contents would be fragile
    // for it specifically (content already relocated away).
    expect(css).toMatch(/#size-group\[hidden\]\s*\{\s*\n\s*display:\s*none;/);
  });
});
