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
  /** Plugin-wide master gate (`pitCrewSpotterEnabled`). */
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

let enabled = false;
let state: RadarState = "clear";
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let focusHeld = false;
let registeredBus: IEventBus | null = null;
let pendingSpotterClip = "";
let clearPoolLastIndex = -1;
let stillTherePoolLastIndex = -1;

let deps: SpotterDeps = {
  getMasterEnabled: () => true,
  getCarsEnabled: () => true,
  getStillThereEnabled: () => true,
  getTrackDirection: () => TrackDirection.Neutral,
};

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

// ─── Engine-owned no-repeat pool picks (mirror interpreter pickFromPool) ──────

function pickClearPool(): string {
  let idx = Math.floor(Math.random() * CLEAR_POOL.length);

  if (idx === clearPoolLastIndex && CLEAR_POOL.length > 1) idx = (idx + 1) % CLEAR_POOL.length;

  clearPoolLastIndex = idx;

  return CLEAR_POOL[idx];
}

function pickStillTherePool(): string {
  let idx = Math.floor(Math.random() * STILL_THERE_POOL.length);

  if (idx === stillTherePoolLastIndex && STILL_THERE_POOL.length > 1) idx = (idx + 1) % STILL_THERE_POOL.length;

  stillTherePoolLastIndex = idx;

  return STILL_THERE_POOL[idx];
}

// ─── Firing + focus + loop ───────────────────────────────────────────────────

function fireClip(path: string): void {
  pendingSpotterClip = path;
  getScenarioEngine().fire(SPOTTER_CALL_SCENARIO_ID);
}

function acquireFocusIfNeeded(): void {
  if (focusHeld) return;

  getScenarioEngine().acquireFocus(AudioBus.Voice, SPOTTER_FOCUS_OWNER, WEIGHT.SAFETY);
  focusHeld = true;
}

function releaseFocus(): void {
  if (!focusHeld) return;

  getScenarioEngine().releaseFocus(AudioBus.Voice, SPOTTER_FOCUS_OWNER);
  focusHeld = false;
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
  // Master can drop mid-loop (PI toggle, defense-in-depth) — bail loudly.
  if (!enabled || !deps.getMasterEnabled()) {
    forceClear();

    return;
  }

  // The "still there" opt-in is read live: when off, keep the loop scheduled
  // but fire nothing, so re-enabling mid-session resumes the reminder.
  if (deps.getStillThereEnabled()) fireClip(pickStillTherePool());

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
    if (carsEnabled) fireClip(pickClearPool());

    releaseFocus();

    return;
  }

  acquireFocusIfNeeded();

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
      // 1 → 2 two-cars escalation.
      fireClip(levelClip(occupied, 2, dir));
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

function handleRadarChanged(ev: SimEventOf<"radar.changed">): void {
  if (!enabled) return;

  // Master gate (defense-in-depth alongside `enabled`): read live so the
  // engine respects `pitCrewSpotterEnabled` even if the plugin-level
  // listener that calls `setSpotterEnabled` ever fails to run.
  if (!deps.getMasterEnabled()) {
    forceClear();

    return;
  }

  // Lone qualifying has no other cars on track; `radar.changed` is NOT
  // pre-suppressed for it (diffRadar emits raw CarLeftRight transitions), so
  // this guard is required, not just defensive.
  if (getSessionType() === "Lone Qualify") {
    forceClear();

    return;
  }

  // Likewise pit road: `radar.changed` keeps firing in the pits, so suppress.
  if (isOnPitRoad()) {
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

/**
 * Master gate flip from the mode button. `false` forces clear (stop the loop,
 * release focus, reset internal state to `"clear"`) without playing a clip.
 * `true` is passive — the next `radar.changed` event drives playback.
 */
export function setSpotterEnabled(next: boolean): void {
  enabled = next;

  if (!enabled) forceClear();
}

export function isSpotterEnabled(): boolean {
  return enabled;
}

/** @internal Exported for test isolation only. */
export function _resetSpotterEngine(): void {
  resetLoopTimer();
  enabled = false;
  state = "clear";
  focusHeld = false;
  registeredBus = null;
  pendingSpotterClip = "";
  clearPoolLastIndex = -1;
  stillTherePoolLastIndex = -1;
  deps = {
    getMasterEnabled: () => true,
    getCarsEnabled: () => true,
    getStillThereEnabled: () => true,
    getTrackDirection: () => TrackDirection.Neutral,
  };
}
