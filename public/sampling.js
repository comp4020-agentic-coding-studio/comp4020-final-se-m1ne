// Pure pixel-compositing helper for the Eyedropper tool. Kept separate from
// colour.js (RGB/HSV colour-space conversions) because this is a different
// concern -- turning a raw canvas pixel read into the colour actually visible
// on screen -- with no DOM/canvas dependency, so it's directly unit-testable
// the same way colour.js/fade.js already are.

// #canvas's own 2D context bitmap is transparent (alpha 0) wherever nothing
// has been drawn -- the white the user sees there is a separate, literal,
// never-themed CSS background (#canvas { background: #ffffff }, styles.css),
// which getImageData cannot see. Compositing the raw sampled RGBA over that
// same literal white recovers the colour actually visible on screen, for
// every alpha in between (anti-aliased edges, a partially faded Public
// stroke) as well as the two extremes (fully transparent -> white, fully
// opaque -> unchanged).
export function compositeOverWhite(r, g, b, a) {
  const alpha = a / 255;
  const blend = (channel) => Math.round(channel * alpha + 255 * (1 - alpha));
  return { r: blend(r), g: blend(g), b: blend(b) };
}
