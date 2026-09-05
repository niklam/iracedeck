/**
 * Imperative spotter engine — the Race Engineer's spoken side-awareness
 * family (issue #651; scripted since #1065). Like the radar engine it owns a
 * state machine over `RadarState` driven off the existing `radar.changed`
 * event, but unlike radar (which plays directly on `AudioChannel.Radar`) it
 * schedules every callout through the #652 interpreter via `engine.fire(...)`.
 *
 * The two contracts it fires carry no `when` — nothing on the bus triggers
 * them, this engine does, imperatively — and no sequence: what a fire says is
 * the active voice's `callouts.json` under the same ids
 * (`scenarios["pit-crew.spotter-call"]`, `…-info`), paired at `setScripts`
 * time, and the bundled script is the one step `{{spotterClip}}`. The var's
 * value is a path this engine computes per transition from the `spotter/`
 * clip group, so clip selection stays entirely engine-driven — no interpreter
 * pools, no dependency on the audio manifest at load time — and a pack
 * rephrases around the call (a lead-in, a beat) rather than re-recording the
 * twenty-four terms. `engine.fire(id)` resolves a contract through the same
 * registration path as a bus-triggered one: a voice whose script has no
 * entry is silent for it, a scripted one plays.
 *
 * Scheduling splits into two contracts (issue #867): every car-presence
 * transition call ("Car left", "Two cars right", "Three wide", the combined
 * swaps, the 2→1 de-escalation) fires through `pit-crew.spotter-call` at
 * `WEIGHT.PROXIMITY` — strictly above CRITICAL, so it cuts ANY in-flight
 * line; a missed proximity call is the most dangerous silence the engineer
 * can produce. The informational fires — "Clear." and the still-there
 * reminder loop — go through `pit-crew.spotter-info` at `WEIGHT.SAFETY`, so
 * they can never chop up a CRITICAL line (meatball, fuel-critical, start
 * gantry). The two carry DIFFERENT families ("spotter" vs "spotter-info") so
 * the same-family wholesale-replace rule — which runs before any weight
 * comparison — can never let a SAFETY info fire replace an in-flight
 * PROXIMITY call: a call cuts a playing info line via weight + interrupt,
 * an info fire arriving during a call clip simply drops (the reminder loop
 * retries a cadence later), and each scenario still replaces its own
 * in-flight fires via its family.
 *
 * While a car is alongside the engine holds an exclusive-focus floor
 * (`WEIGHT.SAFETY`) on `AudioBus.Voice` so routine chatter is held back while
 * safety-band callouts (flags) still break through — only while the active
 * voice's script has a body for the call (`engine.isScripted`), since a floor
 * protecting a call that will never be made would just mute everything else
 * — and runs a "still there" reminder loop (default 3 s, user-configurable
 * 1–10 s via the `spotterStillThereSeconds` global setting). It reads
 * `getTrackDirection()` to swap road (left/right) terminology for oval
 * (inside/outside) terminology.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, RadarState, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { getLatestTelemetry, getSessionType, TrackDirection } from "@iracedeck/sim-events-iracing";

import type { ScenarioContract } from "../../dsl.js";
import { NO_FRAME, WEIGHT } from "../../dsl.js";
import { getScenarioEngine } from "../../interpreter.js";

export const SPOTTER_FOCUS_OWNER = "spotter";
export const SPOTTER_CALL_SCENARIO_ID = "pit-crew.spotter-call";
export const SPOTTER_INFO_SCENARIO_ID = "pit-crew.spotter-info";

/** "Still there" reminder cadence bounds (issue #651), user-configurable in the PI. */
export const SPOTTER_STILL_THERE_MIN_SECONDS = 1;
export const SPOTTER_STILL_THERE_MAX_SECONDS = 10;
export const SPOTTER_STILL_THERE_DEFAULT_SECONDS = 3;
export const SPOTTER_STILL_THERE_DEFAULT_MS = SPOTTER_STILL_THERE_DEFAULT_SECONDS * 1000;

/**
 * Coerce a raw global-settings value (seconds) to a clamped loop interval in
 * milliseconds. Plugins wire `getStillThereIntervalMs` to this against the live
 * `spotterStillThereSeconds` setting; a missing / NaN / out-of-range value falls
 * back to the default cadence.
 */
