// Pure document/workspace math for the fixed-document milestone: document
// pixel space, zoom, Fit, and cursor scaling. No DOM dependency, so these are
// unit-testable the same way colour.js/fade.js/sampling.js already are.
// Every export here is called directly by public/app.js -- nothing below
// exists solely so a test has something to call.

export const DOCUMENT_WIDTH = 1920;
export const DOCUMENT_HEIGHT = 1080;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

// Named zoom levels Zoom In/Out step through (see stepZoom), and what the
// status bar's percentage display corresponds to at rest.
export const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function clampZoom(zoom, minZoom = MIN_ZOOM, maxZoom = MAX_ZOOM) {
  return Math.min(maxZoom, Math.max(minZoom, zoom));
}

// Client (CSS pixel) pointer position -> normalized [0,1] point, relative to
// the canvas's own rendered CSS box. `rect` (canvas.getBoundingClientRect())
// already reflects the canvas's current CSS display size -- which changes
// with zoom, since zoom resizes canvas.style.width/height, not a transform --
// and its position within the scrolled workspace viewport -- which changes
// with pan. So this one formula is correct at every zoom level and every pan
// offset without zoom/pan ever appearing as an explicit parameter.
export function cssPointToNormalized(clientX, clientY, rect) {
  return {
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
}

// Normalized [0,1] point -> document-pixel point, in the fixed 1920x1080
// document space -- the backing store's own pixel coordinates, unaffected by
// zoom, pan, DPR, or theme.
export function documentPointToPixel(point, docWidth = DOCUMENT_WIDTH, docHeight = DOCUMENT_HEIGHT) {
  return { x: point.x * docWidth, y: point.y * docHeight };
}

// Normalized brush/eraser size (persisted, relative to document width) -> an
// absolute document-pixel stroke width. Shared by every place that expands a
// stored or in-progress size for rendering, so the formula exists once.
export function brushSizeToDocumentPx(sizeNormalized, docWidth = DOCUMENT_WIDTH) {
  return sizeNormalized * docWidth;
}

// A tool's on-canvas diameter is defined in document pixels (brushSizePx/
// eraserSizePx); the circular cursor overlay is CSS-pixel chrome drawn over
// the workspace, so it must be scaled by the document's current zoom to
// visually match the footprint that will actually be painted.
export function cursorDiameterCssPx(toolDiameterDocumentPx, zoom) {
  return toolDiameterDocumentPx * zoom;
}

// One-shot "fit the whole document inside the available workspace" zoom.
// Always a single scalar applied to both axes -- whichever axis is more
// constraining -- so the document's own aspect ratio is never distorted.
export function fitZoom(
  viewportWidth,
  viewportHeight,
  docWidth = DOCUMENT_WIDTH,
  docHeight = DOCUMENT_HEIGHT,
  marginPx = 0,
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
) {
  const availableWidth = Math.max(0, viewportWidth - 2 * marginPx);
  const availableHeight = Math.max(0, viewportHeight - 2 * marginPx);
  return clampZoom(Math.min(availableWidth / docWidth, availableHeight / docHeight), minZoom, maxZoom);
}

// Zoom In/Out button logic. `levels` is sorted ascending. Moving away from an
// intermediate Fit zoom (not itself one of `levels`) lands on the next named
// level in the requested direction -- no special case is needed, because
// "next level strictly greater/lower than current" already means the same
// thing whether current started on a named level or in between two of them.
// Clamped at the ends of `levels` rather than wrapping. A small epsilon
// guards against float drift (e.g. a zoom value produced by `* 100` math).
export function stepZoom(currentZoom, levels = ZOOM_LEVELS, direction) {
  const EPSILON = 1e-9;
  if (direction > 0) {
    const next = levels.find((level) => level > currentZoom + EPSILON);
    return next ?? levels[levels.length - 1];
  }
  if (direction < 0) {
    for (let i = levels.length - 1; i >= 0; i--) {
      if (levels[i] < currentZoom - EPSILON) return levels[i];
    }
    return levels[0];
  }
  return currentZoom;
}
