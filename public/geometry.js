// Pure geometry for partial erasing. A "capsule" here is the swept region of
// a circle of a given radius moving from point `from` to point `to` (if
// from === to, it degenerates to a plain circle) -- exactly the shape a real
// eraser leaves behind as it's dragged between two pointer samples. All of
// this operates in the same normalized [0,1] space strokes are stored in, so
// it has no notion of canvas pixels at all.
//
// Lives under public/ (not server/) so the browser can import it directly
// for instant local erase feedback, and the server imports this same file
// (../public/geometry.js) so both sides run the identical algorithm -- no
// risk of the client's preview ever disagreeing with what gets persisted.

const EPS = 1e-9;

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}
function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}
function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
function samePoint(a, b) {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
}

function distSqToSegment(point, a, b) {
  const d = sub(b, a);
  const len2 = dot(d, d);
  if (len2 < EPS) {
    const diff = sub(point, a);
    return dot(diff, diff);
  }
  let t = dot(sub(point, a), d) / len2;
  t = Math.max(0, Math.min(1, t));
  const proj = lerp(a, b, t);
  const diff = sub(point, proj);
  return dot(diff, diff);
}

function solveQuadratic(a, b, c) {
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) < EPS) return [];
    return [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
}

// The sub-interval of t in [0, 1] along segment p0->p1 that lies within
// `radius` of the point `center` (a degenerate, zero-length capsule), or
// null if there is none.
function erasedIntervalForCircle(p0, p1, center, radius) {
  const e = sub(p1, p0);
  const f = sub(p0, center);
  const r2 = radius * radius;
  const roots = solveQuadratic(dot(e, e), 2 * dot(f, e), dot(f, f) - r2);
  const inside = (t) => {
    const point = lerp(p0, p1, t);
    const diff = sub(point, center);
    return dot(diff, diff) <= r2 + 1e-9;
  };
  const relevant = roots.filter(inside);
  if (inside(0)) relevant.push(0);
  if (inside(1)) relevant.push(1);
  if (relevant.length === 0) return null;
  const start = Math.max(0, Math.min(...relevant));
  const end = Math.min(1, Math.max(...relevant));
  return end - start > EPS ? [start, end] : null;
}

// The sub-interval of t in [0, 1] along segment p0->p1 that lies within
// `radius` of the capsule segment from->to, or null if there is none. The
// capsule is convex, so its intersection with the (infinite) line through
// p0/p1 is a single interval: there's no "it dips in, out, then back in"
// case to worry about missing.
function erasedIntervalOnSegment(p0, p1, from, to, radius) {
  const d = sub(to, from);
  const len2 = dot(d, d);
  if (len2 < EPS) return erasedIntervalForCircle(p0, p1, from, radius);

  const e = sub(p1, p0);
  const f0 = sub(p0, from);
  const r2 = radius * radius;
  const sOf = (t) => (dot(f0, d) + t * dot(e, d)) / len2;

  const candidates = [];

  // Nearest capsule point is on the segment from->to itself (distance to the
  // infinite line through it), valid wherever the projection lands in [0, 1].
  const c0 = cross(f0, d);
  const c1 = cross(e, d);
  for (const root of solveQuadratic(c1 * c1, 2 * c0 * c1, c0 * c0 - r2 * len2)) {
    const s = sOf(root);
    if (s >= -1e-6 && s <= 1 + 1e-6) candidates.push(root);
  }

  // Nearest capsule point is one of its two round ends, valid beyond that end.
  for (const [center, validWhen] of [
    [from, (s) => s <= 1e-6],
    [to, (s) => s >= 1 - 1e-6],
  ]) {
    const g = sub(p0, center);
    for (const root of solveQuadratic(dot(e, e), 2 * dot(g, e), dot(g, g) - r2)) {
      if (validWhen(sOf(root))) candidates.push(root);
    }
  }

  // Seams between those regions, in case p0->p1 runs parallel to from->to and
  // the quadratics above degenerate to "always" or "never" rather than a root.
  const s1 = dot(e, d) / len2;
  if (Math.abs(s1) > EPS) {
    const s0 = dot(f0, d) / len2;
    candidates.push((0 - s0) / s1, (1 - s0) / s1);
  }

  const inside = (t) => distSqToSegment(lerp(p0, p1, t), from, to) <= r2 + 1e-9;
  const relevant = candidates.filter(inside);
  if (inside(0)) relevant.push(0);
  if (inside(1)) relevant.push(1);
  if (relevant.length === 0) return null;

  const start = Math.max(0, Math.min(...relevant));
  const end = Math.min(1, Math.max(...relevant));
  return end - start > EPS ? [start, end] : null;
}

// Erases the part of a stroke's polyline that falls within `radius` of the
// swept capsule from->to, splitting it into zero or more surviving polylines.
// Returns { changed: false } untouched when nothing intersects, so callers
// can skip rewriting strokes the eraser never actually touched.
export function eraseFromPolyline(points, from, to, radius) {
  if (points.length === 1) {
    const hit = distSqToSegment(points[0], from, to) <= radius * radius;
    return { changed: hit, fragments: hit ? [] : [points] };
  }

  const fragments = [];
  let current = [];
  let anyChange = false;

  const pushPoint = (p) => {
    if (current.length === 0 || !samePoint(current[current.length - 1], p)) current.push(p);
  };
  const flush = () => {
    if (current.length >= 2) fragments.push(current);
    current = [];
  };

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const interval = erasedIntervalOnSegment(p0, p1, from, to, radius);

    if (!interval) {
      pushPoint(p0);
      pushPoint(p1);
      continue;
    }

    anyChange = true;
    const [start, end] = interval;
    if (start > EPS) {
      pushPoint(p0);
      pushPoint(lerp(p0, p1, start));
    }
    flush();
    if (end < 1 - EPS) {
      pushPoint(lerp(p0, p1, end));
      pushPoint(p1);
    }
  }
  flush();

  if (!anyChange) return { changed: false, fragments: [points] };
  return { changed: true, fragments };
}

// How far from the swept capsule's centerline a stroke's own ink still
// counts as touched: the eraser's chosen radius, plus the stroke's own
// half-width, since a wide stroke's edge can be touched well before its
// centerline is.
export function effectiveRadius(eraserRadius, strokeWidth) {
  return eraserRadius + strokeWidth / 2;
}

// Bounding-box prefilter -- a scalability optimization only, never a
// correctness change. It's a conservative "could this possibly intersect"
// test: expanding a stroke's axis-aligned bounding box by the effective
// radius and checking it against the swept segment's bounding box can never
// reject a pair the exact capsule/polyline math would actually touch (box
// containment is implied by the tighter capsule containment), so skipping
// eraseFromPolyline whenever this returns false changes no erase result --
// it only skips segments/strokes that provably cannot intersect.
export function strokeBoundingBox(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function segmentBoundingBox(from, to) {
  return {
    minX: Math.min(from.x, to.x),
    maxX: Math.max(from.x, to.x),
    minY: Math.min(from.y, to.y),
    maxY: Math.max(from.y, to.y),
  };
}

export function boundingBoxesIntersectWithMargin(a, b, margin) {
  return (
    a.minX - margin <= b.maxX &&
    a.maxX + margin >= b.minX &&
    a.minY - margin <= b.maxY &&
    a.maxY + margin >= b.minY
  );
}