export function resolveStillThereIntervalMs(rawSeconds: unknown): number {
  const s = Number(rawSeconds);

  if (!Number.isFinite(s)) return SPOTTER_STILL_THERE_DEFAULT_MS;

  return Math.min(Math.max(s, SPOTTER_STILL_THERE_MIN_SECONDS), SPOTTER_STILL_THERE_MAX_SECONDS) * 1000;
}

/**
 * → clear confirmation buffer (issue #651). `CarLeftRight` flickers at the
 * lateral detection boundary, so announcing "clear" the instant it goes clear
 * stutters ("Cle…car right…clear"). Instead, on a → clear transition the engine
 * holds the call and polls the gap to the nearest car; "clear" only fires once
 * that gap has grown by {@link SPOTTER_CLEAR_BUFFER_METERS}, confirming the car
 * genuinely separated. {@link SPOTTER_CLEAR_FALLBACK_MS} is a safety net for the
 * rare case where a car steps sideways at a matched longitudinal position, so
 * the lap-distance gap never grows.
 */
export const SPOTTER_CLEAR_BUFFER_METERS = 0.5;
export const SPOTTER_CLEAR_POLL_MS = 200;
export const SPOTTER_CLEAR_FALLBACK_MS = 1500;

/** Plugin-supplied accessors the engine consults live on every event/tick. */
export type SpotterDeps = {
  /**
   * Race Engineer master gate (`pitCrewRaceEngineerEnabled`). The spotter is a
   * Race Engineer callout family, not a standalone toggle — it rides the same
   * master as the flag / position / lap-time callouts.
   */
  getMasterEnabled: () => boolean;
  /** "Cars" opt-in (`calloutEnabledSpotterCars`) — every transition call. */
  getCarsEnabled: () => boolean;
  /** "Still there" opt-in (`calloutEnabledSpotterStillThere`) — the repeating loop. */
  getStillThereEnabled: () => boolean;
  /** Loop cadence in ms (`spotterStillThereSeconds` × 1000), read live each tick. */
  getStillThereIntervalMs: () => number;
  /** Road (left/right) vs oval (inside/outside) terminology. */
  getTrackDirection: () => TrackDirection;
  /**
   * Distance (m) to the nearest car on track, or `null` when unavailable. Drives
   * the → clear confirmation buffer: "clear" is held until this grows by
   * {@link SPOTTER_CLEAR_BUFFER_METERS}. Default `() => null` disables the buffer
   * (immediate clear), so tests and unwired callers keep the prior behavior.
   */
  getNearestCarGapMeters: () => number | null;
  logger?: ILogger;
};

/**
 * The transition-call contract — every car-presence transition fires through
 * it. The voice script's `{{spotterClip}}` step plays whatever path the
 * engine stashed in `pendingSpotterClip` for this transition;
 * `focusOwner: "spotter"` lets the engine's own fires bypass the SAFETY floor
 * it holds while a car is alongside. Unframed (decision D1): no radio
 * open/close ticks. Since issue #1064 the engine applies the frame itself,
 * so it is the contract's `frame: NO_FRAME` (`"none"`) that enforces this
 * now — on the informational sibling below too. No `when`: only this
 * engine's `fire()` ever triggers it.
 *
 * `WEIGHT.PROXIMITY` + `interrupt: true` (issue #867): a proximity transition
 * must always be heard immediately, cutting even an in-flight CRITICAL line.
 * `queueable: false` stays — a stale proximity call must never replay late;
 * the guarantee comes from winning the bus now.
 */
const SPOTTER_CALL_CONTRACT: ScenarioContract = {
  id: SPOTTER_CALL_SCENARIO_ID,
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  weight: WEIGHT.PROXIMITY,
  interrupt: true,
  queueable: false,
  family: "spotter",
  focusOwner: SPOTTER_FOCUS_OWNER,
  frame: NO_FRAME,
  description:
    "The cars alongside you change — one arrives, a second joins it, one of two drops away, or they swap sides — in any session but Lone Qualify, while you are not on pit road.",
};

/**
 * The informational sibling (issue #867): "Clear." and the still-there
 * reminder loop. Identical shape but `WEIGHT.SAFETY` — informational lines
 * must never chop up a CRITICAL call (meatball, fuel-critical, the start
 * gantry), and the 1–10 s reminder cadence would do exactly that at
 * PROXIMITY. Deliberately NOT in `family: "spotter"`: same-family preemption
 * replaces the in-flight family-mate regardless of weight, so sharing the
 * call scenario's family would let a reminder tick chop a still-playing
 * transition call — the exact "always heard" inversion the review of #867
 * flagged. With its own `family: "spotter-info"` the call still cuts a
 * playing info line (PROXIMITY > SAFETY + interrupt), info fires still
 * replace each other ("Clear." over a playing reminder), and an info fire
 * arriving during a call clip drops harmlessly (the loop retries next tick).
 */
