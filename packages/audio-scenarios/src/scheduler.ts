/**
 * The scheduler (issue #1514): arbitration over the buses — whether a fire
 * may take its bus now, waits for it, or is dropped — and the schedule half
 * of every bus's state: its queue, its focus floor and its pending hold. It
 * owns `sessionGeneration`, stamps every contract's `lastFireAt`, asks the
 * speak-time gate and commits the pool picks (issue #1138), and starts and
 * cuts fires only by calling playback, which reports a bus take and a finish
 * back through `PlaybackListener`, synchronously.
 *
 * Scheduling rules (weight model, issue #652):
 *   - Only one scenario plays at a time on a given bus.
 *   - Higher `weight` wins a busy bus. A winner with `interrupt: true` cuts
 *     the in-flight lower-weight fire immediately; without it, it waits in
 *     the bus's queue for the current line to finish.
 *   - A fire that can't take the bus (equal/lower weight, or below an
 *     exclusive-focus floor) is deferred for idle-replay when
 *     `queueable: true`, else dropped. The deferred fire replays
 *     unconditionally — `where:` is NOT re-run, since it decided at event
 *     time; what must hold at speak time is the contract's `speakGate`
 *     (issue #1138), asked again on replay; freshness of the words comes
 *     from var resolvers at speak time. This preserves the former
 *     `low`-priority deferred-replay behaviour.
 *   - Same-`family` fires replace each other wholesale regardless of weight.
 *   - `acquireFocus`/`releaseFocus` raise a per-bus weight floor: while held,
 *     only fires at or above it (or the owner's own) play.
 *   - A `resumable` queueable fire cut by an `interrupt` stashes its expanded
 *     ops + position; the idle-replay re-expands and, when the expansion is
 *     unchanged, continues from the interrupted clip (re-keying the radio
 *     frame) instead of re-firing from the top (issue #758). A changed
 *     expansion falls back to a full fresh replay (#481 freshness).
 *   - Deferred fires wait in a bounded per-bus queue (`PendingQueue`, issue
 *     #1185): heaviest first, then the longest-waiting, then arrival order.
 *     A lighter newcomer waits rather than being dropped, and a heavier one
 *     evicts nothing. A newer fire replaces a waiting one of its
 *     `supersedeGroup` (the contract id by default); an arrival above
 *     `PENDING_QUEUE_CAPACITY` roots drops the lightest, then oldest — one
 *     entry per arrival, so a follower that drop frees stays;
 *     a fire not started within its `maxQueueWaitMs` of its FIRST deferral
 *     is dropped when the queue is next read. Every such drop is logged.
 *   - The bus drains its queue one fire at a time as it idles, replaying
 *     each through `attemptFire`: a replay that does not take the bus (gate
 *     refused, expansion aborted, no script, cooldown, disabled) drains the
 *     next at once, and one deferred again stops the drain. While a focus
 *     floor is held the drain skips what is below it, in place.
 *   - A finishing fire with `pendingHoldMs` delays the drain of the whole
 *     queue by that window, so a train of fires (count-in marks) doesn't let
 *     the displaced line stutter back into its gaps (issue #758).
 *   - A fire whose contract names a waiting fire in `queueBehind` is placed
 *     right after it whatever the weights (issue #1108), and does not count
 *     toward the cap; a follower never plays ahead of its waiting leader,
 *     even on an idle bus; a leader that leaves without playing, or fails to
 *     take the bus at replay, leaves its follower to play as an ordinary
 *     entry.
 *   - `session.changed` clears every bus's queue (and any armed hold) before
 *     that event's own contracts are dispatched, and a line still playing
 *     from the session that ended is not stashed when an interrupt cuts it,
 *     so nothing from that session is spoken in the new one.
 *
 * It expands nothing itself (`expansion.prepare` hands back an uncommitted
 * fire) and plays nothing itself (`playback`). The per-bus loops here —
 * `stopAll`, `cancelDisabled`, the session-change clear — run over the one
 * bus table, in its order, calling playback once per bus.
 */
import { AudioBus } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";

