/**
 * Imperative radar engine — the one pit-crew concern the scenario DSL
 * cannot yet express (state-driven tick loop whose interval switches at
 * runtime based on proximity state — see design doc §15).
 *
 * Owns its own subscription to `radar.changed` on the event bus, reads
 * telemetry for pit-road suppression, and plays looping directional beeps
 * on `AudioChannel.Radar`. Notifies listeners on visual-state transitions
 * so the pit-crew action can re-render its key icon without holding any
 * radar state itself.
 */
import { AudioChannel, getAudio } from "@iracedeck/audio-service";
import type { IEventBus, SimEventOf } from "@iracedeck/event-bus";
import { getLatestTelemetry, getSessionType } from "@iracedeck/sim-events-iracing";

export type RadarVisualState = "clear" | "left" | "right" | "both" | "two-left" | "two-right";

type ActiveState = Exclude<RadarVisualState, "clear">;

type RadarListener = (state: RadarVisualState) => void;

const RADAR_AUDIO: Record<ActiveState, string> = {
  left: "sfx/radar/IRD-radar-left.mp3",
  right: "sfx/radar/IRD-radar-right.mp3",
  both: "sfx/radar/IRD-radar-both.mp3",
  "two-left": "sfx/radar/IRD-radar-left.mp3",
  "two-right": "sfx/radar/IRD-radar-right.mp3",
};

// Single-car states tick at 250 ms (matches the legacy 4 Hz cadence).
// Two-cars-same-side is faster (180 ms) because being sandwiched on one
// side is the highest-risk position. Both-sides is 230 ms — locked between
// cars but the driver is holding a straight line.
const RADAR_TICK_INTERVALS: Readonly<Record<ActiveState, number>> = {
  left: 250,
  right: 250,
  "two-left": 180,
  "two-right": 180,
  both: 230,
};

const RADAR_TEST_SEQUENCE: readonly string[] = [
  "sfx/radar/IRD-radar-left.mp3",
  "sfx/radar/IRD-radar-right.mp3",
  "sfx/radar/IRD-radar-both.mp3",
];

const RADAR_TEST_GAP_MS = 250;

let enabled = false;
let visualState: RadarVisualState = "clear";
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let registeredBus: IEventBus | null = null;
let testSequenceInFlight = false;
// Monotonic counter — bumped on every `playRadarTest` and on every
// `setRadarEnabled(false)`. Every scheduled callback captures the generation
// at scheduling time and bails if it no longer matches, so a clip completion
// that lands after a disable can't schedule the next preview step.
let testSequenceGeneration = 0;
const listeners = new Set<RadarListener>();

// Plugin-wide master gate (issue #515). Defense-in-depth alongside the
// `enabled` flag set via `setRadarEnabled` — if the plugin-level
// global-settings listener ever fails to fire (test harness, future
// refactor, race during startup), `getMasterEnabled` is consulted live
// on every `radar.changed` arrival AND on every scheduled tick so the
// engine can't audibly fire when the master toggle is off. Plugins
// compose the closure from `pitCrewRadarEnabled === true` and pass it
// through `registerPitCrew` → `registerRadarEngine`.
let getMasterEnabled: () => boolean = () => true;

function stopTickLoop(): void {
  if (tickTimer !== null) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
}

function startTickLoop(state: ActiveState): void {
  stopTickLoop();

  const file = RADAR_AUDIO[state];
  const interval = RADAR_TICK_INTERVALS[state];
  const fire = (): void => {
    // Master gate (issue #515): even if `enabled` is true and a tick is
    // already scheduled, refuse to fire when the plugin-wide master
    // toggle is off. Catches the narrow window where a tick was queued
    // before `setRadarEnabled(false)` ran but landed after.
    //
    // Also clears the latched `visualState`: if `setRadarEnabled(false)`
    // is the path that failed (the very scenario this defense-in-depth
    // gate exists for), the icon would otherwise stay "occupied"
    // indefinitely. Don't stop the channel — the in-flight clip
    // finishes naturally, matching the voice-master-gate's
    // "doesn't cut in-flight" contract.
    if (!getMasterEnabled()) {
      setVisualState("clear");

      return;
    }

    // If the audio engine isn't ready, playOnChannel returns false — don't
    // reschedule a timer in that case; the next radar.changed event will
    // retry the loop once the system is healthy.
    if (!getAudio().playOnChannel(AudioChannel.Radar, file)) return;

    tickTimer = setTimeout(fire, interval);
  };

  fire();
}