const SPOTTER_INFO_CONTRACT: ScenarioContract = {
  id: SPOTTER_INFO_SCENARIO_ID,
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  weight: WEIGHT.SAFETY,
  interrupt: true,
  queueable: false,
  family: "spotter-info",
  focusOwner: SPOTTER_FOCUS_OWNER,
  frame: NO_FRAME,
  description:
    "The last car alongside has genuinely separated after the radar reads clear, or a car is still alongside when the reminder interval (three seconds by default) comes round again.",
};

/**
 * Both spotter contracts, in registration order — the transition call and
 * the informational sibling. Exported so the catalog's completeness tests
 * can pair them with the bundled script; the engine registers them itself
 * in {@link registerSpotterEngine}.
 */
export const SPOTTER_CONTRACTS: readonly ScenarioContract[] = [SPOTTER_CALL_CONTRACT, SPOTTER_INFO_CONTRACT];

export const SPOTTER_SCENARIO_IDS: readonly string[] = SPOTTER_CONTRACTS.map((c) => c.id);

// ─── Clip catalog (paths carry `{voice}`; the interpreter substitutes it) ────

const BASE = "voice/{voice}/spotter/";

/** Spoken side term per physical side, given the track rotation direction. */
type SpokenTerm = "left" | "right" | "inside" | "outside";

const THREE_WIDE = `${BASE}three-wide.mp3`;

/** Clear-pool variants ("Clear." / "Clear! Clear!") with engine-owned no-repeat. */
const CLEAR_POOL: readonly string[] = [`${BASE}clear.mp3`];

/** Still-there-pool variants ("Still there." / "Hold your line.") with no-repeat. */
const STILL_THERE_POOL: readonly string[] = [`${BASE}still-there.mp3`, `${BASE}hold-your-line.mp3`];

// ─── Module state ────────────────────────────────────────────────────────────

type PoolPick = { readonly clips: readonly string[]; lastIndex: number };

let state: RadarState = "clear";
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let clearPollTimer: ReturnType<typeof setTimeout> | null = null;
/** In-flight → clear confirmation: the gap baseline + elapsed poll time. */
let pendingClear: { baselineGap: number; elapsedMs: number } | null = null;
let registeredBus: IEventBus | null = null;
let pendingSpotterClip = "";
const clearPick: PoolPick = { clips: CLEAR_POOL, lastIndex: -1 };
const stillTherePick: PoolPick = { clips: STILL_THERE_POOL, lastIndex: -1 };

/** Permissive defaults until a plugin wires real accessors via registerSpotterEngine. */
const DEFAULT_DEPS: SpotterDeps = {
  getMasterEnabled: () => true,
  getCarsEnabled: () => true,
  getStillThereEnabled: () => true,
  getStillThereIntervalMs: () => SPOTTER_STILL_THERE_DEFAULT_MS,
  getTrackDirection: () => TrackDirection.Neutral,
  getNearestCarGapMeters: () => null,
};

let deps: SpotterDeps = DEFAULT_DEPS;

// ─── Per-side car counts ─────────────────────────────────────────────────────

type Side = "left" | "right";
type Counts = { left: number; right: number };

function counts(s: RadarState): Counts {
  switch (s) {
    case "left":
      return { left: 1, right: 0 };
    case "right":
      return { left: 0, right: 1 };
    case "both":
      return { left: 1, right: 1 };
    case "two-left":
      return { left: 2, right: 0 };
    case "two-right":
      return { left: 0, right: 2 };
    case "clear":
    default:
      return { left: 0, right: 0 };
  }
}

/** Map a physical side to its spoken term given the track rotation direction. */
function termFor(side: Side, dir: TrackDirection): SpokenTerm {
  if (dir === TrackDirection.Left) return side === "left" ? "inside" : "outside";

  if (dir === TrackDirection.Right) return side === "left" ? "outside" : "inside";

  // Neutral / unknown (road course): physical side is the spoken side.
  return side;
}

