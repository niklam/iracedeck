/**
 * The fires waiting for one audio bus (issue #1185) — replaces the single
 * deferred slot the engine kept per bus.
 *
 * Pure: no timers, no logger. Every operation returns what left the queue
 * without playing and why, and the interpreter logs it. Placement is
 * heaviest first, then oldest `queuedAt`, then insertion; a `queueBehind`
 * follower sits right after its leader whatever the weights and does not
 * count toward the cap. A newcomer supersedes any waiting entry of its
 * `group`, which is how the features the single slot provided by eviction
 * survive (DQ over black, go over ready, an incident escalation, the newest
 * readout). Pacing is the per-entry max wait, checked whenever the queue is
 * read; the cap only bounds a pathological burst.
 *
 * One arrival drops at most one entry. When the victim is a leader, the
 * followers its drop frees become roots and may leave the queue over the
 * cap until it drains — and a removal for any other reason (a disable, a
 * group superseded) is not followed by re-applying the cap, for the same
 * reason. The excess stays bounded: a leader's followers can only be
 * contracts whose `queueBehind` names it.
 */

/**
 * How many waiting roots one arrival may bring the queue to before it drops
 * one; followers do not count. Followers freed by that drop may leave the
 * roots above it until the queue drains.
 */
export const PENDING_QUEUE_CAPACITY = 4;

export type QueuedFire<F> = {
  readonly id: string;
  readonly weight: number;
  /** The supersede group (spec §3); defaults to the contract id upstream. */
  readonly group: string;
  /** When the fire was FIRST deferred; a re-deferral keeps it. */
  readonly queuedAt: number;
  readonly maxWaitMs: number;
  /** The waiting entry this one plays right after (`queueBehind`), or null. */
  after: string | null;
  /** The caller's payload (the interpreter's `WaitingFire`). */
  readonly fire: F;
  /** Insertion counter — the last tie-break. */
  readonly seq: number;
};

export type OfferInput<F> = {
  id: string;
  weight: number;
  group: string;
  queuedAt: number;
  maxWaitMs: number;
  fire: F;
  /**
   * The input is an interrupt's stash of a fire that was already playing:
   * any entry of its group still waiting arrived after it began, so the
   * stash yields — it is dropped, superseded by that entry, rather than
   * superseding it. Without it, a cut line would replace the newer line of
   * its group that waited behind it.
   */
  yieldsToGroup?: boolean;
};

export type QueueDropReason =
  | { kind: "superseded"; by: string }
  | { kind: "queue-full" }
  | { kind: "expired"; waitedMs: number; maxWaitMs: number }
  | { kind: "cleared" };

export type QueueDrop<F> = { entry: QueuedFire<F>; reason: QueueDropReason };

export type OfferResult<F> = {
  /** Entries that left without playing — the newcomer too when the cap dropped it. */
  drops: QueueDrop<F>[];
  /** The newcomer's 1-based play position, or null when the cap dropped it. */
  position: number | null;
  size: number;
  /** The leader the newcomer waits behind, if any. */
  behind: string | null;
};

/** Play order: heaviest, then oldest `queuedAt`, then earliest insertion. */
const byPriority = <F>(a: QueuedFire<F>, b: QueuedFire<F>): number =>
  b.weight - a.weight || a.queuedAt - b.queuedAt || a.seq - b.seq;

/**
 * Cap-victim order: lightest, then oldest `queuedAt`, then earliest insertion.
 * Not the reverse of `byPriority` — within a weight the OLDEST goes, since it
 * is the nearest to its max wait and the most likely to be stale.
 */
const byVictim = <F>(a: QueuedFire<F>, b: QueuedFire<F>): number =>
  a.weight - b.weight || a.queuedAt - b.queuedAt || a.seq - b.seq;

/** Whether an entry has waited past its max wait at `now` (exactly at it is still served). */
const isExpired = <F>(e: QueuedFire<F>, now: number): boolean => now - e.queuedAt > e.maxWaitMs;

export class PendingQueue<F> {
  private entries: QueuedFire<F>[] = [];
  private seq = 0;

