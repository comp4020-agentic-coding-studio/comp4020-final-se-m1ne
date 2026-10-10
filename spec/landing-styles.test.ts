// Guards the two structural fixes from this round against regression: the
// landing canvas's background must be a literal, non-themed white (never a
// token a dark-mode override could touch), and the landing page itself must
// never offer its own Light/Dark toggle. Same text-based CSS-source approach
// spec/pixel-editor-styles.test.ts already uses for this exact class of
// concern (no real layout engine here, so this cannot confirm actual
// rendered pixels -- see that file's own comment).

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const landingCss = fs.readFileSync(path.resolve(__dirname, "../public/landing.css"), "utf8");
const landingHtml = fs.readFileSync(path.resolve(__dirname, "../public/landing.html"), "utf8");
const indexHtml = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
const tokensCss = fs.readFileSync(path.resolve(__dirname, "../public/theme-tokens.css"), "utf8");

describe("the landing canvas's appearance is independent of system theme", () => {
  it("#landing-canvas has a literal #ffffff background, not a themed token", () => {
    const rule = landingCss.match(/#landing-canvas\s*\{[^}]*\}/);
    expect(rule, "#landing-canvas rule should exist").toBeTruthy();
    expect(rule![0]).toMatch(/background:\s*#ffffff/);
    expect(rule![0]).not.toMatch(/var\(--/); // no token -- nothing for a dark override to touch
  });

  it("no [data-theme=\"dark\"] block anywhere overrides #landing-canvas", () => {
    const darkBlocks = landingCss.match(/:root\[data-theme="dark"\]\s*\{[^}]*\}/g) ?? [];
    for (const block of darkBlocks) {
      expect(block).not.toMatch(/#landing-canvas/);
    }
    // theme-tokens.css's own dark override is pure custom properties, never a
    // #landing-canvas (or #canvas) rule of its own.
    const tokenDarkBlock = tokensCss.match(/:root\[data-theme="dark"\]\s*\{[^}]*\}/)?.[0] ?? "";
    expect(tokenDarkBlock).not.toMatch(/#landing-canvas/);
  });
});

describe("the landing page offers no Light/Dark toggle of its own", () => {
  it("landing.html has no theme-toggle control", () => {
    expect(landingHtml).not.toMatch(/id="theme-toggle"/);
    expect(landingHtml).not.toMatch(/class="[^"]*theme-toggle/);
  });
});

describe("one shared visual language across the landing page and the editor", () => {
  it("both pages link the same shared token and component stylesheets", () => {
    for (const html of [landingHtml, indexHtml]) {
      expect(html).toMatch(/href="\/theme-tokens\.css"/);
      expect(html).toMatch(/href="\/shared-ui\.css"/);
    }
  });

  it("landing.css defines no colour tokens of its own -- it reads the shared ones", () => {
    expect(landingCss).not.toMatch(/:root\s*\{/);
    expect(landingCss).not.toMatch(/--landing-/);
  });

  it("the editor's own stylesheet also defines no colour tokens of its own any more", () => {
    const stylesCss = fs.readFileSync(path.resolve(__dirname, "../public/styles.css"), "utf8");
    expect(stylesCss).not.toMatch(/:root\s*\{/);
    expect(stylesCss).not.toMatch(/:root\[data-theme="dark"\]\s*\{\s*\n\s*--/);
  });
});
