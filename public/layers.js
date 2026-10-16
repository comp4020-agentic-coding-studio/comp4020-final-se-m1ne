// Fixed, per-canvas-type layer structure -- the single place every layer id,
// default name, and backward-compatible-default rule is defined, shared by
// server/index.js (request validation) and public/app.js (rendering,
// gesture assignment, the LAYERS panel). No DOM dependency, same
// server+client-shared style as public/shapes.js's own SHAPE_TYPES/SHAPE_MODES.
//
// Layer order is permanently fixed and never created/deleted/reordered by a
// user -- these arrays are listed bottom-to-top, which is both the
// compositing order (see effectiveLayerId/layer index lookups in
// public/app.js) and the canonical order local settings are keyed by.
export const PUBLIC_LAYER_IDS = ["colour", "lineart"]; // bottom -> top
export const PUBLIC_LAYER_DEFAULT_NAMES = { colour: "Colour", lineart: "Lineart" };

export const PRIVATE_LAYER_IDS = ["layer1", "layer2", "layer3", "layer4"]; // bottom -> top
export const PRIVATE_LAYER_DEFAULT_NAMES = {
  layer1: "Layer 1",
  layer2: "Layer 2",
  layer3: "Layer 3",
  layer4: "Layer 4",
};

export function layerIdsFor(isPublicCanvas) {
  return isPublicCanvas ? PUBLIC_LAYER_IDS : PRIVATE_LAYER_IDS;
}

export function defaultLayerNamesFor(isPublicCanvas) {
  return isPublicCanvas ? PUBLIC_LAYER_DEFAULT_NAMES : PRIVATE_LAYER_DEFAULT_NAMES;
}

// Deterministic backward-compatible assignment for an op with no stored (or
// an unrecognized/stale) layerId: always the bottom-most layer. Existing
// artwork predates layers entirely, so by default it belongs underneath
// everything drawn after the layer system shipped, never floating to the top
// and never split arbitrarily across layers.
export function effectiveLayerId(op, isPublicCanvas) {
  const ids = layerIdsFor(isPublicCanvas);
  return op.layerId && ids.includes(op.layerId) ? op.layerId : ids[0];
}

// --- Personal (per-user, per-canvas) layer settings -------------------------
// Layer names, visibility, and the selected layer are never shared/broadcast
// -- see public/app.js's own profilePrefs for the established "personal,
// localStorage-only preference" precedent this follows, extended with a
// per-canvas key (profilePrefs itself is a single global key; layer settings
// additionally need per-room isolation, which has no prior precedent in this
// codebase, so the room/"public" scoping lives entirely in this one key
// function).
export function layerSettingsStorageKey(roomCode) {
  return `layerSettings:${roomCode ?? "public"}`;
}

// Builds a fresh settings object: every layer visible, every name at its
// default, and the topmost layer selected (a new user's first drawing
// naturally lands on the layer that's already on top, visually nearest the
// pointer). `raw` is whatever localStorage.getItem returned (string or
// null) -- same defensive JSON.parse + shape-check style as app.js's own
// loadProfilePrefs, so a corrupted or pre-layer-system localStorage value can
// never crash boot; it just falls back to these defaults.
export function parseLayerSettings(raw, layerIds, defaultNames) {
  const fallback = {
    selected: layerIds[layerIds.length - 1],
    names: { ...defaultNames },
    hidden: {},
  };
  if (!raw) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object") return fallback;
  const names = { ...defaultNames };
  if (parsed.names && typeof parsed.names === "object") {
    for (const id of layerIds) {
      if (typeof parsed.names[id] === "string" && parsed.names[id].trim().length > 0) {
        names[id] = parsed.names[id];
      }
    }
  }
  const hidden = {};
  if (parsed.hidden && typeof parsed.hidden === "object") {
    for (const id of layerIds) {
      if (parsed.hidden[id]) hidden[id] = true;
    }
  }
  // Safe fallback if the saved selection no longer names one of this
  // canvas's current layers (e.g. a stale value from before this code
  // existed, or local corruption) -- never an invalid/missing active layer.
  const selected = typeof parsed.selected === "string" && layerIds.includes(parsed.selected)
    ? parsed.selected
    : fallback.selected;
  return { selected, names, hidden };
}
