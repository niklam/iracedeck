/**
 * Imperative spotter engine — the Race Engineer's spoken side-awareness
 * family (issue #651). Like the radar engine it owns a state machine over
 * `RadarState` driven off the existing `radar.changed` event, but unlike
 * radar (which plays directly on `AudioChannel.Radar`) it schedules every
 * callout through the #652 interpreter via `engine.fire("pit-crew.spotter-call")`.
 *
 * That single scenario plays a `{ var: "spotterClip" }` step whose value this
 * engine computes per transition, so clip selection is entirely var-driven —
 * no interpreter pools, no dependency on the audio manifest at load time
 * (the engine builds and tests green before any spotter clip exists).
 *
 * While a car is alongside the engine holds an exclusive-focus floor
 * (`WEIGHT.SAFETY`) on `AudioBus.Voice` so routine chatter is held back while
 * safety-band callouts (flags) still break through, and runs a ~4 s
 * "still there" reminder loop. It reads `getTrackDirection()` to swap road
 * (left/right) terminology for oval (inside/outside) terminology.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, RadarState, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { getLatestTelemetry, getSessionType, TrackDirection } from "@iracedeck/sim-events-iracing";

import type { Scenario } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import { getScenarioEngine } from "../../interpreter.js";

export const SPOTTER_FOCUS_OWNER = "spotter";
export const SPOTTER_STILL_THERE_INTERVAL_MS = 4000;
export const SPOTTER_CALL_SCENARIO_ID = "pit-crew.spotter-call";

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
  /** "Still there" opt-in (`calloutEnabledSpotterStillThere`) — the ~4 s loop. */
  getStillThereEnabled: () => boolean;
  /** Road (left/right) vs oval (inside/outside) terminology. */
  getTrackDirection: () => TrackDirection;
  logger?: ILogger;
};

/**
 * The single interpreter-scheduled scenario every spotter callout fires
 * through. `sequence: [{ var: "spotterClip" }]` plays whatever path the engine
 * stashed in `pendingSpotterClip` for this transition; `focusOwner: "spotter"`
 * lets the engine's own fires bypass the SAFETY floor it holds while a car is
 * alongside. Unframed (decision D1): no `@pit-crew.radio-open`/`-close`.
 */
const SPOTTER_CALL_SCENARIO: Scenario = {
  id: SPOTTER_CALL_SCENARIO_ID,
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  weight: WEIGHT.SAFETY,
  interrupt: true,
  queueable: false,
  family: "spotter",
  focusOwner: SPOTTER_FOCUS_OWNER,
  sequence: [{ var: "spotterClip" }],
};

// ─── Clip catalog (paths carry `{voice}`; the interpreter substitutes it) ────

const BASE = "voice/{voice}/spotter/";

/** Spoken side term per physical side, given the track rotation direction. */
type SpokenTerm = "left" | "right" | "inside" | "outside";

const THREE_WIDE = `${BASE}three-wide.mp3`;

/** Clear-pool variants ("Clear." / "Clear! Clear!") with engine-owned no-repeat. */
const CLEAR_POOL: readonly string[] = [`${BASE}clear.mp3`, `${BASE}clear-clear.mp3`];

/** Still-there-pool variants ("Still there." / "Hold your line.") with no-repeat. */
const STILL_THERE_POOL: readonly string[] = [`${BASE}still-there.mp3`, `${BASE}hold-your-line.mp3`];

// ─── Module state ────────────────────────────────────────────────────────────

type PoolPick = { readonly clips: readonly string[]; lastIndex: number };

let state: RadarState = "clear";
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let registeredBus: IEventBus | null = null;
let pendingSpotterClip = "";
const clearPick: PoolPick = { clips: CLEAR_POOL, lastIndex: -1 };
const stillTherePick: PoolPick = { clips: STILL_THERE_POOL, lastIndex: -1 };

