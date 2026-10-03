import { describe, expect, it } from "vitest";
import {
  DOCUMENT_WIDTH,
  DOCUMENT_HEIGHT,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_LEVELS,
  clampZoom,
  cssPointToNormalized,
  documentPointToPixel,
  brushSizeToDocumentPx,
  cursorDiameterCssPx,
  fitZoom,
  stepZoom,
} from "../public/viewport.js";

describe("cssPointToNormalized + documentPointToPixel (pointer/document coordinate pipeline)", () => {
  it("maps the canvas's own top-left/centre/bottom-right at 100% zoom (rect == document size)", () => {
    const rect = { left: 0, top: 0, width: 1920, height: 1080 };
    expect(cssPointToNormalized(0, 0, rect)).toEqual({ x: 0, y: 0 });
    expect(cssPointToNormalized(960, 540, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(cssPointToNormalized(1920, 1080, rect)).toEqual({ x: 1, y: 1 });
  });

  it("stays correct at 50% zoom, where the rendered CSS box is half the document size", () => {
    const rect = { left: 0, top: 0, width: 960, height: 540 };
    const normalized = cssPointToNormalized(480, 270, rect);
    expect(normalized).toEqual({ x: 0.5, y: 0.5 });
    expect(documentPointToPixel(normalized, DOCUMENT_WIDTH, DOCUMENT_HEIGHT)).toEqual({ x: 960, y: 540 });
  });

  it("stays correct at 200% zoom, where the rendered CSS box is double the document size", () => {
    const rect = { left: 0, top: 0, width: 3840, height: 2160 };
    const normalized = cssPointToNormalized(1920, 1080, rect);
    expect(normalized).toEqual({ x: 0.5, y: 0.5 });
    expect(documentPointToPixel(normalized, DOCUMENT_WIDTH, DOCUMENT_HEIGHT)).toEqual({ x: 960, y: 540 });
  });

  it("accounts for the rect's own position, so panning/scrolling the viewport doesn't shift the result", () => {
    // A panned/scrolled viewport moves the canvas's getBoundingClientRect
    // origin, but a click on the same document point must still resolve to
    // the same normalized point.
    const rect = { left: -200, top: -150, width: 1920, height: 1080 };
    const normalized = cssPointToNormalized(760, 390, rect);
    expect(normalized).toEqual({ x: 0.5, y: 0.5 });
    expect(documentPointToPixel(normalized, DOCUMENT_WIDTH, DOCUMENT_HEIGHT)).toEqual({ x: 960, y: 540 });
  });

  it("documentPointToPixel is the exact inverse scaling of a normalized point regardless of zoom/pan", () => {
    // This is what guarantees the Eyedropper samples the same document pixel
    // no matter what zoom/pan the pointer event arrived under.
    const point = { x: 0.25, y: 0.75 };
    expect(documentPointToPixel(point, DOCUMENT_WIDTH, DOCUMENT_HEIGHT)).toEqual({ x: 480, y: 810 });
  });
});

describe("brushSizeToDocumentPx", () => {
  it("scales a normalized size against the document width", () => {
    expect(brushSizeToDocumentPx(0.5, DOCUMENT_WIDTH)).toBeCloseTo(960);
    expect(brushSizeToDocumentPx(1, DOCUMENT_WIDTH)).toBe(DOCUMENT_WIDTH);
    expect(brushSizeToDocumentPx(0, DOCUMENT_WIDTH)).toBe(0);
  });
});

describe("cursorDiameterCssPx", () => {
  it("scales a document-pixel tool diameter by the current zoom", () => {
    expect(cursorDiameterCssPx(40, 1)).toBe(40);
    expect(cursorDiameterCssPx(40, 0.5)).toBe(20);
    expect(cursorDiameterCssPx(40, 2)).toBe(80);
  });
});

describe("fitZoom", () => {
  it("picks the width-constraining zoom for a wide viewport", () => {
    // 16:9 viewport, wider than the document -- height is the binding
    // constraint.
    expect(fitZoom(3840, 1080, DOCUMENT_WIDTH, DOCUMENT_HEIGHT, 0)).toBeCloseTo(1);
  });

  it("picks the height-constraining zoom for a tall/narrow viewport", () => {
    expect(fitZoom(960, 2160, DOCUMENT_WIDTH, DOCUMENT_HEIGHT, 0)).toBeCloseTo(0.5);
  });

  it("never distorts the document's 16:9 aspect ratio -- always one scalar on both axes", () => {
    const zoom = fitZoom(1200, 900, DOCUMENT_WIDTH, DOCUMENT_HEIGHT, 0);
    const width = DOCUMENT_WIDTH * zoom;
    const height = DOCUMENT_HEIGHT * zoom;
    expect(width / height).toBeCloseTo(DOCUMENT_WIDTH / DOCUMENT_HEIGHT);
  });

  it("subtracts the margin from both sides of the available space before fitting", () => {
    // availableWidth = 1920 - 2*24 = 1872; availableHeight = 1080 - 2*24 = 1032
    // width/1920 = 0.975; height/1080 = 0.9555...; height is binding.
    const zoom = fitZoom(1920, 1080, DOCUMENT_WIDTH, DOCUMENT_HEIGHT, 24);
    expect(zoom).toBeCloseTo(1032 / 1080);
  });

  it("clamps the result to the zoom range for a very small or very large viewport", () => {
    expect(fitZoom(10, 10, DOCUMENT_WIDTH, DOCUMENT_HEIGHT, 0, MIN_ZOOM, MAX_ZOOM)).toBe(MIN_ZOOM);
    expect(fitZoom(100000, 100000, DOCUMENT_WIDTH, DOCUMENT_HEIGHT, 0, MIN_ZOOM, MAX_ZOOM)).toBe(MAX_ZOOM);
  });

  it("never returns a negative zoom when the margin exceeds the viewport", () => {
    expect(fitZoom(20, 20, DOCUMENT_WIDTH, DOCUMENT_HEIGHT, 100, MIN_ZOOM, MAX_ZOOM)).toBe(MIN_ZOOM);
  });
});

describe("clampZoom", () => {
  it("passes values already inside the range through unchanged", () => {
    expect(clampZoom(1, MIN_ZOOM, MAX_ZOOM)).toBe(1);
  });

  it("clamps at the minimum and maximum boundaries", () => {
    expect(clampZoom(0.1, MIN_ZOOM, MAX_ZOOM)).toBe(MIN_ZOOM);
    expect(clampZoom(10, MIN_ZOOM, MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(clampZoom(MIN_ZOOM, MIN_ZOOM, MAX_ZOOM)).toBe(MIN_ZOOM);
    expect(clampZoom(MAX_ZOOM, MIN_ZOOM, MAX_ZOOM)).toBe(MAX_ZOOM);
  });
});

describe("stepZoom (Zoom In/Out named-level stepping)", () => {
  it("steps up/down through named levels from an exact level", () => {
    expect(stepZoom(1, ZOOM_LEVELS, 1)).toBe(1.5);
    expect(stepZoom(1, ZOOM_LEVELS, -1)).toBe(0.75);
  });

  it("from an intermediate (e.g. Fit) zoom, Zoom In picks the next level greater than current", () => {
    expect(stepZoom(0.6, ZOOM_LEVELS, 1)).toBe(0.75);
  });

  it("from an intermediate (e.g. Fit) zoom, Zoom Out picks the next level lower than current", () => {
    expect(stepZoom(0.6, ZOOM_LEVELS, -1)).toBe(0.5);
  });

  it("clamps at the top of the named levels instead of wrapping", () => {
    expect(stepZoom(4, ZOOM_LEVELS, 1)).toBe(4);
    expect(stepZoom(3.5, ZOOM_LEVELS, 1)).toBe(4);
  });

  it("clamps at the bottom of the named levels instead of wrapping", () => {
    expect(stepZoom(0.25, ZOOM_LEVELS, -1)).toBe(0.25);
    expect(stepZoom(0.3, ZOOM_LEVELS, -1)).toBe(0.25);
  });
});
