import { describe, expect, it } from "vitest";
import { compositeOverWhite } from "../public/sampling.js";

describe("compositeOverWhite", () => {
  it("alpha 0 (untouched canvas) composites to white regardless of the underlying RGB", () => {
    expect(compositeOverWhite(0, 0, 0, 0)).toEqual({ r: 255, g: 255, b: 255 });
    expect(compositeOverWhite(230, 57, 53, 0)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("alpha 255 (fully opaque) composites to exactly the original RGB", () => {
    expect(compositeOverWhite(230, 57, 53, 255)).toEqual({ r: 230, g: 57, b: 53 });
    expect(compositeOverWhite(0, 0, 0, 255)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("partial alpha produces the correctly rounded blend over white", () => {
    // alpha = 128/255 = 0.50196...: red channel 255*a + 255*(1-a) = 255 (unchanged);
    // green/blue channel 0*a + 255*(1-a) = 255*0.49804 = 127.0 -> 127
    expect(compositeOverWhite(255, 0, 0, 128)).toEqual({ r: 255, g: 127, b: 127 });
  });

  it("a low but non-zero alpha (anti-aliased edge) still blends mostly toward white", () => {
    const result = compositeOverWhite(0, 0, 0, 26); // ~10% opaque black
    expect(result.r).toBeGreaterThan(200);
    expect(result.r).toBe(result.g);
    expect(result.g).toBe(result.b);
  });
});
