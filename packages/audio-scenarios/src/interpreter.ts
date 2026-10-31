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
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, CONNECTOR_POOL } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import { ContractRegistry } from "./contract-registry.js";
import type {
  ResolvedStep,
  Scenario,
  ScenarioContext,
  ScenarioContract,
  SpeakGate,
  VocabularyResolver,
} from "./dsl.js";
import { applyBase, DEFAULT_MAX_QUEUE_WAIT_MS, DEFAULT_WEIGHT, NO_FRAME, resolveStep } from "./dsl.js";
import {
  type ActiveFire,
  type BusState,
  codePointOrder,
  type CompiledScenario,
  type ExecOp,
  type ExpandedFrame,
  ExpansionAbort,
  fireContext,
  type FrameSide,
  type PreparedFire,
  type ResumeState,
  type WaitingFire,
} from "./engine-types.js";
// Manifest types + helpers live in `./manifest.js` to break a circular
// import with `./validation.js`; the pool store and validation both read
// `referenceVoice` from it, and this file only the manifest type.
import type { AudioAssetsManifest } from "./manifest.js";
import { OnceWarnings } from "./once-warnings.js";
import { PendingQueue, type QueuedFire, type QueueDrop } from "./pending-queue.js";
import { type PickSession, PoolStore } from "./pool-store.js";
import type { CompiledFrame, CompiledVoiceScript } from "./script-compiler.js";
import { ScriptSet } from "./script-set.js";
import { isStatePartError, readStatePart, type StatePartError } from "./state-part.js";
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
 * The bus id the frame preview plays under (issue #1124). Not a scenario:
 * no contract is registered with it, so every lookup by it misses — no
 * cooldown, no pending hold, nothing to stash when it is cut.
 */
const FRAME_PREVIEW_ID = "(frame preview)";

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

class ScenarioEngine implements IScenarioEngine {
  private readonly eventBus: IEventBus;
  private readonly audio: IAudioService;
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
  private readonly busState = new Map<AudioBus, BusState>();

  /** The scripts, their compiled form, the dirty flag and the expansion generation (`ScriptSet`). */
  private readonly scripts: ScriptSet;
  /**
   * Bumped by every `session.changed` (issue #1185). The queue clear on that
   * event cannot reach a line still playing from the session that ended, so
   * the fire records the generation it started in and an interrupt cutting
   * it after the change drops it instead of stashing it.
   */
  private sessionGeneration = 0;
  /**
   * The once-per warn sets (`OnceWarnings`): five keyspaces, every one cleared
   * by `setScripts`, so a rescan that hands the engine a still-broken pack
   * says so again.
   */
  private readonly warnings = new OnceWarnings();
  /** Unsubscribes the session-change clear; called by `dispose`. */
  private readonly unsubscribeSessionChanged: () => void;
  /**
   * One bus subscription per distinct `endsOn` event (issue #1407), made when
   * the first contract naming that event registers and kept for the engine's
   * life: `endFires` reads the registered contracts at each arrival, so a
   * redefinition needs no new subscription. Unsubscribed by `dispose`.
   */
  private readonly endSubscriptions = new Map<SimEventName, () => void>();

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
    // Subscribed here, before any contract can register, so that on a
    // `session.changed` it runs FIRST (the bus dispatches in subscription
    // order) — the session-start and race-start lines that fire on that
    // event are deferred into an already-cleared queue, not cleared by it.
    // A redefined contract unsubscribes and subscribes again, behind this.
    // The plugin's engine lives as long as the plugin; `dispose` is for a
    // reset (`_resetAudioScenarios`) that builds another on the same bus.
    this.unsubscribeSessionChanged = this.eventBus.subscribe("session.changed", () =>
      this.clearQueuesForSessionChange(),
    );
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

    for (const unsubscribe of this.endSubscriptions.values()) unsubscribe();

    this.endSubscriptions.clear();

    for (const entry of this.registry.entries.values()) {
      entry.unsubscribe?.();
      entry.unsubscribe = null;

      if (entry.pendingTriggerTimer !== null) {
        clearTimeout(entry.pendingTriggerTimer);
        entry.pendingTriggerTimer = null;
      }
    }

    for (const state of this.busState.values()) this.clearPendingHold(state);
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
      existing.unsubscribe?.();

      if (existing.pendingTriggerTimer !== null) {
        clearTimeout(existing.pendingTriggerTimer);
        existing.pendingTriggerTimer = null;
      }
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

    if (s.when) {
      entry.unsubscribe = this.subscribeToEvent(s.id, s.when.event, s.when.where);
    }

    if (s.endsOn) this.subscribeToEnd(s.endsOn.event);
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
      // The accessor itself rather than `frameOptions()`, which logs a throw.
      frameOptions: readStatePart(() => ({ ...this.getFrameOptions() })),
      scriptsDirty: this.scripts.dirty,
      // `busState.get`, not `getBusState`: a read creates no state.
      buses: audioBuses().map((bus) => describeBus(bus, this.busState.get(bus))),
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
      if (entry.pendingTriggerTimer !== null) {
        clearTimeout(entry.pendingTriggerTimer);
        entry.pendingTriggerTimer = null;
      }

      // Cancel in-flight execution on any bus + remove its waiting entry. A
      // fire that waited behind it (issue #1108) stays, as an ordinary entry
      // (issue #1185).
      for (const state of this.busState.values()) {
        const wasActive = state.activeFire?.id === scenarioId;

        if (wasActive) this.cancelActiveFire(state);

        if (state.queue.remove(scenarioId) !== null) this.logger.debug(`Scenario "${scenarioId}" dropped — disabled`);

        // Disabling the in-flight scenario idled the bus — play whatever was
        // waiting behind it rather than stranding it (issue #652 review).
        if (wasActive && state.playingId === null) this.drainPending(state);
      }
    }
  }

  fire(scenarioId: string): void {
    const entry = this.registry.get(scenarioId);

    if (!entry) {
      this.logger.warn(`fire: scenario "${scenarioId}" not found`);

      return;
    }

    this.attemptFire(entry, null);
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
    this.scripts.ensureCompiled();

    const voice = this.getActiveVoice();
    const script = voice === null ? undefined : this.scripts.compiled(voice);

    if (voice === null || script === undefined || !script.frames.has(frameName)) {
      this.logger.debug(`Frame preview "${frameName}" unavailable for voice "${voice ?? "(none)"}"`);

      return "no-frame";
    }

    const state = this.getBusState(AudioBus.Voice);

    if (state.playingId !== null || state.queue.size > 0 || state.focus !== null) {
      this.logger.debug(`Frame preview "${frameName}" skipped — the Voice bus is in use`);

      return "bus-busy";
    }

    let frame: ExpandedFrame | null;
    const session = this.poolStore.openSession();

    try {
      frame = this.expandFrame(frameName, voice, script, FRAME_PREVIEW_ID, fireContext(null), null, session);
    } catch (err) {
      if (err instanceof ExpansionAbort) {
        this.logger.debug(`Frame preview "${frameName}" skipped — ${err.reason}`);
      } else {
        this.logger.error(
          `Frame preview "${frameName}" expansion failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return "no-frame";
    }

    if (frame === null) return "no-frame";

    session.commit();

    if (frame.open.length === 0 && frame.close.length === 0) {
      // Both switches off: nothing to audition, and no reason to hold the
      // bus for a silent window.
      onComplete?.();

      return "playing";
    }

    const ops: ExecOp[] = [...frame.open, { kind: "pause", ms: holdMs }, ...frame.close];

    this.takeBus(state, {
      id: FRAME_PREVIEW_ID,
      bus: AudioBus.Voice,
      // Never compared: an arriving fire treats the preview's bus as idle.
      weight: 0,
      ops,
      index: 0,
      sourceOps: ops,
      sourceStart: 0,
      prerollCount: 0,
      cancelled: false,
      pauseTimer: null,
      usedChannels: collectUsedChannels(ops),
      event: null,
      sessionGeneration: this.sessionGeneration,
      cutTail: [],
      ended: false,
      onSettled: onComplete,
    });

    this.logger.info(`Playing frame preview "${frameName}" for voice "${voice}"`);
    this.logger.debug(`Ops (${ops.length}): ${ops.map(opLabel).join(" | ")}`);

    this.stepNext(state);

    return "playing";
  }

  /**
   * Cut the frame preview if it holds the bus (issue #1124), so a fire that
   * is about to play takes the bus as if it were idle. Called only once
   * that fire has expanded to something to play: one that aborts leaves
   * the preview running.
   */
  private yieldPreview(state: BusState): void {
    if (state.activeFire?.id === FRAME_PREVIEW_ID) this.cancelActiveFire(state);
  }

  /**
   * Cancel every in-flight fire on all buses and clear every bus's queue of
   * deferred replays (unlogged per entry: the reset is the reason). Used when the Race Engineer master gate flips off so a callout
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
      state.queue.clear();
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
      const entry = this.registry.get(id);

      if (!entry || !entry.enabled) return;

      const triggerDelay = entry.raw.triggerDelay ?? 0;
      const settle = entry.raw.settle;

      if (triggerDelay <= 0 && !settle) {
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
      // A contract with `settle` (issue #1284) takes this path even with no
      // `triggerDelay`, and after the delay keeps asking `pending` until it
      // reports ready or the wait reaches `maxWaitMs` from the event's
      // arrival. Every hop reuses `pendingTriggerTimer`, so what cancels a
      // deferred fire — a newer event, a disable, a redefinition — cancels a
      // settle in progress too.
      //
      // Cancel any pending timer for this scenario so the most recent event
      // wins. Two rapid SessionNum advances would otherwise queue two fires.
      if (entry.pendingTriggerTimer !== null) {
        clearTimeout(entry.pendingTriggerTimer);
      }

      const arrivedAt = Date.now();
      let asks = 0;

      const onTimer = (): void => {
        entry.pendingTriggerTimer = null;

        // Re-check entry state — scenario may have been redefined or
        // disabled during the wait.
        const current = this.registry.get(id);

        if (!current || !current.enabled || current !== entry) return;

        if (settle) {
          const missing = this.settlePending(id, settle.pending, ev);
          const waited = Date.now() - arrivedAt;

          asks++;

          if (missing !== null) {
            const remaining = settle.maxWaitMs - waited;

            if (remaining > 0) {
              entry.pendingTriggerTimer = setTimeout(onTimer, Math.min(settle.pollMs, remaining));

              return;
            }

            this.logger.info(`Scenario "${id}" proceeding without ${missing} after ${waited} ms`);
          } else if (asks > 1) {
            this.logger.debug(`Scenario "${id}" settled after ${waited} ms`);
          }
        }

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
      };

      entry.pendingTriggerTimer = setTimeout(onTimer, Math.max(triggerDelay, 0));
    };

    return this.eventBus.subscribe(eventName, handler);
  }

  /**
   * Subscribe `endFires` to an `endsOn` event (issue #1407), once per distinct
   * event however many contracts name it. A contract is never ended by its
   * own trigger (validation refuses it), but the end can still race ANOTHER
   * contract that the same event triggers, because the bus dispatches in
   * subscription order: one triggered immediately (no `triggerDelay` /
   * `settle`), not `queueable`, on the same bus as a line this end stops
   * silently, plays only if `endFires` ran first — otherwise it meets the
   * busy bus and is dropped. That order is registration order, and not
   * stable: a redefined contract subscribes again at the end, while this
   * subscription keeps its place. Nothing hits it today — `pitLane.exited`
   * triggers only `limiter-on-track`, whose `triggerDelay` makes it a timer
   * that runs after every handler — but a new contract of that shape must
   * not rely on the order.
   */
  private subscribeToEnd(event: SimEventName): void {
    if (this.endSubscriptions.has(event)) return;

    this.endSubscriptions.set(
      event,
      this.eventBus.subscribe(event, () => this.endFires(event)),
    );
  }

  /**
   * End every fire of every contract whose `endsOn` names `event` (issue
   * #1407), wherever it is: a pending `triggerDelay` / `settle` timer is
   * cleared, a waiting fire (an interrupt's stash included) is removed and
   * logged as dropped with the reason `ended`, and the playing fire either
   * plays its cut tail (`playCutTail`) — once words have been heard and the
   * tail is not empty — or is stopped silently and the bus drained, as a
   * disable does. A fire whose line has been heard in full (`lineFinished`:
   * no body clip left from the op in flight on — it is in its close ops, or
   * in a trailing pause after its last clip) is left to finish, so the
   * driver never hears "never mind" after a complete line. A fire that is
   * already a cut tail (`ended`) is left alone too, so a second end — a tow
   * or a reset can publish the exit twice — is a no-op. One debug line per
   * contract that had anything to end.
   *
   * Two passes: every timer and waiting fire goes first, so a silent stop's
   * drain can never start a fire of another contract this same event is
   * about to end.
   */
  private endFires(event: SimEventName): void {
    const ending = [...this.registry.entries.values()].filter((entry) => entry.raw.endsOn?.event === event);
    const outcomes = new Map<string, string[]>();
    const note = (id: string, outcome: string): void => {
      outcomes.set(id, [...(outcomes.get(id) ?? []), outcome]);
    };

    for (const entry of ending) {
      const id = entry.raw.id;

      if (entry.pendingTriggerTimer !== null) {
        clearTimeout(entry.pendingTriggerTimer);
        entry.pendingTriggerTimer = null;
        note(id, "pending");
      }

      for (const state of this.busState.values()) {
        const waiting = state.queue.remove(id);

        if (waiting === null) continue;

        this.logQueueDrops([{ entry: waiting, reason: { kind: "ended" } }]);
        note(id, "waiting");
      }
    }

    for (const entry of ending) {
      const id = entry.raw.id;

      for (const state of this.busState.values()) {
        const fire = state.activeFire;

        if (fire === null || fire.id !== id || fire.ended) continue;

        if (lineFinished(fire)) {
          note(id, "playing → closing");
        } else if (fire.cutTail.length > 0 && wordsHeard(fire)) {
          this.playCutTail(state, fire);
          note(id, "playing → tail");
        } else {
          this.cancelActiveFire(state);
          this.drainPending(state);
          note(id, "playing → silent");
        }
      }
    }

    for (const [id, outcome] of outcomes) {
      this.logger.debug(`Scenario "${id}" ended by ${event} (${outcome.join(", ")})`);
    }
  }

  /**
   * Cut a playing fire's body mid-clip and put its cut tail on the bus in its
   * place (issue #1407), as a fire of its own marked `ended`: it holds the bus
   * until the tail finishes and then drains it like any fire, a same-family
   * or heavier `interrupt` arrival may cut it, and nothing stashes it.
   *
   * The old fire is marked `cancelled` BEFORE its channels stop: `stopChannel`
   * may fire the body clip's complete callback, and that guard is what keeps
   * `stepNext` from moving the cut fire into its next body op. It is not
   * `cancelActiveFire`, which would release the bus and drop the `onSettled`
   * a caller waits on; the tail inherits both instead.
   *
   * The radio's ambience bed is left running when the tail stops it itself —
   * both first-party cuts are "never mind", then the bed stops with the close
   * tick, and a frame without `cut` falls back to its `close`, which carries
   * the same stop — so "never mind" is said over the bed rather than into
   * silence. A tail with no ambience stop has the bed stopped at the cut, as
   * before: nothing else would ever stop the loop.
   */
  private playCutTail(state: BusState, fire: ActiveFire): void {
    fire.cancelled = true;

    if (fire.pauseTimer) {
      clearTimeout(fire.pauseTimer);
      fire.pauseTimer = null;
    }

    const tail = fire.cutTail;
    const tailStopsBed = tail.some((op) => op.kind === "ambient" && op.action === "stop");

    for (const channel of fire.usedChannels) {
      if (channel === AudioChannel.Ambient && tailStopsBed) continue;

      this.audio.stopChannel(channel);
    }

    this.takeBus(state, {
      id: fire.id,
      bus: fire.bus,
      weight: fire.weight,
      ops: tail,
      index: 0,
      sourceOps: tail,
      sourceStart: 0,
      prerollCount: 0,
      cancelled: false,
      pauseTimer: null,
      usedChannels: collectUsedChannels(tail),
      event: fire.event,
      sessionGeneration: fire.sessionGeneration,
      cutTail: [],
      ended: true,
      onSettled: fire.onSettled,
    });

    this.stepNext(state);
  }

  /**
   * One ask of a contract's `settle.pending` (issue #1284), with the context
   * a vocabulary resolver would get for the same event. A throwing check is
   * logged at error and read as ready, so a bug in it cannot silence the
   * callout — the fire goes on to `where:` as if nothing were missing.
   */
  private settlePending(
    id: string,
    pending: (ctx: ScenarioContext) => string | null,
    event: SimEventOf<SimEventName>,
  ): string | null {
    try {
      return pending(fireContext(event));
    } catch (err) {
      this.logger.error(
        `Scenario "${id}" settle.pending() threw; proceeding as ready: ${err instanceof Error ? err.message : String(err)}`,
      );

      return null;
    }
  }

  // ── Firing pipeline ──

  private attemptFire(
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
    const state = this.getBusState(bus);
    const weight = entry.raw.weight ?? DEFAULT_WEIGHT;

    // Exclusive-focus floor (issue #652): while an owner holds the bus, a
    // non-owner fire BELOW the floor is blocked. The owner's own fires
    // (matching `focusOwner`) always pass; fires AT OR ABOVE the floor break
    // through and schedule normally below — so a floor set to the SAFETY band
    // admits the safety-flag callouts while holding back routine chatter.
    if (this.belowFloor(state, entry.raw.focusOwner, weight)) {
      const reason = `below focus floor (${state.focus?.ownerId ?? ""})`;
      this.queueOrDrop(entry, event, weight, state, reason, resume, admitted, queuedAt);

      return;
    }

    // A bus the frame preview holds counts as idle: the preview yields to
    // every callout (issue #1124), and is cut below once this fire has
    // expanded to something to play.
    if (state.playingId !== null && state.playingId !== FRAME_PREVIEW_ID) {
      const running = this.registry.get(state.playingId);
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
        const expanded = this.prepareOps(entry, event, admitted);

        if (expanded === null) return;

        // Higher weight + interrupt: cut the in-flight fire immediately. If
        // that fire is queueable, stash it so it replays once we're done.
        // (A same-family replacement never stashes — the new fire is fresher
        // info about the same subject.)
        if (!sameFamily) this.stashRunningIfQueueable(state, running);

        this.cancelActiveFire(state);

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
    if (state.queue.hasLeaderFor(entry.raw.id, now)) {
      const reason = "the fire it waits behind is pending";
      this.enqueue(entry.raw.id, event, weight, state, reason, resume, admitted, queuedAt);

      return;
    }

    const expanded = this.prepareOps(entry, event, admitted);

    if (expanded === null) return;

    this.yieldPreview(state);

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
  private supersedeWaitingOfGroup(state: BusState, entry: CompiledScenario): void {
    this.logQueueDrops(state.queue.removeGroup(entry.raw.supersedeGroup ?? entry.raw.id, entry.raw.id));
  }

  /**
   * Whether a fire of `weight` on a bus is held back by its focus floor
   * (issue #652): a floor is held, the fire is not its owner's, and its
   * weight is below the floor. The one predicate both `attemptFire` and the
   * drain read, so the drain never takes off the queue a fire that
   * `attemptFire` would only park again.
   */
  private belowFloor(state: BusState, focusOwner: string | undefined, weight: number): boolean {
    const focus = state.focus;

    return focus !== null && focusOwner !== focus.ownerId && weight < focus.floor;
  }

  /** Defer a fire for idle-replay when `queueable`, otherwise drop it. */
  private queueOrDrop(
    entry: CompiledScenario,
    event: SimEventOf<SimEventName> | null,
    weight: number,
    state: BusState,
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
    state: BusState,
    reason: string,
    resume?: ResumeState,
    admitted = false,
    queuedAt: number = Date.now(),
    yieldsToGroup = false,
  ): void {
    const raw = this.registry.get(id)?.raw;
    const result = state.queue.offer(
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
   * event's own contracts (see the constructor). It also opens a new
   * `sessionGeneration`, so a line still playing from the old session is
   * not stashed if an interrupt cuts it.
   */
  private clearQueuesForSessionChange(): void {
    this.sessionGeneration++;

    for (const state of this.busState.values()) {
      this.clearPendingHold(state);
      this.logQueueDrops(state.queue.clear());
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
  private stashRunningIfQueueable(state: BusState, running: CompiledScenario | undefined): void {
    const active = state.activeFire;

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
        ? buildResumeState(active, this.getActiveVoice(), this.scripts.generation)
        : undefined;
    this.enqueue(active.id, active.event, active.weight, state, "stashed (preempted)", resume, true, undefined, true);
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
   * resolves to nothing aborts the fire like any other required step — and
   * for a body that could hold a clip the frame is expanded BEFORE the body,
   * so that a body step's side effect cannot be left standing by a frame
   * aborting afterwards, for a fire that never plays. No body CONDITION
   * commits anything: a registered condition must be pure since #1138 — the
   * one that did, the furled-flag `if` that marked the flag spoken, moved to
   * the contract's `speakGate` — precisely because a pack may write it into
   * a body. A var RESOLVER may still keep a tracker, which is why the frame
   * is expanded first: it costs nothing, and it is what keeps such a tracker
   * from being moved by a frame that then aborts. The position readout's
   * intro was that example until #1138 — it still DECIDES its lead-in during
   * expansion, but only stashes the decision for its contract's `speakGate`
   * to commit, so a readout refused there (or aborted further down) records
   * nothing for the next one's delta.
   * A body that can never hold a clip (`canProducePlay`) has no frame
   * expanded at all — nothing can be due for it, so nothing can abort it or
   * warn about it. The rule and its one accepted cost are stated on
   * `applyFrame`.
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
    this.scripts.ensureCompiled();

    const ctx = fireContext(event);

    const voice = this.getActiveVoice();
    const script = voice === null ? undefined : this.scripts.compiled(voice);
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

    let prepared: PreparedFire;
    // The pool picks this expansion makes are recorded on the session and
    // committed into the pools only once the fire is accepted (issue #1138):
    // a fire that aborts, expands empty or is refused by the gate consumed no
    // take, so the next fire still avoids the take the driver last heard.
    const session = this.poolStore.openSession();

    try {
      // The cut tail is expanded only for a contract an event can end (issue
      // #1407): any other contract never plays it, and expanding it anyway
      // would let a broken `cut` abort a callout that cannot be ended. It is
      // expanded under this fire's picks, so its pool take is committed with
      // the fire's — a take of the tail counted but never heard only shifts
      // that pool's no-repeat guard.
      const frame = canProducePlay(body)
        ? this.expandFrame(
            frameName,
            voice,
            script,
            entry.raw.id,
            ctx,
            entry.raw.endsOn !== undefined ? entry.raw.channel : null,
            session,
          )
        : null;
      const bodyOps = this.expandSequence(
        body,
        entry.raw.base,
        entry.raw.channel,
        ctx,
        new Set([entry.raw.id]),
        session,
      );
      prepared = applyFrame(bodyOps, frame);
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

    if (prepared.ops.length === 0) {
      this.logger.debug(`Scenario "${entry.raw.id}" expanded to empty sequence; skipping`);

      return null;
    }

    // The speak-time gate (issue #1138): the contract's second look, in code,
    // after the body expanded and before the ops take the bus — so it holds
    // for every voice, whatever its script says. A fire that already passed
    // the gate — cut and stashed, resumed, or replayed whole — is the same
    // fire (and may have committed its claim there), so it is not asked
    // again; a fire deferred before it expanded re-enters here and is.
    const gate = entry.raw.speakGate;

    if (gate !== undefined && !admitted && !this.admits(gate, entry.raw.id, ctx)) {
      this.logger.debug(`Scenario "${entry.raw.id}" skipped — speak-time gate: ${gate.description}`);

      return null;
    }

    // Accepted: the takes this fire drew are now the ones the driver hears.
    session.commit();

    return prepared;
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

  /**
   * Expand the frame a fire will be wrapped in, as the active voice's script
   * defines it (see `prepareOps`) — before the body, so a frame that aborts
   * never lets a body side effect commit, and only for a body that could
   * hold a clip, so its warns and aborts concern a callout the frame is
   * actually due for. A `cutChannel` also expands the cut tail an end plays
   * (issue #1407), tagged `cut` — the frame's `cut`, spoken on that channel
   * (the callout's own), else its `close` as the close plays — and `null`
   * leaves it empty. Unlike an open or close step, a tail step that resolves
   * to nothing does not abort the fire: the tail is only what an end plays,
   * so the line still speaks, and the tail falls back to the close
   * (`expandCutTail`).
   * Returns `null` when no frame applies: the scenario
   * wants none (`NO_FRAME`), the voice has no script, or its script does not
   * provide the frame (a legacy scenario's, since a contract's was checked
   * at compile time — warned once per `(voice, frame)`, saying whether the
   * frame is undefined or failed to compile).
   *
   * Two things are decided here and nowhere else (issue #1064):
   *
   * - **Every op the frame produces is tagged with its side**, which is how
   *   the frame is identified afterwards — never by clip path.
   * - **Every clip the frame's open and close play goes on the SFX
   *   channel**, whatever it is: a pack's own beep rides the Background bus
   *   like the built-in tick, under the Background volume and the Radio
   *   beeps switch. The `cut` is the exception (issue #1407): it is what the
   *   engineer SAYS when a line is abandoned, so its clips are spoken on the
   *   callout's channel, and only the built-in ticks in it are sound effects.
   *
   * The user's two switches are applied to the frame's STEPS, before any of
   * them expands, so a step the user switched off can never abort the
   * callout because its clip is missing. A frame step that resolves to
   * nothing otherwise throws `ExpansionAbort` like any required step, after
   * one warn per `(voice, frame)` — the body's own abort stays at debug, but
   * a frame failure is a broken pack, not a per-callout omission, and it
   * silences every callout the frame wraps.
   */
  private expandFrame(
    frameName: string,
    voice: string | null,
    script: CompiledVoiceScript | undefined,
    ownerId: string,
    ctx: ScenarioContext,
    cutChannel: AudioChannel | null,
    session: PickSession,
  ): ExpandedFrame | null {
    if (frameName === NO_FRAME) return null;

    if (voice === null || !script) {
      this.logger.debug(`Scenario "${ownerId}" gets no frame — no script for voice "${voice ?? "(none)"}"`);

      return null;
    }

    const frame = script.frames.get(frameName);

    if (!frame) {
      const key = `${voice}|${frameName}`;

      if (this.warnings.once("legacyFrames", key)) {
        const failure = script.failedFrames.get(frameName);
        this.logger.warn(
          failure === undefined
            ? `Voice "${voice}" defines no frame "${frameName}" — legacy scenarios using it play unframed`
            : `Voice "${voice}" frame "${frameName}" failed to compile: ${failure} — legacy scenarios using it play unframed`,
        );
      }

      return null;
    }

    const options = this.frameOptions();
    const side = (steps: ResolvedStep[], tag: FrameSide): ExecOp[] =>
      this.expandSequence(
        filterFrameSteps(steps, options),
        undefined,
        AudioChannel.SFX,
        ctx,
        new Set([ownerId]),
        session,
      )
        // A second pass on the ops, for the one step whose ops cannot be
        // predicted from its kind: an include, whose fragment is only known
        // once expanded. Every other step was filtered before it expanded.
        .filter((op) => (op.kind === "ambient" ? options.ambience : options.beeps))
        .map((op) => ({ ...op, frame: tag }));

    let halves: { open: ExecOp[]; close: ExecOp[] };

    try {
      halves = { open: side(frame.open, "open"), close: side(frame.close, "close") };
    } catch (err) {
      if (err instanceof ExpansionAbort) {
        const key = `${voice}|${frameName}`;

        if (this.warnings.once("frameAborts", key)) {
          this.logger.warn(
            `Voice "${voice}" frame "${frameName}" cannot play — ${err.reason}; every callout it frames is skipped`,
          );
        }
      }

      throw err;
    }

    if (cutChannel === null) return { ...halves, cut: [] };

    // The cut is spoken (issue #1407): its clips default to the callout's
    // channel and only the built-in ticks route to SFX (`channelForPath`).
    // Pit ambience still drops its ambient steps, but Radio beeps drops only
    // the SFX plays — the ticks — never the words. So the steps are not
    // filtered for beeps before they expand (a tick the user switched off is
    // a built-in the manifest always carries), and the ops are sorted after.
    const cutSide = (steps: ResolvedStep[]): ExecOp[] =>
      this.expandSequence(
        filterFrameSteps(steps, { ambience: options.ambience, beeps: true }),
        undefined,
        cutChannel,
        ctx,
        new Set([ownerId]),
        session,
      )
        .filter((op) => {
          if (op.kind === "ambient") return options.ambience;

          return op.kind !== "play" || op.channel !== AudioChannel.SFX || options.beeps;
        })
        .map((op) => ({ ...op, frame: "cut" as const }));

    return {
      ...halves,
      cut: this.expandCutTail(frame, frameName, voice, cutSide, (steps) => side(steps, "cut"), session),
    };
  }

  /**
   * Expand a frame's cut tail (issue #1407): its `cut` through `cutSide`
   * (spoken on the callout's channel, see `expandFrame`), else its `close`
   * through `closeSide` — exactly as the close plays, every clip a sound
   * effect — so a pack that never heard of `cut` still lets go of the button
   * the way it always does. A `cut` step that
   * resolves to nothing does not abort the fire it rides: the tail is only
   * what an end would play, and trading the line itself for it would silence
   * the warning to save the "never mind". It falls back to the close instead
   * — the tail is empty, and an end stops silently, if that aborts too —
   * after one warn per `(voice, frame)`, keyed apart from the frame-abort
   * warn in the same set. The picks a failed attempt made are put back, so a
   * take that will never be played commits nothing.
   */
  private expandCutTail(
    frame: CompiledFrame,
    frameName: string,
    voice: string,
    cutSide: (steps: ResolvedStep[]) => ExecOp[],
    closeSide: (steps: ResolvedStep[]) => ExecOp[],
    session: PickSession,
  ): ExecOp[] {
    const attempt = (expand: (steps: ResolvedStep[]) => ExecOp[], steps: ResolvedStep[]): ExecOp[] | ExpansionAbort => {
      const before = session.snapshot();

      try {
        return expand(steps);
      } catch (err) {
        if (!(err instanceof ExpansionAbort)) throw err;

        session.restore(before);

        return err;
      }
    };

    const tail = frame.cut === null ? attempt(closeSide, frame.close) : attempt(cutSide, frame.cut);

    if (!(tail instanceof ExpansionAbort)) return tail;

    const key = `${voice}|${frameName}|cut`;

    if (this.warnings.once("frameAborts", key)) {
      this.logger.warn(
        `Voice "${voice}" frame "${frameName}" cut tail cannot play — ${tail.reason}; an ended line closes the radio instead`,
      );
    }

    if (frame.cut === null) return [];

    const close = attempt(closeSide, frame.close);

    return close instanceof ExpansionAbort ? [] : close;
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
    prepared: PreparedFire,
    resume?: ResumeState,
  ): void {
    const expanded = prepared.ops;

    // Resume from an interrupt cut (issue #758): when the fresh expansion is
    // unchanged from the stashed one, continue from the interrupted clip
    // (re-keying the radio frame when it was already opened). A changed
    // expansion means the underlying state moved on while stashed — resuming
    // would speak a stale tail, so fall back to the full fresh replay (the
    // #481 freshness guarantee).
    let ops = expanded;
    let sourceStart = 0;
    let prerollCount = 0;

    if (resume && resume.index > 0 && resume.index < expanded.length) {
      const blocked = this.resumeBlocker(resume, expanded);

      if (blocked === null) {
        const preroll = this.reopenPreroll(expanded, resume.index, entry.resolvedSequence !== null);
        ops = [...preroll, ...expanded.slice(resume.index)];
        // `ops` is everything still to be heard — the re-key included — so
        // the pools it does NOT draw are the ones whose fresh commit is
        // about to be sliced away unheard (issue #1136).
        this.poolStore.restoreHeadPoolIndices(resume.ops.slice(0, resume.index), ops);
        sourceStart = resume.index;
        prerollCount = preroll.length;
      } else {
        this.logger.debug(`Scenario "${entry.raw.id}" replays whole — ${blocked}`);
      }
    }

    const bus = entry.raw.bus;
    const state = this.getBusState(bus);
    this.takeBus(state, {
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

    this.stepNext(state);
  }

  /**
   * When the portion delivered before the cut had opened the radio frame,
   * the resumed tail re-keys with the frame's open so it doesn't restart
   * cold mid-sentence.
   *
   * The frame is known by its tag (issue #1064): the re-key is exactly the
   * ops tagged `open` that were delivered before the cut — a pack's own
   * beep, the ambience bed the cut stopped — as the user's switches left
   * them, never the built-in tick looked up by path. A tail that resumes
   * inside the open (a two-beep open cut at its second beep) gets the part
   * already delivered replayed ahead of it, which completes the open rather
   * than doubling it.
   *
   * One shape is still read by path: a LEGACY scenario whose expansion carries
   * no tag at all is a sequence playing the built-in tick inline (the catalog
   * has none since #1064, and #1065 retires the shape), and for that one the
   * re-key is the manifest's open tick, found by path, unless the tail itself
   * begins with it. A scripted contract never takes that route — a body of
   * its playing the tick as an ordinary clip has opened no frame.
   */
  private reopenPreroll(expanded: ExecOp[], resumeIndex: number, legacy: boolean): ExecOp[] {
    const delivered = expanded.slice(0, resumeIndex);

    if (!legacy || expanded.some((op) => op.frame !== undefined)) {
      return delivered.filter((op) => op.frame === "open");
    }

    const openTick = this.poolStore.currentManifest().ticks.open;
    const frameWasOpened = delivered.some((op) => op.kind === "play" && op.path === openTick);
    const first = expanded[resumeIndex];
    const resumesWithTick = first.kind === "play" && first.path === openTick;

    if (!frameWasOpened || resumesWithTick) return [];

    return [{ kind: "play", channel: AudioChannel.SFX, path: openTick }];
  }

  /**
   * Why a stashed resume may not continue into this fresh expansion, or
   * `null` when it may. Three things must hold, and only the first is the
   * #758 rule: the ops must match (`opsEqual`), the ACTIVE VOICE must be the
   * one the head was spoken in, and the engine's expansion `generation` must
   * be the one the head was expanded under (issue #1136).
   *
   * The last two used to be implied. `opsEqual` compared clip paths, and a
   * voice's paths name that voice, so a voice change failed the comparison
   * and replayed whole; a pack redefinition that changed a pool's members
   * usually changed a path too. Comparing a pool-drawn op by its POOL key
   * removes both accidents — the key is voice-independent and survives a
   * redefinition — so an all-pool body (which is every scripted readback)
   * would otherwise resume its tail in a voice the driver never heard the
   * head in. They are checked explicitly rather than folded into `opsEqual`
   * because they are facts about the WORLD between the two expansions, not
   * about the ops.
   */
  private resumeBlocker(resume: ResumeState, expanded: readonly ExecOp[]): string | null {
    if (resume.voice !== this.getActiveVoice()) return "voice changed while stashed";

    if (resume.generation !== this.scripts.generation) return "scripts changed while stashed";

    if (!opsEqual(expanded, resume.ops)) return "the expansion changed while stashed";

    return null;
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
        if (op.action === "start")
          this.audio.playOnChannel(AudioChannel.Ambient, this.poolStore.currentManifest().ambientLoop, true);
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

  /**
   * Put a fire on the bus and record it as the one playing. A pending hold
   * armed at the previous fire's finish is obsolete; it re-arms when this
   * fire finishes. The caller starts it with `stepNext`.
   */
  private takeBus(state: BusState, fire: ActiveFire): void {
    this.clearPendingHold(state);
    state.playingId = fire.id;
    state.activeFire = fire;
  }

  private finishFire(scenarioId: string, bus: AudioBus): void {
    const state = this.getBusState(bus);

    if (state.playingId === scenarioId) state.playingId = null;

    if (state.activeFire?.id === scenarioId) {
      const finished = state.activeFire;
      state.activeFire = null;
      this.settle(finished);
    }

    // A finishing fire in a train of related fires (count-in marks) holds the
    // drain of the whole queue for its declared window, so the displaced line
    // doesn't stutter back into the gaps between the train's members (issue
    // #758).
    const holdMs = this.registry.get(scenarioId)?.raw.pendingHoldMs ?? 0;

    if (state.queue.size > 0 && holdMs > 0) {
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
  private drainPending(state: BusState): void {
    this.clearPendingHold(state);

    while (state.playingId === null) {
      const { entry, drops } = state.queue.next(Date.now(), (e) => this.playableAtIdle(state, e));

      this.logQueueDrops(drops);

      if (entry === null) return;

      this.replayWaiting(entry.fire);

      // Deferred again: it is back in the queue with its original `queuedAt`
      // — stop, rather than take the same fire off the queue in a loop. A
      // defensive bound: `playableAtIdle` filters out every idle-bus
      // re-deferral `attemptFire` knows today (the focus floor, a waiting
      // `queueBehind` leader), so this should not trigger; it is what keeps
      // a future disagreement between the two from looping.
      if (state.queue.has(entry.id)) return;
    }
  }

  /**
   * Whether `attemptFire` would let this waiting fire take an idle bus now,
   * rather than park it again: the drain's filter (see `drainPending`).
   */
  private playableAtIdle(state: BusState, e: QueuedFire<WaitingFire>): boolean {
    if (this.belowFloor(state, this.registry.get(e.id)?.raw.focusOwner, e.weight)) return false;

    return !state.queue.hasLeaderFor(e.id, Date.now());
  }

  /** Replay one parked fire, unless its scenario has been disabled meanwhile. */
  private replayWaiting(waiting: WaitingFire): void {
    const entry = this.registry.get(waiting.id);

    if (!entry?.enabled) {
      this.logger.debug(`Scenario "${waiting.id}" dropped — disabled`);

      return;
    }

    this.logger.debug(`Replaying pending scenario "${waiting.id}"`);
    this.attemptFire(entry, waiting.event, waiting.resume, waiting.admitted, waiting.queuedAt);
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
    this.settle(fire);
  }

  /**
   * Run a fire's `onSettled` once it has left the bus, finished or cut. A
   * callback that throws is logged and swallowed: it is the caller's
   * cleanup, and the scheduler step that ran it must still complete.
   */
  private settle(fire: ActiveFire): void {
    const onSettled = fire.onSettled;

    if (onSettled === undefined) return;

    fire.onSettled = undefined;

    try {
      onSettled();
    } catch (err) {
      this.logger.error(`"${fire.id}" completion callback threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getBusState(bus: AudioBus): BusState {
    let state = this.busState.get(bus);

    if (!state) {
      state = {
        playingId: null,
        queue: new PendingQueue<WaitingFire>((follower, leader) => this.registry.waitsBehind(follower, leader)),
        activeFire: null,
        focus: null,
        pendingHoldTimer: null,
      };
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
    session: PickSession,
  ): ExecOp[] {
    const out: ExecOp[] = [];

    for (const step of steps) {
      switch (step.kind) {
        case "clip": {
          const path = this.poolStore.substituteVoice(applyBase(base, step.path));
          this.assertClipAvailable(path, `clip "${step.path}"`);
          this.pushClip(out, path, defaultChannel);
          break;
        }

        case "var": {
          const resolver = this.vocab.vars.get(step.name);
          const value = resolver ? resolver(ctx) : null;
          ctx.vars[step.name] = value;

          if (!value) throw new ExpansionAbort(`var {{${step.name}}} resolved to nothing`);

          // A resolver may return a dynamic pool reference (`pool:<group>/<base>`,
          // issue #836) instead of a clip path — value-indexed clips (numbers,
          // names, temps) are pools too, usually of size 1.
          if (value.startsWith("pool:")) {
            const pick = this.poolStore.pickFromPoolRef(value, session);

            if (!pick) {
              throw new ExpansionAbort(`var {{${step.name}}} → "${value}" is empty for the active voice`);
            }

            this.pushClip(out, pick, defaultChannel, value);

            break;
          }

          const path = this.poolStore.substituteVoice(value);
          this.assertClipAvailable(path, `var {{${step.name}}}`);
          this.pushClip(out, path, defaultChannel);

          break;
        }

        case "pool": {
          // A slashed name addresses the voice's own clip groups directly
          // (`group/base`, issue #1064) — the same reference form a var
          // resolver returns. Registered names never carry a slash.
          const slashed = step.name.includes("/");
          const key = slashed ? `pool:${step.name}` : step.name;
          const pick = slashed
            ? this.poolStore.pickFromPoolRef(key, session, step.noRepeat)
            : this.poolStore.pickFromPool(step.name, session, step.noRepeat);

          if (!pick) throw new ExpansionAbort(`pool "${step.name}" resolved to nothing for the active voice`);

          const path = this.poolStore.substituteVoice(pick);
          this.assertClipAvailable(path, `pool "${step.name}"`);
          this.pushClip(out, path, defaultChannel, key);

          break;
        }

        case "connector": {
          const pick = this.poolStore.pickFromPool(CONNECTOR_POOL, session, true);

          if (!pick) throw new ExpansionAbort(`connector pool resolved to nothing`);

          const path = this.poolStore.substituteVoice(pick);
          this.assertClipAvailable(path, `connector`);
          this.pushClip(out, path, defaultChannel, CONNECTOR_POOL);

          break;
        }

        case "include": {
          if (visitedIncludes.has(step.id)) {
            throw new Error(`include cycle: ${Array.from(visitedIncludes).join(" → ")} → ${step.id}`);
          }

          const target = this.registry.get(step.id);

          if (!target) throw new Error(`include target not found: ${step.id}`);

          // Only a legacy closure sequence ever carries an include here: a
          // script's includes target the script's own fragments and are
          // inlined at compile time (issue #1065). A contract has no sequence
          // of its own to splice in, so a legacy include may not target one.
          if (target.resolvedSequence === null) throw new Error(`include target has no sequence: ${step.id}`);

          const nested = this.expandSequence(
            target.resolvedSequence,
            target.raw.base,
            defaultChannel,
            ctx,
            new Set([...visitedIncludes, step.id]),
            session,
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
          out.push(...this.expandSequence(branch, base, defaultChannel, ctx, visitedIncludes, session));
          break;
        }

        case "case": {
          // The resolver returns a key; the script maps keys to steps (issue
          // #1064). An unmapped key takes the script's `default` branch, or
          // nothing — the completeness of the mapping is the pack's business.
          // A key the resolver never DECLARED is a code bug: warned once, then
          // treated as unmapped.
          out.push(
            ...this.expandSequence(
              this.vocab.pickCaseBranch(step, ctx),
              base,
              defaultChannel,
              ctx,
              visitedIncludes,
              session,
            ),
          );
          break;
        }

        case "optional": {
          // A genuinely-optional clause (issue #835): a member resolving to
          // nothing skips the WHOLE group locally — never half a clause —
          // and the rest of the callout still plays. Each recursive call
          // builds its own op list, so a mid-group abort discards the
          // group's partial ops cleanly.
          try {
            out.push(...this.expandSequence(step.steps, base, defaultChannel, ctx, visitedIncludes, session));
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
    if (this.poolStore.hasClip(path)) return;

    throw new ExpansionAbort(`${what} → "${path}" is not in the manifest for the active voice`);
  }

  /**
   * Push a clip op, routing walkie-talkie ticks to SFX and everything else to
   * the default channel. `pool` is the key the clip was drawn from, given only
   * for a pool-drawn pick — see `ExecOp` and `opsEqual` (issue #1136).
   */
  private pushClip(out: ExecOp[], path: string, defaultChannel: AudioChannel, pool?: string): void {
    const channel = this.channelForPath(path, defaultChannel);

    out.push({ kind: "play", channel, path, pool });
  }

  private channelForPath(path: string, defaultChannel: AudioChannel): AudioChannel {
    const { ticks } = this.poolStore.currentManifest();

    if (path === ticks.open || path === ticks.close) return AudioChannel.SFX;

    return defaultChannel;
  }
}

/**
 * Capture where an interrupted fire left off, mapped back to its ORIGINAL
 * expansion via the fire's source fields — so a resumed fire that is cut
 * again still stashes an absolute position, not one relative to its tail
 * (issue #758). `active.index` points one past the op in flight; the resume
 * replays that op from its start.
 *
 * `voice` and `generation` stamp the state of the world the ops were expanded
 * under, which `executeFire` re-checks before it continues (issue #1136).
 */
function buildResumeState(active: ActiveFire, voice: string | null, generation: number): ResumeState | undefined {
  const playIndex = Math.max(0, active.index - 1);
  const sourceIndex = active.sourceStart + Math.max(0, playIndex - active.prerollCount);

  if (sourceIndex >= active.sourceOps.length) return undefined;

  return { ops: active.sourceOps, index: sourceIndex, voice, generation };
}

/**
 * How many ops of a playing fire's FULL expansion (`sourceOps`) the driver has
 * started to hear (issue #1407) — the op in flight included, since `index`
 * points one past it. Judged against the source expansion rather than `ops`
 * so that a resumed fire is read by where its line actually is, not by its
 * re-key preroll: the ops before `sourceStart` were heard before the
 * interrupt, and the op at `sourceStart` was in flight when the interrupt cut
 * it, so a resumed fire has started at least `sourceStart + 1` source ops
 * even while its preroll (the first `prerollCount` ops of `ops`, a replay of
 * the open) is still playing. A fresh fire has `sourceOps === ops` and no
 * preroll, which makes this `index`.
 */
function startedSourceOps(fire: ActiveFire): number {
  const played = Math.max(0, fire.index - fire.prerollCount);

  return fire.sourceStart > 0 ? fire.sourceStart + Math.max(1, played) : played;
}

/**
 * Whether the driver has heard words of a playing fire (issue #1407), which
 * decides whether an end plays the cut tail or stops it silently: an op with
 * no frame tag — a body op — is among the source ops started
 * (`startedSourceOps`), so a body clip that has just started counts (words
 * started are words heard). A resumed fire is read by its source position:
 * one cut mid-body has been heard even while its re-key preroll plays, and
 * one cut inside a two-beep open has not, so it stops silently.
 *
 * Any untagged op counts, not only a clip: a body that began with a `pause`
 * or an `ambient` step would count as heard once that op is consumed, before
 * any clip has started. No script has such a body today; one that does
 * would get the tail a beat early, which errs towards closing the radio.
 */
function wordsHeard(fire: ActiveFire): boolean {
  return fire.sourceOps.slice(0, startedSourceOps(fire)).some((op) => op.frame === undefined);
}

/**
 * Whether a playing fire's line has been heard in full (issue #1407): it has
 * started, and no body clip (an untagged `play`) remains from the op in
 * flight on — it is in its close ops, or in a trailing pause or ambience op
 * after its last clip. An end then leaves it to finish rather than say
 * "never mind" after a complete line. While the last body clip is itself in
 * flight the line is still being spoken, so it does not count. Read against
 * the source expansion like `wordsHeard`, so a fire resumed into its close
 * counts as finished during its re-key preroll.
 */
function lineFinished(fire: ActiveFire): boolean {
  const started = startedSourceOps(fire);

  if (started === 0) return false;

  return !fire.sourceOps.slice(started - 1).some((op) => op.kind === "play" && op.frame === undefined);
}

/**
 * One bus's row of `describeState` (issue #1387); `state` is `undefined` for
 * a bus nothing has used yet, which reads as idle. `queue.ordered()` is the
 * queue's one pure read — `next` would expire entries and hand one out.
 */
function describeBus(bus: AudioBus, state: BusState | undefined): ScenarioEngineState["buses"][number] {
  const fire = state?.activeFire ?? null;

  return {
    bus: AudioBus[bus] ?? String(bus),
    playingId: state?.playingId ?? null,
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
    focus: state?.focus ? { ownerId: state.focus.ownerId, floor: state.focus.floor } : null,
    pendingHoldArmed: (state?.pendingHoldTimer ?? null) !== null,
    waiting: (state?.queue.ordered() ?? []).map((e) => ({
      id: e.id,
      weight: e.weight,
      group: e.group,
      queuedAt: e.queuedAt,
      maxWaitMs: e.maxWaitMs,
      after: e.after,
    })),
  };
}

/**
 * Wrap an expanded body in its expanded frame — unless there is no frame, or
 * the body holds no clip: no callout ever plays bare ticks around nothing,
 * so a body of ambience or pauses alone, or an empty one, stays as it is and
 * the frame is discarded. The frame's cut tail (issue #1407) is handed back
 * beside the ops when the frame was applied, and is empty when it was not.
 *
 * The ORDER the two were expanded in is decided in `prepareOps` from the
 * body's steps, before either runs (`canProducePlay`): a body that can never
 * hold a clip — ambience or pauses alone, at every nesting — never has its
 * frame expanded at all, so a broken frame cannot kill it and earns no warn
 * for it; a body that can hold one has its frame expanded FIRST, so a frame
 * that aborts can commit none of the body's side effects. That case is
 * hypothetical rather than actual since #1138 — a body step commits nothing
 * now that the furled marking is the contract's `speakGate`, and a
 * registered condition must stay a pure read — and the order is kept
 * because it costs nothing and holds whatever a body is later asked to do.
 * Between the two sits the one accepted cost: a body that could speak but
 * expands to nothing this time (a script `if` that said no) is dropped by a
 * broken frame rather than played bare — it would have played nothing
 * anyway — and the frame's warn fires, because the frame is due for that
 * callout whenever its body speaks. Knowing the dynamic answer before the
 * body runs would mean running it, which is exactly what the order avoids
 * committing to.
 */
function applyFrame(body: ExecOp[], frame: ExpandedFrame | null): PreparedFire {
  // The cut tail (issue #1407) goes with the frame: a body left bare has no
  // radio to let go of, so an end stops it silently.
  if (frame === null || !body.some((op) => op.kind === "play")) return { ops: body, cutTail: [] };

  return { ops: [...frame.open, ...body, ...frame.close], cutTail: frame.cut };
}

/**
 * Whether a body's steps could expand to a `play` op at all — read off the
 * steps, without expanding them, so it commits nothing. `clip`, `var`,
 * `pool`, `connector` and `include` can (an include's fragment is not
 * inspected: the conservative answer is what keeps `prepareOps`'s order
 * right); `ambient` and `pause` never can; the branching forms can iff a
 * branch can.
 */
function canProducePlay(steps: readonly ResolvedStep[]): boolean {
  return steps.some((step) => {
    switch (step.kind) {
      case "optional":
        return canProducePlay(step.steps);
      case "if":
        return canProducePlay(step.then) || (step.else !== undefined && canProducePlay(step.else));
      case "case":
        return canProducePlay(step.fallback) || [...step.of.values()].some(canProducePlay);
      case "ambient":
      case "pause":
        return false;
      default:
        return true;
    }
  });
}

/**
 * The user's two frame switches, applied to a frame's steps BEFORE any of
 * them expands (issue #1064): `ambient` steps stay iff `ambience`, every
 * other sound leaf iff `beeps` — by kind, which is by position in the frame,
 * so a pack's own beep clip is governed exactly like the built-in tick. A
 * step the user switched off is never expanded, so a missing clip behind it
 * can never abort the callout. The branching forms (`optional`, `if`,
 * `case`) and `include` are structure rather than sound and are kept — the
 * branches with their contents filtered, an include as it is, since its
 * fragment is only known once expanded and the post-expansion op filter in
 * `expandFrame` is what sorts its ops — so an `if` around the ambience bed,
 * or a fragment carrying it, still keeps the bed when only beeps are off.
 * The include case is reachable only from a legacy closure sequence: a
 * script's includes are inlined by the compiler (issue #1065), so a frame
 * from a script arrives here with its fragments already spliced in and
 * filtered by kind like any other step.
 */
function filterFrameSteps(steps: readonly ResolvedStep[], options: FrameOptions): ResolvedStep[] {
  const out: ResolvedStep[] = [];

  for (const step of steps) {
    switch (step.kind) {
      case "optional":
        out.push({ ...step, steps: filterFrameSteps(step.steps, options) });
        break;
      case "if":
        out.push({
          ...step,
          then: filterFrameSteps(step.then, options),
          else: step.else ? filterFrameSteps(step.else, options) : undefined,
        });
        break;
      case "case":
        out.push({
          ...step,
          of: new Map([...step.of].map(([key, branch]) => [key, filterFrameSteps(branch, options)])),
          fallback: filterFrameSteps(step.fallback, options),
        });
        break;
      case "include":
        out.push(step);
        break;
      case "ambient":
        if (options.ambience) out.push(step);

        break;
      default:
        if (options.beeps) out.push(step);

        break;
    }
  }

  return out;
}

/**
 * Element-wise equality of two expanded op lists (plain data, no functions).
 * The frame tag is part of an op's identity: the same clip played as a frame
 * and as body are two different ops, and a resume must not mistake one for
 * the other.
 *
 * A play op that came out of a pool is compared by that POOL and its channel,
 * never by the take drawn (issue #1136): `noRepeat` plus the take committed on
 * acceptance make a re-expansion of a two-take pool draw the other take every
 * time, and which recording of a slot came up is not part of what the body
 * says — so a path comparison would fail every resume of a scripted readback.
 * A path-drawn op is compared by path and channel as before, and a pool-drawn
 * op is never equal to a path-drawn one. What the comparison still catches: a
 * var resolving to a different value is a different reference
 * (`pool:numbers/12` against `pool:numbers/13`), and a slot that appears,
 * disappears or reorders changes the shape.
 *
 * What it deliberately no longer catches, because a pool key is voice-
 * independent and survives a redefinition of what the pool holds: a change of
 * ACTIVE VOICE or of the scripts/manifest while the fire was stashed. Those
 * are facts about the world rather than about the ops, and `resumeBlocker`
 * checks them beside this — do not read a `true` from here as "nothing moved".
 */
function opsEqual(a: readonly ExecOp[], b: readonly ExecOp[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];

    if (x.kind !== y.kind || x.frame !== y.frame) return false;

    if (x.kind === "play" && y.kind === "play") {
      if (x.channel !== y.channel) return false;

      if (x.pool !== undefined || y.pool !== undefined) {
        if (x.pool !== y.pool) return false;
      } else if (x.path !== y.path) return false;
    }

    if (x.kind === "ambient" && y.kind === "ambient" && x.action !== y.action) return false;

    if (x.kind === "pause" && y.kind === "pause" && x.ms !== y.ms) return false;
  }

  return true;
}

function opLabel(op: ExecOp): string {
  const tag = op.frame === undefined ? "" : `${op.frame}:`;

  // The pool a take came from is what the resume compares (issue #1136), so a
  // debug line that shows the ops shows it beside the take it drew.
  if (op.kind === "play") return `${tag}play[${op.channel}] ${op.path}${op.pool === undefined ? "" : ` (${op.pool})`}`;

  if (op.kind === "ambient") return `${tag}ambient:${op.action}`;

  return `${tag}pause:${op.ms}`;
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
  engine?.dispose();
  engine = null;
}