import type { ContractRegistry } from "./contract-registry.js";
import type { ScenarioContext, SpeakGate } from "./dsl.js";
import { DEFAULT_MAX_QUEUE_WAIT_MS, DEFAULT_WEIGHT } from "./dsl.js";
import {
  type BusTableView,
  type BusView,
  type CompiledScenario,
  type ExecOp,
  FRAME_PREVIEW_ID,
  type PreparedFire,
  type ResumeState,
  type WaitingFire,
} from "./engine-types.js";
import type { Expansion } from "./expansion.js";
import type { FramePreviewResult } from "./interpreter.js";
import type { QueuedFire, QueueDrop, QueueDropReason } from "./pending-queue.js";
import { opLabel, type Playback, type PlaybackListener } from "./playback.js";
import type { PoolStore } from "./pool-store.js";
import { buildResumeState, planResume } from "./resume.js";
import type { ScriptSet } from "./script-set.js";

/** What the scheduler reads of the other modules — only the members it uses. */
export type SchedulerDeps = {
  /** The registered contracts, for the running fire's and a waiting fire's contract. */
  contracts: Pick<ContractRegistry, "get">;
  /** The expansion generation a stash stamps, and the compile and compiled frames the preview reads. */
  scripts: Pick<ScriptSet, "generation" | "ensureCompiled" | "compiled">;
  /** The live manifest's open tick for a resume, and the put-back of a resumed head's takes. */
  pools: Pick<PoolStore, "currentManifest" | "restoreHeadPoolIndices">;
  /** A fire's and the preview's expansion, each handed back uncommitted. */
  expansion: Pick<Expansion, "prepare" | "prepareFrame">;
  /** The only way a fire starts or is cut. */
  playback: Pick<Playback, "takeBus" | "stepNext" | "cancelActiveFire">;
};

export class Scheduler implements PlaybackListener {
  /**
   * Bumped by every `session.changed` (issue #1185). The queue clear on that
   * event cannot reach a line still playing from the session that ended, so
   * the fire records the generation it started in and an interrupt cutting
   * it after the change drops it instead of stashing it.
   */
  private sessionGeneration = 0;

  constructor(
    private readonly logger: ILogger,
    /** Resolves the active Race Engineer voice key at fire time; `null` when none is selected. */
    private readonly getActiveVoice: () => string | null,
    /**
     * The one table of per-bus state (`BusTable`), seen here through
     * `BusTableView`: the schedule half is this module's to write, the
     * active fire is read-only and changed only through playback.
     */
    private readonly buses: BusTableView,
    private readonly deps: SchedulerDeps,
  ) {}

  // ── Playback's listener ──

  /** Playback's `busTaken`: a fire took the bus, so a hold armed at the previous fire's finish is obsolete. */
  busTaken(bus: AudioBus): void {
    this.clearPendingHold(this.buses.get(bus));
  }

  /**
   * Playback's `fireFinished`: the fire has left the bus and its `onSettled`
   * has run. Hold the drain for the contract's `pendingHoldMs`, else drain.
   */
  fireFinished(bus: AudioBus, scenarioId: string): void {
    const state = this.buses.get(bus);

    // A finishing fire in a train of related fires (count-in marks) holds the
    // drain of the whole queue for its declared window, so the displaced line
    // doesn't stutter back into the gaps between the train's members (issue
    // #758).
    const holdMs = this.deps.contracts.get(scenarioId)?.raw.pendingHoldMs ?? 0;

    if (state.schedule.queue.size > 0 && holdMs > 0) {
      this.clearPendingHold(state);
      this.logger.debug(`Pending drain held for ${holdMs} ms after "${scenarioId}"`);
      state.schedule.holdTimer = setTimeout(() => {
        state.schedule.holdTimer = null;
        this.drainPending(state);
      }, holdMs);

      return;
    }

    this.drainPending(state);
  }

  // ── Runtime API ──

  /**
   * A disabled contract's fires, wherever they are (`setEnabled(false)`):
   * cancel in-flight execution on any bus + remove its waiting entry. A fire
   * that waited behind it (issue #1108) stays, as an ordinary entry (issue
   * #1185). The disable's timer clear is the triggers' and runs before this.
   */
  cancelDisabled(scenarioId: string): void {
    for (const [bus, state] of this.buses.entries()) {
      const wasActive = state.transport.active?.id === scenarioId;

      if (wasActive) this.deps.playback.cancelActiveFire(bus);

      if (state.schedule.queue.remove(scenarioId) !== null)
        this.logger.debug(`Scenario "${scenarioId}" dropped — disabled`);

      // Disabling the in-flight scenario idled the bus — play whatever was
      // waiting behind it rather than stranding it (issue #652 review).
      if (wasActive && state.transport.active === null) this.drainPending(state);
    }
  }

