import { describe, expect, it } from "vitest";
import {
  clampByte,
  clampPercent,
  hexToRgb,
  hsvToRgb,
  nextPickerHue,
  normalizeHue,
  rgbToHex,
  rgbToHsv,
} from "../public/colour.js";

describe("hexToRgb", () => {
  it("parses known 6-digit values", () => {
    expect(hexToRgb("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb("#1d1d1d")).toEqual({ r: 29, g: 29, b: 29 });
  });

  it("accepts a missing leading # and 3-digit shorthand", () => {
    expect(hexToRgb("ff0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("#0f0")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("handles malformed input safely by returning null instead of throwing", () => {
    expect(hexToRgb("not-a-colour")).toBeNull();
    expect(hexToRgb("#12345")).toBeNull();
    expect(hexToRgb(null as unknown as string)).toBeNull();
    expect(hexToRgb(undefined as unknown as string)).toBeNull();
    expect(hexToRgb(42 as unknown as string)).toBeNull();
  });
});

describe("rgbToHex", () => {
  it("produces known values", () => {
    expect(rgbToHex({ r: 255, g: 0, b: 0 })).toBe("#ff0000");
    expect(rgbToHex({ r: 0, g: 255, b: 0 })).toBe("#00ff00");
    expect(rgbToHex({ r: 29, g: 29, b: 29 })).toBe("#1d1d1d");
  });

  it("round-trips through hexToRgb", () => {
    expect(hexToRgb(rgbToHex({ r: 18, g: 52, b: 86 }))).toEqual({ r: 18, g: 52, b: 86 });
  });
});

describe("RGB clamping", () => {
  it("clampByte clamps and rounds into 0-255", () => {
    expect(clampByte(300)).toBe(255);
    expect(clampByte(-10)).toBe(0);
    expect(clampByte(128.6)).toBe(129);
    expect(clampByte(Number.NaN)).toBe(0);
  });

  it("rgbToHex clamps out-of-range channels instead of producing an invalid string", () => {
    expect(rgbToHex({ r: 300, g: -5, b: 128 })).toBe("#ff0080");
  });
});

describe("S/V clamping", () => {
  it("clampPercent clamps and rounds into 0-100", () => {
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(-20)).toBe(0);
    expect(clampPercent(50.4)).toBe(50);
  });

  it("hsvToRgb clamps out-of-range s/v instead of producing an invalid colour", () => {
    expect(hsvToRgb({ h: 0, s: 150, v: -10 })).toEqual({ r: 0, g: 0, b: 0 });
    expect(hsvToRgb({ h: 0, s: 150, v: 200 })).toEqual({ r: 255, g: 0, b: 0 });
  });
});

describe("hue wrapping", () => {
  it("normalizeHue wraps into [0, 360)", () => {
    expect(normalizeHue(370)).toBe(10);
    expect(normalizeHue(-10)).toBe(350);
    expect(normalizeHue(720)).toBe(0);
    expect(normalizeHue(-730)).toBe(350);
  });

  it("hsvToRgb treats an out-of-range hue the same as its wrapped equivalent", () => {
    expect(hsvToRgb({ h: 370, s: 100, v: 100 })).toEqual(hsvToRgb({ h: 10, s: 100, v: 100 }));
    expect(hsvToRgb({ h: -10, s: 100, v: 100 })).toEqual(hsvToRgb({ h: 350, s: 100, v: 100 }));
  });
});

describe("rgbToHsv on primary/secondary colours", () => {
  it("red is h=0, s=100, v=100", () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, v: 100 });
  });

  it("green is h=120, s=100, v=100", () => {
    expect(rgbToHsv({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 100, v: 100 });
  });

  it("blue is h=240, s=100, v=100", () => {
    expect(rgbToHsv({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 100, v: 100 });
  });

  it("white is s=0, v=100 (hue undefined, reported as 0)", () => {
    expect(rgbToHsv({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, v: 100 });
  });

  it("black is s=0, v=0", () => {
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
  });
});

describe("hsvToRgb on primary/secondary colours", () => {
  it("h=0 s=100 v=100 is red", () => {
    expect(hsvToRgb({ h: 0, s: 100, v: 100 })).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("h=120 s=100 v=100 is green", () => {
    expect(hsvToRgb({ h: 120, s: 100, v: 100 })).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("h=240 s=100 v=100 is blue", () => {
    expect(hsvToRgb({ h: 240, s: 100, v: 100 })).toEqual({ r: 0, g: 0, b: 255 });
  });

  it("s=0 is always grey regardless of hue", () => {
    expect(hsvToRgb({ h: 200, s: 0, v: 50 })).toEqual({ r: 128, g: 128, b: 128 });
  });
});

describe("RGB <-> HSV round trips", () => {
  const colours = [
    { r: 29, g: 29, b: 29 }, // the app's default brush colour
    { r: 230, g: 57, b: 53 }, // the red preset
    { r: 255, g: 165, b: 0 }, // orange
    { r: 128, g: 0, b: 128 }, // purple
    { r: 12, g: 200, b: 180 }, // teal-ish, all three channels distinct
  ];

  for (const rgb of colours) {
    it(`round-trips rgb(${rgb.r},${rgb.g},${rgb.b}) within rounding tolerance`, () => {
      const hsv = rgbToHsv(rgb);
      const back = hsvToRgb(hsv);
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    });
  }
});

describe("nextPickerHue (achromatic hue-retention policy)", () => {
  it("keeps the previous hue when the new colour is achromatic (s=0)", () => {
    expect(nextPickerHue(240, { h: 0, s: 0, v: 50 })).toBe(240);
  });

  it("adopts the new hue when the new colour has meaningful saturation", () => {
    expect(nextPickerHue(240, { h: 90, s: 40, v: 50 })).toBe(90);
  });

  it("models blue -> grey -> blue, not blue -> grey -> red", () => {
    let pickerHue = rgbToHsv({ r: 0, g: 0, b: 255 }).h; // 240, start on blue
    const grey = rgbToHsv({ r: 128, g: 128, b: 128 }); // drag saturation to 0
    pickerHue = nextPickerHue(pickerHue, grey);
    expect(pickerHue).toBe(240); // still remembers blue, not reset to 0/red

    const backTowardsBlue = hsvToRgb({ h: pickerHue, s: 60, v: 100 }); // raise saturation again
    expect(rgbToHsv(backTowardsBlue).h).toBe(240);
  });

  it("normalizes an out-of-range previous hue even when retained", () => {
    expect(nextPickerHue(370, { h: 0, s: 0, v: 50 })).toBe(10);
  });
});