/**
 * Level clip for one side: `car-<term>` (1 car), `two-cars-<term>` (2 cars),
 * or `one-car-<term>` (de-escalation 2→1). `<term> = termFor(side, dir)`.
 */
function levelClip(side: Side, count: number, dir: TrackDirection, oneCar = false): string {
  const term = termFor(side, dir);

  if (oneCar) return `${BASE}one-car-${term}.mp3`;

  if (count === 2) return `${BASE}two-cars-${term}.mp3`;

  return `${BASE}car-${term}.mp3`;
}

/**
 * Combined de-escalation/swap clip carrying both cues in one clip:
 * `clear-<termCleared>-{car|two-cars}-<termRemaining>`.
 */
function combinedClip(clearedSide: Side, remainingSide: Side, remainingCount: number, dir: TrackDirection): string {
  const termCleared = termFor(clearedSide, dir);
  const termRemaining = termFor(remainingSide, dir);
  const word = remainingCount === 2 ? "two-cars" : "car";

  return `${BASE}clear-${termCleared}-${word}-${termRemaining}.mp3`;
}

// ─── Engine-owned no-repeat pool pick (mirrors the interpreter's pickFromPool) ─

function pickNoRepeat(pool: PoolPick): string {
  let idx = Math.floor(Math.random() * pool.clips.length);

  if (idx === pool.lastIndex && pool.clips.length > 1) idx = (idx + 1) % pool.clips.length;

  pool.lastIndex = idx;

  return pool.clips[idx];
}

// ─── Firing + focus + loop ───────────────────────────────────────────────────

/** Fire a car-presence transition call at PROXIMITY — always heard, cuts anything (#867). */
function fireCallClip(path: string): void {
  pendingSpotterClip = path;
  getScenarioEngine().fire(SPOTTER_CALL_SCENARIO_ID);
}

/** Fire an informational line ("Clear.", still-there) at SAFETY — never cuts a CRITICAL line. */
function fireInfoClip(path: string): void {
  pendingSpotterClip = path;
  getScenarioEngine().fire(SPOTTER_INFO_SCENARIO_ID);
}

// Re-assert the focus floor on every non-clear transition rather than caching a
// local "held" flag: the interpreter's stopAll() (Race Engineer master toggled
// off, issue #587) clears the bus focus WITHOUT notifying this engine, so a
// cached flag would desync and the floor would never be restored while a car is
// still alongside. acquireFocus is idempotent and releaseFocus is a no-op when
// another owner holds the bus, so re-asserting/releasing unconditionally is safe
// and keeps the engine and the interpreter in sync.
//
// Only for a call the active voice will actually make (issue #1065). The floor
// keeps chatter from talking over the proximity call this engine is about to
// fire; a pack whose script omits the spotter is silent for it — a pack is
// never punished for what it does not say — and with no call to protect, the
// floor would only mute every lower-weight callout for as long as a car is
// alongside. So the same transition that would raise it lets it go instead,
// which also drops a floor raised under a voice that scripted the spotter
// before a rescan or a voice change took the entry away mid-episode.
function acquireFocus(): void {
  if (!getScenarioEngine().isScripted(SPOTTER_CALL_SCENARIO_ID)) {
    releaseFocus();

    return;
  }

  getScenarioEngine().acquireFocus(AudioBus.Voice, SPOTTER_FOCUS_OWNER, WEIGHT.SAFETY);
}

function releaseFocus(): void {
  getScenarioEngine().releaseFocus(AudioBus.Voice, SPOTTER_FOCUS_OWNER);
}