  /**
   * See `IScenarioEngine.playFramePreview`. A separate entry point rather
   * than a contract: a frame wraps speech, so `applyFrame` gives a body with
   * no clip no frame, and the preview is the one legitimate frame around
   * silence. It owns no cooldown, gate or resume — it is never stashed, so a
   * cut preview is over. `attemptFire` is what makes it yield: it treats a
   * bus the preview holds as idle and cuts the preview (`yieldPreview`) only
   * once the arriving fire has expanded to something to play.
   */
  playFramePreview(frameName: string, holdMs: number, onComplete?: () => void): FramePreviewResult {
    this.deps.scripts.ensureCompiled();

    const voice = this.getActiveVoice();
    const script = voice === null ? undefined : this.deps.scripts.compiled(voice);

    if (voice === null || script === undefined || !script.frames.has(frameName)) {
      this.logger.debug(`Frame preview "${frameName}" unavailable for voice "${voice ?? "(none)"}"`);

      return "no-frame";
    }

    const state = this.buses.get(AudioBus.Voice);

    if (state.transport.active !== null || state.schedule.queue.size > 0 || state.schedule.focus !== null) {
      this.logger.debug(`Frame preview "${frameName}" skipped — the Voice bus is in use`);

      return "bus-busy";
    }

    const prepared = this.deps.expansion.prepareFrame(frameName, voice, script);

    if (prepared === null) return "no-frame";

    // No gate stands between the preview and the bus: its picks are committed
    // at once, before the empty check below.
    prepared.commit();

    const { frame } = prepared;

    if (frame.open.length === 0 && frame.close.length === 0) {
      // Both switches off: nothing to audition, and no reason to hold the
      // bus for a silent window.
      onComplete?.();

      return "playing";
    }

    const ops: ExecOp[] = [...frame.open, { kind: "pause", ms: holdMs }, ...frame.close];

    this.deps.playback.takeBus({
      id: FRAME_PREVIEW_ID,
      bus: AudioBus.Voice,
      // Never compared: an arriving fire treats the preview's bus as idle.
      weight: 0,
      ops,
      sourceOps: ops,
      sourceStart: 0,
      prerollCount: 0,
      event: null,
      sessionGeneration: this.sessionGeneration,
      cutTail: [],
      ended: false,
      onSettled: onComplete,
    });

    this.logger.info(`Playing frame preview "${frameName}" for voice "${voice}"`);
    this.logger.debug(`Ops (${ops.length}): ${ops.map(opLabel).join(" | ")}`);

    this.deps.playback.stepNext(AudioBus.Voice);

    return "playing";
  }

  /**
   * Cut the frame preview if it holds the bus (issue #1124), so a fire that
   * is about to play takes the bus as if it were idle. Called only once
   * that fire has expanded to something to play: one that aborts leaves
   * the preview running.
   */
  private yieldPreview(bus: AudioBus, state: BusView): void {
    if (state.transport.active?.id === FRAME_PREVIEW_ID) this.deps.playback.cancelActiveFire(bus);
  }

  /**
   * Cancel every in-flight fire on all buses and clear every bus's queue of
   * deferred replays (unlogged per entry: the reset is the reason). Used when the Race Engineer master gate flips off so a callout
   * caught mid-playback is stopped immediately — including its looping
   * ambient bed (in each fire's `usedChannels`) — and the active fire is
   * cleared so the bus isn't wedged. Without this the gate-off path only
   * mutes the buses: the ambient loop is orphaned (and becomes audible again
   * on re-enable) and the stuck active fire makes `attemptFire` drop every
   * later callout as "bus busy" for the rest of the session (issue #587).
   *
   * `cancelActiveFire` is a no-op on a bus with no active fire, so this is
   * safe to call whether or not anything is playing.
   */
  stopAll(): void {
    for (const [bus, state] of this.buses.entries()) {
      this.deps.playback.cancelActiveFire(bus);
      state.schedule.queue.clear();
      this.clearPendingHold(state);
      // Release any held focus floor too, so it can't outlive the reset and
      // block every later callout on re-enable (issue #652 review).
      state.schedule.focus = null;
    }
  }

  /** Cancel every bus's pending hold, for `dispose`: no timer outlives the engine. */
  clearHolds(): void {
    for (const state of this.buses.values()) this.clearPendingHold(state);
  }

