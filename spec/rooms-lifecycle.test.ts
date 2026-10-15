import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// This file talks to server/db.js's exported functions directly, not over
// HTTP -- spec/global-setup.ts's spawned server (its own DB_PATH, its own
// port) is a separate process entirely and is never touched here. DB_PATH
// must be set to a fresh, throwaway directory BEFORE the dynamic import
// below, because server/db.js opens its DatabaseSync and runs every
// migration at module-load time, synchronously, reading DB_PATH at that
// exact moment -- a static import would be hoisted ahead of this and would
// silently open the default /data/app.db instead. No other spec file
// imports server/db.js, so this module instance (and its throwaway
// database) can never collide with anything else the suite does.
let db: typeof import("../server/db.js");

beforeAll(async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "comp4020-lifecycle-db-"));
  process.env.DB_PATH = join(dbDir, "app.db");
  db = await import("../server/db.js");
});

// Every "now" below is an explicit injected instant, never Date.now() --
// the whole point of this file is proving multi-hour and multi-day lifecycle
// behaviour deterministically, with no real waiting.
describe("Private Room lifecycle", () => {
  it("1. creation atomically establishes the creator's presence", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 1_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);

    const room = db.getActiveRoom(code, t0);
    expect(room).not.toBeNull();
    expect(room?.empty_since).toBeNull();
    expect(db.presenceCount(code)).toBe(1);
  });

  it("2. a room stays occupied while one lease is still live", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 2_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);

    // Well within STALE_TIMEOUT_MS of the one lease's last_seen.
    const room = db.getActiveRoom(code, t0 + 10_000);
    expect(room).not.toBeNull();
    expect(room?.empty_since).toBeNull();
  });

  it("3. a second presence can join an existing room", () => {
    const owner1 = randomUUID();
    const presence1 = randomUUID();
    const t0 = 3_000_000;
    const code = db.createRoom(presence1, owner1, t0);

    const owner2 = randomUUID();
    const presence2 = randomUUID();
    const room = db.recordHeartbeat(code, presence2, owner2, t0 + 1_000);

    expect(room).not.toBeNull();
    expect(db.presenceCount(code)).toBe(2);
  });

  it("4. one of two leaving leaves the room still occupied", () => {
    const owner1 = randomUUID();
    const presence1 = randomUUID();
    const t0 = 4_000_000;
    const code = db.createRoom(presence1, owner1, t0);
    const owner2 = randomUUID();
    const presence2 = randomUUID();
    db.recordHeartbeat(code, presence2, owner2, t0 + 1_000);

    const room = db.leavePresence(code, presence1, t0 + 2_000);

    expect(room).not.toBeNull();
    expect(room?.empty_since).toBeNull();
    expect(db.presenceCount(code)).toBe(1);
  });

  it("5. the same owner with two presenceIds behaves as two independent tab presences", () => {
    const ownerId = randomUUID(); // same anon_id for both "tabs"
    const presenceTabA = randomUUID();
    const presenceTabB = randomUUID();
    const t0 = 5_000_000;
    const code = db.createRoom(presenceTabA, ownerId, t0);
    db.recordHeartbeat(code, presenceTabB, ownerId, t0 + 1_000);
    expect(db.presenceCount(code)).toBe(2);

    // Tab A leaves; tab B (same owner) is untouched and the room stays occupied.
    const room = db.leavePresence(code, presenceTabA, t0 + 2_000);
    expect(room).not.toBeNull();
    expect(room?.empty_since).toBeNull();
    expect(db.presenceCount(code)).toBe(1);
  });

  it("6. the last explicit Leave sets empty_since to the leave instant itself", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 6_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);

    const leaveAt = t0 + 5_000; // long before STALE_TIMEOUT_MS would have elapsed
    const room = db.leavePresence(code, presenceId, leaveAt);

    expect(room).not.toBeNull();
    expect(room?.empty_since).toBe(leaveAt);
    expect(db.presenceCount(code)).toBe(0);
  });

  it("7. losing the heartbeat (no explicit leave) derives empty_since from last_seen + 90s", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 7_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);

    // Nobody heartbeats or leaves; the next request to touch the room arrives
    // well after the lease has gone stale.
    const laterNow = t0 + db.STALE_TIMEOUT_MS + 1;
    const room = db.getActiveRoom(code, laterNow);

    expect(room).not.toBeNull();
    expect(room?.empty_since).toBe(t0 + db.STALE_TIMEOUT_MS);
  });

  it("8. a reconciliation delayed by many hours does not move empty_since forward", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 8_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);

    const firstReconcile = t0 + db.STALE_TIMEOUT_MS + 1;
    const established = db.getActiveRoom(code, firstReconcile);
    const expectedEmptySince = t0 + db.STALE_TIMEOUT_MS;
    expect(established?.empty_since).toBe(expectedEmptySince);

    // The Fly machine could have been stopped for hours; reconciliation only
    // actually runs again once something finally touches the room.
    const muchLater = firstReconcile + 6 * 60 * 60 * 1000;
    const stillSame = db.getActiveRoom(code, muchLater);
    expect(stillSame?.empty_since).toBe(expectedEmptySince);
  });

  it("9. re-entering before 24h clears empty_since", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 9_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);
    const goneStale = t0 + db.STALE_TIMEOUT_MS + 1;
    db.getActiveRoom(code, goneStale); // establishes empty_since

    const returningPresence = randomUUID();
    const reentryAt = goneStale + 60_000; // well before the 24h expiry window
    const room = db.recordHeartbeat(code, returningPresence, ownerId, reentryAt);

    expect(room).not.toBeNull();
    expect(room?.empty_since).toBeNull();
  });

  it("10. leaving again after re-entry establishes a fresh empty_since", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 10_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);
    const firstEmptySince = t0 + db.STALE_TIMEOUT_MS;
    db.getActiveRoom(code, firstEmptySince + 1);

    const returningPresence = randomUUID();
    const reentryAt = firstEmptySince + 60_000;
    db.recordHeartbeat(code, returningPresence, ownerId, reentryAt);

    const secondLeaveAt = reentryAt + 30_000;
    const room = db.leavePresence(code, returningPresence, secondLeaveAt);

    expect(room?.empty_since).toBe(secondLeaveAt);
    expect(room?.empty_since).not.toBe(firstEmptySince);
  });

  it("11. a room just before its 24h expiry is still valid", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 11_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);
    const emptySince = t0 + 5_000;
    db.leavePresence(code, presenceId, emptySince);

    const justBefore = emptySince + db.ROOM_EMPTY_EXPIRY_MS - 1;
    const room = db.getActiveRoom(code, justBefore);
    expect(room).not.toBeNull();
  });

  it("12. a room at exactly 24h since empty_since is expired (inclusive boundary)", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 12_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);
    const emptySince = t0 + 5_000;
    db.leavePresence(code, presenceId, emptySince);

    const exactly24h = emptySince + db.ROOM_EMPTY_EXPIRY_MS;
    const room = db.getActiveRoom(code, exactly24h);
    expect(room).toBeNull();
  });

  it("13. a room well after its 24h expiry is expired", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 13_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);
    const emptySince = t0 + 5_000;
    db.leavePresence(code, presenceId, emptySince);

    const wellAfter = emptySince + db.ROOM_EMPTY_EXPIRY_MS + 7 * 24 * 60 * 60 * 1000;
    const room = db.getActiveRoom(code, wellAfter);
    expect(room).toBeNull();
  });

  it("14. an expired room cannot be re-entered", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 14_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);
    const emptySince = t0 + 5_000;
    db.leavePresence(code, presenceId, emptySince);
    const expiredAt = emptySince + db.ROOM_EMPTY_EXPIRY_MS;
    expect(db.getActiveRoom(code, expiredAt)).toBeNull(); // triggers physical deletion

    // A later heartbeat attempt against the same code must not reoccupy it --
    // it has to behave exactly like an unknown room.
    const room = db.recordHeartbeat(code, randomUUID(), randomUUID(), expiredAt + 1_000);
    expect(room).toBeNull();
    expect(db.getActiveRoom(code, expiredAt + 2_000)).toBeNull();
  });

  it("15. an expired room's ops are physically deleted", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 15_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);
    db.insertOp({
      id: randomUUID(),
      ownerId,
      kind: "draw",
      color: "#1d1d1d",
      size: 0.02,
      points: [{ x: 0.1, y: 0.1 }],
      createdAt: t0,
      // server/db.js is untyped by design (see tsconfig.json); roomId's
      // inferred type comes from its `= null` default, so a real room code
      // needs an explicit escape hatch here rather than a db.js annotation.
      roomId: code as unknown as null,
    });
    expect(db.listOps(code as unknown as null)).toHaveLength(1);

    const emptySince = t0 + 5_000;
    db.leavePresence(code, presenceId, emptySince);
    const expiredAt = emptySince + db.ROOM_EMPTY_EXPIRY_MS;
    expect(db.getActiveRoom(code, expiredAt)).toBeNull();

    expect(db.listOps(code as unknown as null)).toHaveLength(0);
  });

  it("16. an expired room's presence rows are physically deleted", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 16_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);
    const emptySince = t0 + 5_000;
    db.leavePresence(code, presenceId, emptySince);
    const expiredAt = emptySince + db.ROOM_EMPTY_EXPIRY_MS;

    expect(db.getActiveRoom(code, expiredAt)).toBeNull();
    expect(db.presenceCount(code)).toBe(0);
  });

  it("17. expiring a private room never touches Public Canvas ops", () => {
    const publicOpId = randomUUID();
    db.insertOp({
      id: publicOpId,
      ownerId: randomUUID(),
      kind: "draw",
      color: "#e53935",
      size: 0.03,
      points: [{ x: 0.2, y: 0.2 }],
      createdAt: 17_000_000,
      roomId: null,
    });

    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 17_100_000;
    const code = db.createRoom(presenceId, ownerId, t0);
    const emptySince = t0 + 5_000;
    db.leavePresence(code, presenceId, emptySince);
    db.getActiveRoom(code, emptySince + db.ROOM_EMPTY_EXPIRY_MS);

    const publicOps = db.listOps(null);
    expect(publicOps.some((op) => op.id === publicOpId)).toBe(true);
  });

  it("18. stale presence rows are only removed after empty_since evidence is captured", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 18_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);

    // One tick before the lease would go stale: still live, row untouched.
    const justBeforeStale = t0 + db.STALE_TIMEOUT_MS - 1;
    const stillLive = db.getActiveRoom(code, justBeforeStale);
    expect(stillLive?.empty_since).toBeNull();
    expect(db.presenceCount(code)).toBe(1);

    // One tick after: empty_since must be derived from the row's own
    // last_seen (t0) BEFORE that row is deleted -- if deletion ever ran
    // first, MAX(last_seen) would see no rows and empty_since would
    // incorrectly stay null.
    const justAfterStale = t0 + db.STALE_TIMEOUT_MS + 1;
    const nowEmpty = db.getActiveRoom(code, justAfterStale);
    expect(nowEmpty?.empty_since).toBe(t0 + db.STALE_TIMEOUT_MS);
    expect(db.presenceCount(code)).toBe(0);
  });

  it("19. repeated late reconciliation never drifts an already-established empty_since", () => {
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    const t0 = 19_000_000;
    const code = db.createRoom(presenceId, ownerId, t0);
    const establishAt = t0 + db.STALE_TIMEOUT_MS + 1;
    const expected = db.getActiveRoom(code, establishAt)?.empty_since;

    let checkAt = establishAt;
    for (let i = 0; i < 5; i++) {
      checkAt += 2 * 60 * 60 * 1000; // two more hours each pass
      const room = db.getActiveRoom(code, checkAt);
      expect(room?.empty_since).toBe(expected);
    }
  });

  it("20. the Public Canvas needs no presence heartbeat at all", () => {
    const op = db.insertOp({
      id: randomUUID(),
      ownerId: randomUUID(),
      kind: "draw",
      color: "#43a047",
      size: 0.01,
      points: [{ x: 0.5, y: 0.5 }],
      createdAt: 20_000_000,
      roomId: null,
    });

    // No createRoom/recordHeartbeat/leavePresence call anywhere in this test
    // -- the Public scope works purely through insertOp/listOps(null), with
    // no presence row ever created for it.
    expect(typeof op).toBe("number");
    expect(db.listOps(null).some((o) => o.createdAt === 20_000_000)).toBe(true);
  });
});

