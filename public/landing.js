// Landing page: a live, read-only preview of Public Canvas plus "Enter
// Canvas" and the one-time guest onboarding modal. See public/landing-canvas.js
// for why this is a separate, reduced renderer rather than importing
// public/app.js directly (that file is the full interactive editor and would
// crash immediately against this page's much smaller DOM, besides risking
// making the background secretly interactive).
import { createPublicCanvasRenderer } from "./landing-canvas.js";
import { renderAboutContent } from "./about-content.js";

const canvas = document.getElementById("landing-canvas");
const enterButton = document.getElementById("enter-canvas-button");
const onlineCountEl = document.getElementById("online-count");
const onboardingOverlay = document.getElementById("onboarding-overlay");
const onboardingAbout = document.getElementById("onboarding-about");
const onboardingNicknameInput = document.getElementById("onboarding-nickname-input");
const onboardingColourInput = document.getElementById("onboarding-colour-input");
const onboardingStartButton = document.getElementById("onboarding-start-button");

onboardingAbout.appendChild(renderAboutContent());

// --- Read-only live background ----------------------------------------------
// Fitting the fixed 1920x1080 document to the viewport without stretching
// (cropping where needed) is handled entirely by CSS object-fit: cover on
// #landing-canvas (see landing.css) -- the canvas's backing store
// (canvas.width/height, set once in createPublicCanvasRenderer) never
// changes, exactly like public/app.js's own zoom never touches it either, so
// there is no resize-driven JS needed here at all.
const renderer = createPublicCanvasRenderer(canvas);

function startCanvasSync() {
  const source = new EventSource("/api/ops/stream");

  source.addEventListener("sync", (event) => {
    const data = JSON.parse(event.data);
    renderer.applySync(data.ops);
    if (typeof data.onlineCount === "number") setOnlineCount(data.onlineCount);
  });
  source.addEventListener("op", (event) => renderer.applyOp(JSON.parse(event.data)));
  source.addEventListener("undo", (event) => renderer.applyUndo(JSON.parse(event.data)));
  source.addEventListener("redo", (event) => renderer.applyRedo(JSON.parse(event.data)));
  // Public's own "Online Now" count, pushed over this exact same stream
  // (server/index.js's /api/presence/heartbeat and /leave routes) rather
  // than polled separately -- one connection, one source of live updates.
  source.addEventListener("presence", (event) => setOnlineCount(JSON.parse(event.data).count));
  // cursor/cursor-hide/stroke/stroke-end events exist on this same stream
  // for the interactive editor's own remote cursors and in-progress stroke
  // previews -- this page has no such UI at all (it is read-only ambient
  // background, not the editor), so they are simply never listened for here.

  // Deliberately no onerror/reconnect handling, same reasoning as
  // public/app.js's own startRealtimeSync: EventSource retries natively, and
  // every retry gets an equally fresh, authoritative `sync` snapshot.
}

function setOnlineCount(count) {
  onlineCountEl.textContent = String(count);
}

// --- "Online Now" presence --------------------------------------------------
// A lease exactly like a Private Room's own (public/app.js's
// startPresence/sendHeartbeat), just scoped to Public via a dedicated pair of
// routes (server/index.js's /api/presence/heartbeat, /api/presence/leave --
// server/db.js's recordPublicHeartbeat/leavePublicPresence) instead of a room
// code, since Public has no room row to heartbeat against. Counts this tab
// itself as "online now" along with everyone else -- intentional: if this is
// the only visitor on the whole site, the counter should read 1, not 0.
const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000; // same cadence as every other presence lease in this app
let presenceId = null;
let heartbeatHandle = null;

async function sendHeartbeat() {
  try {
    const res = await fetch("/api/presence/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presenceId }),
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.count === "number") setOnlineCount(data.count);
    }
  } catch {
    // best-effort, same spirit as every other heartbeat in this codebase --
    // a missed beat just lets this lease go stale sooner, corrected by the
    // next successful one.
  }
}

function startPresence() {
  presenceId = crypto.randomUUID();
  sendHeartbeat();
  heartbeatHandle = setInterval(sendHeartbeat, PRESENCE_HEARTBEAT_INTERVAL_MS);
}

// Best-effort proactive leave on navigation/tab close -- sendBeacon (not
// fetch) because the page may already be unloading by the time this runs, and
// a Blob with an explicit JSON content type is required for Express's
// express.json() to actually parse the body (sendBeacon's own default content
// type is text/plain, which express.json() ignores). The lease simply going
// stale (STALE_TIMEOUT_MS, server/db.js) is still the correctness fallback if
// this never fires at all -- a closed tab, a crash, a lost network.
function leavePresenceBestEffort() {
  if (!presenceId || typeof navigator.sendBeacon !== "function") return;
  try {
    navigator.sendBeacon("/api/presence/leave", new Blob([JSON.stringify({ presenceId })], { type: "application/json" }));
  } catch {
    // best-effort
  }
  if (heartbeatHandle !== null) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
}

window.addEventListener("pagehide", leavePresenceBestEffort);

// --- Enter Canvas / guest onboarding -----------------------------------------
// Reuses the exact same server-side guest profile GET /api/me's nickname
// already distinguishes "new" (null) from "returning" (set) -- the same
// signal public/app.js's own maybeShowGuestSetup checks, which stays as a
// safety net for anyone who lands on /canvas directly without ever visiting
// this page at all.
function goToCanvas() {
  location.href = "/canvas";
}

async function handleEnterCanvas() {
  let me;
  try {
    const res = await fetch("/api/me");
    me = await res.json();
  } catch {
    // Can't tell new from returning -- fail open to the editor itself, which
    // has its own guest-setup fallback (public/app.js's maybeShowGuestSetup)
    // if a profile turns out not to exist after all.
    goToCanvas();
    return;
  }
  if (me.nickname === null) {
    onboardingColourInput.value = me.cursorColor ?? "#1e88e5";
    onboardingOverlay.hidden = false;
  } else {
    goToCanvas();
  }
}

enterButton.addEventListener("click", handleEnterCanvas);

onboardingStartButton.addEventListener("click", async () => {
  const nickname = onboardingNicknameInput.value.trim();
  if (nickname.length === 0 || nickname.length > 20) return; // the input's own maxlength already stops longer input
  try {
    const res = await fetch("/api/me/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, cursorColor: onboardingColourInput.value }),
    });
    if (!res.ok) return;
  } catch {
    return;
  }
  goToCanvas();
});

startCanvasSync();
startPresence();