  acquireFocus(bus: AudioBus, ownerId: string, floorWeight: number): void {
    const state = this.buses.get(bus);
    state.schedule.focus = { ownerId, floor: floorWeight };
    this.logger.debug(`Focus acquired on bus ${bus} by "${ownerId}" (floor ${floorWeight})`);
  }

  releaseFocus(bus: AudioBus, ownerId: string): void {
    const state = this.buses.get(bus);

    if (state.schedule.focus?.ownerId !== ownerId) return;

    state.schedule.focus = null;
    this.logger.debug(`Focus released on bus ${bus} by "${ownerId}"`);

    // A fire deferred while below the floor may now be playable.
    if (state.transport.active === null) this.drainPending(state);
  }

  // ── The line ends' two calls ──

  /**
   * Remove a contract's waiting fire from a bus's queue and log the drop
   * with `reason` (an end, issue #1407). Returns whether one was waiting.
   * The queue is this module's; the line ends see no bus's schedule.
   */
  dropWaiting(bus: AudioBus, id: string, reason: QueueDropReason): boolean {
    const waiting = this.buses.get(bus).schedule.queue.remove(id);

    if (waiting === null) return false;

    this.logQueueDrops([{ entry: waiting, reason }]);

    return true;
  }

  /** Drain a bus's queue now that a silent stop idled it (see `drainPending`). */
  drain(bus: AudioBus): void {
    this.drainPending(this.buses.get(bus));
  }

  // ── Firing pipeline ──

  /**
   * Offer a fire to its bus: the cooldown, the focus floor, the weight
   * model against what is playing, the `queueBehind` leader check, the
   * expansion and the gate, then the bus take. `event` is `null` for an
   * imperative fire. The last three parameters are the idle-replay's
   * (`replayWaiting`): the stash to continue from, whether the fire already
   * passed its gate (`WaitingFire.admitted`), and when it was first deferred.
   */
  attemptFire(
    entry: CompiledScenario,
    event: SimEventOf<SimEventName> | null,
    resume?: ResumeState,
    admitted = false,
    queuedAt?: number,
  ): void {
    const now = Date.now();

    // A resume is a continuation of a fire that already passed (and stamped)
    // the cooldown — re-checking it here would drop the tail of an
    // interrupted line (issue #758).
    if (!resume && entry.raw.cooldown && entry.lastFireAt > 0 && now - entry.lastFireAt < entry.raw.cooldown) return;

    const bus = entry.raw.bus;
    const state = this.buses.get(bus);
    const weight = entry.raw.weight ?? DEFAULT_WEIGHT;

    // Exclusive-focus floor (issue #652): while an owner holds the bus, a
    // non-owner fire BELOW the floor is blocked. The owner's own fires
    // (matching `focusOwner`) always pass; fires AT OR ABOVE the floor break
    // through and schedule normally below — so a floor set to the SAFETY band
    // admits the safety-flag callouts while holding back routine chatter.
    if (this.belowFloor(state, entry.raw.focusOwner, weight)) {
      const reason = `below focus floor (${state.schedule.focus?.ownerId ?? ""})`;
      this.queueOrDrop(entry, event, weight, state, reason, resume, admitted, queuedAt);

      return;
    }

    // A bus the frame preview holds counts as idle: the preview yields to
    // every callout (issue #1124), and is cut below once this fire has
    // expanded to something to play.
    const playingId = state.transport.active?.id ?? null;

    if (playingId !== null && playingId !== FRAME_PREVIEW_ID) {
      const running = this.deps.contracts.get(playingId);
      const runningWeight = state.transport.active?.weight ?? DEFAULT_WEIGHT;

      // Same-family preemption: a new event in a family invalidates the
      // in-flight callout for that family (e.g. tire-set switch mid-playback).
      // A wholesale replacement regardless of weight — the new fire is fresher
      // info about the same subject, so the old one is not stashed for replay.
      const sameFamily =
        entry.raw.family !== undefined && running !== undefined && entry.raw.family === running.raw.family;

      const interruptCut = weight > runningWeight && entry.raw.interrupt === true;

      if (sameFamily || interruptCut) {
        // This fire would silence the in-flight one — expand FIRST (issue
        // #835), so a fire that aborts (or expands empty) never cancels
        // what's playing.
        const expanded = this.prepareOps(entry, event, admitted);

        if (expanded === null) return;

        // Higher weight + interrupt: cut the in-flight fire immediately. If
        // that fire is queueable, stash it so it replays once we're done.
        // (A same-family replacement never stashes — the new fire is fresher
        // info about the same subject.)
        if (!sameFamily) this.stashRunningIfQueueable(state, running);

        this.deps.playback.cancelActiveFire(bus);

        if (!resume) entry.lastFireAt = now;

        if (!admitted) this.supersedeWaitingOfGroup(state, entry);

        this.executeFire(entry, event, expanded, resume);

        return;
      }

      if (weight > runningWeight) {
        // Higher weight, no interrupt: win the bus but let the current line
        // finish — wait in the queue, queueable or not.
        const reason = "waiting for bus (higher weight, no interrupt)";
        this.enqueue(entry.raw.id, event, weight, state, reason, resume, admitted, queuedAt);

        return;
      }

      // Equal or lower weight: can't take the bus now.
      this.queueOrDrop(entry, event, weight, state, "bus busy", resume, admitted, queuedAt);

      return;
    }

    // An idle bus can still have fires waiting — held back by a
    // `pendingHoldMs` hold, or parked below a focus floor this fire clears.
    // A fire whose contract waits behind one of THOSE must not play past it
    // (issue #1108): it is queued behind it here exactly as it would be on a
    // busy bus, and the drain plays the two in order.
    if (state.schedule.queue.hasLeaderFor(entry.raw.id, now)) {
      const reason = "the fire it waits behind is pending";
      this.enqueue(entry.raw.id, event, weight, state, reason, resume, admitted, queuedAt);

      return;
    }

    const expanded = this.prepareOps(entry, event, admitted);

    if (expanded === null) return;

    this.yieldPreview(bus, state);

    if (!resume) entry.lastFireAt = now;

    if (!admitted) this.supersedeWaitingOfGroup(state, entry);

    this.executeFire(entry, event, expanded, resume);
  }

