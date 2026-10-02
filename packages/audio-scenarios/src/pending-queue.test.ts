import { describe, expect, it } from "vitest";

import { type OfferInput, PENDING_QUEUE_CAPACITY, PendingQueue } from "./pending-queue.js";

/** `queueBehind` relations for the tests: follower id → the leader ids it names. */
function relations(map: Record<string, string[]>) {
  return (followerId: string, leaderId: string) => map[followerId]?.includes(leaderId) ?? false;
}

function input(id: string, weight: number, queuedAt = 0, extra: Partial<OfferInput<string>> = {}): OfferInput<string> {
  return { id, weight, group: id, queuedAt, maxWaitMs: 8000, fire: id, ...extra };
}

const ids = (q: PendingQueue<string>) => q.ordered().map((e) => e.id);

describe("PendingQueue (issue #1185)", () => {
  it("orders by weight, then by age, then by insertion", () => {
    const q = new PendingQueue<string>(relations({}));
    q.offer(input("a", 50, 100), 100);
    q.offer(input("b", 70, 200), 200);
    q.offer(input("c", 50, 50), 200);
    q.offer(input("d", 50, 50), 200);
    expect(ids(q)).toEqual(["b", "c", "d", "a"]);
  });

  it("a lighter newcomer waits instead of being dropped, and a heavier one evicts nothing", () => {
    const q = new PendingQueue<string>(relations({}));
    q.offer(input("heavy", 70), 0);
    const r = q.offer(input("light", 10), 0);
    expect(r.drops).toEqual([]);
    expect(r.position).toBe(2);
    expect(ids(q)).toEqual(["heavy", "light"]);
  });

  it("supersedes a waiting entry of the same group", () => {
    const q = new PendingQueue<string>(relations({}));
    q.offer(input("black", 70, 0, { group: "penalty" }), 0);
    const r = q.offer(input("dq", 70, 10, { group: "penalty" }), 10);
    expect(r.drops).toEqual([
      { entry: expect.objectContaining({ id: "black" }), reason: { kind: "superseded", by: "dq" } },
    ]);
    expect(ids(q)).toEqual(["dq"]);
  });

  it("the same id supersedes itself through the default group", () => {
    const q = new PendingQueue<string>(relations({}));
    q.offer(input("readout", 40, 0), 0);
    q.offer(input("readout", 40, 5), 5);
    expect(q.size).toBe(1);
    expect(q.ordered()[0].queuedAt).toBe(5);
  });

  it("a follower sits right after its leader whatever the weights", () => {
    const q = new PendingQueue<string>(relations({ damage: ["incident"] }));
    q.offer(input("incident", 50), 0);
    q.offer(input("caution", 70), 0);
    const r = q.offer(input("damage", 50), 0);
    expect(r.behind).toBe("incident");
    expect(ids(q)).toEqual(["caution", "incident", "damage"]);
  });

  it("a newcomer named by a waiting entry goes ahead of it, which links behind it", () => {
    const q = new PendingQueue<string>(relations({ damage: ["incident"] }));
    q.offer(input("damage", 50), 0);
    q.offer(input("incident", 50), 1);
    expect(ids(q)).toEqual(["incident", "damage"]);
    expect(q.ordered()[1].after).toBe("incident");
  });

  it("a superseded leader's follower re-links to a newcomer it names, and goes free otherwise", () => {
    const q = new PendingQueue<string>(relations({ damage: ["off-track", "collision-world"] }));
    q.offer(input("off-track", 50, 0, { group: "incident" }), 0);
    q.offer(input("damage", 50, 1), 1);
    q.offer(input("collision-world", 50, 2, { group: "incident" }), 2);
    expect(ids(q)).toEqual(["collision-world", "damage"]);
    expect(q.ordered()[1].after).toBe("collision-world");

    const q2 = new PendingQueue<string>(relations({ tire: ["readback"] }));
    q2.offer(input("readback", 20, 0, { group: "rb" }), 0);
    q2.offer(input("tire", 50, 1), 1);
    q2.offer(input("other", 20, 2, { group: "rb" }), 2);
    expect(q2.ordered().find((e) => e.id === "tire")?.after).toBeNull();
    expect(ids(q2)).toEqual(["tire", "other"]);
  });

  it("drops the lightest, then oldest, root above the cap — the newcomer included", () => {
    const q = new PendingQueue<string>(relations({}));
    q.offer(input("a", 70, 0), 0);
    q.offer(input("b", 70, 1), 1);
    q.offer(input("c", 50, 2), 2);
    q.offer(input("d", 50, 3), 3);
    const r = q.offer(input("e", 60, 4), 4);
    expect(r.drops).toEqual([{ entry: expect.objectContaining({ id: "c" }), reason: { kind: "queue-full" } }]);
    const r2 = q.offer(input("f", 10, 5), 5);
    expect(r2.position).toBeNull();
    expect(r2.drops[0].entry.id).toBe("f");
    expect(q.size).toBe(PENDING_QUEUE_CAPACITY);
  });

  it("followers do not count toward the cap", () => {
    const q = new PendingQueue<string>(relations({ damage: ["incident"] }));

    for (const id of ["w", "l", "p"]) q.offer(input(id, 70), 0);

    q.offer(input("incident", 50), 0);
    const r = q.offer(input("damage", 50), 0);
    expect(r.drops).toEqual([]);
    expect(ids(q)).toEqual(["w", "l", "p", "incident", "damage"]);
  });

  it("one arrival drops at most one entry: a follower its drop frees stays, one root over the cap", () => {
    const q = new PendingQueue<string>(relations({ damage: ["incident"] }));

    for (const [i, id] of ["waving", "lineup", "pace-car"].entries()) q.offer(input(id, 70, i), i);

    q.offer(input("incident", 50, 3), 3);
    q.offer(input("damage", 50, 4), 4);
    const r = q.offer(input("fuel", 50, 5), 5);

    expect(r.drops).toEqual([{ entry: expect.objectContaining({ id: "incident" }), reason: { kind: "queue-full" } }]);
    expect(ids(q)).toEqual(["waving", "lineup", "pace-car", "damage", "fuel"]);
    expect(r.position).toBe(5);
  });

  it("next() expires entries past their max wait and returns the head", () => {
    const q = new PendingQueue<string>(relations({}));
    q.offer(input("old", 70, 0, { maxWaitMs: 8000 }), 0);
    q.offer(input("long", 50, 0, { maxWaitMs: 30000 }), 0);
    const { entry, drops } = q.next(9000);
    expect(drops).toEqual([
      { entry: expect.objectContaining({ id: "old" }), reason: { kind: "expired", waitedMs: 9000, maxWaitMs: 8000 } },
    ]);
    expect(entry?.id).toBe("long");
    expect(q.size).toBe(0);
  });

  it("an entry exactly at its max wait is still served", () => {
    const q = new PendingQueue<string>(relations({}));
    q.offer(input("a", 50, 0), 0);
    expect(q.next(8000).entry?.id).toBe("a");
  });

  it("a re-offered entry keeps its original queuedAt, so its wait runs from the first deferral", () => {
    const q = new PendingQueue<string>(relations({}));
    q.offer(input("a", 50, 0), 5000);
    expect(q.ordered()[0].queuedAt).toBe(0);
    const { entry, drops } = q.next(8500);
    expect(entry).toBeNull();
    expect(drops).toEqual([
      { entry: expect.objectContaining({ id: "a" }), reason: { kind: "expired", waitedMs: 8500, maxWaitMs: 8000 } },
    ]);
  });

  it("next() never serves a follower before its leader, and frees it once the leader is taken", () => {
    const q = new PendingQueue<string>(relations({ damage: ["incident"] }));
    q.offer(input("incident", 50), 0);
    q.offer(input("damage", 50), 0);
    expect(q.next(0, (e) => e.id !== "incident").entry).toBeNull();
    expect(q.next(0).entry?.id).toBe("incident");
    expect(q.ordered()[0].after).toBeNull();
    expect(q.next(0).entry?.id).toBe("damage");
  });

  it("an expired leader leaves its follower to be served", () => {
    const q = new PendingQueue<string>(relations({ damage: ["incident"] }));
    q.offer(input("incident", 50, 0, { maxWaitMs: 1000 }), 0);
    q.offer(input("damage", 50, 0, { maxWaitMs: 30000 }), 0);
    const { entry, drops } = q.next(2000);
    expect(drops.map((d) => d.entry.id)).toEqual(["incident"]);
    expect(entry?.id).toBe("damage");
  });

  it("canPlay skips entries without moving them", () => {
    const q = new PendingQueue<string>(relations({}));
    q.offer(input("low", 50), 0);
    q.offer(input("high", 80), 0);
    expect(q.next(0, (e) => e.weight < 60).entry?.id).toBe("low");
    expect(ids(q)).toEqual(["high"]);
  });

  it("remove() frees the removed entry's followers; clear() reports everything", () => {
    const q = new PendingQueue<string>(relations({ damage: ["incident"] }));
    q.offer(input("incident", 50), 0);
    q.offer(input("damage", 50), 0);
    expect(q.remove("incident")?.id).toBe("incident");
    expect(q.ordered()[0].after).toBeNull();
    expect(q.clear()).toEqual([{ entry: expect.objectContaining({ id: "damage" }), reason: { kind: "cleared" } }]);
    expect(q.size).toBe(0);
  });

  it("hasLeaderFor() reports a waiting entry the id names", () => {
    const q = new PendingQueue<string>(relations({ tire: ["readback"] }));
    expect(q.hasLeaderFor("tire")).toBe(false);
    q.offer(input("readback", 20), 0);
    expect(q.hasLeaderFor("tire")).toBe(true);
    expect(q.has("readback")).toBe(true);
  });

  it("never links into a cycle", () => {
    const q = new PendingQueue<string>(relations({ a: ["b"], b: ["a"] }));
    q.offer(input("a", 50), 0);
    q.offer(input("b", 50), 1);
    expect(q.ordered()).toHaveLength(2);
    expect(q.next(0).entry).not.toBeNull();
    expect(q.next(0).entry).not.toBeNull();
  });
});