/** Permissive defaults until a plugin wires real accessors via registerSpotterEngine. */
const DEFAULT_DEPS: SpotterDeps = {
  getMasterEnabled: () => true,
  getCarsEnabled: () => true,
  getStillThereEnabled: () => true,
  getTrackDirection: () => TrackDirection.Neutral,
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

function fireClip(path: string): void {
  pendingSpotterClip = path;
  getScenarioEngine().fire(SPOTTER_CALL_SCENARIO_ID);
}

// Re-assert the focus floor on every non-clear transition rather than caching a
// local "held" flag: the interpreter's stopAll() (Race Engineer master toggled
// off, issue #587) clears the bus focus WITHOUT notifying this engine, so a
// cached flag would desync and the floor would never be restored while a car is
// still alongside. acquireFocus is idempotent and releaseFocus is a no-op when
// another owner holds the bus, so re-asserting/releasing unconditionally is safe
// and keeps the engine and the interpreter in sync.
function acquireFocus(): void {
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

function startLoop(): void {
  resetLoopTimer();
  loopTimer = setTimeout(tick, SPOTTER_STILL_THERE_INTERVAL_MS);
}

function tick(): void {
  // Master can drop mid-loop, or the driver can enter the pits / a lone-qualify
  // session without a fresh radar.changed to suppress us — re-check all three
  // live and tear down loudly, mirroring handleRadarChanged's guards. Otherwise
  // the reminder would keep speaking on pit road when the relative position
  // hasn't changed (so no event drives forceClear).
  if (!deps.getMasterEnabled() || !spotterActive() || getSessionType() === "Lone Qualify" || isOnPitRoad()) {
    forceClear();

    return;
  }

  // The "still there" opt-in is read live: when off, keep the loop scheduled
  // but fire nothing, so re-enabling mid-session resumes the reminder.
  if (deps.getStillThereEnabled()) fireClip(pickNoRepeat(stillTherePick));

  loopTimer = setTimeout(tick, SPOTTER_STILL_THERE_INTERVAL_MS);
}

/** Master off / pit road / Lone Qualify: tear everything down, no clip. */
function forceClear(): void {
  resetLoopTimer();
  releaseFocus();
  state = "clear";
}

// ─── State machine ───────────────────────────────────────────────────────────

function handleTransition(oldState: RadarState, newState: RadarState, dir: TrackDirection): void {
  resetLoopTimer();

  const carsEnabled = deps.getCarsEnabled();

  if (newState === "clear") {
    if (carsEnabled) fireClip(pickNoRepeat(clearPick));

    releaseFocus();

    return;
  }

  acquireFocus();

  if (newState === "both") {
    if (carsEnabled) fireClip(THREE_WIDE);

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
      fireClip(combinedClip(other, occupied, n, dir));
    } else if (old[occupied] === 0) {
      // 0 → 1 car / 0 → 2 two-cars.
      fireClip(levelClip(occupied, n, dir));
    } else if (n > old[occupied]) {
      // 1 → 2 two-cars escalation (n is 2 here; pass it rather than a literal).
      fireClip(levelClip(occupied, n, dir));
    } else {
      // 2 → 1 de-escalation: "One car <side>."
      fireClip(levelClip(occupied, 1, dir, true));
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
  // The spotter is a Race Engineer callout family: gated by the Race Engineer
  // master plus its own opt-ins, read live on every event. When neither call
  // type is enabled there's nothing to protect, so stay clear (no focus floor).
  if (!deps.getMasterEnabled() || !spotterActive()) {
    forceClear();

    return;
  }

  // Lone qualifying / pit road: `radar.changed` is NOT pre-suppressed (diffRadar
  // emits raw CarLeftRight transitions), so these guards are required.
  if (getSessionType() === "Lone Qualify" || isOnPitRoad()) {
    forceClear();

    return;
  }

  const to = ev.data.to;

  if (to === state) return;

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
  deps = nextDeps;

  if (registeredBus !== null) {
    if (registeredBus !== bus) {
      throw new Error(
        "registerSpotterEngine called with a different event bus than the initial registration. All callers must share the same bus instance.",
      );
    }

    return;
  }

  const engine = getScenarioEngine();
  engine.defineVar("spotterClip", () => pendingSpotterClip);
  engine.defineScenario(SPOTTER_CALL_SCENARIO);

  registeredBus = bus;
  bus.subscribe("radar.changed", handleRadarChanged);
}

/** @internal Exported for test isolation only. */
export function _resetSpotterEngine(): void {
  resetLoopTimer();
  state = "clear";
  registeredBus = null;
  pendingSpotterClip = "";
  clearPick.lastIndex = -1;
  stillTherePick.lastIndex = -1;
  deps = DEFAULT_DEPS;
}