  /**
   * A fire that is about to take the bus is the newest of its
   * `supersedeGroup`: what still waits of that group is older and would
   * play stale after it (issue #1185) — fuel-laps-left-5 waiting below a
   * floor or out a `pendingHoldMs` hold, behind a fuel-laps-left-3 that
   * cleared it. Each is dropped, logged as superseded; their followers stay
   * as ordinary entries. Not called for an interrupt's stash coming back
   * (`admitted`): it is the older fire, and a newer one of its group would
   * already have replaced it, or made it yield, in the queue.
   */
  private supersedeWaitingOfGroup(state: BusView, entry: CompiledScenario): void {
    this.logQueueDrops(state.schedule.queue.removeGroup(entry.raw.supersedeGroup ?? entry.raw.id, entry.raw.id));
  }

  /**
   * Whether a fire of `weight` on a bus is held back by its focus floor
   * (issue #652): a floor is held, the fire is not its owner's, and its
   * weight is below the floor. The one predicate both `attemptFire` and the
   * drain read, so the drain never takes off the queue a fire that
   * `attemptFire` would only park again.
   */
  private belowFloor(state: BusView, focusOwner: string | undefined, weight: number): boolean {
    const focus = state.schedule.focus;

    return focus !== null && focusOwner !== focus.ownerId && weight < focus.floor;
  }

  /** Defer a fire for idle-replay when `queueable`, otherwise drop it. */
  private queueOrDrop(
    entry: CompiledScenario,
    event: SimEventOf<SimEventName> | null,
    weight: number,
    state: BusView,
    reason: string,
    resume?: ResumeState,
    admitted = false,
    queuedAt?: number,
  ): void {
    if (entry.raw.queueable === true) {
      this.enqueue(entry.raw.id, event, weight, state, `deferred (${reason})`, resume, admitted, queuedAt);
    } else {
      this.logger.debug(`Scenario "${entry.raw.id}" dropped (${reason})`);
    }
  }

