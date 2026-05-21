/**
 * Audio Scenario Interpreter — the heart of `@iracedeck/audio-scenarios`.
 *
 * Subscribes to `@iracedeck/event-bus` on behalf of every registered
 * scenario, expands the `Step` tree at fire time (shorthand → ops; pool /
 * variable / include / conditional resolution), then walks the expanded op
 * list one step at a time driving `@iracedeck/audio-service`.
 *
 * Priority and cooldown rules (design doc §8):
 *   - Only one voice scenario plays at a time on a given bus.
 *   - `urgent` + `preempt:true` cancels the running scenario before playing.
 *   - `low` fires are deferred while the bus is busy: the most recent
 *     dropped `low` fire is retried when the bus goes idle. This preserves
 *     the former 1500 ms service-reminder deferred-replay behavior without
 *     special-casing.
 *   - All other fires are dropped when the bus is busy.
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

import type { ResolvedStep, Scenario, ScenarioContext, ScenarioPriority } from "./dsl.js";
import { applyBase, resolveStep } from "./dsl.js";
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
 * A deferred `low`-priority fire. Retains the triggering event so the replay
 * has the same `ctx.data` / `ctx.telemetry` the original fire would have
 * used — critical for scenarios like service-reminder that decode pit-flags
 * from the event's telemetry snapshot.
 */
type DeferredFire = {
  id: string;
  event: SimEventOf<SimEventName> | null;
};

/**
 * Per-bus execution state. Each audio bus can independently be playing a
 * scenario or holding a deferred `low` fire for replay on idle.
 */
type BusState = {
  playingId: string | null;
  deferredLowFire: DeferredFire | null;
  activeFire: ActiveFire | null;
};

type ActiveFire = {
  id: string;
  bus: AudioBus;
  ops: ExecOp[];
  index: number;
  cancelled: boolean;
  pauseTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Channels this fire can touch — computed once from the expanded ops and
   * used by `cancelActiveFire` so we don't stop channels belonging to
   * scenarios running on other buses.
   */
  usedChannels: ReadonlySet<AudioChannel>;
  /**
   * Triggering event retained so a `low`-priority fire that gets
   * preempted by a higher-priority scenario can be deferred and replayed
   * with the same `ctx.data` / `ctx.telemetry` it would have seen
   * originally. Mirrors the existing `DeferredFire.event` shape.
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

const PRIORITY_ORDER: Record<ScenarioPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

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
        if (state.activeFire?.id === scenarioId) this.cancelActiveFire(state);

        if (state.deferredLowFire?.id === scenarioId) state.deferredLowFire = null;
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

  private attemptFire(entry: CompiledScenario, event: SimEventOf<SimEventName> | null): void {
    const now = Date.now();

    if (entry.raw.cooldown && entry.lastFireAt > 0 && now - entry.lastFireAt < entry.raw.cooldown) return;

    const bus = entry.raw.bus;
    const state = this.getBusState(bus);
    const priority: ScenarioPriority = entry.raw.priority ?? "normal";

    if (state.playingId !== null) {
      const running = this.scenarios.get(state.playingId);
      const runningPriority: ScenarioPriority = running?.raw.priority ?? "normal";

      // Same-family preemption: a new event in a family invalidates the
      // in-flight callout for that family (e.g. tire-set switch mid-playback).
      const sameFamily =
        entry.raw.family !== undefined && running !== undefined && entry.raw.family === running.raw.family;

      // `low`-priority scenarios are background commentary by design
      // (pit-readback, service-reminder) — anything higher than `low`
      // preempts them. The preempted low fire is captured into
      // `deferredLowFire` so it replays once the bus goes idle, mirroring
      // the existing busy-bus deferral path.
      //
      // Same-family preemption is a wholesale replacement (the new entry
      // invalidates the old one), so we exclude it from the low-fire
      // stash even when the new entry happens to have higher priority —
      // otherwise the older snapshot would replay after the newer
      // family member completes, contradicting the family semantic.
      const preemptsLow = !sameFamily && runningPriority === "low" && priority !== "low";

      const canPreempt =
        sameFamily ||
        preemptsLow ||
        (priority === "urgent" &&
          entry.raw.preempt === true &&
          PRIORITY_ORDER[priority] > PRIORITY_ORDER[runningPriority]);

      if (canPreempt) {
        if (preemptsLow && state.activeFire) {
          // Stash the preempted low fire so it replays after the
          // higher-priority scenario completes. Same shape as the
          // busy-bus deferral — id + original event. If a newer low
          // fire is already queued (arrived while this one was
          // running) keep it; the established "most-recent low wins"
          // semantic should not be silently flipped by preemption
          // dropping the newer queued fire in favour of the older
          // running one.
          if (state.deferredLowFire === null) {
            state.deferredLowFire = { id: state.activeFire.id, event: state.activeFire.event };
            this.logger.debug(`Scenario "${state.activeFire.id}" preempted by "${entry.raw.id}"; deferred for replay`);
          } else {
            this.logger.debug(
              `Scenario "${state.activeFire.id}" preempted by "${entry.raw.id}"; ` +
                `dropped (newer low "${state.deferredLowFire.id}" already queued)`,
            );
          }
        }

        this.cancelActiveFire(state);
      } else {
        if (priority === "low") {
          // Retain the full event so the deferred replay has the same
          // `ctx.data` / `ctx.telemetry` the original fire would have seen.
          state.deferredLowFire = { id: entry.raw.id, event };
          this.logger.debug(`Scenario "${entry.raw.id}" deferred (bus busy)`);
        } else {
          this.logger.debug(`Scenario "${entry.raw.id}" dropped (bus busy)`);
        }

        return;
      }
    }

    entry.lastFireAt = now;
    this.executeFire(entry, event);
  }

  private executeFire(entry: CompiledScenario, event: SimEventOf<SimEventName> | null): void {
    const ctx: ScenarioContext = {
      event,
      telemetry: event?.telemetry ?? null,
      data: event?.data ?? null,
      now: Date.now(),
      vars: {},
    };

    let ops: ExecOp[];

    try {
      ops = this.expandSequence(
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

    if (ops.length === 0) {
      this.logger.debug(`Scenario "${entry.raw.id}" expanded to empty sequence; skipping`);

      return;
    }

    const bus = entry.raw.bus;
    const state = this.getBusState(bus);
    state.playingId = entry.raw.id;
    state.activeFire = {
      id: entry.raw.id,
      bus,
      ops,
      index: 0,
      cancelled: false,
      pauseTimer: null,
      usedChannels: collectUsedChannels(ops),
      event,
    };

    this.logger.info(`Playing scenario "${entry.raw.id}"`);
    this.logger.debug(`Ops (${ops.length}): ${ops.map(opLabel).join(" | ")}`);

    this.stepNext(state);
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

    const deferred = state.deferredLowFire;
    state.deferredLowFire = null;

    if (deferred) {
      const entry = this.scenarios.get(deferred.id);

      if (entry?.enabled) {
        this.logger.debug(`Replaying deferred scenario "${deferred.id}"`);
        this.attemptFire(entry, deferred.event);
      }
    }
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
      state = { playingId: null, deferredLowFire: null, activeFire: null };
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
