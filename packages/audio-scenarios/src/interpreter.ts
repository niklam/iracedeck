/**
 * Audio Scenario Interpreter — the heart of `@iracedeck/audio-scenarios`.
 *
 * Subscribes to `@iracedeck/event-bus` on behalf of every registered
 * scenario, expands the `Step` tree at fire time (shorthand → ops; pool /
 * variable / include / conditional resolution), then walks the expanded op
 * list one step at a time driving `@iracedeck/audio-service`.
 *
 * Scheduling rules (weight model, issue #652):
 *   - Only one scenario plays at a time on a given bus.
 *   - Higher `weight` wins a busy bus. A winner with `interrupt: true` cuts
 *     the in-flight lower-weight fire immediately; without it, it waits for
 *     the current line to finish (becomes the pending next fire).
 *   - A fire that can't take the bus (equal/lower weight, or below an
 *     exclusive-focus floor) is deferred for idle-replay when
 *     `queueable: true`, else dropped. The deferred fire replays
 *     unconditionally — `where:` is NOT re-run (a side-effecting predicate
 *     would mis-fire); freshness comes from var resolvers at speak time. This
 *     preserves the former `low`-priority deferred-replay behaviour.
 *   - Same-`family` fires replace each other wholesale regardless of weight.
 *   - `acquireFocus`/`releaseFocus` raise a per-bus weight floor: while held,
 *     only fires at or above it (or the owner's own) play.
 *   - A `resumable` queueable fire cut by an `interrupt` stashes its expanded
 *     ops + position; the idle-replay re-expands and, when the expansion is
 *     unchanged, continues from the interrupted clip (re-keying the radio
 *     frame) instead of re-firing from the top (issue #758). A changed
 *     expansion falls back to a full fresh replay (#481 freshness).
 *   - A finishing fire with `pendingHoldMs` delays the pending drain by that
 *     window, so a train of fires (count-in marks) doesn't let the displaced
 *     line stutter back into its gaps (issue #758).
 *
 * Channel routing for clip steps:
 *   - Paths matching the manifest's walkie-talkie ticks go on the SFX channel.
 *   - Everything else goes on the scenario's declared `channel` (typically Voice).
 *   - The Ambient channel is driven exclusively by `{ ambient: "start|stop|seek" }`.
 */