function resetLoopTimer(): void {
  if (loopTimer !== null) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

/** Live loop cadence in ms; falls back to the default for a degenerate value. */
function loopIntervalMs(): number {
  const ms = deps.getStillThereIntervalMs();

  return Number.isFinite(ms) && ms > 0 ? ms : SPOTTER_STILL_THERE_DEFAULT_MS;
}

function startLoop(): void {
  resetLoopTimer();
  loopTimer = setTimeout(tick, loopIntervalMs());
}

/** Live suppression: master off, both opt-ins off, on pit road, or Lone Qualify. */
function suppressed(): boolean {
  return !deps.getMasterEnabled() || !spotterActive() || getSessionType() === "Lone Qualify" || isOnPitRoad();
}

function tick(): void {
  // Master can drop mid-loop, or the driver can enter the pits / a lone-qualify
  // session without a fresh radar.changed — re-check live and tear down loudly,
  // else the reminder keeps speaking on pit road when the relative position
  // hasn't changed (no event would drive forceClear).
  if (suppressed()) {
    forceClear();

    return;
  }

  // The "still there" opt-in is read live: when off, keep the loop scheduled but
  // fire nothing, so re-enabling mid-session resumes the reminder. Also hold the
  // reminder while a → clear is being confirmed (pendingClear), so a short
  // cadence can't speak "still there" moments before the buffered "clear".
  if (pendingClear === null && deps.getStillThereEnabled()) fireInfoClip(pickNoRepeat(stillTherePick));

  loopTimer = setTimeout(tick, loopIntervalMs());
}

/** Master off / pit road / Lone Qualify: tear everything down, no clip. */
function forceClear(): void {
  abandonPendingClear();
  resetLoopTimer();
  releaseFocus();
  state = "clear";
}

// ─── → clear confirmation buffer ──────────────────────────────────────────────

function stopClearPoll(): void {
  if (clearPollTimer !== null) {
    clearTimeout(clearPollTimer);
    clearPollTimer = null;
  }
}

/** Abandon an in-flight → clear confirmation (a car is back, or we're tearing down). */
function abandonPendingClear(): void {
  pendingClear = null;
  stopClearPoll();
}

/** Confirm the buffered clear: announce it, release focus, settle to "clear". */
function confirmClear(): void {
  abandonPendingClear();
  handleTransition(state, "clear", deps.getTrackDirection());
  state = "clear";
}

function clearPollTick(): void {
  if (pendingClear === null) return;

  // Re-check suppression live — the driver can pit / a session can flip while we wait.
  if (suppressed()) {
    forceClear();

    return;
  }

  pendingClear.elapsedMs += SPOTTER_CLEAR_POLL_MS;

  const gap = deps.getNearestCarGapMeters();
  const grewEnough = gap !== null && gap >= pendingClear.baselineGap + SPOTTER_CLEAR_BUFFER_METERS;

  // Confirm when the nearest car has pulled SPOTTER_CLEAR_BUFFER_METERS clear, the
  // distance data drops out, or the fallback elapses (sideways separation that
  // never grows the lap-distance gap).
  if (grewEnough || gap === null || pendingClear.elapsedMs >= SPOTTER_CLEAR_FALLBACK_MS) {
    confirmClear();

    return;
  }

  clearPollTimer = setTimeout(clearPollTick, SPOTTER_CLEAR_POLL_MS);
}

/**
 * Enter the → clear confirmation buffer: keep the alongside state + loop + focus,
 * and poll the nearest-car gap until it grows by {@link SPOTTER_CLEAR_BUFFER_METERS}.
 * With no distance data the buffer is skipped — "clear" fires now.
 */
function beginPendingClear(): void {
  const baseline = deps.getNearestCarGapMeters();

  if (baseline === null) {
    handleTransition(state, "clear", deps.getTrackDirection());
    state = "clear";

    return;
  }

  abandonPendingClear();
  pendingClear = { baselineGap: baseline, elapsedMs: 0 };
  clearPollTimer = setTimeout(clearPollTick, SPOTTER_CLEAR_POLL_MS);
}

// ─── State machine ───────────────────────────────────────────────────────────

function handleTransition(oldState: RadarState, newState: RadarState, dir: TrackDirection): void {
  resetLoopTimer();

  const carsEnabled = deps.getCarsEnabled();

  if (newState === "clear") {
    if (carsEnabled) fireInfoClip(pickNoRepeat(clearPick));

    releaseFocus();

    return;
  }

  acquireFocus();

  if (newState === "both") {
    if (carsEnabled) fireCallClip(THREE_WIDE);

    startLoop();

    return;
  }

  // new is one-sided (left / right / two-left / two-right).
  const newCounts = counts(newState);
  const occupied: Side = newCounts.left > 0 ? "left" : "right";
  const other: Side = occupied === "left" ? "right" : "left";
  const n = newCounts[occupied]; // 1 or 2
  const old = counts(oldState);

  if (carsEnabled) {
    if (old[other] > 0) {
      // Other side just cleared while occupied keeps car(s) → combined clip.
      fireCallClip(combinedClip(other, occupied, n, dir));
    } else if (old[occupied] === 0) {
      // 0 → 1 car / 0 → 2 two-cars.
      fireCallClip(levelClip(occupied, n, dir));
    } else if (n > old[occupied]) {
      // 1 → 2 two-cars escalation (n is 2 here; pass it rather than a literal).
      fireCallClip(levelClip(occupied, n, dir));
    } else {
      // 2 → 1 de-escalation: "One car <side>."
      fireCallClip(levelClip(occupied, 1, dir, true));
    }
  }

  startLoop();
}

function isOnPitRoad(): boolean {
  const telemetry = getLatestTelemetry() as { OnPitRoad?: boolean } | null;

  return telemetry?.OnPitRoad === true;
}

/**
 * The spotter is active only when at least one of its callout opt-ins is on.
 * With neither enabled it would never speak, so the engine stays fully clear
 * (no focus floor, no loop) rather than silently holding back other chatter.
 */
function spotterActive(): boolean {
  return deps.getCarsEnabled() || deps.getStillThereEnabled();
}

function handleRadarChanged(ev: SimEventOf<"radar.changed">): void {
  // Gated live by the Race Engineer master + the spotter opt-ins (the spotter is
  // a Race Engineer callout family) and suppressed on pit road / Lone Qualify —
  // `radar.changed` is NOT pre-suppressed for those (diffRadar emits raw
  // CarLeftRight transitions), so the guard is required here, not just defensive.
  if (suppressed()) {
    forceClear();

    return;
  }

  const to = ev.data.to;

  if (pendingClear !== null) {
    // We're confirming a buffered clear. `radar.changed` only fires on change, so
    // any event here means CarLeftRight left "clear" — the car is back / the
    // proximity changed. Abandon the pending clear (the still-there loop kept
    // running throughout, so a flicker back to the same side says nothing).
    abandonPendingClear();

    if (to === state) return;

    handleTransition(state, to, deps.getTrackDirection());
    state = to;

    return;
  }

  if (to === state) return;

  if (to === "clear") {
    // Don't announce "clear" the instant CarLeftRight flickers clear — buffer it
    // until the car has actually pulled away (anti-stutter, issue #651).
    beginPendingClear();

    return;
  }

  handleTransition(state, to, deps.getTrackDirection());
  state = to;
}

// ─── Public surface ──────────────────────────────────────────────────────────

/**
 * Define the spotter var + scenario and subscribe the engine to the event
 * bus. Idempotent as long as every call passes the same bus instance —
 * re-registering with a different bus would leave the handler attached to the
 * original one and silently break spotter events, so we throw loudly instead.
 * Invoked once from `registerPitCrew(bus, …)`, which runs after
 * `initializeAudioScenarios`, so `getScenarioEngine()` is available.
 */
export function registerSpotterEngine(bus: IEventBus, nextDeps: SpotterDeps): void {
  if (registeredBus !== null) {
    if (registeredBus !== bus) {
      throw new Error(
        "registerSpotterEngine called with a different event bus than the initial registration. All callers must share the same bus instance.",
      );
    }

    // Same-bus re-registration just refreshes the live accessors — only mutate
    // state after the guard so a rejected (different-bus) call leaves it intact.
    deps = nextDeps;

    return;
  }

  deps = nextDeps;
  const engine = getScenarioEngine();
  // The vocabulary before the contracts, so the first `setScripts` compile
  // sees it (issue #1065). The engine stashes the clip for the transition it
  // is about to fire; the var hands it to whichever contract fires.
  engine.defineVar(
    "spotterClip",
    () => pendingSpotterClip,
    'The spotter call for the car-presence change that just happened, drawn from the spotter group: "Car left", "Two cars right", "Three wide", the combined swaps ("Clear right, car left"), the 2-to-1 de-escalation, "Clear", and the still-there reminders — inside/outside terms on an oval. Chosen by the spotter engine per transition and read when it fires, so it is the whole call.',
  );

  for (const contract of SPOTTER_CONTRACTS) engine.defineContract(contract);

  registeredBus = bus;
  bus.subscribe("radar.changed", handleRadarChanged);
}

/** @internal Exported for test isolation only. */
export function _resetSpotterEngine(): void {
  resetLoopTimer();
  abandonPendingClear();
  state = "clear";
  registeredBus = null;
  pendingSpotterClip = "";
  clearPick.lastIndex = -1;
  stillTherePick.lastIndex = -1;
  deps = DEFAULT_DEPS;
}