  /**
   * Offer a fire to the bus's queue (issue #1185). The queue places it —
   * heaviest first, then the longest-waiting, a `queueBehind` follower right
   * after its leader — supersedes any waiting fire of its group, applies the
   * cap and drops what has waited too long; this logs every drop and the
   * newcomer's place. `queuedAt` is the time of the fire's FIRST deferral: a
   * replay deferred again passes its own, so its max wait still runs from
   * then. `admitted` travels with the fire (see `WaitingFire.admitted`).
   * `yieldsToGroup` marks an interrupt's stash, which gives way to a newer
   * waiting fire of its group instead of replacing it.
   */
  private enqueue(
    id: string,
    event: SimEventOf<SimEventName> | null,
    weight: number,
    state: BusView,
    reason: string,
    resume?: ResumeState,
    admitted = false,
    queuedAt: number = Date.now(),
    yieldsToGroup = false,
  ): void {
    const raw = this.deps.contracts.get(id)?.raw;
    const result = state.schedule.queue.offer(
      {
        id,
        weight,
        group: raw?.supersedeGroup ?? id,
        queuedAt,
        maxWaitMs: raw?.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS,
        fire: { id, event, weight, resume, admitted, queuedAt },
        yieldsToGroup,
      },
      Date.now(),
    );

    this.logQueueDrops(result.drops);

    if (result.position !== null) {
      const behind = result.behind !== null ? ` behind "${result.behind}"` : "";
      this.logger.debug(`Scenario "${id}" pending (${result.position} of ${result.size})${behind} — ${reason}`);
    }
  }

  /** One debug line per fire that left a queue without playing, naming why (issue #1185). */
  private logQueueDrops(drops: readonly QueueDrop<WaitingFire>[]): void {
    for (const { entry, reason } of drops) {
      const why =
        reason.kind === "superseded"
          ? `superseded by "${reason.by}"`
          : reason.kind === "queue-full"
            ? "queue full (lightest)"
            : reason.kind === "expired"
              ? `waited ${reason.waitedMs} ms (max ${reason.maxWaitMs} ms)`
              : reason.kind === "ended"
                ? "ended"
                : "session changed";
      this.logger.debug(`Scenario "${entry.id}" dropped — ${why}`);
    }
  }

  /**
   * A new session began (issue #1185): nothing waiting from the one that
   * ended is still true. Clear every bus's queue, logging each fire, and
   * cancel any armed hold — a hold whose drain would find the queue empty
   * anyway, cancelled so no timer outlives the reset. Runs before the
   * event's own contracts (see the facade's constructor). It also opens a
   * new `sessionGeneration`, so a line still playing from the old session is
   * not stashed if an interrupt cuts it.
   */
  clearQueuesForSessionChange(): void {
    this.sessionGeneration++;

    for (const state of this.buses.values()) {
      this.clearPendingHold(state);
      this.logQueueDrops(state.schedule.queue.clear());
    }
  }

  /**
   * When an interrupt cut a queueable fire, keep it for idle-replay. It was
   * playing, so it had passed its gate: the stash is marked `admitted`
   * whether it resumes from the cut (`resumable`) or replays whole, and the
   * replay is not asked again (issue #1138). It is a new deferral, so its max
   * wait runs from now; a full queue may drop it as the cap's victim, which
   * is logged like any other drop and discards its resume with it.
   *
   * A fire of its `supersedeGroup` already waiting arrived while this one
   * played, so it is the newer: the stash yields to it and is dropped,
   * logged as superseded by it (issue #1185). Replacing it instead would
   * replay the cut line over the newer one — and in a group whose `where:`
   * writes one stash a resolver reads (the #922 shape), speak the newer
   * fire's subject in the older line.
   *
   * A fire that began before the last `session.changed` is not stashed at
   * all: it is dropped, logged as `session changed` (see
   * `sessionGeneration`). Neither is the cut tail of an ended fire (issue
   * #1407), which is never re-queued.
   */
  private stashRunningIfQueueable(state: BusView, running: CompiledScenario | undefined): void {
    const active = state.transport.active;

    if (!active || !running || running.raw.queueable !== true) return;

    // An ended fire's cut tail (issue #1407) is never re-queued: the line it
    // abandons stopped being true, whatever `queueable` says.
    if (active.ended) return;

    if (active.sessionGeneration !== this.sessionGeneration) {
      this.logger.debug(`Scenario "${active.id}" dropped — session changed`);

      return;
    }

    const resume =
      running.raw.resumable === true
        ? buildResumeState(active, this.getActiveVoice(), this.deps.scripts.generation)
        : undefined;
    this.enqueue(active.id, active.event, active.weight, state, "stashed (preempted)", resume, true, undefined, true);
  }

