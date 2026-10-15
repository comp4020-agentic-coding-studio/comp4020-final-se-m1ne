// The established custom-colour interaction (preset swatches, the integrated
// Hue-ring + SV-square wheel, RGB/HSV sliders and numeric inputs), extracted
// unchanged from its original pre-Step-5 home in public/app.js so BOTH the
// legacy freehand editor and the pixel editor wire up the exact same
// control, never two competing colour-selection systems. Every function body
// below is the original logic verbatim; the only thing that changed is that
// `color`/`brushColor`/`pickerHue` are now this factory's own closure state
// (via initColourPicker) instead of public/app.js's module-level variables,
// and a colour change now reaches the caller through `onChange(hex)` instead
// of writing directly to a shared module-level `color`.
//
// initColourPicker wires every DOM element below by the exact same ids
// public/index.html already has (#colour-current, #edit-colour-button,
// #colour-popover and its children, the preset swatches) -- there is exactly
// one copy of this markup on the page, and exactly one of public/app.js or
// public/pixel-editor.js ever runs on a given page load, so there is never a
// double-registration conflict.

import { clampByte, clampPercent, hexToRgb, hsvToRgb, nextPickerHue, normalizeHue, rgbToHex, rgbToHsv } from "./colour.js";

/**
 * @param {Object} options
 * @param {string} [options.initialColor]
 * @param {(hex: string) => void} [options.onChange] called whenever the live colour changes, from any source
 * @returns {{ setColor(hex: string): void }}
 */