function setVisualState(next: RadarVisualState): void {
  if (visualState === next) return;

  visualState = next;

  for (const listener of listeners) listener(next);
}

function isOnPitRoad(): boolean {
  const telemetry = getLatestTelemetry() as { OnPitRoad?: boolean } | null;

  return telemetry?.OnPitRoad === true;
}

function forceClear(): void {
  if (visualState === "clear") return;

  // Don't touch AudioChannel.Radar while a test preview owns it; the
  // preview completion callback re-syncs playback from the (possibly
  // "clear") visualState.
  if (!testSequenceInFlight) {
    stopTickLoop();
    getAudio().stopChannel(AudioChannel.Radar);
  }

  setVisualState("clear");
}

function handleRadarChanged(ev: SimEventOf<"radar.changed">): void {
  if (!enabled) return;

  // Master gate (issue #515): defense-in-depth alongside `enabled`.
  // Read live so the engine respects `pitCrewRadarEnabled` even if the
  // plugin-level listener that calls `setRadarEnabled` ever fails to
  // run. Clear the latched visual state so a stale icon doesn't stay
  // "occupied" while the gate is off — see the matching note in
  // `startTickLoop.fire`.
  if (!getMasterEnabled()) {
    setVisualState("clear");

    return;
  }

  // Lone qualifying sessions have no other cars on track; the raw
  // CarLeftRight value can flicker, and the callouts aren't useful. If a
  // loop was already running from a prior non-qualify state, tear it down
  // so the radar doesn't keep ticking after the session flips.
  if (getSessionType() === "Lone Qualify") {
    forceClear();

    return;
  }

  if (isOnPitRoad()) {
    forceClear();

    return;
  }

  const next = ev.data.to as RadarVisualState;

  if (next === visualState) return;

  // A test preview owns AudioChannel.Radar until it completes — gate
  // every live tick / stop to keep the left→right→both sequence from being
  // garbled. `visualState` still flips here so listeners stay current;
  // the preview's completion handler resumes the live loop with the
  // post-test state.
  if (!testSequenceInFlight) {
    if (next === "clear") {
      stopTickLoop();
      getAudio().stopChannel(AudioChannel.Radar);
    } else {
      startTickLoop(next);
    }
  }

  setVisualState(next);
}

/**
 * Subscribe the engine to the event bus. Idempotent as long as every call
 * passes the same bus instance — re-registering with a different bus would
 * leave the handler attached to the original one and silently break radar
 * events, so we throw loudly instead. Invoked once from
 * `registerPitCrew(bus, …)` at plugin startup; takes the bus explicitly
 * so tests can pass a fake bus without going through `initializeEventBus`.
 *
 * `masterEnabledGetter` (issue #515) is the plugin-wide master gate the
 * engine consults on every `radar.changed` arrival and every scheduled
 * tick. Optional — when omitted the gate stays at `() => true` (legacy
 * behavior). Subsequent calls with a different getter overwrite the
 * previous one, which keeps the bus-instance idempotency check honest:
 * tests that re-register with the same bus can still update the gate.
 */