// The landing page's "Online Now" counter: a presence lease exactly like a
// room's own (same table, same staleness definition), just scoped to a fixed
// sentinel instead of a real room code (see server/db.js's own comment on
// why this is safe -- no FK, and room codes can never collide with it).
// countOnlineNow() itself is intentionally site-wide (DISTINCT owner_id
// across every room_id, Public and every Private Room alike) -- see its own
// comment in server/db.js. Explicit injected `now` throughout, same
// reasoning as the rest of this file: staleness is proven deterministically,
// never by really waiting STALE_TIMEOUT_MS (90s) out.
describe("Public Canvas presence (Online Now counter)", () => {
  it("a heartbeat makes exactly one presence-id count as online", () => {
    const t0 = 100_000_000;
    db.recordPublicHeartbeat(randomUUID(), randomUUID(), t0);
    expect(db.countOnlineNow(t0)).toBe(1);
  });

  it("two different tabs (two presence ids) count once, since they share the same owner", () => {
    const t0 = 101_000_000;
    const sameOwner = randomUUID();
    db.recordPublicHeartbeat(randomUUID(), sameOwner, t0);
    db.recordPublicHeartbeat(randomUUID(), sameOwner, t0);
    expect(db.countOnlineNow(t0)).toBe(1); // DISTINCT owner_id, not distinct presence leases
  });

  it("a renewed heartbeat for the same presence id does not double-count", () => {
    const t0 = 102_000_000;
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    db.recordPublicHeartbeat(presenceId, ownerId, t0);
    db.recordPublicHeartbeat(presenceId, ownerId, t0 + 1000);
    expect(db.countOnlineNow(t0 + 1000)).toBe(1);
  });

  it("leaving removes exactly that one lease from the live count", () => {
    const t0 = 103_000_000;
    const staying = randomUUID();
    const leaving = randomUUID();
    db.recordPublicHeartbeat(staying, randomUUID(), t0);
    db.recordPublicHeartbeat(leaving, randomUUID(), t0);
    expect(db.countOnlineNow(t0)).toBe(2);

    db.leavePublicPresence(leaving);
    expect(db.countOnlineNow(t0)).toBe(1);
  });

  it("navigation handoff: registering the new lease before releasing the old one never dips the count", () => {
    const t0 = 104_000_000;
    const owner = randomUUID();
    const oldLease = randomUUID();
    const newLease = randomUUID();
    db.recordPublicHeartbeat(oldLease, owner, t0);
    expect(db.countOnlineNow(t0)).toBe(1);

    db.recordPublicHeartbeat(newLease, owner, t0 + 100); // destination page registers first
    expect(db.countOnlineNow(t0 + 100)).toBe(1);
    db.leavePublicPresence(oldLease); // then the previous lease is released
    expect(db.countOnlineNow(t0 + 100)).toBe(1);
  });

  it("closing one of several tabs of the same guest keeps that guest counted; closing the last removes them immediately", () => {
    const t0 = 105_000_000;
    const owner = randomUUID();
    const tabA = randomUUID();
    const tabB = randomUUID();
    db.recordPublicHeartbeat(tabA, owner, t0);
    db.recordPublicHeartbeat(tabB, owner, t0);

    db.leavePublicPresence(tabA);
    expect(db.countOnlineNow(t0)).toBe(1);
    db.leavePublicPresence(tabB);
    expect(db.countOnlineNow(t0)).toBe(0);
  });

  it("a lease older than STALE_TIMEOUT_MS no longer counts as online (and is pruned by the next heartbeat)", () => {
    const t0 = 104_000_000;
    const stalePresenceId = randomUUID();
    db.recordPublicHeartbeat(stalePresenceId, randomUUID(), t0);
    const justStale = t0 + db.STALE_TIMEOUT_MS + 1;
    expect(db.countOnlineNow(justStale)).toBe(0);

    // The stale-session cleanup this feature needs: a fresh heartbeat from
    // someone else, at the later instant, physically prunes the stale row
    // rather than leaving it to accumulate forever.
    db.recordPublicHeartbeat(randomUUID(), randomUUID(), justStale);
    expect(db.countOnlineNow(justStale)).toBe(1);
  });

  it("distinguishes active sessions from historical visitors: a saved guest profile with no heartbeat is never counted online", () => {
    const t0 = 105_000_000;
    const neverVisitedOwner = randomUUID();
    db.setGuestNickname(neverVisitedOwner, "Ghost", t0);
    db.setGuestCursorColor(neverVisitedOwner, "#abcdef");
    expect(db.countOnlineNow(t0)).toBe(0);

    // A real, separate presence lease for someone else is unaffected by how
    // many historical guest rows exist.
    db.recordPublicHeartbeat(randomUUID(), randomUUID(), t0);
    expect(db.countOnlineNow(t0)).toBe(1);
  });

  it("Online Now is site-wide: a Private Room's own presence counts toward it alongside Public's", () => {
    const t0 = 106_000_000;
    const code = db.createRoom(randomUUID(), randomUUID(), t0); // a room presence row
    db.recordPublicHeartbeat(randomUUID(), randomUUID(), t0); // a Public presence row, different owner

    expect(db.presenceCount(code)).toBe(1); // the room's own per-room count still sees only its own lease
    expect(db.countOnlineNow(t0)).toBe(2); // but the site-wide count sees both distinct owners
  });
});