  constructor(
    private readonly waitsBehind: (followerId: string, leaderId: string) => boolean,
    private readonly capacity = PENDING_QUEUE_CAPACITY,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  has(id: string): boolean {
    return this.entries.some((e) => e.id === id);
  }

  /**
   * Whether a waiting entry still inside its max wait at `now` is one `id`'s
   * contract names in `queueBehind`. An entry past its max wait is no one's
   * leader: it is dropped, and logged, at the next read. Without `now`, the
   * idle-bus check would queue a follower behind a dead leader, and on an
   * idle bus nothing would drain it.
   */
  hasLeaderFor(id: string, now: number): boolean {
    return this.entries.some((e) => e.id !== id && !isExpired(e, now) && this.waitsBehind(id, e.id));
  }

  /** The waiting entries in play order. */
  ordered(): readonly QueuedFire<F>[] {
    const out: QueuedFire<F>[] = [];
    const visit = (e: QueuedFire<F>): void => {
      out.push(e);

      for (const f of this.entries.filter((x) => x.after === e.id).sort((a, b) => a.seq - b.seq)) visit(f);
    };

    for (const root of this.roots().sort(byPriority)) visit(root);

    return out;
  }

  offer(input: OfferInput<F>, now: number): OfferResult<F> {
    const drops = this.expire(now);
    const { yieldsToGroup, ...fields } = input;
    const newer = yieldsToGroup === true ? this.entries.find((e) => e.group === input.group) : undefined;

    if (newer !== undefined) {
      const entry: QueuedFire<F> = { ...fields, after: null, seq: this.seq++ };
      drops.push({ entry, reason: { kind: "superseded", by: newer.id } });

      return { drops, position: null, size: this.entries.length, behind: null };
    }

    drops.push(...this.removeGroup(input.group, input.id));

    const entry: QueuedFire<F> = { ...fields, after: null, seq: this.seq++ };
    const leader = this.ordered().find((e) => this.waitsBehind(entry.id, e.id));

    if (leader !== undefined) entry.after = leader.id;

    this.entries.push(entry);

    // A waiting entry that names the newcomer moves behind it — unless that
    // would close a loop through the newcomer's own leader chain.
    for (const e of this.entries) {
      if (e !== entry && this.waitsBehind(e.id, entry.id) && !this.isAncestorOf(e, entry)) e.after = entry.id;
    }

    // One arrival drops at most one victim. Not a loop: dropping a leader
    // frees its followers into roots, and a recount would then take one of
    // them too (#1288's damage line behind the incident it follows).
    const roots = this.roots();

    if (roots.length > this.capacity) {
      const victim = roots.reduce((v, e) => (byVictim(e, v) < 0 ? e : v));
      this.removeEntry(victim);
      drops.push({ entry: victim, reason: { kind: "queue-full" } });
    }

    const position = this.ordered().indexOf(entry);

    return {
      drops,
      position: position < 0 ? null : position + 1,
      size: this.entries.length,
      behind: position < 0 ? null : entry.after,
    };
  }

  /**
   * Expire what has waited too long, then take the first entry in play order
   * that `canPlay` accepts. A follower is served only once its leader has
   * left the queue; skipped entries keep their places.
   */
  next(
    now: number,
    canPlay: (e: QueuedFire<F>) => boolean = () => true,
  ): { entry: QueuedFire<F> | null; drops: QueueDrop<F>[] } {
    const drops = this.expire(now);

    for (const e of this.ordered()) {
      if (!this.isRoot(e) || !canPlay(e)) continue;

      this.removeEntry(e);

      return { entry: e, drops };
    }

    return { entry: null, drops };
  }

  remove(id: string): QueuedFire<F> | null {
    const e = this.entries.find((x) => x.id === id);

    if (e === undefined) return null;

    this.removeEntry(e);

    return e;
  }

  /**
   * Remove every waiting entry of `group`, superseded by `by` — a fire of
   * that group that has just taken the bus. Their followers become roots.
   */
  removeGroup(group: string, by: string): QueueDrop<F>[] {
    const drops: QueueDrop<F>[] = [];

    for (const old of this.entries.filter((e) => e.group === group)) {
      this.removeEntry(old);
      drops.push({ entry: old, reason: { kind: "superseded", by } });
    }

    return drops;
  }

  clear(): QueueDrop<F>[] {
    const drops = this.ordered().map((entry) => ({ entry, reason: { kind: "cleared" } as const }));
    this.entries = [];

    return drops;
  }

  private expire(now: number): QueueDrop<F>[] {
    const drops: QueueDrop<F>[] = [];

    for (const e of [...this.entries]) {
      if (isExpired(e, now)) {
        this.removeEntry(e);
        drops.push({ entry: e, reason: { kind: "expired", waitedMs: now - e.queuedAt, maxWaitMs: e.maxWaitMs } });
      }
    }

    return drops;
  }

  private roots(): QueuedFire<F>[] {
    return this.entries.filter((e) => this.isRoot(e));
  }

  private isRoot(e: QueuedFire<F>): boolean {
    return e.after === null || !this.has(e.after);
  }

  /** Whether `candidate` is on `entry`'s leader chain. */
  private isAncestorOf(candidate: QueuedFire<F>, entry: QueuedFire<F>): boolean {
    const seen = new Set<string>();
    let at: string | null = entry.after;

    while (at !== null && !seen.has(at)) {
      if (at === candidate.id) return true;

      seen.add(at);
      at = this.entries.find((x) => x.id === at)?.after ?? null;
    }

    return false;
  }

  /** Remove one entry; its followers become roots. */
  private removeEntry(e: QueuedFire<F>): void {
    this.entries = this.entries.filter((x) => x !== e);

    for (const f of this.entries) if (f.after === e.id) f.after = null;
  }
}
