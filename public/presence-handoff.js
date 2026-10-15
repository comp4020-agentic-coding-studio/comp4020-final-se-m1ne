// Same-tab presence handoff. A page that is about to navigate within the site
// records its own lease here instead of sending a leave; the destination page
// registers its own lease first and then asks the server to release the old
// one, so the guest is never absent from "Online Now" in between.
const KEY = "presenceHandoff";
const NAVIGATION_MARK_MAX_AGE_MS = 5_000;
const HANDOFF_MAX_AGE_MS = 30_000;

function read() {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// scope: "public" or a room code.
export function markNavigating(scope, presenceId) {
  if (!presenceId) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ scope, presenceId, at: Date.now() }));
  } catch {
    // storage unavailable: the leave beacon / lease expiry still apply
  }
}

export function isNavigating() {
  const mark = read();
  return mark !== null && Date.now() - mark.at < NAVIGATION_MARK_MAX_AGE_MS;
}

// Call once the new page's own first heartbeat has landed.
export async function releasePreviousLease(currentPresenceId) {
  const mark = read();
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  if (!mark || Date.now() - mark.at > HANDOFF_MAX_AGE_MS || mark.presenceId === currentPresenceId) return;
  try {
    await fetch("/api/presence/handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: mark.scope, presenceId: mark.presenceId }),
    });
  } catch {
    // best-effort: the old lease simply expires
  }
}

// Marks the page as navigating for any same-site link click or form submit,
// and for the keyboard reload shortcuts, so the pagehide leave is skipped.
export function installNavigationMarking(getLease) {
  // Navigation API (Chromium): also fires for toolbar reload, back/forward and
  // location.href assignments, which no click/keydown listener can see.
  if (typeof navigation !== "undefined" && typeof navigation.addEventListener === "function") {
    navigation.addEventListener("navigate", (event) => {
      if (event.hashChange || event.downloadRequest) return;
      let sameOrigin = false;
      try {
        sameOrigin = new URL(event.destination.url).origin === location.origin;
      } catch {
        return;
      }
      const lease = getLease();
      if (sameOrigin && lease) markNavigating(lease.scope, lease.presenceId);
    });
  }
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (link && link.origin === location.origin && !link.target && !event.defaultPrevented) {
        const lease = getLease();
        if (lease) markNavigating(lease.scope, lease.presenceId);
      }
    },
    true,
  );
  window.addEventListener("keydown", (event) => {
    const reload = event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
    if (!reload) return;
    const lease = getLease();
    if (lease) markNavigating(lease.scope, lease.presenceId);
  });
}