export function registerRadarEngine(bus: IEventBus, masterEnabledGetter?: () => boolean): void {
  if (masterEnabledGetter) {
    getMasterEnabled = masterEnabledGetter;
  }

  if (registeredBus !== null) {
    if (registeredBus !== bus) {
      throw new Error(
        "registerRadarEngine called with a different event bus than the initial registration. All callers must share the same bus instance.",
      );
    }

    return;
  }

  registeredBus = bus;
  bus.subscribe("radar.changed", handleRadarChanged);
}

/**
 * Master gate. `false` aborts any in-flight test preview, stops the tick
 * loop, silences the radar channel, and forces the visual state back to
 * `"clear"` (notifying subscribers so the key icon clears). `true` is
 * passive — the next `radar.changed` event will drive playback.
 *
 * Uses a monotonic `testSequenceGeneration` counter so that
 * `onChannelComplete` callbacks and `setTimeout`-scheduled `playNext`
 * invocations from a previous preview are inert after the gate flips off.
 * Without that guard, a clip that completes immediately after the user
 * toggles Radar off would queue the next preview clip and play it on
 * `AudioChannel.Radar` despite the master being off.
 */
export function setRadarEnabled(next: boolean): void {
  enabled = next;

  if (!enabled) {
    testSequenceGeneration++;
    testSequenceInFlight = false;
    stopTickLoop();
    getAudio().stopChannel(AudioChannel.Radar);
    setVisualState("clear");
  }
}

/**
 * Plays the three-clip preview sequence (left → right → both) on the
 * radar channel with a 250 ms gap between clips. Used by the PI Test
 * button; works regardless of the master gate. Safe against double-press:
 * a second call while a sequence is in flight is a no-op.
 */
export function playRadarTest(): void {
  if (testSequenceInFlight) return;

  const generation = ++testSequenceGeneration;

  testSequenceInFlight = true;
  // Suspend the live tick loop so a scheduled tick doesn't cut off the
  // preview clip mid-play. `handleRadarChanged` also gates on
  // `testSequenceInFlight` so no new live tick fires during the preview.
  stopTickLoop();

  const finishTest = (): void => {
    if (generation !== testSequenceGeneration) return;

    testSequenceInFlight = false;

    // Resume the live loop if the radar is still active. Events that
    // arrived during the preview updated `visualState` without touching
    // the audio channel, so this picks up the latest state.
    if (enabled && visualState !== "clear") {
      startTickLoop(visualState);
    }
  };

  let idx = 0;
  const playNext = (): void => {
    if (generation !== testSequenceGeneration || !testSequenceInFlight) return;

    if (idx >= RADAR_TEST_SEQUENCE.length) {
      finishTest();

      return;
    }

    const file = RADAR_TEST_SEQUENCE[idx];
    idx++;
    getAudio().onChannelComplete(AudioChannel.Radar, () => {
      setTimeout(() => {
        if (generation === testSequenceGeneration && testSequenceInFlight) {
          playNext();
        }
      }, RADAR_TEST_GAP_MS);
    });

    // If playOnChannel returns false (audio engine not initialized) the
    // completion callback will never fire, so clear the guard here and
    // resume the live loop; a future press after audio comes up will
    // start fresh.
    if (!getAudio().playOnChannel(AudioChannel.Radar, file)) {
      finishTest();
    }
  };

  playNext();
}

/** Returns the latest proximity state (for icon rendering on appear / rerender). */
export function getRadarVisualState(): RadarVisualState {
  return visualState;
}

/**
 * Subscribe to visual-state transitions. Returns an unsubscribe function.
 * The listener is invoked synchronously after the internal state flips,
 * so callers can read `getRadarVisualState()` from inside the callback.
 */
export function subscribeRadarVisualState(listener: RadarListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** @internal Exported for test isolation only. */
export function _resetRadarEngine(): void {
  stopTickLoop();
  enabled = false;
  visualState = "clear";
  listeners.clear();
  registeredBus = null;
  testSequenceInFlight = false;
  testSequenceGeneration = 0;
  getMasterEnabled = () => true;
}