export function initColourPicker({ initialColor = "#1d1d1d", onChange } = {}) {
  const colourCurrent = document.getElementById("colour-current");
  const editColourButton = document.getElementById("edit-colour-button");
  const colourPopover = document.getElementById("colour-popover");
  const colourPopoverClose = document.getElementById("colour-popover-close");
  const colourWheelCanvas = document.getElementById("colour-wheel");
  // getContext("2d") is guarded throughout below rather than assumed: every
  // real browser returns a context here, but a DOM-only test environment
  // without canvas rendering support may return null -- guarding this is a
  // no-op in production and is what keeps the non-canvas parts of this
  // module (colour state, swatches, sliders, popover visibility) testable
  // without pulling in a canvas-rendering dependency.
  const colourWheelCtx = colourWheelCanvas.getContext("2d");
  const colourPreviewSwatch = document.getElementById("colour-preview-swatch");
  const colourPreviewHex = document.getElementById("colour-preview-hex");
  const rgbRSlider = document.getElementById("rgb-r-slider");
  const rgbRNumber = document.getElementById("rgb-r-number");
  const rgbGSlider = document.getElementById("rgb-g-slider");
  const rgbGNumber = document.getElementById("rgb-g-number");
  const rgbBSlider = document.getElementById("rgb-b-slider");
  const rgbBNumber = document.getElementById("rgb-b-number");
  const hsvHSlider = document.getElementById("hsv-h-slider");
  const hsvHNumber = document.getElementById("hsv-h-number");
  const hsvSSlider = document.getElementById("hsv-s-slider");
  const hsvSNumber = document.getElementById("hsv-s-number");
  const hsvVSlider = document.getElementById("hsv-v-slider");
  const hsvVNumber = document.getElementById("hsv-v-number");

  let color = initialColor;
  let brushColor = hexToRgb(color) ?? { r: 29, g: 29, b: 29 };
  let pickerHue = rgbToHsv(brushColor).h;

  // Logical (CSS-pixel) geometry, fixed by the markup's width="180" attribute.
  // Read before the backing-store resize below overwrites the width property.
  const WHEEL_SIZE = colourWheelCanvas.width;
  const WHEEL_CENTER = WHEEL_SIZE / 2;
  const WHEEL_OUTER_RADIUS = WHEEL_CENTER - 2;
  const WHEEL_RING_THICKNESS = 18;
  const WHEEL_INNER_RADIUS = WHEEL_OUTER_RADIUS - WHEEL_RING_THICKNESS;
  const WHEEL_SQUARE_HALF = (WHEEL_INNER_RADIUS - 4) / Math.SQRT2; // inscribed so corners stay clear of the ring

  // Backing store scaled for crisp rendering on high-DPI screens. Every
  // drawing coordinate from here on stays in the logical WHEEL_SIZE-by-
  // WHEEL_SIZE space (via colourWheelCtx.setTransform); pointer handling maps
  // client coordinates through the canvas's CSS-pixel bounding rect, which is
  // always that same logical space regardless of backing-store scale.
  if (colourWheelCtx) {
    const wheelDpr = window.devicePixelRatio || 1;
    colourWheelCanvas.width = WHEEL_SIZE * wheelDpr;
    colourWheelCanvas.height = WHEEL_SIZE * wheelDpr;
    colourWheelCanvas.style.width = `${WHEEL_SIZE}px`;
    colourWheelCanvas.style.height = `${WHEEL_SIZE}px`;
    colourWheelCtx.setTransform(wheelDpr, 0, 0, wheelDpr, 0, 0);
  }

  let hueRingImage = null; // cached static ring render -- fixed geometry, never depends on the current colour

  function renderHueRing() {
    if (!colourWheelCtx) return;
    const ringCanvas = document.createElement("canvas");
    ringCanvas.width = WHEEL_SIZE;
    ringCanvas.height = WHEEL_SIZE;
    const rctx = ringCanvas.getContext("2d");
    if (!rctx) return;
    const steps = 360;
    for (let i = 0; i < steps; i++) {
      const h0 = (i / steps) * 360;
      const h1 = ((i + 1) / steps) * 360;
      const { r, g, b } = hsvToRgb({ h: (h0 + h1) / 2, s: 100, v: 100 });
      rctx.beginPath();
      rctx.moveTo(WHEEL_CENTER, WHEEL_CENTER);
      rctx.arc(WHEEL_CENTER, WHEEL_CENTER, WHEEL_OUTER_RADIUS, (h0 * Math.PI) / 180, (h1 * Math.PI) / 180);
      rctx.closePath();
      rctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      rctx.fill();
    }
    // Punch out the centre, leaving just the ring band -- this destination-out
    // only ever touches this throwaway offscreen canvas, never the shared
    // drawing canvas or either of its contexts.
    rctx.globalCompositeOperation = "destination-out";
    rctx.beginPath();
    rctx.arc(WHEEL_CENTER, WHEEL_CENTER, WHEEL_INNER_RADIUS, 0, Math.PI * 2);
    rctx.fill();
    rctx.globalCompositeOperation = "source-over";
    hueRingImage = ringCanvas;
  }

  function drawMarker(x, y) {
    if (!colourWheelCtx) return;
    colourWheelCtx.beginPath();
    colourWheelCtx.arc(x, y, 5, 0, Math.PI * 2);
    colourWheelCtx.strokeStyle = "#ffffff";
    colourWheelCtx.lineWidth = 2;
    colourWheelCtx.stroke();
    colourWheelCtx.beginPath();
    colourWheelCtx.arc(x, y, 5, 0, Math.PI * 2);
    colourWheelCtx.strokeStyle = "#1d1d1d";
    colourWheelCtx.lineWidth = 1;
    colourWheelCtx.stroke();
  }

  function renderColourWheel() {
    if (!colourWheelCtx) return;
    if (!hueRingImage) renderHueRing();
    colourWheelCtx.clearRect(0, 0, WHEEL_SIZE, WHEEL_SIZE);
    if (hueRingImage) colourWheelCtx.drawImage(hueRingImage, 0, 0, WHEEL_SIZE, WHEEL_SIZE);

    // SV square: solid hue fill, then a white-to-transparent horizontal
    // gradient (saturation) and a transparent-to-black vertical gradient
    // (value) layered on top -- the standard three-fill way to render one.
    const left = WHEEL_CENTER - WHEEL_SQUARE_HALF;
    const top = WHEEL_CENTER - WHEEL_SQUARE_HALF;
    const side = WHEEL_SQUARE_HALF * 2;
    const pureHue = hsvToRgb({ h: pickerHue, s: 100, v: 100 });

    colourWheelCtx.fillStyle = `rgb(${pureHue.r}, ${pureHue.g}, ${pureHue.b})`;
    colourWheelCtx.fillRect(left, top, side, side);

    const satGradient = colourWheelCtx.createLinearGradient(left, 0, left + side, 0);
    satGradient.addColorStop(0, "rgba(255,255,255,1)");
    satGradient.addColorStop(1, "rgba(255,255,255,0)");
    colourWheelCtx.fillStyle = satGradient;
    colourWheelCtx.fillRect(left, top, side, side);

    const valGradient = colourWheelCtx.createLinearGradient(0, top, 0, top + side);
    valGradient.addColorStop(0, "rgba(0,0,0,0)");
    valGradient.addColorStop(1, "rgba(0,0,0,1)");
    colourWheelCtx.fillStyle = valGradient;
    colourWheelCtx.fillRect(left, top, side, side);

    // Hue marker, on the ring at the retained hue.
    const hueAngle = (pickerHue * Math.PI) / 180;
    const hueMarkerRadius = (WHEEL_INNER_RADIUS + WHEEL_OUTER_RADIUS) / 2;
    drawMarker(WHEEL_CENTER + Math.cos(hueAngle) * hueMarkerRadius, WHEEL_CENTER + Math.sin(hueAngle) * hueMarkerRadius);

    // SV marker: horizontal = saturation, vertical = value with top = high
    // value (matches applySvFromPoint's own mapping below).
    const hsv = rgbToHsv(brushColor);
    drawMarker(left + (hsv.s / 100) * side, top + (1 - hsv.v / 100) * side);
  }

  // Which region a drag started in, held for the whole gesture so dragging
  // past the control's edge keeps adjusting the same thing instead of
  // jumping between hue and SV mid-drag.
  let wheelDragMode = null; // "hue" | "sv" | null

  function wheelLocalPoint(event) {
    const rect = colourWheelCanvas.getBoundingClientRect();
    return { x: event.clientX - rect.left - WHEEL_CENTER, y: event.clientY - rect.top - WHEEL_CENTER };
  }

  function applyHueFromPoint(x, y) {
    let degrees = (Math.atan2(y, x) * 180) / Math.PI;
    if (degrees < 0) degrees += 360;
    pickerHue = degrees; // explicit hue edit: always adopted, regardless of resulting saturation
    const hsv = rgbToHsv(brushColor);
    setBrushColorFromHsv({ h: pickerHue, s: hsv.s, v: hsv.v });
  }

  function applySvFromPoint(x, y) {
    const cx = Math.min(WHEEL_SQUARE_HALF, Math.max(-WHEEL_SQUARE_HALF, x));
    const cy = Math.min(WHEEL_SQUARE_HALF, Math.max(-WHEEL_SQUARE_HALF, y));
    const s = ((cx + WHEEL_SQUARE_HALF) / (WHEEL_SQUARE_HALF * 2)) * 100;
    const v = (1 - (cy + WHEEL_SQUARE_HALF) / (WHEEL_SQUARE_HALF * 2)) * 100;
    setBrushColorFromHsv({ h: pickerHue, s, v });
  }

  colourWheelCanvas.addEventListener("pointerdown", (event) => {
    colourWheelCanvas.setPointerCapture(event.pointerId);
    const { x, y } = wheelLocalPoint(event);
    if (Math.abs(x) <= WHEEL_SQUARE_HALF && Math.abs(y) <= WHEEL_SQUARE_HALF) {
      wheelDragMode = "sv";
      applySvFromPoint(x, y);
    } else if (Math.hypot(x, y) <= WHEEL_OUTER_RADIUS) {
      wheelDragMode = "hue";
      applyHueFromPoint(x, y);
    } else {
      wheelDragMode = null;
    }
  });

  colourWheelCanvas.addEventListener("pointermove", (event) => {
    if (!wheelDragMode) return;
    const { x, y } = wheelLocalPoint(event);
    if (wheelDragMode === "hue") applyHueFromPoint(x, y);
    else applySvFromPoint(x, y);
  });

  function endWheelDrag() {
    wheelDragMode = null;
  }
  colourWheelCanvas.addEventListener("pointerup", endWheelDrag);
  colourWheelCanvas.addEventListener("pointercancel", endWheelDrag);

  function setBrushColorFromRgb(rgb) {
    brushColor = { r: clampByte(rgb.r), g: clampByte(rgb.g), b: clampByte(rgb.b) };
    color = rgbToHex(brushColor);
    pickerHue = nextPickerHue(pickerHue, rgbToHsv(brushColor));
    syncColourUI();
    onChange?.(color);
  }

  function setBrushColorFromHsv(hsv) {
    brushColor = hsvToRgb(hsv);
    color = rgbToHex(brushColor);
    syncColourUI();
    onChange?.(color);
  }

  function selectSwatch(swatch) {
    document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
    swatch.classList.add("selected");
  }

  // Whichever preset swatch matches the live brush colour stays visually
  // "selected"; anything typed or dragged in via the popover that doesn't
  // exactly match a preset simply leaves no preset selected.
  function syncSelectedSwatch() {
    const presetMatch = Array.from(document.querySelectorAll(".swatch[data-color]")).find(
      (s) => s.dataset.color.toLowerCase() === color,
    );
    document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
    if (presetMatch) selectSwatch(presetMatch);
  }

  function setSliderGradient(slider, startRgb, endRgb) {
    slider.style.setProperty("--grad-start", rgbToHex(startRgb));
    slider.style.setProperty("--grad-end", rgbToHex(endRgb));
  }

  // The only place any colour control's value is written -- always via
  // direct property assignment, never .dispatchEvent, so writing a value back
  // here can never itself re-trigger the "input" listener that led here.
  function syncColourUI() {
    const hsv = rgbToHsv(brushColor);
    colourCurrent.style.background = color;
    syncSelectedSwatch();
    colourPreviewSwatch.style.background = color;
    colourPreviewHex.textContent = color;

    rgbRSlider.value = String(brushColor.r);
    rgbRNumber.value = String(brushColor.r);
    rgbGSlider.value = String(brushColor.g);
    rgbGNumber.value = String(brushColor.g);
    rgbBSlider.value = String(brushColor.b);
    rgbBNumber.value = String(brushColor.b);

    // H always reflects the retained pickerHue, not rgbToHsv(brushColor).h --
    // at s=0 the latter is arbitrary (grey has no hue).
    hsvHSlider.value = String(Math.round(pickerHue));
    hsvHNumber.value = String(Math.round(pickerHue));
    hsvSSlider.value = String(Math.round(hsv.s));
    hsvSNumber.value = String(Math.round(hsv.s));
    hsvVSlider.value = String(Math.round(hsv.v));
    hsvVNumber.value = String(Math.round(hsv.v));

    setSliderGradient(rgbRSlider, { r: 0, g: brushColor.g, b: brushColor.b }, { r: 255, g: brushColor.g, b: brushColor.b });
    setSliderGradient(rgbGSlider, { r: brushColor.r, g: 0, b: brushColor.b }, { r: brushColor.r, g: 255, b: brushColor.b });
    setSliderGradient(rgbBSlider, { r: brushColor.r, g: brushColor.g, b: 0 }, { r: brushColor.r, g: brushColor.g, b: 255 });
    setSliderGradient(hsvSSlider, hsvToRgb({ h: pickerHue, s: 0, v: hsv.v }), hsvToRgb({ h: pickerHue, s: 100, v: hsv.v }));
    setSliderGradient(hsvVSlider, hsvToRgb({ h: pickerHue, s: hsv.s, v: 0 }), hsvToRgb({ h: pickerHue, s: hsv.s, v: 100 }));

    if (!colourPopover.hidden) renderColourWheel();
  }

  function openColourPopover() {
    const rect = editColourButton.getBoundingClientRect();
    const popoverWidth = 232;
    colourPopover.hidden = false;
    // Keep the whole popup inside the viewport: below the button if it fits,
    // else above it, else pinned to the viewport edge (CSS max-height then
    // scrolls it internally).
    const margin = 8;
    const height = Math.min(colourPopover.offsetHeight, window.innerHeight - margin * 2);
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin) {
      top = rect.top - 6 - height >= margin ? rect.top - 6 - height : Math.max(margin, window.innerHeight - margin - height);
    }
    colourPopover.style.top = `${top}px`;
    colourPopover.style.left = `${Math.min(rect.left, window.innerWidth - popoverWidth - margin)}px`;
    editColourButton.setAttribute("aria-expanded", "true");
    renderColourWheel();
  }

  function closeColourPopover() {
    colourPopover.hidden = true;
    editColourButton.setAttribute("aria-expanded", "false");
  }

  editColourButton.addEventListener("click", () => {
    if (colourPopover.hidden) openColourPopover();
    else closeColourPopover();
  });

  colourPopoverClose.addEventListener("click", closeColourPopover);

  // Outside-click close: a pointerdown already in flight when the popover
  // first opens can't reach here before `hidden` is set (click fires after
  // pointerdown), so opening and closing never race each other.
  document.addEventListener("pointerdown", (event) => {
    if (colourPopover.hidden) return;
    if (colourPopover.contains(event.target) || editColourButton.contains(event.target)) return;
    closeColourPopover();
  });

  window.addEventListener("keydown", (event) => {
    if (!colourPopover.hidden && event.key === "Escape") closeColourPopover();
  });

  function wireRgbChannel(slider, number, key) {
    const commit = (value) => setBrushColorFromRgb({ ...brushColor, [key]: clampByte(Number(value)) });
    slider.addEventListener("input", () => commit(slider.value));
    number.addEventListener("input", () => commit(number.value));
  }
  wireRgbChannel(rgbRSlider, rgbRNumber, "r");
  wireRgbChannel(rgbGSlider, rgbGNumber, "g");
  wireRgbChannel(rgbBSlider, rgbBNumber, "b");

  function currentHsv() {
    return rgbToHsv(brushColor);
  }

  hsvHSlider.addEventListener("input", () => {
    pickerHue = normalizeHue(Number(hsvHSlider.value));
    const hsv = currentHsv();
    setBrushColorFromHsv({ h: pickerHue, s: hsv.s, v: hsv.v });
  });
  hsvHNumber.addEventListener("input", () => {
    pickerHue = normalizeHue(Number(hsvHNumber.value));
    const hsv = currentHsv();
    setBrushColorFromHsv({ h: pickerHue, s: hsv.s, v: hsv.v });
  });
  hsvSSlider.addEventListener("input", () => {
    setBrushColorFromHsv({ h: pickerHue, s: clampPercent(Number(hsvSSlider.value)), v: currentHsv().v });
  });
  hsvSNumber.addEventListener("input", () => {
    setBrushColorFromHsv({ h: pickerHue, s: clampPercent(Number(hsvSNumber.value)), v: currentHsv().v });
  });
  hsvVSlider.addEventListener("input", () => {
    setBrushColorFromHsv({ h: pickerHue, s: currentHsv().s, v: clampPercent(Number(hsvVSlider.value)) });
  });
  hsvVNumber.addEventListener("input", () => {
    setBrushColorFromHsv({ h: pickerHue, s: currentHsv().s, v: clampPercent(Number(hsvVNumber.value)) });
  });

  for (const swatch of document.querySelectorAll(".swatch[data-color]")) {
    swatch.addEventListener("click", () => {
      const rgb = hexToRgb(swatch.dataset.color);
      if (!rgb) return; // malformed preset data-color -- ignore rather than crash
      setBrushColorFromRgb(rgb);
    });
  }

  syncColourUI();

  return {
    // Sets the live colour from any caller (the Eyedropper, a future
    // integration) -- funnels through the exact same path a swatch click or
    // slider edit would, so the popover/preview/sliders/selected-swatch all
    // stay in sync and onChange fires exactly once, consistently.
    setColor(hex) {
      const rgb = hexToRgb(hex);
      if (!rgb) return;
      setBrushColorFromRgb(rgb);
    },
  };
}
