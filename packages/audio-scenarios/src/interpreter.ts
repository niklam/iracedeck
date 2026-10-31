/**
 * Audio Scenario Interpreter — the heart of `@iracedeck/audio-scenarios`.
 *
 * Subscribes to `@iracedeck/event-bus` on behalf of every registered
 * scenario, expands the `Step` tree at fire time (shorthand → ops; pool /
 * variable / include / conditional resolution), then walks the expanded op
 * list one step at a time driving `@iracedeck/audio-service`. Since issue
 * #1514 each of those jobs is a module of its own beside this file, and
 * `ScenarioEngine` here is the facade that builds them and sequences the
 * calls that cross them; the scheduling rules (weight model, issue #652) are
 * stated on `scheduler.ts`.
 *
 * Channel routing for clip steps:
 *   - Every clip a FRAME plays goes on the SFX channel, whatever it is (#1064).
 *   - In a body, paths matching the manifest's walkie-talkie ticks go on the
 *     SFX channel (legacy sequences carrying the tick inline).
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
 *     (#1066), and `contracts()` reports every registered contract beside it —
 *     effective frame and weight, the trigger event, and the contract's
 *     `description` of when it fires. Registering anything after `setScripts`
 *     marks the compiled map dirty and the next `prepareOps` recompiles
 *     before use.
 *   - Frames: a body that expanded to at least one clip is wrapped in the
 *     frame its script entry (else its contract, else `DEFAULT_FRAME`) names,
 *     as the active voice's script defines it. The frame's ops are tagged
 *     with their side and its clips ride the SFX channel; the frame expands
 *     BEFORE the body, so a frame that aborts commits none of the body's
 *     side effects. The user's Radio beeps / Pit ambience settings arrive
 *     through `getFrameOptions` and drop the frame's non-ambient / ambient
 *     STEPS before they expand. A legacy `Scenario` is framed the same way
 *     when its voice has a script, and plays unframed when it does not
 *     (an engine path the catalog no longer exercises since #1065, kept for
 *     `defineScenario`'s remaining callers — the interpreter's own tests).
 *   - A pool named by the active voice's script shadows a code-registered
 *     pool of the same name, for that voice only; a slashed pool step
 *     (`group/base`) addresses the voice's clip groups directly.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus } from "@iracedeck/audio-service";
import type { CalloutScript } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import { ContractRegistry } from "./contract-registry.js";
import type { ResolvedStep, Scenario, ScenarioContract, VocabularyResolver } from "./dsl.js";
import { resolveStep } from "./dsl.js";
import { BusTable, type BusTableView, type BusView, codePointOrder, type WaitingFire } from "./engine-types.js";
import { Expansion } from "./expansion.js";
import { LineEnds } from "./line-ends.js";
// Manifest types + helpers live in `./manifest.js` to break a circular
// import with `./validation.js`; the pool store and validation both read
// `referenceVoice` from it, and this file only the manifest type.
import type { AudioAssetsManifest } from "./manifest.js";
import { OnceWarnings } from "./once-warnings.js";
import { PendingQueue } from "./pending-queue.js";
import { Playback } from "./playback.js";
import { PoolStore } from "./pool-store.js";
import { Scheduler } from "./scheduler.js";
import type { CompiledVoiceScript } from "./script-compiler.js";
import { ScriptSet } from "./script-set.js";
import { isStatePartError, readStatePart, type StatePartError } from "./state-part.js";
import { Triggers } from "./triggers.js";
import { Vocabulary } from "./vocabulary.js";

// Re-export so existing consumers of `interpreter.js` keep their import paths.
export { type AudioAssetsManifest, manifestVoices } from "./manifest.js";
export { poolMemberPattern } from "./pool-store.js";

/**
 * The user's two frame switches (issue #1064), read live at every frame
 * expansion: `beeps` keeps the frame's non-ambient steps (the walkie-talkie
 * ticks, or whatever a pack put there), `ambience` keeps its `ambient` steps.
 * The definition is by position in the frame, not by clip path, so a pack's
 * own beep clip is governed by the setting too.
 */
export type FrameOptions = { beeps: boolean; ambience: boolean };