  /**
   * Expand a fire (`expansion.prepare` — the abort decision point, issue
   * #835), ask its contract's speak-time gate, and commit its pool picks, in
   * that order. Returns `null` when the fire must not play: for every reason
   * the expansion has (no script for the voice, a required step resolving to
   * nothing, a throw, an empty body — each logged there), and for a gate
   * that refused. `attemptFire` calls this BEFORE any bus cancellation, so an
   * aborting or refused fire can't silence an in-flight one, and stamps no
   * cooldown.
   *
   * The speak-time gate (issue #1138) runs LAST, once the body has expanded
   * to something to play: the contract's `speakGate.admit` is asked with the
   * fire's context — the resolved vars included — and `false` returns `null`
   * exactly like a required-step abort, so the fire stamps no cooldown,
   * takes no bus and cancels nothing in flight. It runs after expansion so
   * that a claim committed inside it (#1137) is committed for a callout that
   * will play, and so a body that aborts never reaches it. A fire deferred
   * before it ever expanded re-enters here at idle-replay and is asked
   * then, for the first time; a fire that already passed the gate — cut and
   * stashed, resumed, or replayed whole — is not asked again, which is what
   * `admitted` says (see `WaitingFire.admitted`): a gate that committed a
   * claim on the way in must not be asked to claim the same fire twice, and
   * one that reads live state must not drop the tail of a line the engineer
   * has already begun. Note what that covers: `executeFire` continues from
   * the interrupted clip only when the fresh expansion still matches the
   * stashed one and otherwise replays the whole body from the top (the #481
   * freshness fallback), and a non-`resumable` fire the cut stashed replays
   * whole with no resume at all — every one of those is the same fire, which
   * passed the gate once, so none is asked again. A contract that is both
   * `queueable` and gated must be able to tolerate that.
   */
  private prepareOps(
    entry: CompiledScenario,
    event: SimEventOf<SimEventName> | null,
    admitted = false,
  ): PreparedFire | null {
    const prepared = this.deps.expansion.prepare(entry, event);

    if (prepared === null) return null;

    // The speak-time gate (issue #1138): the contract's second look, in code,
    // after the body expanded and before the ops take the bus — so it holds
    // for every voice, whatever its script says. A fire that already passed
    // the gate — cut and stashed, resumed, or replayed whole — is the same
    // fire (and may have committed its claim there), so it is not asked
    // again; a fire deferred before it expanded re-enters here and is.
    const gate = entry.raw.speakGate;

    if (gate !== undefined && !admitted && !this.admits(gate, entry.raw.id, prepared.ctx)) {
      this.logger.debug(`Scenario "${entry.raw.id}" skipped — speak-time gate: ${gate.description}`);

      return null;
    }

    // Accepted: the takes this fire drew are now the ones the driver hears.
    prepared.commit();

    return prepared.fire;
  }

  /**
   * Ask a speak-time gate (issue #1138). A gate that throws is logged at
   * error and treated as a refusal: the fire it was asked about is dropped
   * like any other refused one, never played on the strength of a check
   * that did not complete.
   */
  private admits(gate: SpeakGate, scenarioId: string, ctx: ScenarioContext): boolean {
    try {
      return gate.admit(ctx);
    } catch (err) {
      this.logger.error(
        `Scenario "${scenarioId}" speak-time gate failed: ${err instanceof Error ? err.message : String(err)}`,
      );

      return false;
    }
  }

  private executeFire(
    entry: CompiledScenario,
    event: SimEventOf<SimEventName> | null,
    prepared: PreparedFire,
    resume?: ResumeState,
  ): void {
    const expanded = prepared.ops;

    // Resume from an interrupt cut (issue #758): `planResume` continues from
    // the interrupted clip when the fresh expansion is unchanged from the
    // stashed one, and falls back to the full fresh replay (the #481
    // freshness guarantee) when the state moved on while stashed.
    let ops = expanded;
    let sourceStart = 0;
    let prerollCount = 0;

    const plan = planResume(resume, expanded, entry.resolvedSequence !== null, {
      activeVoice: () => this.getActiveVoice(),
      generation: () => this.deps.scripts.generation,
      openTick: () => this.deps.pools.currentManifest().ticks.open,
    });

    if (plan.kind === "resume") {
      ({ ops, sourceStart, prerollCount } = plan);
      // `ops` is everything still to be heard — the re-key included — so
      // the pools it does NOT draw are the ones whose fresh commit is
      // about to be sliced away unheard (issue #1136).
      this.deps.pools.restoreHeadPoolIndices(plan.head, ops);
    } else if (plan.kind === "whole") {
      this.logger.debug(`Scenario "${entry.raw.id}" replays whole — ${plan.blocked}`);
    }

    const bus = entry.raw.bus;
    this.deps.playback.takeBus({
      id: entry.raw.id,
      bus,
      weight: entry.raw.weight ?? DEFAULT_WEIGHT,
      ops,
      sourceOps: expanded,
      sourceStart,
      prerollCount,
      event,
      sessionGeneration: this.sessionGeneration,
      cutTail: prepared.cutTail,
      ended: false,
    });

    if (sourceStart > 0) {
      this.logger.info(`Resuming scenario "${entry.raw.id}"`);
      this.logger.debug(`Resumed at op ${sourceStart}/${expanded.length}`);
    } else {
      this.logger.info(`Playing scenario "${entry.raw.id}"`);
    }

    this.logger.debug(`Ops (${ops.length}): ${ops.map(opLabel).join(" | ")}`);

    this.deps.playback.stepNext(bus);
  }

