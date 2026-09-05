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
 *
 * Pack-owned scripts (issue #1064):
 *   - A `ScenarioContract` (`defineContract`) subscribes exactly like a
 *     `Scenario` but holds no sequence. What it says comes from the active
 *     voice's `callouts.json`, handed in as a map by `setScripts` and compiled
 *     eagerly (`script-compiler.ts`) against the contracts, vars, conditions,
 *     cases and pools registered in code. A voice with no compiled entry for a
 *     contract is silent for it — no cooldown, no bus take — never a half-line.
 *   - `defineCond` / `defineCase` are the script-facing registries beside
 *     `defineVar`; `vocabulary()` reports all three for the generated reference
 *     (#1066). Registering anything after `setScripts` marks the compiled map
 *     dirty and the next `prepareOps` recompiles before use.
 *   - Frames: a body that expanded to at least one clip is wrapped in the
 *     frame its script entry (else its contract, else `DEFAULT_FRAME`) names,
 *     as the active voice's script defines it. The user's Radio beeps /
 *     Pit ambience settings arrive through `getFrameOptions` and drop the
 *     frame's non-ambient / ambient ops respectively. A legacy `Scenario` is
 *     framed the same way when its voice has a script, and plays unframed
 *     when it does not (transitional; #1065 removes legacy scenarios).
 *   - A pool named by the active voice's script shadows a code-registered
 *     pool of the same name, for that voice only; a slashed pool step
 *     (`group/base`) addresses the voice's clip groups directly.
 */
import type { AudioBus, IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, CONNECTOR_POOL } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import type { ResolvedStep, Scenario, ScenarioContext, ScenarioContract } from "./dsl.js";
import { applyBase, DEFAULT_FRAME, DEFAULT_WEIGHT, NO_FRAME, resolveStep } from "./dsl.js";
// Manifest types + helpers live in `./manifest.js` to break a circular
// import with `./validation.js`, which also needs `referenceVoice`.
import { type AudioAssetsManifest, referenceVoice } from "./manifest.js";
import { type CompiledVoiceScript, compileVoiceScript } from "./script-compiler.js";
import { validateScenario } from "./validation.js";

// Re-export so existing consumers of `interpreter.js` keep their import paths.
export { type AudioAssetsManifest, manifestVoices } from "./manifest.js";

/**
 * The user's two frame switches (issue #1064), read live at every frame
 * expansion: `beeps` keeps the frame's non-ambient steps (the walkie-talkie
 * ticks, or whatever a pack put there), `ambience` keeps its `ambient` steps.
 * The definition is by position in the frame, not by clip path, so a pack's
 * own beep clip is governed by the setting too.
 */
export type FrameOptions = { beeps: boolean; ambience: boolean };

/**
 * What the engine's vocabulary registries hold, for the generated pack-author
 * reference and `lint:pack` (#1066): every var, condition and case with its
 * description, and each case's declared key set with what each key means.
 * Sorted by name, so two engines registering the same catalog report equal.
 */
export type VocabularyReport = {
  vars: readonly { name: string; description: string }[];
  conds: readonly { name: string; description: string }[];
  cases: readonly { name: string; description: string; keys: Readonly<Record<string, string>> }[];
};

export interface IScenarioEngine {
  defineScenario(s: Scenario): void;
  /**
   * Register the code-owned half of a scripted scenario (issue #1064): the
   * trigger, the scheduling and the default frame, with no sequence. What it
   * says comes from the active voice's script (`setScripts`); a voice whose
   * script has no compiled entry for the id is silent for it.
   */
  defineContract(c: ScenarioContract): void;
  definePool(name: string, clips: string[]): void;
  /**
   * Register a pool whose members are derived from the audio-asset manifest
   * (issue #664): every clip matching `voice/<voice>/<group>/<base>-NN.mp3`,
   * resolved at fire time for the active voice. Voices may carry different
   * variant counts or omit the pool entirely — an empty pool skips the step.
   * No clip list is enumerated in code.
   *
   * `(group, base)` is the pool's STABLE IDENTIFIER: renaming a base — in
   * the registry or on disk — silently changes (or empties) what the pool
   * resolves to, so treat it as a breaking change for the pool. The
   * reference-voice typo guard warns at registration; it deliberately never
   * rejects, because an empty pool is indistinguishable from a legitimate
   * per-voice omission (and tests register the full catalog against minimal
   * manifests).
   */
  definePoolFromManifest(name: string, group: string, base: string): void;

  /**
   * Replace the manifest — after a voice-pack scan (issue #1034). The engine
   * stays a once-only singleton; only its view of the available clips changes.
   */
  setManifest(manifest: AudioAssetsManifest): void;

  /** @internal Exported for testing — the manifest currently in force. */
  currentManifest(): AudioAssetsManifest;
  /**
   * Register a variable a sequence reads with `{{name}}`: a clip path or a
   * `pool:<group>/<base>` reference, or `null` for "nothing to say". The
   * description feeds the generated reference (#1066).
   */
  defineVar(name: string, resolver: () => string | null, description?: string): void;
  /**
   * Register a condition a script's `if` names (issue #1064). Scripts can
   * only reference conditions, never compose them — a script needing
   * `a && b` gets a named condition registered here.
   */
  defineCond(name: string, predicate: () => boolean, description: string): void;
  /**
   * Register a case var a script's `case` branches on (issue #1064). The key
   * set is DECLARED, not inferred: `keys` maps each key the resolver can
   * return to what it means, which is what lets a pack author write the
   * branch without reading the resolver, and lets the compiler refuse a
   * typo'd key. A resolver returning an undeclared key is a code bug (warned
   * once) and takes the script's `default` branch.
   */
  defineCase(
    name: string,
    resolver: () => string | null,
    keys: Readonly<Record<string, string>>,
    description: string,
  ): void;
  /**
   * Replace the voice scripts wholesale — voice id → parsed `callouts.json`
   * — and compile every one eagerly against the registries (issue #1064).
   * Runs on every voice-pack rescan, exactly as `setManifest` does.
   */
  setScripts(scripts: ReadonlyMap<string, CalloutScript>): void;
  /** Everything the vocabulary registries hold, for the reference generator and the pack linter (#1066). */
  vocabulary(): VocabularyReport;
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

/**
 * A pool is either an explicit clip list (`static`) or derived from the
 * manifest per voice at fire time (`manifest`, issue #664). Both share the
 * no-immediate-repeat `lastIndex`; manifest pools also track the voice the
 * index belongs to, since variant counts differ across voices.
 */
type PoolState =
  | { kind: "static"; clips: string[]; lastIndex: number }
  | {
      kind: "manifest";
      group: string;
      base: string;
      byVoice: Map<string, string[]>;
      lastIndex: number;
      lastVoice: string | null;
    };

type CompiledScenario = {
  raw: ScenarioContract;
  /**
   * The sequence a legacy `Scenario` welded on, resolved once at definition;
   * `null` for a contract, whose body is looked up in the active voice's
   * compiled script at fire time (issue #1064).
   */
  resolvedSequence: ResolvedStep[] | null;
  /** The default frame name (`s.frame ?? DEFAULT_FRAME`); a script entry may override it. */
  frame: string;
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

/**
 * Internal control-flow signal (issue #835): a REQUIRED clip-producing step
 * resolved to nothing during expansion — missing clip for the active voice,
 * null var, or empty pool. Thrown by `expandSequence`, caught locally by
 * `{ optional: [...] }` groups, and otherwise surfaced to `prepareOps`, which
 * skips the whole callout so a fragment is never spoken. The abort is decided
 * BEFORE any bus cancellation (see `attemptFire`), so an aborting fire can
 * never silence an in-flight one.
 */
class ExpansionAbort {
  constructor(readonly reason: string) {}
}

class ScenarioEngine implements IScenarioEngine {
  private readonly eventBus: IEventBus;
  private readonly audio: IAudioService;
  private manifest: AudioAssetsManifest;
  private readonly logger: ILogger;
  /**
   * Resolves the active Race Engineer voice key (e.g. `"luca"`) at clip-
   * resolution time. Used to substitute `{voice}` placeholders in scenario
   * `base` and pool clips. Returns `null` if no voice is selected.
   */
  private readonly getActiveVoice: () => string | null;

  /**
   * The user's Radio beeps / Pit ambience switches (issue #1064), read at
   * every frame expansion so a toggle takes effect on the next callout.
   */
  private readonly getFrameOptions: () => FrameOptions;

  private readonly scenarios = new Map<string, CompiledScenario>();
  private readonly pools = new Map<string, PoolState>();
  private readonly vars = new Map<string, () => string | null>();
  /** Parallel to `vars`: the description each var was registered with (`""` when none). */
  private readonly varDescriptions = new Map<string, string>();
  private readonly conds = new Map<string, { predicate: () => boolean; description: string }>();
  private readonly cases = new Map<
    string,
    { resolve: () => string | null; keys: Readonly<Record<string, string>>; description: string }
  >();
  private readonly busState = new Map<AudioBus, BusState>();
  /** Set view of `manifest.clips` for O(1) availability checks at expansion time. */
  private clipSet: Set<string>;
  /**
   * `(group, base)` source of every manifest-backed pool, so a manifest reload
   * can re-derive them without the catalog having to re-register anything
   * (issue #1034).
   */
  private readonly manifestPoolSources = new Map<string, { group: string; base: string }>();

  /** Voice id → parsed script, as last handed in by `setScripts` (issue #1064). */
  private scripts: ReadonlyMap<string, CalloutScript> = new Map();
  /** Voice id → the script compiled against the registries as they stood at the last compile. */
  private compiled: ReadonlyMap<string, CompiledVoiceScript> = new Map();
  /**
   * Set by every registration that feeds the compile (contracts, vars,
   * conditions, cases, pools, legacy fragments); the next `prepareOps`
   * recompiles before it looks anything up.
   */
  private scriptsDirty = false;
  /**
   * Per-voice state of the pools a script defines — the no-repeat tracker
   * and the manifest-derived members — keyed `(voice, pool name)`. Built
   * lazily on first pick; cleared by `setManifest` and by every compile.
   */
  private readonly scriptPoolState = new Map<string, Map<string, PoolState>>();
  /**
   * Non-deliberate skips already warned about since the last `setScripts`,
   * keyed `voice|id|reason`, so a dirty recompile only warns about what is
   * new rather than repeating the load's diagnostics on the first fire.
   */
  private readonly warnedSkips = new Set<string>();
  /** `(case, key)` pairs a resolver returned without declaring — a code bug, warned once each. */
  private readonly warnedCaseKeys = new Set<string>();
  /** `(voice, frame)` pairs a legacy scenario asked for that the voice's script does not define — warned once each. */
  private readonly warnedLegacyFrames = new Set<string>();
  /**
   * `(voice, frame)` pairs whose frame aborted a callout (a step resolving to
   * nothing, #835) — warned once each, and cleared by `setScripts` so a
   * reinstalled pack that is still broken says so again. Per-fire detail
   * stays at debug: a broken frame takes EVERY framed callout of its voice
   * down, and a warn per fire would be a warn per flag.
   */
  private readonly warnedFrameAborts = new Set<string>();

  constructor(
    eventBus: IEventBus,
    audio: IAudioService,
    manifest: AudioAssetsManifest,
    logger: ILogger,
    getActiveVoice: () => string | null = () => null,
    getFrameOptions: () => FrameOptions = () => ({ beeps: true, ambience: true }),
  ) {
    this.eventBus = eventBus;
    this.audio = audio;
    this.manifest = manifest;
    this.logger = logger;
    this.getActiveVoice = getActiveVoice;
    this.getFrameOptions = getFrameOptions;
    this.clipSet = new Set(manifest.clips);
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
    let resolvedSequence: ResolvedStep[];

    try {
      resolvedSequence = s.sequence.map(resolveStep);
    } catch (err) {
      this.logger.error(`Scenario "${s.id}" rejected: ${err instanceof Error ? err.message : String(err)}`);

      return;
    }

    this.registerEntry(s, resolvedSequence);
  }

  defineContract(c: ScenarioContract): void {
    this.registerEntry(c, null);
  }

  /**
   * The shared registration path: a legacy scenario brings its resolved
   * sequence, a contract brings `null` and is scripted per voice at fire
   * time. Either way the id is subscribed, validated and — since a new id
   * or fragment changes what the scripts compile against — marks the
   * compiled scripts dirty.
   */
  private registerEntry(s: ScenarioContract, resolvedSequence: ResolvedStep[] | null): void {
    const existing = this.scenarios.get(s.id);

    if (existing) {
      this.logger.warn(`Scenario "${s.id}" redefined; replacing previous definition`);
      existing.unsubscribe?.();

      if (existing.pendingTriggerTimer !== null) {
        clearTimeout(existing.pendingTriggerTimer);
        existing.pendingTriggerTimer = null;
      }
    }

    const entry: CompiledScenario = {
      raw: s,
      resolvedSequence,
      frame: s.frame ?? DEFAULT_FRAME,
      enabled: true,
      unsubscribe: null,
      lastFireAt: 0,
      pendingTriggerTimer: null,
    };

    this.scenarios.set(s.id, entry);
    this.scriptsDirty = true;

    const { errors, warnings } = validateScenario(
      s,
      resolvedSequence,
      this.scenarios,
      this.pools,
      this.vars,
      this.manifest,
    );

    if (warnings.length > 0) {
      this.logger.warn(`Scenario "${s.id}" has validation warnings:\n  - ${warnings.join("\n  - ")}`);
    }

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

    // A `{voice}`-templated clip is checked against the REFERENCE voice only
    // (issue #664): per-voice clip sets may legitimately diverge, so a gap in
    // another voice is not an error. A miss for the reference voice is a
    // probable typo and warns without rejecting the pool. Non-templated
    // clips must exist verbatim.
    const reference = referenceVoice(this.manifest);
    const missing: string[] = [];
    const suspect: string[] = [];

    for (const clip of clips) {
      if (clip.includes("{voice}")) {
        if (reference !== null) {
          const resolved = clip.replace(/\{voice\}/g, reference);

          if (!this.manifest.clips.includes(resolved)) suspect.push(resolved);
        }
      } else if (!this.manifest.clips.includes(clip)) {
        missing.push(clip);
      }
    }

    if (missing.length > 0) {
      this.logger.error(`Pool "${name}" rejected; unknown clips:\n  - ${missing.join("\n  - ")}`);

      return;
    }

    if (suspect.length > 0) {
      this.logger.warn(
        `Pool "${name}": no clip for reference voice "${reference}" (possible typo):\n  - ${suspect.join("\n  - ")}`,
      );
    }

    this.pools.set(name, { kind: "static", clips: [...clips], lastIndex: -1 });
    this.scriptsDirty = true;
  }

  definePoolFromManifest(name: string, group: string, base: string): void {
    if (this.pools.has(name)) {
      this.logger.warn(`Pool "${name}" redefined`);
    }

    this.manifestPoolSources.set(name, { group, base });

    const pool = this.buildManifestPool(group, base);

    // Typo guard: only the reference voice is checked — other voices may
    // legitimately omit the callout. Warn, never reject: a pool that is
    // empty for the active voice just skips at fire time.
    const reference = referenceVoice(this.manifest);

    if (reference !== null && !pool.byVoice.has(reference)) {
      this.logger.warn(
        `Pool "${name}": no "${group}/${base}" clips for reference voice "${reference}" (possible typo)`,
      );
    }

    this.pools.set(name, pool);
    this.scriptsDirty = true;
  }

  setManifest(manifest: AudioAssetsManifest): void {
    this.manifest = manifest;
    this.clipSet = new Set(manifest.clips);

    // Script-defined pools are derived per voice from the manifest too (issue
    // #1064); drop every cached member list so the next pick rebuilds it.
    this.scriptPoolState.clear();

    // Re-derive every manifest-backed pool from its recorded `(group, base)`.
    // Members are per-voice, so a pack arriving or leaving changes what a pool
    // holds for the voices it touches and nothing else.
    for (const [name, source] of this.manifestPoolSources) {
      this.pools.set(name, this.buildManifestPool(source.group, source.base));
    }

    // Dynamic `pool:<group>/<base>` refs (issue #836) are built lazily on first
    // use and cached under the ref string. Drop them so they rebuild against the
    // new manifest instead of serving a stale member list.
    for (const key of [...this.pools.keys()]) {
      if (key.startsWith("pool:")) this.pools.delete(key);
    }

    // Static pools keep their clips (they were registered explicitly, not
    // derived), but every pool's no-repeat tracker is reset: variant counts
    // differ per voice, so a retained index can point past the end of the new
    // member list — the same reason an active-voice change resets them.
    for (const pool of this.pools.values()) pool.lastIndex = -1;

    this.logger.info("Audio manifest reloaded");
    this.logger.debug(`Clips: ${manifest.clips.length}`);
  }

  currentManifest(): AudioAssetsManifest {
    return this.manifest;
  }

  /**
   * Scan the manifest for a pool's members: every
   * `voice/<voice>/<group>/<base>-NN.mp3` variant PLUS the bare
   * `voice/<voice>/<group>/<base>.mp3` (issue #836 — a bare value clip is a
   * size-1 pool, so numbers/names/temps need no rename migration).
   */
  private buildManifestPool(group: string, base: string): Extract<PoolState, { kind: "manifest" }> {
    const pattern = poolMemberPattern(group, base);
    const byVoice = new Map<string, string[]>();

    for (const clip of this.manifest.clips) {
      const match = pattern.exec(clip);

      if (!match) continue;

      let members = byVoice.get(match[1]);

      if (!members) {
        members = [];
        byVoice.set(match[1], members);
      }

      members.push(clip);
    }

    for (const members of byVoice.values()) members.sort();

    return { kind: "manifest", group, base, byVoice, lastIndex: -1, lastVoice: null };
  }

  defineVar(name: string, resolver: () => string | null, description = ""): void {
    this.vars.set(name, resolver);
    this.varDescriptions.set(name, description);
    this.scriptsDirty = true;
  }

  defineCond(name: string, predicate: () => boolean, description: string): void {
    this.conds.set(name, { predicate, description });
    this.scriptsDirty = true;
  }

  defineCase(
    name: string,
    resolver: () => string | null,
    keys: Readonly<Record<string, string>>,
    description: string,
  ): void {
    this.cases.set(name, { resolve: resolver, keys: { ...keys }, description });
    this.scriptsDirty = true;
  }

  vocabulary(): VocabularyReport {
    // Code-point order, not `localeCompare`: the report feeds a generated
    // reference (#1066) and a completeness test, and a locale-aware sort would
    // order the same names differently from one machine's ICU to another's.
    const byName = <T extends { name: string }>(items: T[]): T[] =>
      items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return {
      vars: byName([...this.vars.keys()].map((name) => ({ name, description: this.varDescriptions.get(name) ?? "" }))),
      conds: byName([...this.conds].map(([name, { description }]) => ({ name, description }))),
      cases: byName([...this.cases].map(([name, { description, keys }]) => ({ name, description, keys: { ...keys } }))),
    };
  }

  setScripts(scripts: ReadonlyMap<string, CalloutScript>): void {
    this.scripts = new Map(scripts);
    this.warnedSkips.clear();
    this.warnedFrameAborts.clear();
    this.compileScripts();
    this.logger.info("Voice scripts loaded");
  }

  /**
   * Recompile when a registration landed after the last compile. Called at
   * the top of `prepareOps`, so a contract defined after `setScripts` (or a
   * script loaded before the catalog registered) is compiled before its
   * first fire ever looks it up.
   */
  private ensureCompiled(): void {
    if (!this.scriptsDirty) return;

    if (this.scripts.size === 0) {
      this.scriptsDirty = false;

      return;
    }

    this.compileScripts();
    this.logger.debug("Voice scripts recompiled");
  }

  /**
   * Compile every voice's script against the registries as they stand now.
   * Per voice: one debug line with the scripted count, the deliberate skips
   * at debug, and ONE warn per (voice, scenario) for a skip the pack did not
   * mean — deduped across recompiles, so a dirty recompile only reports what
   * changed. The compiler never throws; neither does this.
   */
  private compileScripts(): void {
    this.scriptsDirty = false;
    this.scriptPoolState.clear();

    const contracts = new Map<string, { frame: string }>();
    const fragments = new Set<string>();

    for (const [id, entry] of this.scenarios) {
      if (entry.resolvedSequence === null) contracts.set(id, { frame: entry.frame });
      else fragments.add(id);
    }

    const conds = new Map<string, () => boolean>();

    for (const [name, { predicate }] of this.conds) conds.set(name, predicate);

    const cases = new Map<string, { resolve: () => string | null; keys: ReadonlySet<string> }>();

    for (const [name, { resolve, keys }] of this.cases) cases.set(name, { resolve, keys: new Set(Object.keys(keys)) });

    const deps = {
      contracts,
      vars: new Set(this.vars.keys()),
      conds,
      cases,
      // Registered names only: the `pool:` keys are cached dynamic refs, not pools a script may name.
      legacyPools: new Set([...this.pools.keys()].filter((name) => !name.startsWith("pool:"))),
      fragments,
    };

    const compiled = new Map<string, CompiledVoiceScript>();

    for (const [voice, script] of this.scripts) {
      const result = compileVoiceScript(script, deps);
      compiled.set(voice, result);

      this.logger.debug(`Voice "${voice}": ${result.scenarios.size} of ${contracts.size} callouts scripted`);

      const deliberate = result.skipped.filter((skip) => skip.deliberate).map((skip) => skip.id);

      if (deliberate.length > 0) this.logger.debug(`Voice "${voice}": not scripted — ${deliberate.join(", ")}`);

      for (const skip of result.skipped) {
        if (skip.deliberate) continue;

        const key = `${voice}|${skip.id}|${skip.reason}`;

        if (this.warnedSkips.has(key)) continue;

        this.warnedSkips.add(key);
        this.logger.warn(`Voice "${voice}": scenario "${skip.id}" skipped — ${skip.reason}`);
      }
    }

    this.compiled = compiled;
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

      const interruptCut = weight > runningWeight && entry.raw.interrupt === true;

      if (sameFamily || interruptCut) {
        // This fire would silence the in-flight one — expand FIRST (issue
        // #835), so a fire that aborts (or expands empty) never cancels
        // what's playing.
        const expanded = this.prepareOps(entry, event);

        if (expanded === null) return;

        // Higher weight + interrupt: cut the in-flight fire immediately. If
        // that fire is queueable, stash it so it replays once we're done.
        // (A same-family replacement never stashes — the new fire is fresher
        // info about the same subject.)
        if (!sameFamily) this.stashRunningIfQueueable(state, running);

        this.cancelActiveFire(state);

        if (!resume) entry.lastFireAt = now;

        this.executeFire(entry, event, expanded, resume);

        return;
      }

      if (weight > runningWeight) {
        // Higher weight, no interrupt: win the bus but let the current line
        // finish — wait as the pending next fire.
        this.setPending(entry.raw.id, event, weight, state, "waiting for bus (higher weight, no interrupt)");

        return;
      }

      // Equal or lower weight: can't take the bus now.
      this.queueOrDrop(entry, event, weight, state, "bus busy", resume);

      return;
    }

    const expanded = this.prepareOps(entry, event);

    if (expanded === null) return;

    if (!resume) entry.lastFireAt = now;

    this.executeFire(entry, event, expanded, resume);
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

  /**
   * Expand a fire's sequence into execution ops — the abort decision point
   * (issue #835). Returns `null` when the fire must not play: a REQUIRED
   * clip-producing step resolved to nothing (missing clip / null var / empty
   * pool for the active voice — never a half-sentence), the expansion threw,
   * it produced no ops, or — for a contract — the active voice's script has
   * no compiled entry for it (issue #1064). `attemptFire` calls this BEFORE
   * any bus cancellation, so an aborting fire can't silence an in-flight
   * one, and an aborted fire stamps no cooldown.
   *
   * Frame application (issue #1064): a body that expanded to at least one
   * clip is wrapped in its frame — the script entry's, else the contract's,
   * else `DEFAULT_FRAME` — as the active voice's script defines it, with the
   * user's beeps / ambience switches applied by position. An empty body, or
   * one with no clip at all, gets no frame: no callout ever plays bare ticks
   * around nothing. The frame is part of the callout, so a frame step that
   * resolves to nothing aborts the fire like any other required step.
   */
  private prepareOps(entry: CompiledScenario, event: SimEventOf<SimEventName> | null): ExecOp[] | null {
    this.ensureCompiled();

    const ctx: ScenarioContext = {
      event,
      telemetry: event?.telemetry ?? null,
      data: event?.data ?? null,
      now: Date.now(),
      vars: {},
    };

    const voice = this.getActiveVoice();
    const script = voice === null ? undefined : this.compiled.get(voice);
    let body: ResolvedStep[];
    let frameName: string;

    if (entry.resolvedSequence === null) {
      const scripted = script?.scenarios.get(entry.raw.id);

      if (!scripted) {
        this.logger.debug(`Scenario "${entry.raw.id}" skipped — no script for voice "${voice ?? "(none)"}"`);

        return null;
      }

      body = scripted.resolved;
      frameName = scripted.frame;
    } else {
      body = entry.resolvedSequence;
      frameName = entry.frame;
    }

    let expanded: ExecOp[];

    try {
      expanded = this.expandSequence(body, entry.raw.base, entry.raw.channel, ctx, new Set([entry.raw.id]));
      expanded = this.applyFrame(expanded, frameName, voice, script, entry, ctx);
    } catch (err) {
      if (err instanceof ExpansionAbort) {
        this.logger.debug(`Scenario "${entry.raw.id}" skipped — ${err.reason}`);

        return null;
      }

      this.logger.error(
        `Scenario "${entry.raw.id}" expansion failed: ${err instanceof Error ? err.message : String(err)}`,
      );

      return null;
    }

    if (expanded.length === 0) {
      this.logger.debug(`Scenario "${entry.raw.id}" expanded to empty sequence; skipping`);

      return null;
    }

    return expanded;
  }

  /**
   * Wrap an expanded body in its frame, as the active voice's script defines
   * it (see `prepareOps`). Returns the body untouched when it wants no frame
   * (`NO_FRAME`), holds no clip, or the voice has no script or no such frame.
   * A frame step that resolves to nothing throws `ExpansionAbort` like any
   * other required step, after one warn per `(voice, frame)` — the body's own
   * abort stays at debug, but a frame failure is a broken pack, not a
   * per-callout omission, and it silences every callout the frame wraps.
   */
  private applyFrame(
    expanded: ExecOp[],
    frameName: string,
    voice: string | null,
    script: CompiledVoiceScript | undefined,
    entry: CompiledScenario,
    ctx: ScenarioContext,
  ): ExecOp[] {
    if (frameName === NO_FRAME || !expanded.some((op) => op.kind === "play")) return expanded;

    if (voice === null || !script) {
      this.logger.debug(`Scenario "${entry.raw.id}" plays unframed — no script for voice "${voice ?? "(none)"}"`);

      return expanded;
    }

    const frame = script.frames.get(frameName);

    if (!frame) {
      // A contract's frame was checked at compile time, so only a legacy
      // scenario can get here: the voice has a script, but not this frame.
      const key = `${voice}|${frameName}`;

      if (!this.warnedLegacyFrames.has(key)) {
        this.warnedLegacyFrames.add(key);
        this.logger.warn(`Voice "${voice}" defines no frame "${frameName}" — legacy scenarios using it play unframed`);
      }

      return expanded;
    }

    const options = this.frameOptions();
    const expandFrame = (steps: ResolvedStep[]) =>
      this.expandSequence(steps, undefined, entry.raw.channel, ctx, new Set([entry.raw.id])).filter((op) =>
        op.kind === "ambient" ? options.ambience : options.beeps,
      );

    try {
      return [...expandFrame(frame.open), ...expanded, ...expandFrame(frame.close)];
    } catch (err) {
      if (err instanceof ExpansionAbort) {
        const key = `${voice}|${frameName}`;

        if (!this.warnedFrameAborts.has(key)) {
          this.warnedFrameAborts.add(key);
          this.logger.warn(
            `Voice "${voice}" frame "${frameName}" cannot play — ${err.reason}; every callout it frames is skipped`,
          );
        }
      }

      throw err;
    }
  }

  /** The user's frame switches, read live; a throwing accessor keeps the frame whole. */
  private frameOptions(): FrameOptions {
    try {
      return this.getFrameOptions();
    } catch (err) {
      this.logger.error(`getFrameOptions threw: ${err instanceof Error ? err.message : String(err)}`);

      return { beeps: true, ambience: true };
    }
  }

  private executeFire(
    entry: CompiledScenario,
    event: SimEventOf<SimEventName> | null,
    expanded: ExecOp[],
    resume?: ResumeState,
  ): void {
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
        case "clip": {
          const path = this.substituteVoice(applyBase(base, step.path));
          this.assertClipAvailable(path, `clip "${step.path}"`);
          this.pushClip(out, path, defaultChannel);
          break;
        }

        case "var": {
          const resolver = this.vars.get(step.name);
          const value = resolver ? resolver() : null;
          ctx.vars[step.name] = value;

          if (!value) throw new ExpansionAbort(`var {{${step.name}}} resolved to nothing`);

          // A resolver may return a dynamic pool reference (`pool:<group>/<base>`,
          // issue #836) instead of a clip path — value-indexed clips (numbers,
          // names, temps) are pools too, usually of size 1.
          if (value.startsWith("pool:")) {
            const pick = this.pickFromPoolRef(value);

            if (!pick) {
              throw new ExpansionAbort(`var {{${step.name}}} → "${value}" is empty for the active voice`);
            }

            this.pushClip(out, pick, defaultChannel);

            break;
          }

          const path = this.substituteVoice(value);
          this.assertClipAvailable(path, `var {{${step.name}}}`);
          this.pushClip(out, path, defaultChannel);

          break;
        }

        case "pool": {
          // A slashed name addresses the voice's own clip groups directly
          // (`group/base`, issue #1064) — the same reference form a var
          // resolver returns. Registered names never carry a slash.
          const pick = step.name.includes("/")
            ? this.pickFromPoolRef(`pool:${step.name}`)
            : this.pickFromPool(step.name, step.noRepeat);

          if (!pick) throw new ExpansionAbort(`pool "${step.name}" resolved to nothing for the active voice`);

          const path = this.substituteVoice(pick);
          this.assertClipAvailable(path, `pool "${step.name}"`);
          this.pushClip(out, path, defaultChannel);

          break;
        }

        case "connector": {
          const pick = this.pickFromPool(CONNECTOR_POOL, true);

          if (!pick) throw new ExpansionAbort(`connector pool resolved to nothing`);

          const path = this.substituteVoice(pick);
          this.assertClipAvailable(path, `connector`);
          this.pushClip(out, path, defaultChannel);

          break;
        }

        case "include": {
          if (visitedIncludes.has(step.id)) {
            throw new Error(`include cycle: ${Array.from(visitedIncludes).join(" → ")} → ${step.id}`);
          }

          const target = this.scenarios.get(step.id);

          if (!target) throw new Error(`include target not found: ${step.id}`);

          // A contract has no sequence of its own to splice in: includes
          // target legacy fragments only (the compiler enforces the same).
          if (target.resolvedSequence === null) throw new Error(`include target has no sequence: ${step.id}`);

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

        case "case": {
          // The resolver returns a key; the script maps keys to steps (issue
          // #1064). An unmapped key takes the script's `default` branch, or
          // nothing — the completeness of the mapping is the pack's business.
          // A key the resolver never DECLARED is a code bug: warned once, then
          // treated as unmapped.
          out.push(...this.expandSequence(this.pickCaseBranch(step), base, defaultChannel, ctx, visitedIncludes));
          break;
        }

        case "optional": {
          // A genuinely-optional clause (issue #835): a member resolving to
          // nothing skips the WHOLE group locally — never half a clause —
          // and the rest of the callout still plays. Each recursive call
          // builds its own op list, so a mid-group abort discards the
          // group's partial ops cleanly.
          try {
            out.push(...this.expandSequence(step.steps, base, defaultChannel, ctx, visitedIncludes));
          } catch (err) {
            if (!(err instanceof ExpansionAbort)) throw err;

            this.logger.debug(`optional clause skipped — ${err.reason}`);
          }

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

  /**
   * Guard a resolved clip path against the manifest (issue #835): a required
   * clip the active voice doesn't have aborts the whole callout — never a
   * half-sentence. `{ optional: [...] }` groups catch the abort locally.
   */
  private assertClipAvailable(path: string, what: string): void {
    if (this.clipSet.has(path)) return;

    throw new ExpansionAbort(`${what} → "${path}" is not in the manifest for the active voice`);
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

  /**
   * Resolve a dynamic pool reference returned by a var resolver (issue #836):
   * `pool:<group>/<base>`. The pool is derived from the manifest on first use
   * and cached in the pools map under the full ref string (registered pool
   * names never carry the `pool:` prefix, so the namespaces can't collide) —
   * giving value pools the same no-repeat guard and voice-change reset as
   * registered pools. No reference-voice typo guard: values legitimately
   * differ per voice.
   */
  private pickFromPoolRef(ref: string): string | null {
    if (!this.pools.has(ref)) {
      const spec = ref.slice("pool:".length);
      const slash = spec.indexOf("/");

      if (slash <= 0 || slash === spec.length - 1) {
        this.logger.error(`pickFromPoolRef: malformed pool reference "${ref}" — expected pool:<group>/<base>`);

        return null;
      }

      this.pools.set(ref, this.buildManifestPool(spec.slice(0, slash), spec.slice(slash + 1)));
    }

    return this.pickFromPool(ref, true);
  }

  private pickCaseBranch(step: Extract<ResolvedStep, { kind: "case" }>): ResolvedStep[] {
    const declared = this.cases.get(step.name);

    if (!declared) {
      // The compiler refuses a script naming an unregistered case, so this is
      // reachable only if the case was registered and later replaced.
      this.logger.error(`case "${step.name}" is not registered — taking the default branch`);

      return step.fallback;
    }

    let key: string | null = null;

    try {
      key = declared.resolve();
    } catch (err) {
      this.logger.error(`case "${step.name}" resolver threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (key === null) return step.fallback;

    if (!Object.hasOwn(declared.keys, key)) {
      const warnKey = `${step.name}|${key}`;

      if (!this.warnedCaseKeys.has(warnKey)) {
        this.warnedCaseKeys.add(warnKey);
        this.logger.warn(`case "${step.name}" resolved to undeclared key "${key}" — taking the default branch`);
      }

      return step.fallback;
    }

    return step.of.get(key) ?? step.fallback;
  }

  /**
   * A pool the active voice's script defines shadows a code-registered pool
   * of the same name, for that voice only (issue #1064): its state lives in
   * the per-voice cache, built from the manifest on first pick.
   */
  private scriptPool(name: string): PoolState | null {
    const voice = this.getActiveVoice();

    if (voice === null) return null;

    const source = this.compiled.get(voice)?.pools.get(name);

    if (!source) return null;

    let perVoice = this.scriptPoolState.get(voice);

    if (!perVoice) {
      perVoice = new Map();
      this.scriptPoolState.set(voice, perVoice);
    }

    let pool = perVoice.get(name);

    if (!pool) {
      pool = this.buildManifestPool(source.group, source.base);
      perVoice.set(name, pool);
    }

    return pool;
  }

  private pickFromPool(name: string, noRepeat: boolean): string | null {
    const pool = this.scriptPool(name) ?? this.pools.get(name);

    if (!pool) {
      // Surfaces a class of bug that's otherwise silent: a scenario references
      // a pool that was never registered (or was removed without updating the
      // scenario). `defineScenario` validation catches this for scenarios
      // defined ahead of fire time, but not for pools that vanish later or
      // for `connector` step types whose pool is implicit.
      this.logger.error(`pickFromPool: unknown pool "${name}" — step skipped, clip will not play`);

      return null;
    }

    let clips: string[];

    if (pool.kind === "manifest") {
      const voice = this.getActiveVoice();

      if (!voice) {
        this.logger.debug(`pickFromPool: pool "${name}" skipped — no active voice selected`);

        return null;
      }

      // Variant counts differ across voices, so a stale lastIndex from
      // another voice would skew the no-repeat guard — reset it on voice
      // change (issue #664).
      if (voice !== pool.lastVoice) {
        pool.lastVoice = voice;
        pool.lastIndex = -1;
      }

      clips = pool.byVoice.get(voice) ?? [];
    } else {
      clips = pool.clips;
    }

    if (clips.length === 0) {
      // Not an error: a voice may legitimately omit a callout (issue #664) —
      // the step skips silently.
      this.logger.debug(`pickFromPool: pool "${name}" is empty for the active voice — step skipped`);

      return null;
    }

    let idx = Math.floor(Math.random() * clips.length);

    if (noRepeat && clips.length > 1 && idx === pool.lastIndex) {
      idx = (idx + 1) % clips.length;
    }

    pool.lastIndex = idx;

    return clips[idx];
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

/** Escape a literal string for embedding in a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @internal Exported for testing — the pool-membership rule `buildManifestPool`
 * applies to the manifest: a clip belongs to the `(group, base)` pool of the
 * voice it names when its path is `voice/<voice>/<group>/<base>-NN.mp3` with
 * exactly two digits, or the bare `voice/<voice>/<group>/<base>.mp3` (issue
 * #836). The first capture group is the voice. The digit count is pinned on
 * purpose: the #1051 entry in the callout-examples rule records what a
 * three-digit suffix did to a whole family.
 */
export function poolMemberPattern(group: string, base: string): RegExp {
  return new RegExp(`^voice/([^/]+)/${escapeRegExp(group)}/${escapeRegExp(base)}(?:-\\d{2})?\\.mp3$`);
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
  getFrameOptions: () => FrameOptions = () => ({ beeps: true, ambience: true }),
): IScenarioEngine {
  if (engine) {
    throw new Error("Audio scenarios already initialized. initializeAudioScenarios() should only be called once.");
  }

  const built = new ScenarioEngine(eventBus, audio, manifest, logger, getActiveVoice, getFrameOptions);
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
