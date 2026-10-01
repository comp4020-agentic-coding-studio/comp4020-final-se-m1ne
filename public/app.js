const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const customColorInput = document.getElementById("custom-color");
const sizeSlider = document.getElementById("brush-size-slider");
const sizeValue = document.getElementById("brush-size-value");

let strokes = [];
let color = "#1d1d1d";
let brushSizePx = Number(sizeSlider.value);
let current = null; // { color, width, points: [{x, y}] }, width normalized like points are

function resizeCanvas() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  redraw();
}

// Points are stored normalized to the canvas's own width/height at draw
// time, so redrawing at a different size (resize, or a different device)
// reproduces the same proportions rather than the same raw pixels.
function toNormalized(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
}

function toPixels(point) {
  return { x: point.x * canvas.width, y: point.y * canvas.height };
}

function drawStroke(stroke) {
  if (stroke.points.length === 0) return;

  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width * canvas.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const pixels = stroke.points.map(toPixels);
  ctx.beginPath();
  ctx.moveTo(pixels[0].x, pixels[0].y);
  for (const point of pixels.slice(1)) ctx.lineTo(point.x, point.y);
  if (pixels.length === 1) ctx.lineTo(pixels[0].x, pixels[0].y); // a tap: draw a dot
  ctx.stroke();
}

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const stroke of strokes) drawStroke(stroke);
  if (current) drawStroke(current);
}

async function loadStrokes() {
  const res = await fetch("/api/strokes");
  strokes = await res.json();
  redraw();
}

async function saveStroke(stroke) {
  await fetch("/api/strokes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ color: stroke.color, width: stroke.width, points: stroke.points }),
  });
}

function pointerPos(event) {
  return toNormalized(event.clientX, event.clientY);
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  current = { color, width: brushSizePx / canvas.width, points: [pointerPos(event)] };
  redraw();
});

canvas.addEventListener("pointermove", (event) => {
  if (!current) return;
  current.points.push(pointerPos(event));
  redraw();
});

function endStroke() {
  if (!current) return;
  const finished = current;
  current = null;
  strokes.push(finished);
  redraw();
  saveStroke(finished);
}

canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

function selectSwatch(swatch) {
  document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
  swatch.classList.add("selected");
}

for (const swatch of document.querySelectorAll(".swatch[data-color]")) {
  swatch.addEventListener("click", () => {
    color = swatch.dataset.color;
    selectSwatch(swatch);
  });
}

const customSwatch = customColorInput.closest(".swatch");
customSwatch.style.background = customColorInput.value;

customColorInput.addEventListener("input", () => {
  color = customColorInput.value;
  customSwatch.style.background = customColorInput.value;
  selectSwatch(customSwatch);
});

sizeSlider.addEventListener("input", () => {
  brushSizePx = Number(sizeSlider.value);
  sizeValue.textContent = `${brushSizePx}px`;
});

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
loadStrokes();
