// Pure colour-space conversions and clamping, with no DOM/canvas dependency --
// this is what makes spec/colour.test.ts able to unit-test them directly (see
// spec/fade.test.ts for the established pattern of importing a plain
// public/*.js module from a .ts test). Nothing in here is specific to brush
// vs eraser, or to this app's UI: every function is a total function of its
// inputs, including malformed ones.

// Rounds to an integer and clamps into 0-255, the storage range for a single
// R/G/B channel. The single place every RGB output passes through, so a
// malformed or out-of-range input (a bad hex digit, an HSV edge case, a
// hand-typed number input) can never produce an invalid channel value.
export function clampByte(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(255, Math.max(0, Math.round(n)));
}

// Rounds to an integer and clamps into 0-100, the storage range for S and V.
export function clampPercent(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// Wraps a hue into [0, 360) -- hue is circular, so 370 and -10 both mean the
// same angle as 10. Handles any finite input, including multiple full turns
// in either direction.
export function normalizeHue(h) {
  if (!Number.isFinite(h)) return 0;
  const wrapped = h % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

// "#rgb" or "#rrggbb" (with or without the leading #) -> {r,g,b}, each 0-255.
// Returns null for anything else rather than throwing, so a bad persisted or
// hand-typed value becomes "ignore this" for the caller instead of a crash.
export function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// {r,g,b} -> "#rrggbb", lowercase, always 6 digits. Clamps each channel first,
// so this is also the safe way to turn an out-of-range RGB object (e.g. from
// a hand-typed number input) into the exact persisted-colour string format
// the server and renderer already expect.
export function rgbToHex({ r, g, b }) {
  const toHex = (n) => clampByte(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// {r,g,b} (0-255 each) -> {h,s,v}: h in [0,360), s and v in [0,100]. Standard
// max/min/delta formula; only the final h/s/v are rounded (via the h
// normalization and the caller's own display rounding) -- the intermediate
// 0-1 math here is never rounded, so repeated conversions don't accumulate
// drift.
export function rgbToHsv({ r, g, b }) {
  const rn = clampByte(r) / 255;
  const gn = clampByte(g) / 255;
  const bn = clampByte(b) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
  }
  h = normalizeHue(h);

  const v = max;
  const s = max === 0 ? 0 : delta / max;
  return { h, s: s * 100, v: v * 100 };
}

// {h,s,v} (h any finite degrees, s/v 0-100) -> {r,g,b}, each an integer
// 0-255. Wraps h and clamps s/v first, so an out-of-range or malformed HSV
// triple (a hand-typed number input, a dragged-past-the-edge pointer) still
// produces a valid colour instead of NaN or an out-of-gamut value.
export function hsvToRgb({ h, s, v }) {
  const hh = normalizeHue(h);
  const ss = Math.min(100, Math.max(0, Number.isFinite(s) ? s : 0)) / 100;
  const vv = Math.min(100, Math.max(0, Number.isFinite(v) ? v : 0)) / 100;

  const c = vv * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = vv - c;

  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hh < 60) {
    rp = c; gp = x; bp = 0;
  } else if (hh < 120) {
    rp = x; gp = c; bp = 0;
  } else if (hh < 180) {
    rp = 0; gp = c; bp = x;
  } else if (hh < 240) {
    rp = 0; gp = x; bp = c;
  } else if (hh < 300) {
    rp = x; gp = 0; bp = c;
  } else {
    rp = c; gp = 0; bp = x;
  }

  return {
    r: clampByte((rp + m) * 255),
    g: clampByte((gp + m) * 255),
    b: clampByte((bp + m) * 255),
  };
}

// The achromatic-hue-retention policy: a picker's remembered hue only moves
// when the colour it's being updated from actually has meaningful saturation.
// At s=0 the "hue" rgbToHsv reports is arbitrary (grey has no hue), so without
// this, dragging saturation down to 0 and back up would snap to an unrelated
// hue (typically 0/red) instead of returning to the colour the user started
// from (e.g. blue -> grey -> blue, not blue -> grey -> red).
//
// This only gates *implicit* hue changes (derived from an RGB value, e.g. a
// preset or an RGB slider edit). A direct hue-control edit (the hue ring, or
// the HSV H slider) calls hsvToRgb with its own explicit h and should set the
// retained hue to exactly that value regardless of the resulting saturation
// -- that call site assigns the new hue directly rather than going through
// this helper.
export function nextPickerHue(previousHue, hsv) {
  return hsv.s > 0 ? hsv.h : normalizeHue(previousHue);
}
