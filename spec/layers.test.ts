import { describe, expect, it } from "vitest";
import {
  PUBLIC_LAYER_IDS,
  PUBLIC_LAYER_DEFAULT_NAMES,
  PRIVATE_LAYER_IDS,
  PRIVATE_LAYER_DEFAULT_NAMES,
  layerIdsFor,
  defaultLayerNamesFor,
  effectiveLayerId,
  layerSettingsStorageKey,
  parseLayerSettings,
} from "../public/layers.js";

describe("fixed layer counts and order", () => {
  it("the Public Canvas has exactly 2 layers, bottom-to-top Colour then Lineart", () => {
    expect(PUBLIC_LAYER_IDS).toEqual(["colour", "lineart"]);
    expect(layerIdsFor(true)).toHaveLength(2);
    expect(PUBLIC_LAYER_DEFAULT_NAMES).toEqual({ colour: "Colour", lineart: "Lineart" });
  });

  it("a Private Room has exactly 4 layers, bottom-to-top Layer 1..4", () => {
    expect(PRIVATE_LAYER_IDS).toEqual(["layer1", "layer2", "layer3", "layer4"]);
    expect(layerIdsFor(false)).toHaveLength(4);
    expect(PRIVATE_LAYER_DEFAULT_NAMES).toEqual({
      layer1: "Layer 1",
      layer2: "Layer 2",
      layer3: "Layer 3",
      layer4: "Layer 4",
    });
  });

  it("layerIdsFor/defaultLayerNamesFor switch correctly on isPublicCanvas", () => {
    expect(layerIdsFor(true)).toBe(PUBLIC_LAYER_IDS);
    expect(layerIdsFor(false)).toBe(PRIVATE_LAYER_IDS);
    expect(defaultLayerNamesFor(true)).toBe(PUBLIC_LAYER_DEFAULT_NAMES);
    expect(defaultLayerNamesFor(false)).toBe(PRIVATE_LAYER_DEFAULT_NAMES);
  });
});

describe("effectiveLayerId: backward-compatible default assignment", () => {
  it("an op with a valid layerId keeps it, on both canvas types", () => {
    expect(effectiveLayerId({ layerId: "lineart" }, true)).toBe("lineart");
    expect(effectiveLayerId({ layerId: "layer3" }, false)).toBe("layer3");
  });

  it("an op with no layerId (legacy, pre-layer-system) defaults to the bottom-most layer", () => {
    expect(effectiveLayerId({ layerId: null }, true)).toBe("colour");
    expect(effectiveLayerId({}, true)).toBe("colour");
    expect(effectiveLayerId({ layerId: null }, false)).toBe("layer1");
  });

  it("an op with a layerId that isn't valid for this canvas type also falls back to the bottom layer", () => {
    // e.g. a Private-shaped layerId surviving into a Public context, or vice versa -- never crashes, never
    // silently renders on a nonexistent layer.
    expect(effectiveLayerId({ layerId: "layer2" }, true)).toBe("colour");
    expect(effectiveLayerId({ layerId: "lineart" }, false)).toBe("layer1");
  });
});

describe("layerSettingsStorageKey: per-canvas isolation", () => {
  it("Public Canvas (no room code) uses a distinct, stable key", () => {
    expect(layerSettingsStorageKey(null)).toBe("layerSettings:public");
  });

  it("each room code gets its own distinct key", () => {
    expect(layerSettingsStorageKey("ABC123")).toBe("layerSettings:ABC123");
    expect(layerSettingsStorageKey("XYZ789")).toBe("layerSettings:XYZ789");
    expect(layerSettingsStorageKey("ABC123")).not.toBe(layerSettingsStorageKey("XYZ789"));
  });
});

describe("parseLayerSettings: defaulting and safe fallback", () => {
  const ids = PUBLIC_LAYER_IDS;
  const names = PUBLIC_LAYER_DEFAULT_NAMES;

  it("absent (null) storage produces every-layer-visible defaults, selected = topmost layer", () => {
    const settings = parseLayerSettings(null, ids, names);
    expect(settings.selected).toBe("lineart");
    expect(settings.names).toEqual(names);
    expect(settings.hidden).toEqual({});
  });

  it("corrupted JSON falls back to the same defaults rather than throwing", () => {
    const settings = parseLayerSettings("{not json", ids, names);
    expect(settings.selected).toBe("lineart");
    expect(settings.hidden).toEqual({});
  });

  it("a non-object parsed value falls back to defaults", () => {
    expect(parseLayerSettings("42", ids, names).selected).toBe("lineart");
    expect(parseLayerSettings('"a string"', ids, names).selected).toBe("lineart");
  });

  it("a saved selection naming a layer that no longer exists on this canvas falls back to the topmost layer", () => {
    const settings = parseLayerSettings(JSON.stringify({ selected: "layer3" }), ids, names);
    expect(settings.selected).toBe("lineart");
  });

  it("a valid saved selection is preserved", () => {
    const settings = parseLayerSettings(JSON.stringify({ selected: "colour" }), ids, names);
    expect(settings.selected).toBe("colour");
  });

  it("saved names are preserved per layer, with no name blown away for the sibling layer", () => {
    const settings = parseLayerSettings(JSON.stringify({ names: { colour: "Background" } }), ids, names);
    expect(settings.names.colour).toBe("Background");
    expect(settings.names.lineart).toBe("Lineart"); // untouched, still the default
  });

  it("a blank/whitespace-only saved name is ignored in favour of the default", () => {
    const settings = parseLayerSettings(JSON.stringify({ names: { colour: "   " } }), ids, names);
    expect(settings.names.colour).toBe("Colour");
  });

  it("saved hidden flags are preserved only for ids that still exist on this canvas", () => {
    const settings = parseLayerSettings(JSON.stringify({ hidden: { colour: true, bogus: true } }), ids, names);
    expect(settings.hidden).toEqual({ colour: true });
  });
});
