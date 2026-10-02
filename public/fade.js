// A public-canvas draw op's visual opacity decays linearly and continuously
// with age: 2 percentage points lost every 15 minutes, reaching 0 at exactly
// 750 minutes (12.5 hours). This is purely a rendering concern -- it never
// affects whether an op is persisted, never applies to erase ops (which are
// mask mutations, not visual content, and so never fade), and never affects
// the ownership mask an owner's erasing is checked against.
export const FADE_DURATION_MS = 750 * 60 * 1000;

export function fadeOpacity(createdAt, now) {
  return Math.max(0, 1 - (now - createdAt) / FADE_DURATION_MS);
}

// The one gate between Public Canvas fading and Private Room permanence: a
// Private Room op's opacity is always 1, regardless of age -- it never calls
// fadeOpacity at all, so a Private op's createdAt (still persisted, just
// unused for rendering here) can never cause it to dim or disappear.
export function effectiveOpacity(op, now, isPublicCanvas) {
  return isPublicCanvas ? fadeOpacity(op.createdAt, now) : 1;
}