/**
 * What `playFramePreview` did (issue #1124): started (or, with both switches
 * off, completed on the spot), found no frame to play, or found the bus in
 * use and left it alone.
 */
export type FramePreviewResult = "playing" | "no-frame" | "bus-busy";

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

/**
 * One registered contract as the generated pack-author reference and
 * `lint:pack` see it (#1066): the id a script entry pairs with, what triggers
 * it, the prose on when it fires, and the scheduling a pack cannot change but
 * an author should know about. Every field is EFFECTIVE — `frame` and `weight`
 * carry the default a contract left unset (`DEFAULT_FRAME`, `DEFAULT_WEIGHT`),
 * `event` is `null` for a contract only `fire()` triggers, `family` and `base`
 * are `null` when it has none — so a consumer never re-derives a default the
 * scheduler already applies. A legacy `Scenario` is reported through the same
 * shape; the reference generator refuses one, and the enumeration is what
 * lets it.
 */
export type ContractReport = {
  id: string;
  event: SimEventName | null;
  /** `""` when the contract carries none — the bundled catalog is held to a sentence by `bundled-scripts.test.ts`. */
  description: string;
  frame: string;
  family: string | null;
  weight: number;
  queueable: boolean;
  interrupt: boolean;
  /**
   * The speak-time gate's one-sentence description (issue #1138) — what is
   * re-checked after the script expands and before the bus take — or `null`
   * when the contract carries none. The reference renders it beside the
   * trigger so a pack author reading a silent callout knows the second gate
   * exists and what it asks.
   */
  speakGate: string | null;
  /**
   * The one-sentence description of the event that ends the contract's fires
   * early (`endsOn`, issue #1407), or `null` when it carries none. The
   * reference renders it as "Ends when: …" beside the speak-time gate.
   */
  endsOn: string | null;
  /**
   * The event named by `endsOn` (issue #1407), or `null` when the contract
   * carries none. Not published in the pack reference — a pack author reads
   * the description — but read by the check that the translator never
   * publishes the contract's `event` after this one within a tick (#1499,
   * `race-engineer-wiring`'s `ends-on-order.test.ts`).
   */
  endsOnEvent: SimEventName | null;
  /**
   * The contract's `base` as registered (`"voice/{voice}"`, `"pit-crew"`),
   * `null` when it has none: what a bare literal clip path in a script entry
   * is resolved against — `flags/green-01.mp3` plays from the voice's folder
   * under the first, from the audio root under none — so the reference can
   * say which callouts resolve a literal where (#1066).
   */
  base: string | null;
};

/**
 * What the engine is doing right now, for the Telemetry Snapshot (issue
 * #1387): a support case can see what was on the radio, what was waiting for
 * it and why a callout stayed silent at the moment the key was pressed. Plain
 * data throughout — ids, numbers, booleans — so it serialises as it stands:
 * a timer is reported as a boolean, and a fire's event, ops and resume state
 * are left out.
 *
 * `activeVoice` and `frameOptions` come from the two accessors the engine was
 * handed — code it does not own, reading the settings. Each is read on its
 * own (`readStatePart`), so one that throws is an `{ error }` entry in its
 * field and costs nothing else: the buses, the queue and the contracts are
 * the engine's own maps and are reported regardless.
 */
