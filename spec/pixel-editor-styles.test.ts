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
// Shared custom-property tokens (colours, radii, fonts) now live in their own
// file, loaded alongside styles.css from public/index.html's own <head> --
// one effective stylesheet in the browser, so checks for a token's
// DEFINITION read both; checks for a selector's own RULE (which never moved)
// still read styles.css alone.
const tokensCss = fs.readFileSync(path.resolve(__dirname, "../public/theme-tokens.css"), "utf8");

// Assumes the browser default root font-size (16px) -- this project sets no
// html{font-size} override (confirmed by grep during this task), so
// #tool-size-number's own `font-size: 0.85rem` resolves to 13.6px, and its
// own `width: Nem` is relative to THAT (its own font-size), per CSS's em
// definition.
const ROOT_FONT_PX = 16;

function parsePxOrEm(value: string, ownFontPx: number): number {
  const trimmed = value.trim();
  if (trimmed.endsWith("em")) return parseFloat(trimmed) * ownFontPx;
  return parseFloat(trimmed); // px (or bare 0)
}

function horizontalOf(shorthand: string): number {
  // CSS padding/border shorthand: 1 value = all sides, 2 = vertical
  // horizontal, 3 = top horizontal bottom, 4 = top right bottom left.
  const parts = shorthand.trim().split(/\s+/);
  if (parts.length === 1) return parseFloat(parts[0]) * 2;
  if (parts.length === 2) return parseFloat(parts[1]) * 2;
  if (parts.length === 3) return parseFloat(parts[1]) * 2;
  return parseFloat(parts[1]) + parseFloat(parts[3]);
}

describe("left size rail stays within its narrow budget (styles.css source)", () => {
  it("computes to at/under the 48px hard max (44px target), using only the declared CSS values", () => {
    const numberRule = css.match(/#tool-size-number\s*\{[^}]*\}/)![0];
    const fontSizeMatch = numberRule.match(/font-size:\s*([\d.]+)rem/);
    expect(fontSizeMatch, "#tool-size-number should declare its own font-size").toBeTruthy();
    const ownFontPx = Number(fontSizeMatch![1]) * ROOT_FONT_PX;

    const widthMatch = numberRule.match(/\bwidth:\s*([\d.]+)em/);
    expect(widthMatch, "#tool-size-number should declare an explicit em width").toBeTruthy();
    const numberInputWidthPx = Number(widthMatch![1]) * ownFontPx; // border-box width (box-sizing: border-box is global)

    const railRule = css.match(/\.studio-layout #studio-side-rail\s*\{[^}]*\}/)![0];
    const railPadding = railRule.match(/\bpadding:\s*([^;]+);/)![1];
    const railBorder = railRule.match(/border-right:\s*([\d.]+)px/)![1];
    const railHorizontal = horizontalOf(railPadding) + Number(railBorder);

    const controlRule = css.match(/\.side-rail-control\s*\{[^}]*\}/)![0];
    const controlPadding = controlRule.match(/\bpadding:\s*([^;]+);/)![1];
    const controlHorizontal = horizontalOf(controlPadding);

    // The number input is the widest content in the rail (wider than the
    // 20px vertical slider and the short "Size" label) -- see the CSS's own
    // comment for why. Total rail width = widest content + every
    // non-content horizontal space around it.
    const totalWidth = numberInputWidthPx + controlHorizontal + railHorizontal;

    expect(totalWidth).toBeLessThanOrEqual(48); // hard max
    // Also confirm it isn't narrowed so far that 3 monospace digits
    // ("100") would no longer fit -- same box-sizing:border-box width,
    // minus this element's own padding/border, must leave reasonable room.
    const numberPadding = numberRule.match(/\bpadding:\s*([^;]+);/)![1];
    const numberBorderMatch = numberRule.match(/border:\s*([\d.]+)px/);
    const numberNonText = horizontalOf(numberPadding) + (numberBorderMatch ? Number(numberBorderMatch[1]) * 2 : 0);
    const availableForText = numberInputWidthPx - numberNonText;
    const roughCharWidth = ownFontPx * 0.65; // a generous monospace estimate
    expect(availableForText).toBeGreaterThanOrEqual(roughCharWidth * 3); // "100" is 3 characters
  });
});

describe("pixel-grid overlay uses the shared blue accent, not a neutral gray", () => {
  it("--grid-line is defined for both themes and referenced by #pixel-grid-overlay", () => {
    expect(tokensCss).toMatch(/--grid-line:/);
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
