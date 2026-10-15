// Guards this round's fixes against regression: the editor's light-mode
// palette is restored to its pre-refactor neutral values while dark mode and
// the shared component/typography system are untouched; the landing page's
// own light-mode surfaces (hero/button/counter/dialog) keep their warm
// palette, genuinely separate from the editor's now-neutral one via cascade
// order, not a second duplicated theme system; the landing canvas stays
// literally white and theme-independent; and the title panel/Enter Canvas
// button land at the specified fixed desktop positions/sizes. Same
// text-based CSS-source approach spec/pixel-editor-styles.test.ts already
// uses for this exact class of concern (no real layout engine here, so this
// cannot confirm actual rendered pixels -- see that file's own comment).

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const landingCss = fs.readFileSync(path.resolve(__dirname, "../public/landing.css"), "utf8");
const landingHtml = fs.readFileSync(path.resolve(__dirname, "../public/landing.html"), "utf8");
const indexHtml = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
const tokensCss = fs.readFileSync(path.resolve(__dirname, "../public/theme-tokens.css"), "utf8");
const stylesCss = fs.readFileSync(path.resolve(__dirname, "../public/styles.css"), "utf8");

function block(css: string, selectorPattern: string): string {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{[^}]*\\}`));
  expect(match, `expected to find a ${selectorPattern} rule`).toBeTruthy();
  return match![0];
}

describe("the landing canvas's appearance is independent of system theme", () => {
  it("#landing-canvas has a literal #ffffff background, not a themed token", () => {
    const rule = block(landingCss, "#landing-canvas");
    expect(rule).toMatch(/background:\s*#ffffff/);
    expect(rule).not.toMatch(/var\(--/); // no token -- nothing for a dark override to touch
  });

  it("there is no dark theme at all: no [data-theme] override or prefers-color-scheme script on either page", () => {
    expect(tokensCss).not.toMatch(/data-theme/);
    expect(landingCss).not.toMatch(/data-theme/);
    expect(landingHtml).not.toMatch(/prefers-color-scheme|dataset\.theme/);
    expect(indexHtml).not.toMatch(/prefers-color-scheme|dataset\.theme/);
  });
});

describe("the landing page offers no Light/Dark toggle of its own", () => {
  it("landing.html has no theme-toggle control", () => {
    expect(landingHtml).not.toMatch(/id="theme-toggle"/);
    expect(landingHtml).not.toMatch(/class="[^"]*theme-toggle/);
  });
});

describe("shared typography/component system, separate editor/landing surface palettes", () => {
  it("both pages link the same shared token and component stylesheets", () => {
    for (const html of [landingHtml, indexHtml]) {
      expect(html).toMatch(/href="\/theme-tokens\.css"/);
      expect(html).toMatch(/href="\/shared-ui\.css"/);
    }
  });

  it("landing.css still defines no colour tokens of its own -- it reads the shared ones", () => {
    expect(landingCss).not.toMatch(/:root\s*\{/);
    expect(landingCss).not.toMatch(/--landing-/);
  });

  it("the editor restores its own light-mode surface tokens (overriding theme-tokens.css's shared values for this page only), but defines no dark override of its own", () => {
    expect(stylesCss).toMatch(/:root\s*\{/);
    expect(stylesCss).not.toMatch(/data-theme/);
  });

  it("shared accent/typography tokens (radius, mono font, the landing page's sage accent) are not duplicated in styles.css", () => {
    const editorRoot = block(stylesCss, ":root");
    expect(editorRoot).not.toMatch(/--radius-sm:/); // still only defined once, in theme-tokens.css
    expect(editorRoot).not.toMatch(/--mono-font:/);
    expect(editorRoot).not.toMatch(/--sage:/);
  });
});

describe("the editor's light-mode palette is restored to its neutral, pre-refactor values", () => {
  const editorRoot = () => block(stylesCss, ":root");

  it("main surfaces are white/neutral grey, not the cozy cream/tan values the refactor introduced", () => {
    const root = editorRoot();
    expect(root).toMatch(/--app-bg:\s*#f3f3f3;/);
    expect(root).toMatch(/--workspace-bg:\s*#ffffff;/);
    expect(root).toMatch(/--ribbon-bg:\s*#f7f7f7;/);
    expect(root).toMatch(/--control-bg:\s*#ffffff;/);
    expect(root).toMatch(/--canvas-surround-bg:\s*#e8e9eb;/);
  });

  it("borders/inputs are subtle neutral grey, not warm tan", () => {
    const root = editorRoot();
    expect(root).toMatch(/--border:\s*#e0e0e0;/);
    expect(root).toMatch(/--input-border:\s*#c8c8c8;/);
    expect(root).toMatch(/--input-bg:\s*#ffffff;/);
  });

  it("selection/focus accents are the original restrained blue, not the refactor's warm apricot", () => {
    const root = editorRoot();
    expect(root).toMatch(/--selected-bg:\s*#d9e8fb;/);
    expect(root).toMatch(/--selected-border:\s*#8fb8e8;/);
    expect(root).toMatch(/--focus-ring:\s*#1e88e5;/);
  });

  it("no restored editor token carries a warm cream/tan hex value", () => {
    const root = editorRoot();
    // The refactor's own warm light-mode values (theme-tokens.css, still
    // used by the landing page) -- confirming none of them leaked back in.
    for (const warmValue of ["#f6ead9", "#fffaf2", "#f1e2c8", "#e3934f", "#c97b3d"]) {
      expect(root).not.toContain(warmValue);
    }
  });
});

describe("the landing page's own light-mode chrome keeps its warm, cozy palette", () => {
  it("theme-tokens.css's light block still defines the warm values the hero/button/counter/dialog read", () => {
    const lightBlock = tokensCss.match(/:root\s*\{[^}]*\}/)![0];
    expect(lightBlock).toMatch(/--app-bg:\s*#f6ead9;/);
    expect(lightBlock).toMatch(/--popover-bg:\s*#fffaf2;/);
    expect(lightBlock).toMatch(/--sage:\s*#93a97e;/);
  });
});

describe("landing title panel and Enter Canvas button match the fixed desktop design reference", () => {
  it("#landing-hero is horizontally centred, 600px wide (responsive), top edge at 12% viewport height", () => {
    const rule = block(landingCss, "#landing-hero");
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/top:\s*12vh/); // 12% of viewport height -- 129.6px at 1080
    expect(rule).toMatch(/left:\s*50%/);
    expect(rule).toMatch(/transform:\s*translateX\(-50%\)/);
    expect(rule).toMatch(/width:\s*min\(600px,/); // 600px desktop reference, shrinks responsively
  });

  it("#landing-title is 48px (desktop) via clamp, and #landing-subtitle is 18px (desktop) via clamp", () => {
    const titleRule = block(landingCss, "#landing-title");
    expect(titleRule).toMatch(/font-size:\s*clamp\([^)]*3rem\)/); // 3rem = 48px, the clamp's own max
    const subtitleRule = block(landingCss, "#landing-subtitle");
    expect(subtitleRule).toMatch(/font-size:\s*clamp\([^)]*1\.125rem\)/); // 1.125rem = 18px
  });

  it("#enter-canvas-button is a standalone element (not inside #landing-hero), 220x64px, outside the title panel", () => {
    // Structural: the button's own markup must not be a descendant of
    // #landing-hero -- it must close before the button appears.
    const heroOpenIdx = landingHtml.indexOf('id="landing-hero"');
    const heroCloseIdx = landingHtml.indexOf("</main>", heroOpenIdx);
    const buttonIdx = landingHtml.indexOf('id="enter-canvas-button"');
    expect(heroOpenIdx).toBeGreaterThan(-1);
    expect(buttonIdx).toBeGreaterThan(heroCloseIdx);

    const ctaRule = block(landingCss, "#landing-cta");
    expect(ctaRule).toMatch(/position:\s*fixed/);
    expect(ctaRule).toMatch(/top:\s*68vh/); // 68% of viewport height -- 734.4px at 1080
    expect(ctaRule).toMatch(/left:\s*50%/);

    const buttonRule = block(landingCss, "#enter-canvas-button");
    expect(buttonRule).toMatch(/width:\s*min\(220px,/);
    expect(buttonRule).toMatch(/height:\s*64px/);
  });

  it("#online-counter stays pinned to the bottom-right corner", () => {
    const rule = block(landingCss, "#online-counter");
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/right:/);
    expect(rule).toMatch(/bottom:/);
  });

  it("a narrow/short-viewport media query adapts spacing without removing the title panel or button", () => {
    expect(landingCss).toMatch(/@media[^{]*max-width:\s*480px[^{]*\{/);
    const narrowSection = landingCss.slice(landingCss.indexOf("@media (max-width: 480px), (max-height: 480px)"));
    expect(narrowSection).toMatch(/#landing-hero/);
    expect(narrowSection).toMatch(/#landing-cta/);
  });
});

describe("cursor colour selector uses the specified sizes and colours", () => {
  const sharedCss = fs.readFileSync(path.resolve(__dirname, "../public/shared-ui.css"), "utf8");

  it("presets are 40x40 circles with the specified borders, and selection keeps the outer size", () => {
    const swatch = block(sharedCss, "\.cursor-swatch");
    expect(swatch).toMatch(/box-sizing:\s*border-box/); // a 3px selected border cannot grow the 40px box
    expect(swatch).toMatch(/width:\s*40px/);
    expect(swatch).toMatch(/height:\s*40px/);
    expect(swatch).toMatch(/border-radius:\s*50%/);
    expect(swatch).toMatch(/border:\s*1px solid #d5c7b5/);
    expect(block(sharedCss, "\.cursor-swatch\.is-selected")).toMatch(/border:\s*3px solid #56483d/);
  });

  it("the Custom button and label match the specification", () => {
    const custom = block(sharedCss, "\.cursor-custom-button");
    for (const rule of [/height:\s*40px/, /font-size:\s*14px/, /font-weight:\s*600/, /color:\s*#75624e/, /background:\s*#fffdf9/, /border:\s*1px solid #cdbba5/, /border-radius:\s*10px/, /gap:\s*6px/]) {
      expect(custom).toMatch(rule);
    }
    expect(block(sharedCss, "\.cursor-custom-button\.is-selected")).toMatch(/#56483d/);
    const label = block(sharedCss, "\.cursor-colour-label");
    expect(label).toMatch(/font-size:\s*14px/);
    expect(label).toMatch(/font-weight:\s*600/);
    expect(label).toMatch(/color:\s*#806e5a/);
    expect(block(sharedCss, "\.cursor-colour-field")).toMatch(/gap:\s*12px/);
  });

  it("the row has a 10px gap and wraps instead of scrolling", () => {
    const row = block(sharedCss, "\.cursor-colour-picker");
    expect(row).toMatch(/gap:\s*10px/);
    expect(row).toMatch(/flex-wrap:\s*wrap/);
  });

  it("all three places that choose a cursor colour use the selector", () => {
    expect(landingHtml).toMatch(/id="onboarding-colour-picker"/);
    expect(indexHtml).toMatch(/id="profile-colour-picker"/);
    expect(indexHtml).toMatch(/id="guest-setup-colour-picker"/);
  });
});