export type ScenarioEngineState = {
  /**
   * The voice `{voice}` resolves to; `null` when none is selected. An error
   * entry when the accessor threw — never `null`, which already means "no
   * voice".
   */
  activeVoice: string | null | StatePartError;
  /**
   * The user's Radio beeps / Pit ambience switches as the engine reads them,
   * or an error entry when the accessor threw.
   */
  frameOptions: FrameOptions | StatePartError;
  /**
   * `true` when a registration landed after the last script compile, so each
   * contract's `scripted` below is the LAST compile's answer; the next fire
   * recompiles. `describeState` never compiles: it would log, and reset the
   * script pools' no-repeat trackers, at a key press.
   */
  scriptsDirty: boolean;
  /** One row per audio bus, in the `AudioBus` enum's order — a bus nothing has used yet reads as idle. */
  buses: Array<{
    /** The `AudioBus` member's name (`"Voice"`). */
    bus: string;
    playingId: string | null;
    /**
     * The fire in flight. The engine keeps no start time for it, so its
     * position is the op in flight (`opIndex`, zero-based) out of the ops
     * this fire plays (`opCount`) — for a fire resumed after an interrupt,
     * the resumed tail rather than the callout's whole body.
     */
    active: { id: string; weight: number; opIndex: number; opCount: number } | null;
    /** The exclusive-focus floor held on the bus (issue #652), if any. */
    focus: { ownerId: string; floor: number } | null;
    /** A finished fire's `pendingHoldMs` is delaying the drain of `waiting`. */
    pendingHoldArmed: boolean;
    /**
     * The fires waiting for the bus, in play order. An entry past its
     * `maxWaitMs` stays listed until the next drain drops it.
     */
    waiting: Array<{
      id: string;
      weight: number;
      /** The supersede group; the contract id when it declares none. */
      group: string;
      /** `Date.now()` when the fire was first deferred. */
      queuedAt: number;
      maxWaitMs: number;
      /** The waiting leader this one plays right after (`queueBehind`), or `null`. */
      after: string | null;
    }>;
  }>;
  /** Every registered contract (and legacy scenario), sorted by id in code-point order. */
  contracts: Array<{
    id: string;
    enabled: boolean;
    /**
     * `Date.now()` when a fire of it last took the bus; `0` when none has. A
     * fire that is only waiting has stamped nothing, and neither does a fire
     * resumed after an interrupt.
     */
    lastFireAt: number;
    /**
     * Whether the active voice's compiled script has a body for it — see
     * `scriptsDirty`. `null` when the active voice could not be read (its
     * error entry is `activeVoice`): unknown, not a `false` that would read
     * as "this voice does not say it".
     */
    scripted: boolean | null;
    /** A `triggerDelay` or `settle` timer is running for it. */
    triggerPending: boolean;
  }>;
};

/**
 * The `AudioBus` members, in declaration order (a numeric enum also lists its
 * names as values). Read at the call, never at module load: a test that mocks
 * `@iracedeck/audio-service` without the enum must still be able to import
 * this module.
 */
