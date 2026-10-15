// Landing page: a live, read-only preview of Public Canvas plus "Enter
// Canvas" and the one-time guest onboarding modal. See public/landing-canvas.js
// for why this is a separate, reduced renderer rather than importing
// public/app.js directly (that file is the full interactive editor and would
// crash immediately against this page's much smaller DOM, besides risking
// making the background secretly interactive).
import { createPublicCanvasRenderer } from "./landing-canvas.js";
import { renderAboutContent } from "./about-content.js";
import { installNavigationMarking, isNavigating, markNavigating, releasePreviousLease } from "./presence-handoff.js";

const canvas = document.getElementById("landing-canvas");
const enterButton = document.getElementById("enter-canvas-button");
const onlineCountEl = document.getElementById("online-count");
const totalVisitorsCountEl = document.getElementById("total-visitors-count");
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
    if (typeof data.totalVisitors === "number") setTotalVisitors(data.totalVisitors);
  });
  source.addEventListener("op", (event) => renderer.applyOp(JSON.parse(event.data)));
  source.addEventListener("undo", (event) => renderer.applyUndo(JSON.parse(event.data)));
  source.addEventListener("redo", (event) => renderer.applyRedo(JSON.parse(event.data)));
  // Site-wide "Online Now"/"Total Visitors" counts, pushed over this exact
  // same stream (server/index.js's broadcastOnlineCounts, called from every
  // presence-affecting route -- Public-scoped and room-scoped alike) rather
  // than polled separately -- one connection, one source of live updates.
  source.addEventListener("presence", (event) => {
    const data = JSON.parse(event.data);
    if (typeof data.onlineCount === "number") setOnlineCount(data.onlineCount);
    if (typeof data.totalVisitors === "number") setTotalVisitors(data.totalVisitors);
  });
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

function setTotalVisitors(count) {
  totalVisitorsCountEl.textContent = String(count);
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
      if (typeof data.onlineCount === "number") setOnlineCount(data.onlineCount);
      if (typeof data.totalVisitors === "number") setTotalVisitors(data.totalVisitors);
    }
  } catch {
    // best-effort, same spirit as every other heartbeat in this codebase --
    // a missed beat just lets this lease go stale sooner, corrected by the
    // next successful one.
  }
}

async function startPresence() {
  presenceId = crypto.randomUUID();
  heartbeatHandle = setInterval(sendHeartbeat, PRESENCE_HEARTBEAT_INTERVAL_MS);
  await sendHeartbeat();
  releasePreviousLease(presenceId);
}

// Best-effort proactive leave on navigation/tab close -- sendBeacon (not
// fetch) because the page may already be unloading by the time this runs, and
// a Blob with an explicit JSON content type is required for Express's
// express.json() to actually parse the body (sendBeacon's own default content
// type is text/plain, which express.json() ignores). The lease simply going
// stale (STALE_TIMEOUT_MS, server/db.js) is still the correctness fallback if
// this never fires at all -- a closed tab, a crash, a lost network.
function leavePresenceBestEffort() {
  if (!presenceId || isNavigating() || typeof navigator.sendBeacon !== "function") return;
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
installNavigationMarking(() => (presenceId ? { scope: "public", presenceId } : null));

// --- Enter Canvas / guest onboarding -----------------------------------------
// Reuses the exact same server-side guest profile GET /api/me's nickname
// already distinguishes "new" (null) from "returning" (set) -- the same
// signal public/app.js's own maybeShowGuestSetup checks, which stays as a
// safety net for anyone who lands on /canvas directly without ever visiting
// this page at all.
function goToCanvas() {
  markNavigating("public", presenceId);
  location.href = "/canvas";
}

// The Welcome dialog's own pre-fill, captured each time it opens -- compared
// against the submitted values on "Start/Continue Drawing" so an unchanged
// returning visitor never triggers an unnecessary POST /api/me/profile (see
// below): reusing the existing guest identity must never mean silently
// rewriting it on every single visit just because the dialog happened to be
// shown again.
let existingNickname = null;
let existingCursorColor = null;

// Shown every time "Enter Canvas" is clicked, for a first-time AND a
// returning visitor alike -- the one behaviour change from this page's
// previous round, where a returning visitor (nickname already set) skipped
// the dialog entirely. GET /api/me still decides only the dialog's own
// pre-filled values and its action button's label, never whether it opens.
async function handleEnterCanvas() {
  let me = { nickname: null, cursorColor: null };
  try {
    const res = await fetch("/api/me");
    me = await res.json();
  } catch {
    // Can't read the existing profile -- still show the dialog (same as a
    // first-time visitor would see), rather than silently skipping it; the
    // editor's own guest-setup fallback (public/app.js's maybeShowGuestSetup)
    // remains the final safety net either way.
  }
  existingNickname = me.nickname;
  existingCursorColor = me.cursorColor;
  onboardingNicknameInput.value = me.nickname ?? "";
  onboardingColourInput.value = me.cursorColor ?? "#1e88e5";
  onboardingStartButton.textContent = me.nickname === null ? "Start Drawing" : "Continue Drawing";
  onboardingOverlay.hidden = false;
}

enterButton.addEventListener("click", handleEnterCanvas);

onboardingStartButton.addEventListener("click", async () => {
  const nickname = onboardingNicknameInput.value.trim();
  if (nickname.length === 0 || nickname.length > 20) return; // the input's own maxlength already stops longer input
  const cursorColor = onboardingColourInput.value;

  // A returning visitor who changed nothing needs no write at all -- the
  // existing profile already says exactly this, so this is never "an
  // unnecessary overwrite" (server/db.js's setGuestNickname/
  // setGuestCursorColor are idempotent regardless, but skipping the request
  // outright is both simpler and exactly what "do not unnecessarily
  // overwrite" asks for).
  const unchanged = nickname === existingNickname && cursorColor.toLowerCase() === (existingCursorColor ?? "").toLowerCase();
  if (!unchanged) {
    try {
      const res = await fetch("/api/me/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname, cursorColor }),
      });
      if (!res.ok) return;
    } catch {
      return;
    }
  }
  goToCanvas();
});

startCanvasSync();
startPresence();
