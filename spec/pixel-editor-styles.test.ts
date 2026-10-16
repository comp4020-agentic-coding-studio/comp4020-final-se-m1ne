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

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\}`));
  expect(match, `expected a ${selector} rule`).toBeTruthy();
  return match![0];
}

describe("shared three-column editor layout (styles.css source)", () => {
  it("left tool column is 76px, right sidebar is 264px, with 12px gaps and 14px panel radius", () => {
    expect(rule("#tool-ribbon")).toMatch(/flex:\s*0 0 76px/);
    expect(rule("#tool-ribbon")).toMatch(/width:\s*76px/);
    // The 264px fixed-width sizing now lives on #right-sidebar, the flex
    // column wrapping #colour-group and #layers-group (LAYERS panel,
    // directly below COLOURS) -- #colour-group itself is no longer the
    // direct flex child of #editor-body that owns this sizing.
    expect(rule("#right-sidebar")).toMatch(/flex:\s*0 0 264px/);
    expect(rule("#right-sidebar")).toMatch(/width:\s*264px/);
    expect(rule("#editor-body")).toMatch(/gap:\s*12px/);
    expect(rule("#tool-ribbon")).toMatch(/border-radius:\s*var\(--shell-radius-panel\)/);
    expect(css).toMatch(/--shell-radius-panel:\s*14px/);
    expect(css).toMatch(/--shell-radius-button:\s*10px/);
  });

  it("tool buttons are 48x48 with a 10px vertical gap, and Undo/Redo/Eyedropper are not in the tool column", () => {
    expect(rule("#tool-group .tool-button")).toMatch(/width:\s*48px/);
    expect(rule("#tool-group .tool-button")).toMatch(/height:\s*48px/);
    expect(rule("#tool-group")).toMatch(/flex-direction:\s*column/);
    expect(rule("#tool-group")).toMatch(/gap:\s*10px/);
  });

  it("header navigation is right-aligned in two rows (10px apart, 8px between controls)", () => {
    const right = rule("#action-row-right");
    expect(right).toMatch(/flex-direction:\s*column/);
    expect(right).toMatch(/align-items:\s*flex-end/);
    expect(right).toMatch(/gap:\s*10px/);
    const row = rule(".nav-row");
    expect(row).toMatch(/justify-content:\s*flex-end/);
    expect(row).toMatch(/gap:\s*8px/);
  });

  it("brush slider is 180px wide with a 6px track and a 20px white-bordered thumb", () => {
    expect(rule("#tool-size-slider")).toMatch(/width:\s*180px/);
    expect(rule("#tool-size-slider::-webkit-slider-runnable-track")).toMatch(/height:\s*6px/);
    const thumb = rule("#tool-size-slider::-webkit-slider-thumb");
    expect(thumb).toMatch(/width:\s*20px/);
    expect(thumb).toMatch(/height:\s*20px/);
    expect(thumb).toMatch(/border:\s*2px solid #ffffff/);
  });

  it("brush size and zoom are opposite ends of one row", () => {
    const bar = rule("#status-bar");
    expect(bar).toMatch(/justify-content:\s*space-between/);
    expect(bar).toMatch(/align-items:\s*center/);
    expect(rule(".size-control")).toMatch(/align-items:\s*center/); // label, slider and value on one line
  });

  it("the preset palette is a 5-column grid of equal squares that fits the sidebar's content width", () => {
    const grid = rule("#palette");
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(5,\s*40px\)/);
    const gap = Number(grid.match(/gap:\s*(\d+)px/)![1]);
    const sidebarContent = 264 - 2 * 14 - 2; // 264px column, 14px padding each side, 1px border each side
    expect(5 * 40 + 4 * gap).toBeLessThanOrEqual(sidebarContent);
    expect(rule(".swatch")).toMatch(/width:\s*40px/);
    expect(rule(".swatch")).toMatch(/height:\s*40px/);
  });

  it("public and private differ only in workspace/badge colours", () => {
    expect(css).toMatch(/#workspace\.is-public\s*\{[^}]*--workspace-surface:\s*#e4ead9;[^}]*--badge-bg:\s*#d2e0c6;[^}]*--badge-text:\s*#536d46;/);
    expect(css).toMatch(/#workspace\.is-private\s*\{[^}]*--workspace-surface:\s*#e9e1ee;[^}]*--badge-bg:\s*#ddd0e6;[^}]*--badge-text:\s*#725b85;/);
    expect(rule("#canvas")).toMatch(/background:\s*#ffffff/); // drawing surface is always white
  });
});

describe("pixel-grid overlay uses the shared blue accent, not a neutral gray", () => {
  it("--grid-line is defined and referenced by #pixel-grid-overlay", () => {
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