function audioBuses(): AudioBus[] {
  return Object.values(AudioBus).filter((v): v is AudioBus => typeof v === "number");
}

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
   * description feeds the generated reference (#1066). The resolver receives
   * the `ScenarioContext` of the fire (issue #1065); `event` is `null` for an
   * imperative fire.
   */
  defineVar(name: string, resolver: VocabularyResolver<string | null>, description?: string): void;
  /**
   * Register a condition a script's `if` names (issue #1064). Scripts can
   * only reference conditions, never compose them — a script needing
   * `a && b` gets a named condition registered here. The predicate receives
   * the `ScenarioContext` of the fire (issue #1065); `event` is `null` for an
   * imperative fire.
   */
  defineCond(name: string, predicate: VocabularyResolver<boolean>, description: string): void;
  /**
   * Register a case var a script's `case` branches on (issue #1064). The key
   * set is DECLARED, not inferred: `keys` maps each key the resolver can
   * return to what it means, which is what lets a pack author write the
   * branch without reading the resolver, and lets the compiler refuse a
   * typo'd key. A resolver returning an undeclared key is a code bug (warned
   * once) and takes the script's `default` branch. The resolver receives the
   * `ScenarioContext` of the fire (issue #1065); `event` is `null` for an
   * imperative fire.
   */
  defineCase(
    name: string,
    resolver: VocabularyResolver<string | null>,
    keys: Readonly<Record<string, string>>,
    description: string,
  ): void;
  /**
   * Replace the voice scripts wholesale — voice id → parsed `callouts.json`
   * — and compile every one eagerly against the registries (issue #1064).
   * Runs on every voice-pack rescan, exactly as `setManifest` does.
   */
  setScripts(scripts: ReadonlyMap<string, CalloutScript>): void;
  /**
   * Compile ONE script against the registries as they stand now — the very
   * compile `setScripts` runs per voice, same deps, same diagnostics — and
   * hand the diagnostics back instead of logging them. Loads nothing and
   * changes nothing: what `lint:pack` (#1066) reports for a pack is thereby
   * what the plugin would log for it, rather than a rebuild off the public
   * reports. It names no voice, so a literal `voice/<voice>/…` path stays as
   * the pack wrote it, where `setScripts` qualifies it with the pack of a
   * composite voice (#1144).
   */
  compileScript(script: CalloutScript): CompiledVoiceScript;
  /**
   * Whether the ACTIVE voice's compiled script has a body for the scenario
   * id — the same lookup a fire makes. `false` when the entry is absent or
   * `skip: true`, when the voice has no script, and when no voice is active.
   * For an imperative owner deciding whether a call is worth preparing for
   * (the spotter's focus floor, #1065): a pack is never punished for what it
   * does not say, and neither is every other callout.
   */
  isScripted(scenarioId: string): boolean;
  /** Everything the vocabulary registries hold, for the reference generator and the pack linter (#1066). */
  vocabulary(): VocabularyReport;
  /**
   * Every registered contract — and any legacy scenario — as the reference
   * generator and the pack linter see it (#1066), sorted by id in code-point
   * order like `vocabulary()`. Effective values throughout: see `ContractReport`.
   */
  contracts(): readonly ContractReport[];
  setEnabled(scenarioId: string, enabled: boolean): void;
  fire(scenarioId: string): void;
  /**
   * Play the ACTIVE voice's compiled frame `frameName` around `holdMs` of
   * silence — the Background Test (issue #1124). The frame is expanded as a
   * callout's is: the user's Radio beeps / Pit ambience switches, frame clips
   * on the SFX channel, the ambient steps. It plays on the Voice bus and
   * YIELDS to every callout: it never cuts, delays or displaces one. It
   * starts only on a free bus — nothing playing, nothing pending, no focus
   * floor held — and any callout that would play while it runs cuts it and
   * then schedules exactly as it would on an idle bus.
   *
   * Returns `"no-frame"` without playing when no voice is active or the
   * active voice has no compiled frame of that name (no script, a frame it
   * does not define, or one that failed to compile or aborted on a missing
   * clip) — the caller falls back — and `"bus-busy"` without playing when
   * the bus is not free. Otherwise returns `"playing"`, and `onComplete` runs
   * once the preview leaves the bus — finished, cut, or `stopAll` — or at
   * once when the switches leave the frame nothing to play.
   */
  playFramePreview(frameName: string, holdMs: number, onComplete?: () => void): FramePreviewResult;
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
  /**
   * What the engine is doing right now, for the Telemetry Snapshot (issue
   * #1387) — see `ScenarioEngineState`. A pure read: it logs nothing, compiles
   * nothing, creates no bus state, and neither expires nor takes a waiting
   * fire, so calling it changes nothing about what plays next.
   */
  describeState(): ScenarioEngineState;
}

/**
 * The engine's facade (issue #1514): it builds the modules in its
 * constructor and turns each `IScenarioEngine` method into a short, ordered
 * sequence of module calls — the registration sequence, `defineVar` then
 * mark dirty, `setScripts`' reset then compile, `dispose`'s order. It holds
 * no state of its own beyond the module instances, the one bus table, its
 * three injected read-only dependencies and the session-change unsubscribe;
 * `interpreter-facade.test.ts` fails on the first field added here instead
 * of in the module that owns its concern.
 */
class ScenarioEngine implements IScenarioEngine {
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

  /** The registered contracts; the facade runs the registration sequence over it (`registerEntry`). */
  private readonly registry: ContractRegistry;
  /** The manifest, the pools and the pickers (`PoolStore`); its script-pool source is the script set. */
  private readonly poolStore: PoolStore;
  /** The var, condition and case registries (`Vocabulary`). */
  private readonly vocab: Vocabulary;
  /**
   * The one table of per-bus state (`BusTable`, the declared shared table of
   * the split), seen here through `BusTableView` and read only by
   * `describeState`: the schedule half is the scheduler's to write, the
   * active fire is playback's.
   */
  private readonly buses: BusTableView;
  /**
   * The op walk over `IAudioService` (`Playback`): the bus take, the steps,
   * the cut and the cut tail. It reports a bus take and a finish to the
   * scheduler through its listener, synchronously.
   */
  private readonly playback: Playback;

  /** The scripts, their compiled form, the dirty flag and the expansion generation (`ScriptSet`). */
  private readonly scripts: ScriptSet;
  /**
   * The frame and body expansion (`Expansion`): `prepare` for a fire and
   * `prepareFrame` for the preview, each handing back uncommitted picks. It
   * touches no bus; the gate and the commit are the scheduler's.
   */
  private readonly expansion: Expansion;
  /**
   * The arbitration (`Scheduler`): every bus's queue, focus floor and hold,
   * the session generation, the gate and the commit, the bus take through
   * `playback`, the frame preview, `stopAll` and the focus calls.
   */
  private readonly scheduler: Scheduler;
  /**
   * The contract triggers (`Triggers`): each `when` as a bus subscription,
   * the `where`, `triggerDelay` and `settle` decisions, and every
   * contract's `unsubscribe` and `pendingTriggerTimer`.
   */
  private readonly triggers: Triggers;
  /**
   * The line ends (`LineEnds`): one subscription per `endsOn` event, and
   * `endFires` reaching the timers, the queues and the playing fire through
   * the triggers, the scheduler and playback.
   */
  private readonly lineEnds: LineEnds;
  /**
   * The once-per warn sets (`OnceWarnings`): five keyspaces, every one cleared
   * by `setScripts`, so a rescan that hands the engine a still-broken pack
   * says so again.
   */
  private readonly warnings = new OnceWarnings();
  /** Unsubscribes the session-change clear; called by `dispose`. */
  private readonly unsubscribeSessionChanged: () => void;

  constructor(
    eventBus: IEventBus,
    audio: IAudioService,
    manifest: AudioAssetsManifest,
    logger: ILogger,
    getActiveVoice: () => string | null = () => null,
    getFrameOptions: () => FrameOptions = () => ({ beeps: true, ambience: true }),
  ) {
    this.logger = logger;
    this.getActiveVoice = getActiveVoice;
    this.getFrameOptions = getFrameOptions;
    this.registry = new ContractRegistry(logger);
    // The store reads the active voice's script pools live, on every pick,
    // off whatever the last compile produced.
    this.poolStore = new PoolStore(manifest, logger, getActiveVoice, (voice, name) =>
      this.scripts.compiled(voice)?.pools.get(name),
    );
    this.vocab = new Vocabulary(logger, this.warnings);
    this.scripts = new ScriptSet(logger, this.warnings, getActiveVoice, {
      contracts: this.registry,
      vocabulary: this.vocab,
      pools: this.poolStore,
    });
    this.expansion = new Expansion(logger, this.warnings, getActiveVoice, getFrameOptions, {
      contracts: this.registry,
      vocabulary: this.vocab,
      pools: this.poolStore,
      scripts: this.scripts,
    });
    // One table for both halves of every bus's state; playback is handed it
    // without the schedule half, and reports to the scheduler synchronously.
    // The listener forwards to the scheduler built right after it — no call
    // can reach it during construction, since nothing plays yet.
    const buses = new BusTable(
      () => new PendingQueue<WaitingFire>((follower, leader) => this.registry.waitsBehind(follower, leader)),
    );
    this.buses = buses;
    this.playback = new Playback(
      audio,
      logger,
      buses,
      {
        busTaken: (bus) => this.scheduler.busTaken(bus),
        fireFinished: (bus, id) => this.scheduler.fireFinished(bus, id),
      },
      { pools: this.poolStore },
    );
    this.scheduler = new Scheduler(logger, getActiveVoice, buses, {
      contracts: this.registry,
      scripts: this.scripts,
      pools: this.poolStore,
      expansion: this.expansion,
      playback: this.playback,
    });
    // Subscribed here, before any contract can register, so that on a
    // `session.changed` it runs FIRST (the bus dispatches in subscription
    // order) — the session-start and race-start lines that fire on that
    // event are deferred into an already-cleared queue, not cleared by it.
    // A redefined contract unsubscribes and subscribes again, behind this.
    // The plugin's engine lives as long as the plugin; `dispose` is for a
    // reset (`_resetAudioScenarios`) that builds another on the same bus.
    // The two modules that subscribe are built after it, and subscribe only
    // at a registration.
    this.unsubscribeSessionChanged = eventBus.subscribe("session.changed", () =>
      this.scheduler.clearQueuesForSessionChange(),
    );
    this.triggers = new Triggers(eventBus, logger, { contracts: this.registry, scheduler: this.scheduler });
    this.lineEnds = new LineEnds(eventBus, logger, buses, {
      contracts: this.registry,
      scheduler: this.scheduler,
      triggers: this.triggers,
      playback: this.playback,
    });
  }

  /**
   * Detach the engine from the event bus and stop its timers: the
   * session-change clear, every `endsOn` subscription, every contract's
   * subscription and pending
   * `triggerDelay` / `settle` timer, and every bus's pending hold. Without
   * it, a second engine on the same bus would run alongside the first —
   * one `session.changed` clearing twice (issue #1185).
   */
  dispose(): void {
    this.unsubscribeSessionChanged();
    this.lineEnds.dispose();
    this.triggers.detachAll();
    this.scheduler.clearHolds();
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
    const existing = this.registry.get(s.id);

    if (existing) {
      this.logger.warn(`Scenario "${s.id}" redefined; replacing previous definition`);
      this.triggers.detach(existing);
      this.triggers.cancelPending(existing);
    }

    const entry = this.registry.store(s, resolvedSequence);
    this.scripts.markDirty();
    this.registry.warnCrossBusQueueBehind(entry);
    this.registry.warnQueueBehindCycle(entry);

    const { errors, warnings } = this.registry.validate(entry, {
      pools: this.poolStore.pools,
      vars: this.vocab.vars,
      manifest: this.poolStore.currentManifest(),
    });

    if (warnings.length > 0) {
      this.logger.warn(`Scenario "${s.id}" has validation warnings:\n  - ${warnings.join("\n  - ")}`);
    }

    if (errors.length > 0) {
      this.logger.error(`Scenario "${s.id}" has validation errors and is disabled:\n  - ${errors.join("\n  - ")}`);
      entry.enabled = false;

      return;
    }

    this.triggers.attach(entry);
    this.lineEnds.watch(entry);
  }

  definePool(name: string, clips: string[]): void {
    // Dirty only for a pool the store accepted: a rejected list changes
    // nothing a script compiles against.
    if (this.poolStore.definePool(name, clips)) this.scripts.markDirty();
  }

  definePoolFromManifest(name: string, group: string, base: string): void {
    this.poolStore.definePoolFromManifest(name, group, base);
    this.scripts.markDirty();
  }

  setManifest(manifest: AudioAssetsManifest): void {
    this.poolStore.setManifest(manifest);
    // Every pool's membership was re-derived, so a stashed resume was
    // expanded against clip lists that no longer exist (issue #1136).
    this.scripts.invalidate();

    this.logger.info("Audio manifest reloaded");
    this.logger.debug(`Clips: ${manifest.clips.length}`);
  }

  currentManifest(): AudioAssetsManifest {
    return this.poolStore.currentManifest();
  }

  defineVar(name: string, resolver: VocabularyResolver<string | null>, description = ""): void {
    this.vocab.defineVar(name, resolver, description);
    this.scripts.markDirty();
  }

  defineCond(name: string, predicate: VocabularyResolver<boolean>, description: string): void {
    this.vocab.defineCond(name, predicate, description);
    this.scripts.markDirty();
  }

  defineCase(
    name: string,
    resolver: VocabularyResolver<string | null>,
    keys: Readonly<Record<string, string>>,
    description: string,
  ): void {
    this.vocab.defineCase(name, resolver, keys, description);
    this.scripts.markDirty();
  }

  vocabulary(): VocabularyReport {
    return this.vocab.vocabulary();
  }

  contracts(): readonly ContractReport[] {
    return this.registry.contracts();
  }

  describeState(): ScenarioEngineState {
    // The two accessors are the only calls here into code the engine does not
    // own, so each is read on its own: one that throws is an error entry in
    // its field, and the walk of the engine's own maps below still reports.
    // That walk is not guarded piece by piece — it calls nothing foreign, so
    // a throw there is a bug in this method, which the caller's own
    // `readStatePart` reports as the engine's part failing.
    const activeVoice = readStatePart(() => this.getActiveVoice());
    const voiceUnread = isStatePartError(activeVoice);
    // The compiled map as it stands, NOT `isScripted`: that recompiles a
    // dirty script set, which logs and clears the script pools' no-repeat
    // state. `scriptsDirty` says when the answer is the last compile's.
    const scripted = voiceUnread || activeVoice === null ? undefined : this.scripts.compiled(activeVoice)?.scenarios;

    return {
      activeVoice,
      // The accessor itself rather than `Expansion`'s `frameOptions()`, which logs a throw.
      frameOptions: readStatePart(() => ({ ...this.getFrameOptions() })),
      scriptsDirty: this.scripts.dirty,
      // `peek`, not `get`: a read creates no state.
      buses: audioBuses().map((bus) => describeBus(bus, this.buses.peek(bus))),
      contracts: [...this.registry.entries.values()]
        .map((entry) => ({
          id: entry.raw.id,
          enabled: entry.enabled,
          lastFireAt: entry.lastFireAt,
          scripted: voiceUnread ? null : (scripted?.has(entry.raw.id) ?? false),
          triggerPending: entry.pendingTriggerTimer !== null,
        }))
        .sort((a, b) => codePointOrder(a.id, b.id)),
    };
  }

  compileScript(script: CalloutScript): CompiledVoiceScript {
    return this.scripts.compileScript(script);
  }

  isScripted(scenarioId: string): boolean {
    return this.scripts.isScripted(scenarioId);
  }

  setScripts(scripts: ReadonlyMap<string, CalloutScript>): void {
    this.warnings.reset();
    this.scripts.setScripts(scripts);
    this.logger.info("Voice scripts loaded");
  }

  setEnabled(scenarioId: string, enabled: boolean): void {
    const entry = this.registry.get(scenarioId);

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
      this.triggers.cancelPending(entry);

      // Cancel in-flight execution on any bus + remove its waiting entry.
      this.scheduler.cancelDisabled(scenarioId);
    }
  }

  fire(scenarioId: string): void {
    const entry = this.registry.get(scenarioId);

    if (!entry) {
      this.logger.warn(`fire: scenario "${scenarioId}" not found`);

      return;
    }

    this.scheduler.attemptFire(entry, null);
  }

  playFramePreview(frameName: string, holdMs: number, onComplete?: () => void): FramePreviewResult {
    return this.scheduler.playFramePreview(frameName, holdMs, onComplete);
  }

  stopAll(): void {
    this.scheduler.stopAll();
  }

  acquireFocus(bus: AudioBus, ownerId: string, floorWeight: number): void {
    this.scheduler.acquireFocus(bus, ownerId, floorWeight);
  }

  releaseFocus(bus: AudioBus, ownerId: string): void {
    this.scheduler.releaseFocus(bus, ownerId);
  }
}