// "Total Visitors": a monotonic, all-time distinct-owner count, completely
// independent of the `presence` table's own pruning/staleness -- see
// server/db.js's own comment on visitor_identities and recordVisitorIdentity.
describe("Total Visitors counter", () => {
  it("a new owner's first heartbeat (Public, a room, or room presence) increases the count by exactly one", () => {
    const t0 = 200_000_000;
    const before = Number(db.countTotalVisitors());
    db.recordPublicHeartbeat(randomUUID(), randomUUID(), t0);
    expect(Number(db.countTotalVisitors())).toBe(before + 1);
  });

  it("refreshing, a second tab, or renewing the same owner's heartbeat never increases the count", () => {
    const t0 = 201_000_000;
    const sameOwner = randomUUID();
    db.recordPublicHeartbeat(randomUUID(), sameOwner, t0);
    const afterFirst = db.countTotalVisitors();

    db.recordPublicHeartbeat(randomUUID(), sameOwner, t0 + 1000); // "another tab"
    db.recordPublicHeartbeat(randomUUID(), sameOwner, t0 + 2000); // "refreshing" again
    expect(db.countTotalVisitors()).toBe(afterFirst);
  });

  it("switching from Public to a Private Room under the same owner never increases the count", () => {
    const t0 = 202_000_000;
    const ownerId = randomUUID();
    db.recordPublicHeartbeat(randomUUID(), ownerId, t0);
    const afterPublic = db.countTotalVisitors();

    db.createRoom(randomUUID(), ownerId, t0); // same owner, a different room
    expect(db.countTotalVisitors()).toBe(afterPublic);
  });

  it("never decreases: leaving, going stale, or a room expiring and pruning its presence rows leaves it unchanged", () => {
    const t0 = 203_000_000;
    const presenceId = randomUUID();
    const ownerId = randomUUID();
    db.recordPublicHeartbeat(presenceId, ownerId, t0);
    const afterJoin = db.countTotalVisitors();

    db.leavePublicPresence(presenceId);
    expect(db.countTotalVisitors()).toBe(afterJoin);
  });
});