  /** Cancel an armed pending-hold timer (no-op when none is armed). */
  private clearPendingHold(state: BusView): void {
    if (state.schedule.holdTimer === null) return;

    clearTimeout(state.schedule.holdTimer);
    state.schedule.holdTimer = null;
  }

  /**
   * Play what waits in the bus's queue, one fire at a time, now that the bus
   * is idle (issue #1185). Each fire replays unconditionally — `where:` is
   * NOT re-evaluated: it decided at event time; what must hold at speak time
   * is the contract's `speakGate` (issue #1138), which the replay's
   * `prepareOps` asks of a fire deferred before it ever expanded — and never
   * again of one that already passed it (see `WaitingFire.admitted`) — and a
   * claim belongs there rather than in `where:` (issue #1137). Freshness of
   * the words is preserved by the var resolvers, which read live state at
   * replay expansion rather than from the frozen event payload.
   *
   * The queue hands out the first entry, in play order, that `attemptFire`
   * would let take an idle bus: not below a held focus floor (the same
   * predicate, `belowFloor`), and not a fire one of whose `queueBehind`
   * leaders is still waiting (the idle-bus check in `attemptFire`). Skipped
   * entries keep their places, and a follower is never handed out ahead of
   * the leader it is linked behind. What the queue expired on the way is
   * logged.
   *
   * A replay that takes the bus ends the drain; the next one runs when it
   * finishes. A replay that does not — its expansion aborted, its gate
   * refused, its cooldown or a disable stopped it, the voice has no script
   * for it — leaves the bus idle and the loop takes the next entry at once,
   * so a refused head never stalls the queue and a leader's follower plays
   * next. A replay that is deferred again (re-offered with its original
   * `queuedAt`) stops the drain rather than taking it off the queue again.
   */
  private drainPending(state: BusView): void {
    this.clearPendingHold(state);

    while (state.transport.active === null) {
      const { entry, drops } = state.schedule.queue.next(Date.now(), (e) => this.playableAtIdle(state, e));

      this.logQueueDrops(drops);

      if (entry === null) return;

      this.replayWaiting(entry.fire);

      // Deferred again: it is back in the queue with its original `queuedAt`
      // — stop, rather than take the same fire off the queue in a loop. A
      // defensive bound: `playableAtIdle` filters out every idle-bus
      // re-deferral `attemptFire` knows today (the focus floor, a waiting
      // `queueBehind` leader), so this should not trigger; it is what keeps
      // a future disagreement between the two from looping.
      if (state.schedule.queue.has(entry.id)) return;
    }
  }

  /**
   * Whether `attemptFire` would let this waiting fire take an idle bus now,
   * rather than park it again: the drain's filter (see `drainPending`).
   */
  private playableAtIdle(state: BusView, e: QueuedFire<WaitingFire>): boolean {
    if (this.belowFloor(state, this.deps.contracts.get(e.id)?.raw.focusOwner, e.weight)) return false;

    return !state.schedule.queue.hasLeaderFor(e.id, Date.now());
  }

  /** Replay one parked fire, unless its scenario has been disabled meanwhile. */
  private replayWaiting(waiting: WaitingFire): void {
    const entry = this.deps.contracts.get(waiting.id);

    if (!entry?.enabled) {
      this.logger.debug(`Scenario "${waiting.id}" dropped — disabled`);

      return;
    }

    this.logger.debug(`Replaying pending scenario "${waiting.id}"`);
    this.attemptFire(entry, waiting.event, waiting.resume, waiting.admitted, waiting.queuedAt);
  }
}