/**
 * One bus's row of `describeState` (issue #1387); `state` is `undefined` for
 * a bus nothing has used yet, which reads as idle. `queue.ordered()` is the
 * queue's one pure read — `next` would expire entries and hand one out.
 */
function describeBus(bus: AudioBus, state: BusView | undefined): ScenarioEngineState["buses"][number] {
  const fire = state?.transport.active ?? null;

  return {
    bus: AudioBus[bus] ?? String(bus),
    // Derived, not stored: the playing id is the active fire's (issue #1514).
    playingId: fire?.id ?? null,
    active:
      fire === null
        ? null
        : {
            id: fire.id,
            weight: fire.weight,
            // `index` points one past the op in flight (see `buildResumeState`).
            opIndex: Math.max(0, fire.index - 1),
            opCount: fire.ops.length,
          },
    focus: state?.schedule.focus ? { ownerId: state.schedule.focus.ownerId, floor: state.schedule.focus.floor } : null,
    pendingHoldArmed: (state?.schedule.holdTimer ?? null) !== null,
    waiting: (state?.schedule.queue.ordered() ?? []).map((e) => ({
      id: e.id,
      weight: e.weight,
      group: e.group,
      queuedAt: e.queuedAt,
      maxWaitMs: e.maxWaitMs,
      after: e.after,
    })),
  };
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
  engine?.dispose();
  engine = null;
}