import type { AudioBus, IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import type { ResolvedStep, Scenario, ScenarioContext } from "./dsl.js";
import { applyBase, DEFAULT_WEIGHT, resolveStep } from "./dsl.js";
// Manifest types + helpers live in `./manifest.js` to break a circular
// import with `./validation.js`, which also needs `manifestVoices`.
import { type AudioAssetsManifest, manifestVoices } from "./manifest.js";
import { validateScenario } from "./validation.js";

// Re-export so existing consumers of `interpreter.js` keep their import paths.
export { type AudioAssetsManifest, manifestVoices } from "./manifest.js";

export interface IScenarioEngine {
  defineScenario(s: Scenario): void;
  definePool(name: string, clips: string[]): void;
  defineVar(name: string, resolver: () => string | null): void;
  setEnabled(scenarioId: string, enabled: boolean): void;
  fire(scenarioId: string): void;
  stopAll(): void;
  /**
   * Raise an exclusive-focus weight floor on a bus (issue #652). While held,
   * only fires whose `weight` is at or above `floorWeight` — or whose
   * `focusOwner` matches `ownerId` — can play; everything else defers (when
   * `queueable`) or drops. Used by owners like the spotter engine to hold the
   * Voice bus while a car is alongside (set the floor to the band you want to
   * admit, e.g. `WEIGHT.SAFETY` to let safety flags through).
   */
  acquireFocus(bus: AudioBus, ownerId: string, floorWeight: number): void;
  /** Release a focus floor previously acquired by `ownerId` (no-op if another owner holds it). */
  releaseFocus(bus: AudioBus, ownerId: string): void;
}

type PoolState = { clips: string[]; lastIndex: number };

type CompiledScenario = {
  raw: Scenario;
  resolvedSequence: ResolvedStep[];
  enabled: boolean;
  unsubscribe: (() => void) | null;
  lastFireAt: number;
  /**
   * Active `triggerDelay` timer handle, if any. New event arrivals cancel
   * and replace the pending timer so the most recent trigger wins. Cleared
   * on timer expiry, on `unsubscribe`, and on `defineScenario` replacement.
   */
  pendingTriggerTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * A fire waiting for the bus to idle — either a higher-weight fire that won
 * the bus but is letting the current line finish (no `interrupt`), or a
 * lower/equal-weight `queueable` fire deferred behind what's playing. The
 * highest-weight pending fire wins the single slot; ties go to the newest.
 * Retains the triggering event so the replay resolves vars against the same
 * payload the original fire would have used — critical for scenarios like
 * service-reminder that decode pit-flags from the event's telemetry snapshot.
 */
type PendingFire = {
  id: string;
  event: SimEventOf<SimEventName> | null;
  weight: number;
  /**
   * Present when an `interrupt` cut a `resumable` fire mid-playback: the
   * fire's full expanded ops and the index of the op that was in flight when
   * it was cut. The idle-replay uses this to continue from the interrupted
   * clip instead of re-firing from the top (issue #758).
   */
  resume?: ResumeState;
};

/** Where an interrupted resumable fire left off, for continuation at idle-replay. */
type ResumeState = {
  /** The interrupted fire's FULL original expansion. */
  ops: ExecOp[];
  /** Index of the op that was in flight when the fire was cut. */
  index: number;
};

/**
 * Per-bus execution state. Each audio bus can independently be playing a
 * scenario, holding a pending fire for replay on idle, and/or holding an
 * exclusive-focus floor.
 */
type BusState = {
  playingId: string | null;
  /** Single highest-weight fire waiting to play when the bus next idles. */
  pending: PendingFire | null;
  activeFire: ActiveFire | null;
  /** Exclusive-focus floor (issue #652); non-owner fires need weight above `floor`. */
  focus: { ownerId: string; floor: number } | null;
  /**
   * Armed by `finishFire` when the finished scenario declares `pendingHoldMs`
   * and a pending fire is waiting: the drain runs when the timer expires
   * instead of immediately. Cancelled when a new fire takes the bus (it
   * re-arms at that fire's finish) and by `stopAll` (issue #758).
   */
  pendingHoldTimer: ReturnType<typeof setTimeout> | null;
};

type ActiveFire = {
  id: string;
  bus: AudioBus;
  /** Scheduling weight of this fire — compared against arriving fires. */
  weight: number;
  ops: ExecOp[];
  index: number;
  /**
   * Source mapping back to the fire's FULL original expansion, so a resumed
   * fire that is cut AGAIN can stash its position in the original expansion
   * rather than in the resumed tail (issue #758). For a fresh fire,
   * `sourceOps === ops` with `sourceStart === prerollCount === 0`; for a
   * resumed fire, `ops` is `[re-open tick?] + sourceOps.slice(sourceStart)`.
   */
  sourceOps: ExecOp[];
  sourceStart: number;
  prerollCount: number;
  cancelled: boolean;
  pauseTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Channels this fire can touch — computed once from the expanded ops and
   * used by `cancelActiveFire` so we don't stop channels belonging to
   * scenarios running on other buses.
   */
  usedChannels: ReadonlySet<AudioChannel>;
  /**
   * Triggering event retained so a queueable fire that gets preempted (cut by
   * an `interrupt`, or deferred behind a busier bus) can be replayed with the
   * same `ctx.data` / `ctx.telemetry` it would have seen originally. Mirrors
   * the `PendingFire.event` shape.
   */
  event: SimEventOf<SimEventName> | null;
};

/**
 * Post-expansion execution ops. Each op is either a blocking play (wait for
 * channel-complete) or a fire-and-forget side-effect (ambient, pause).
 */
type ExecOp =
  | { kind: "play"; channel: AudioChannel; path: string }
  | { kind: "ambient"; action: "start" | "stop" | "seek" }
  | { kind: "pause"; ms: number };

class ScenarioEngine implements IScenarioEngine {
  private readonly eventBus: IEventBus;
  private readonly audio: IAudioService;
  private readonly manifest: AudioAssetsManifest;
  private readonly logger: ILogger;
  /**
   * Resolves the active Race Engineer voice key (e.g. `"luca"`) at clip-
   * resolution time. Used to substitute `{voice}` placeholders in scenario
   * `base` and pool clips. Returns `null` if no voice is selected.
   */
  private readonly getActiveVoice: () => string | null;

  private readonly scenarios = new Map<string, CompiledScenario>();
  private readonly pools = new Map<string, PoolState>();
  private readonly vars = new Map<string, () => string | null>();
  private readonly busState = new Map<AudioBus, BusState>();

  constructor(
    eventBus: IEventBus,
    audio: IAudioService,
    manifest: AudioAssetsManifest,
    logger: ILogger,
    getActiveVoice: () => string | null = () => null,
  ) {
    this.eventBus = eventBus;
    this.audio = audio;
    this.manifest = manifest;
    this.logger = logger;
    this.getActiveVoice = getActiveVoice;
  }

  /**
   * Substitute `{voice}` in a path with the active voice. No-op when the
   * path has no placeholder. Returns the path unchanged when the placeholder
   * is present but no voice is selected — the resulting malformed path
   * (e.g. `voice//pit-actions/fuel-on.mp3`) will fail to play and surface
   * loudly via the audio engine, which is the right behaviour: a templated
   * scenario without a voice means the user hasn't picked one yet.
   */
  private substituteVoice(path: string): string {
    if (!path.includes("{voice}")) return path;

    const voice = this.getActiveVoice() ?? "";

    return path.replace(/\{voice\}/g, voice);
  }

  // ── Definition API ──

  defineScenario(s: Scenario): void {
    const existing = this.scenarios.get(s.id);

    if (existing) {
      this.logger.warn(`Scenario "${s.id}" redefined; replacing previous definition`);
      existing.unsubscribe?.();

      if (existing.pendingTriggerTimer !== null) {
        clearTimeout(existing.pendingTriggerTimer);
        existing.pendingTriggerTimer = null;
      }
    }

    let resolvedSequence: ResolvedStep[];

    try {
      resolvedSequence = s.sequence.map(resolveStep);
    } catch (err) {
      this.logger.error(`Scenario "${s.id}" rejected: ${err instanceof Error ? err.message : String(err)}`);

      return;
    }

    const entry: CompiledScenario = {
      raw: s,
      resolvedSequence,
      enabled: true,
      unsubscribe: null,
      lastFireAt: 0,
      pendingTriggerTimer: null,
    };

    this.scenarios.set(s.id, entry);

    const errors = validateScenario(s, resolvedSequence, this.scenarios, this.pools, this.vars, this.manifest);

    if (errors.length > 0) {
      this.logger.error(`Scenario "${s.id}" has validation errors and is disabled:\n  - ${errors.join("\n  - ")}`);
      entry.enabled = false;

      return;
    }

    if (s.when) {
      entry.unsubscribe = this.subscribeToEvent(s.id, s.when.event, s.when.where);
    }
  }

  definePool(name: string, clips: string[]): void {
    if (this.pools.has(name)) {
      this.logger.warn(`Pool "${name}" redefined`);
    }

    // For `{voice}`-templated clips we expand against every voice present in
    // the manifest and require all variants to exist; this catches typos
    // (`{voce}`) and missing-voice gaps at definition time, not at fire time.
    const voices = manifestVoices(this.manifest);
    const missing: string[] = [];

    for (const clip of clips) {
      if (clip.includes("{voice}")) {
        for (const voice of voices) {
          const resolved = clip.replace(/\{voice\}/g, voice);

          if (!this.manifest.clips.includes(resolved)) missing.push(resolved);
        }
      } else if (!this.manifest.clips.includes(clip)) {
        missing.push(clip);
      }
    }

    if (missing.length > 0) {
      this.logger.error(`Pool "${name}" rejected; unknown clips:\n  - ${missing.join("\n  - ")}`);

      return;
    }

    this.pools.set(name, { clips: [...clips], lastIndex: -1 });
  }

  defineVar(name: string, resolver: () => string | null): void {
    this.vars.set(name, resolver);
  }

  setEnabled(scenarioId: string, enabled: boolean): void {
    const entry = this.scenarios.get(scenarioId);

    if (!entry) {
      this.logger.warn(`setEnabled: scenario "${scenarioId}" not found`);

      return;
    }

    if (entry.enabled === enabled) return;

    entry.enabled = enabled;
    this.logger.debug(`Scenario "${scenarioId}" ${enabled ? "enabled" : "disabled"}`);

    if (!enabled) {
      // Cancel a pending `triggerDelay` timer so a stale pre-disable event
      // can't fire after the scenario is re-enabled before the timer expires.
      // (The timer callback guards on `enabled`, but only at expiry — a
      // disable→enable round-trip within the delay window would otherwise let
      // the original event through.)
      if (entry.pendingTriggerTimer !== null) {
        clearTimeout(entry.pendingTriggerTimer);
        entry.pendingTriggerTimer = null;
      }

      // Cancel in-flight execution on any bus + clear deferred replays referring to this id.
      for (const state of this.busState.values()) {
        const wasActive = state.activeFire?.id === scenarioId;

        if (wasActive) this.cancelActiveFire(state);

        if (state.pending?.id === scenarioId) {
          state.pending = null;
        } else if (wasActive && state.playingId === null) {
          // Disabling the in-flight scenario idled the bus — play whatever was
          // waiting behind it rather than stranding it (issue #652 review).
          this.drainPending(state);
        }
      }
    }
  }

  fire(scenarioId: string): void {
    const entry = this.scenarios.get(scenarioId);

    if (!entry) {
      this.logger.warn(`fire: scenario "${scenarioId}" not found`);

      return;
    }

    this.attemptFire(entry, null);
  }

  /**
   * Cancel every in-flight fire on all buses and drop any pending deferred
   * replays. Used when the Race Engineer master gate flips off so a callout
   * caught mid-playback is stopped immediately — including its looping
   * ambient bed (in each fire's `usedChannels`) — and `playingId` is cleared
   * so the bus isn't wedged. Without this the gate-off path only mutes the
   * buses: the ambient loop is orphaned (and becomes audible again on
   * re-enable) and the stuck `playingId` makes `attemptFire` drop every later
   * callout as "bus busy" for the rest of the session (issue #587).
   *
   * `cancelActiveFire` is a no-op on a bus with no active fire, so this is
   * safe to call whether or not anything is playing.
   */
  stopAll(): void {
    for (const state of this.busState.values()) {
      this.cancelActiveFire(state);
      state.pending = null;
      this.clearPendingHold(state);
      // Release any held focus floor too, so it can't outlive the reset and
      // block every later callout on re-enable (issue #652 review).
      state.focus = null;
    }
  }

  acquireFocus(bus: AudioBus, ownerId: string, floorWeight: number): void {
    const state = this.getBusState(bus);
    state.focus = { ownerId, floor: floorWeight };
    this.logger.debug(`Focus acquired on bus ${bus} by "${ownerId}" (floor ${floorWeight})`);
  }

  releaseFocus(bus: AudioBus, ownerId: string): void {
    const state = this.getBusState(bus);

    if (state.focus?.ownerId !== ownerId) return;

    state.focus = null;
    this.logger.debug(`Focus released on bus ${bus} by "${ownerId}"`);

    // A fire deferred while below the floor may now be playable.
    if (state.playingId === null) this.drainPending(state);
  }

  // ── Event wiring ──

  private subscribeToEvent(
    id: string,
    eventName: SimEventName,
    where: ((e: SimEventOf<SimEventName>) => boolean) | undefined,
  ): () => void {
    const handler = (ev: SimEventOf<SimEventName>) => {
      const entry = this.scenarios.get(id);

      if (!entry || !entry.enabled) return;

      const triggerDelay = entry.raw.triggerDelay ?? 0;

      if (triggerDelay <= 0) {
        // Immediate path — where: runs synchronously, attemptFire runs
        // synchronously. Var resolvers will read current state at this
        // moment.
        if (where) {
          try {
            if (!where(ev)) return;
          } catch (err) {
            this.logger.error(`Scenario "${id}" where() threw: ${err instanceof Error ? err.message : String(err)}`);

            return;
          }
        }

        this.attemptFire(entry, ev);

        return;
      }

      // Deferred path — wait `triggerDelay` ms before evaluating where: and
      // attempting fire. By the time the timer fires, both the predicate and
      // any var resolvers will read telemetry that has had time to settle
      // (critical for `session.changed` → race-start, where iRacing's
      // TrackWetness can read Unknown at the transition tick).
      //
      // Cancel any pending timer for this scenario so the most recent event
      // wins. Two rapid SessionNum advances would otherwise queue two fires.
      if (entry.pendingTriggerTimer !== null) {
        clearTimeout(entry.pendingTriggerTimer);
      }

      entry.pendingTriggerTimer = setTimeout(() => {
        entry.pendingTriggerTimer = null;

        // Re-check entry state — scenario may have been redefined or
        // disabled during the wait.
        const current = this.scenarios.get(id);

        if (!current || !current.enabled || current !== entry) return;

        if (where) {
          try {
            if (!where(ev)) return;
          } catch (err) {
            this.logger.error(
              `Scenario "${id}" where() threw (deferred): ${err instanceof Error ? err.message : String(err)}`,
            );

            return;
          }
        }

        this.attemptFire(current, ev);
      }, triggerDelay);
    };

    return this.eventBus.subscribe(eventName, handler);
  }

  // ── Firing pipeline ──

  private attemptFire(entry: CompiledScenario, event: SimEventOf<SimEventName> | null, resume?: ResumeState): void {
    const now = Date.now();

    // A resume is a continuation of a fire that already passed (and stamped)
    // the cooldown — re-checking it here would drop the tail of an
    // interrupted line (issue #758).
    if (!resume && entry.raw.cooldown && entry.lastFireAt > 0 && now - entry.lastFireAt < entry.raw.cooldown) return;

    const bus = entry.raw.bus;
    const state = this.getBusState(bus);
    const weight = entry.raw.weight ?? DEFAULT_WEIGHT;

    // Exclusive-focus floor (issue #652): while an owner holds the bus, a
    // non-owner fire BELOW the floor is blocked. The owner's own fires
    // (matching `focusOwner`) always pass; fires AT OR ABOVE the floor break
    // through and schedule normally below — so a floor set to the SAFETY band
    // admits the safety-flag callouts while holding back routine chatter.
    const focus = state.focus;

    if (focus !== null && entry.raw.focusOwner !== focus.ownerId && weight < focus.floor) {
      this.queueOrDrop(entry, event, weight, state, `below focus floor (${focus.ownerId})`, resume);

      return;
    }

    if (state.playingId !== null) {
      const running = this.scenarios.get(state.playingId);
      const runningWeight = state.activeFire?.weight ?? DEFAULT_WEIGHT;

      // Same-family preemption: a new event in a family invalidates the
      // in-flight callout for that family (e.g. tire-set switch mid-playback).
      // A wholesale replacement regardless of weight — the new fire is fresher
      // info about the same subject, so the old one is not stashed for replay.
      const sameFamily =
        entry.raw.family !== undefined && running !== undefined && entry.raw.family === running.raw.family;

      if (sameFamily) {
        this.cancelActiveFire(state);
        // fall through to play the newer family member
      } else if (weight > runningWeight && entry.raw.interrupt === true) {
        // Higher weight + interrupt: cut the in-flight fire immediately. If
        // that fire is queueable, stash it so it replays once we're done.
        this.stashRunningIfQueueable(state, running);
        this.cancelActiveFire(state);
        // fall through to play now
      } else if (weight > runningWeight) {
        // Higher weight, no interrupt: win the bus but let the current line
        // finish — wait as the pending next fire.
        this.setPending(entry.raw.id, event, weight, state, "waiting for bus (higher weight, no interrupt)");

        return;
      } else {
        // Equal or lower weight: can't take the bus now.
        this.queueOrDrop(entry, event, weight, state, "bus busy", resume);

        return;
      }
    }

    if (!resume) entry.lastFireAt = now;

    this.executeFire(entry, event, resume);
  }

  /** Defer a fire for idle-replay when `queueable`, otherwise drop it. */
  private queueOrDrop(
    entry: CompiledScenario,
    event: SimEventOf<SimEventName> | null,
    weight: number,
    state: BusState,
    reason: string,
    resume?: ResumeState,
  ): void {
    if (entry.raw.queueable === true) {
      this.setPending(entry.raw.id, event, weight, state, `deferred (${reason})`, resume);
    } else {
      this.logger.debug(`Scenario "${entry.raw.id}" dropped (${reason})`);
    }
  }

  /**
   * Record the highest-weight fire waiting for the bus to idle. Ties go to the
   * newest fire (matching the former "most-recent low wins" semantic).
   */
  private setPending(
    id: string,
    event: SimEventOf<SimEventName> | null,
    weight: number,
    state: BusState,
    reason: string,
    resume?: ResumeState,
  ): void {
    if (state.pending === null || weight >= state.pending.weight) {
      state.pending = { id, event, weight, resume };
      this.logger.debug(`Scenario "${id}" pending — ${reason}`);
    } else {
      this.logger.debug(`Scenario "${id}" dropped — lower weight than queued "${state.pending.id}"`);
    }
  }

  /** When an interrupt cut a queueable fire, keep it for idle-replay. */
  private stashRunningIfQueueable(state: BusState, running: CompiledScenario | undefined): void {
    const active = state.activeFire;

    if (!active || !running || running.raw.queueable !== true) return;

    const resume = running.raw.resumable === true ? buildResumeState(active) : undefined;
    this.setPending(active.id, active.event, active.weight, state, "stashed (preempted)", resume);
  }

  private executeFire(entry: CompiledScenario, event: SimEventOf<SimEventName> | null, resume?: ResumeState): void {
    const ctx: ScenarioContext = {
      event,
      telemetry: event?.telemetry ?? null,
      data: event?.data ?? null,
      now: Date.now(),
      vars: {},
    };

    let expanded: ExecOp[];

    try {
      expanded = this.expandSequence(
        entry.resolvedSequence,
        entry.raw.base,
        entry.raw.channel,
        ctx,
        new Set([entry.raw.id]),
      );
    } catch (err) {
      this.logger.error(
        `Scenario "${entry.raw.id}" expansion failed: ${err instanceof Error ? err.message : String(err)}`,
      );

      return;
    }

    if (expanded.length === 0) {
      this.logger.debug(`Scenario "${entry.raw.id}" expanded to empty sequence; skipping`);

      return;
    }

    // Resume from an interrupt cut (issue #758): when the fresh expansion is
    // unchanged from the stashed one, continue from the interrupted clip
    // (re-keying the radio frame when it was already opened). A changed
    // expansion means the underlying state moved on while stashed — resuming
    // would speak a stale tail, so fall back to the full fresh replay (the
    // #481 freshness guarantee).
    let ops = expanded;
    let sourceStart = 0;
    let prerollCount = 0;

    if (resume && resume.index > 0 && resume.index < expanded.length && opsEqual(expanded, resume.ops)) {
      const preroll = this.reopenPreroll(expanded, resume.index);
      ops = [...preroll, ...expanded.slice(resume.index)];
      sourceStart = resume.index;
      prerollCount = preroll.length;
    }

    const bus = entry.raw.bus;
    const state = this.getBusState(bus);
    // A fire is taking the bus — a pending hold armed at the previous fire's
    // finish is obsolete; it re-arms when this fire finishes.
    this.clearPendingHold(state);
    state.playingId = entry.raw.id;
    state.activeFire = {
      id: entry.raw.id,
      bus,
      weight: entry.raw.weight ?? DEFAULT_WEIGHT,
      ops,
      index: 0,
      sourceOps: expanded,
      sourceStart,
      prerollCount,
      cancelled: false,
      pauseTimer: null,
      usedChannels: collectUsedChannels(ops),
      event,
    };

    if (sourceStart > 0) {
      this.logger.info(`Resuming scenario "${entry.raw.id}"`);
      this.logger.debug(`Resumed at op ${sourceStart}/${expanded.length}`);
    } else {
      this.logger.info(`Playing scenario "${entry.raw.id}"`);
    }

    this.logger.debug(`Ops (${ops.length}): ${ops.map(opLabel).join(" | ")}`);

    this.stepNext(state);
  }

  /**
   * When the portion delivered before the cut had opened the walkie-talkie
   * frame, the resumed tail re-keys with the open tick so it doesn't restart
   * cold mid-sentence — unless the tail itself begins with the open tick.
   */
  private reopenPreroll(expanded: ExecOp[], resumeIndex: number): ExecOp[] {
    const openTick = this.manifest.ticks.open;
    const frameWasOpened = expanded.slice(0, resumeIndex).some((op) => op.kind === "play" && op.path === openTick);
    const first = expanded[resumeIndex];
    const resumesWithTick = first.kind === "play" && first.path === openTick;

    if (!frameWasOpened || resumesWithTick) return [];

    return [{ kind: "play", channel: AudioChannel.SFX, path: openTick }];
  }

  /** Advance to the next op in the given bus's active fire. */
  private stepNext(state: BusState): void {
    const fire = state.activeFire;

    if (!fire || fire.cancelled) return;

    if (fire.index >= fire.ops.length) {
      this.finishFire(fire.id, fire.bus);

      return;
    }

    const op = fire.ops[fire.index];
    fire.index++;

    try {
      if (op.kind === "play") {
        this.audio.onChannelComplete(op.channel, () => {
          if (state.activeFire === fire && !fire.cancelled) this.stepNext(state);
        });
        const ok = this.audio.playOnChannel(op.channel, op.path);

        if (!ok) {
          this.logger.warn(`Failed to play ${op.path} on channel ${op.channel}; advancing`);
          this.stepNext(state);
        }

        return;
      }

      if (op.kind === "ambient") {
        if (op.action === "start") this.audio.playOnChannel(AudioChannel.Ambient, this.manifest.ambientLoop, true);
        else if (op.action === "stop") this.audio.stopChannel(AudioChannel.Ambient);
        else if (op.action === "seek") this.audio.seekChannelRandom(AudioChannel.Ambient);

        this.stepNext(state);

        return;
      }

      if (op.kind === "pause") {
        if (op.ms <= 0) {
          this.stepNext(state);

          return;
        }

        fire.pauseTimer = setTimeout(() => {
          fire.pauseTimer = null;

          if (state.activeFire === fire && !fire.cancelled) this.stepNext(state);
        }, op.ms);

        return;
      }
    } catch (err) {
      this.logger.error(`Scenario "${fire.id}" step threw: ${err instanceof Error ? err.message : String(err)}`);
      this.stepNext(state);
    }
  }

  private finishFire(scenarioId: string, bus: AudioBus): void {
    const state = this.getBusState(bus);

    if (state.playingId === scenarioId) state.playingId = null;

    if (state.activeFire?.id === scenarioId) state.activeFire = null;

    // A finishing fire in a train of related fires (count-in marks) holds the
    // pending drain for its declared window, so the displaced line doesn't
    // stutter back into the gaps between the train's members (issue #758).
    const holdMs = this.scenarios.get(scenarioId)?.raw.pendingHoldMs ?? 0;

    if (state.pending !== null && holdMs > 0) {
      this.clearPendingHold(state);
      this.logger.debug(`Pending drain held for ${holdMs} ms after "${scenarioId}"`);
      state.pendingHoldTimer = setTimeout(() => {
        state.pendingHoldTimer = null;
        this.drainPending(state);
      }, holdMs);

      return;
    }

    this.drainPending(state);
  }

  /** Cancel an armed pending-hold timer (no-op when none is armed). */
  private clearPendingHold(state: BusState): void {
    if (state.pendingHoldTimer === null) return;

    clearTimeout(state.pendingHoldTimer);
    state.pendingHoldTimer = null;
  }

  /**
   * Play the pending fire (if any) now that the bus is idle. The fire replays
   * unconditionally — its `where:` is NOT re-evaluated. Some `where:`
   * predicates commit a side effect as their last gate (e.g. the position
   * readout claims a shared cooldown via `tryClaimPositionAnnouncement()`,
   * issues #574/#555); re-running them on replay would fail the already-made
   * claim and silently drop the callout. Freshness is preserved instead by the
   * var resolvers, which read live state at `executeFire` time rather than from
   * the frozen event payload.
   */
  private drainPending(state: BusState): void {
    this.clearPendingHold(state);

    const pending = state.pending;
    state.pending = null;

    if (!pending) return;

    const entry = this.scenarios.get(pending.id);

    if (!entry?.enabled) return;

    this.logger.debug(`Replaying pending scenario "${pending.id}"`);
    this.attemptFire(entry, pending.event, pending.resume);
  }

  /**
   * Cancel the currently-executing fire on the given bus. Stops only the
   * channels the fire actually referenced (from its expanded ops), so
   * scenarios running on other buses aren't disturbed.
   */
  private cancelActiveFire(state: BusState): void {
    const fire = state.activeFire;

    if (!fire) return;

    fire.cancelled = true;

    if (fire.pauseTimer) {
      clearTimeout(fire.pauseTimer);
      fire.pauseTimer = null;
    }

    for (const channel of fire.usedChannels) this.audio.stopChannel(channel);

    if (state.playingId === fire.id) state.playingId = null;

    state.activeFire = null;
  }

  private getBusState(bus: AudioBus): BusState {
    let state = this.busState.get(bus);

    if (!state) {
      state = { playingId: null, pending: null, activeFire: null, focus: null, pendingHoldTimer: null };
      this.busState.set(bus, state);
    }

    return state;
  }

  // ── Sequence expansion ──

  private expandSequence(
    steps: ResolvedStep[],
    base: string | undefined,
    defaultChannel: AudioChannel,
    ctx: ScenarioContext,
    visitedIncludes: Set<string>,
  ): ExecOp[] {
    const out: ExecOp[] = [];

    for (const step of steps) {
      switch (step.kind) {
        case "clip":
          this.pushClip(out, this.substituteVoice(applyBase(base, step.path)), defaultChannel);
          break;

        case "var": {
          const resolver = this.vars.get(step.name);
          const value = resolver ? resolver() : null;
          ctx.vars[step.name] = value;

          if (value) this.pushClip(out, this.substituteVoice(value), defaultChannel);

          break;
        }

        case "pool": {
          const pick = this.pickFromPool(step.name, step.noRepeat);

          if (pick) this.pushClip(out, this.substituteVoice(pick), defaultChannel);

          break;
        }

        case "connector": {
          const pick = this.pickFromPool("connector", true);

          if (pick) this.pushClip(out, pick, defaultChannel);

          break;
        }

        case "include": {
          if (visitedIncludes.has(step.id)) {
            throw new Error(`include cycle: ${Array.from(visitedIncludes).join(" → ")} → ${step.id}`);
          }

          const target = this.scenarios.get(step.id);

          if (!target) throw new Error(`include target not found: ${step.id}`);

          const nested = this.expandSequence(
            target.resolvedSequence,
            target.raw.base,
            defaultChannel,
            ctx,
            new Set([...visitedIncludes, step.id]),
          );
          out.push(...nested);
          break;
        }

        case "if": {
          let predicateResult = false;

          try {
            predicateResult = step.predicate(ctx);
          } catch (err) {
            this.logger.error(`Conditional predicate threw: ${err instanceof Error ? err.message : String(err)}`);
          }

          const branch = predicateResult ? step.then : (step.else ?? []);
          out.push(...this.expandSequence(branch, base, defaultChannel, ctx, visitedIncludes));
          break;
        }

        case "ambient":
          out.push({ kind: "ambient", action: step.action });
          break;

        case "pause":
          out.push({ kind: "pause", ms: step.ms });
          break;
      }
    }

    return out;
  }

  /** Push a clip op, routing walkie-talkie ticks to SFX and everything else to the default channel. */
  private pushClip(out: ExecOp[], path: string, defaultChannel: AudioChannel): void {
    const channel = this.channelForPath(path, defaultChannel);
    out.push({ kind: "play", channel, path });
  }

  private channelForPath(path: string, defaultChannel: AudioChannel): AudioChannel {
    if (path === this.manifest.ticks.open || path === this.manifest.ticks.close) return AudioChannel.SFX;

    return defaultChannel;
  }

  private pickFromPool(name: string, noRepeat: boolean): string | null {
    const pool = this.pools.get(name);

    if (!pool) {
      // Surfaces a class of bug that's otherwise silent: a scenario references
      // a pool that was never registered (or was removed without updating the
      // scenario). `defineScenario` validation catches this for scenarios
      // defined ahead of fire time, but not for pools that vanish later or
      // for `connector` step types whose pool is implicit.
      this.logger.error(`pickFromPool: unknown pool "${name}" — step skipped, clip will not play`);

      return null;
    }

    if (pool.clips.length === 0) {
      this.logger.error(`pickFromPool: pool "${name}" is empty — step skipped, clip will not play`);

      return null;
    }

    let idx = Math.floor(Math.random() * pool.clips.length);

    if (noRepeat && pool.clips.length > 1 && idx === pool.lastIndex) {
      idx = (idx + 1) % pool.clips.length;
    }

    pool.lastIndex = idx;

    return pool.clips[idx];
  }
}

/**
 * Capture where an interrupted fire left off, mapped back to its ORIGINAL
 * expansion via the fire's source fields — so a resumed fire that is cut
 * again still stashes an absolute position, not one relative to its tail
 * (issue #758). `active.index` points one past the op in flight; the resume
 * replays that op from its start.
 */
function buildResumeState(active: ActiveFire): ResumeState | undefined {
  const playIndex = Math.max(0, active.index - 1);
  const sourceIndex = active.sourceStart + Math.max(0, playIndex - active.prerollCount);

  if (sourceIndex >= active.sourceOps.length) return undefined;

  return { ops: active.sourceOps, index: sourceIndex };
}

/** Element-wise equality of two expanded op lists (plain data, no functions). */
function opsEqual(a: readonly ExecOp[], b: readonly ExecOp[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];

    if (x.kind !== y.kind) return false;

    if (x.kind === "play" && y.kind === "play" && (x.path !== y.path || x.channel !== y.channel)) return false;

    if (x.kind === "ambient" && y.kind === "ambient" && x.action !== y.action) return false;

    if (x.kind === "pause" && y.kind === "pause" && x.ms !== y.ms) return false;
  }

  return true;
}

function opLabel(op: ExecOp): string {
  if (op.kind === "play") return `play[${op.channel}] ${op.path}`;

  if (op.kind === "ambient") return `ambient:${op.action}`;

  return `pause:${op.ms}`;
}

/**
 * Scan the expanded op list for every `AudioChannel` the fire will touch.
 * Cancellation uses this set so we stop exactly the channels this fire can
 * play on, no more and no less.
 */
function collectUsedChannels(ops: readonly ExecOp[]): ReadonlySet<AudioChannel> {
  const channels = new Set<AudioChannel>();

  for (const op of ops) {
    if (op.kind === "play") channels.add(op.channel);
    else if (op.kind === "ambient") channels.add(AudioChannel.Ambient);
  }

  return channels;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let engine: ScenarioEngine | null = null;

export function initializeAudioScenarios(
  eventBus: IEventBus,
  audio: IAudioService,
  manifest: AudioAssetsManifest,
  logger: ILogger = silentLogger,
  getActiveVoice: () => string | null = () => null,
): IScenarioEngine {
  if (engine) {
    throw new Error("Audio scenarios already initialized. initializeAudioScenarios() should only be called once.");
  }

  const built = new ScenarioEngine(eventBus, audio, manifest, logger, getActiveVoice);
  logger.info("Audio scenarios initialized");
  engine = built;

  return built;
}

export function getScenarioEngine(): IScenarioEngine {
  if (!engine) {
    throw new Error("Audio scenarios not initialized. Call initializeAudioScenarios() first.");
  }

  return engine;
}

export function isAudioScenariosInitialized(): boolean {
  return engine !== null;
}

/** @internal Exported for test isolation only. */
export function _resetAudioScenarios(): void {
  engine = null;
}
