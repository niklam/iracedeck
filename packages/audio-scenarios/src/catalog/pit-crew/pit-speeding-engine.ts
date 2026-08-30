/**
 * Imperative pit-road speeding cue (issue #912) — a repeating tick that plays
 * for exactly as long as the player is over the posted pit-lane speed limit.
 *
 * Modelled on `radar-engine.ts`, and deliberately NOT on `spotter-engine.ts`:
 * the spotter is imperative in its state machine but routes every clip through
 * `getScenarioEngine().fire(...)`, so it inherits the interpreter's weights,
 * families and focus floor. This cue plays direct, because its entire value is
 * being instantaneous — a scheduling delay defeats the purpose. The
 * consequence is that it never contends for the Voice bus at all, so it simply
 * coexists with a spotter call rather than needing a ducking rule.
 *
 * Channel choice is forced rather than aesthetic. `SFX` carries the
 * walkie-talkie ticks framing every radio callout and `Ambient` carries the
 * pit bed — both are busiest during a pit stop, and `playOnChannel` replaces
 * whatever is playing, so either would have this cue and the engineer's own
 * framing cutting each other every second. `AudioChannel.Radar` is the only
 * channel whose sole other producer (the radar engine) force-clears itself on
 * pit road, i.e. is guaranteed silent exactly where this cue lives.
 *
 * Because `applyRaceEngineerAudio()` deliberately leaves the Alerts bus
 * unmuted when the Race Engineer master is off, the master check below is
 * load-bearing rather than defence in depth: without it the cue would keep
 * beeping with the engineer switched off.
 */
import { AudioChannel, getAudio } from "@iracedeck/audio-service";
import type { IEventBus } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { getLatestTelemetry } from "@iracedeck/sim-events-iracing";

/**
 * Placeholder clip — the non-directional radar tick. A purpose-made warning
 * tone replaces this constant without touching the mechanism (issue #912
 * follow-up).
 */
export const PIT_SPEEDING_CLIP = "sfx/radar/IRD-radar-both.mp3";

/** Repeat cadence while the condition holds. */
export const PIT_SPEEDING_TICK_INTERVAL_MS = 1000;

export type PitSpeedingDeps = {
  /** `pitCrewRaceEngineerEnabled` — read live, see the file header. */
  getMasterEnabled: () => boolean;
  /** `calloutEnabledPitSpeedingCue` — read live. */
  getCueEnabled: () => boolean;
  logger?: ILogger;
};

const DEFAULT_DEPS: PitSpeedingDeps = {
  getMasterEnabled: () => true,
  getCueEnabled: () => true,
};

let deps: PitSpeedingDeps = DEFAULT_DEPS;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let registeredBus: IEventBus | null = null;

function stopTickLoop(): void {
  if (tickTimer !== null) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
}

/**
 * Third and last layer of the always-ends invariant.
 *
 * The diff ends the episode on every exit it can observe, and the translator's
 * disconnect / session-change / replay teardowns cover the exits that stop
 * ticks reaching the diff at all. This is the backstop for both failing: a
 * loop with no `ended` coming dies within one interval.
 *
 * Checked as a POSITIVE `false`, not as "not true". Missing or unknown
 * telemetry keeps playing, following the precedent that unknown data must not
 * silence a warning — and it is also what keeps the cue auditionable from the
 * scenario harness, where no real telemetry sits behind the shortcut buttons.
 */
function leftPitRoad(): boolean {
  const telemetry = getLatestTelemetry() as { OnPitRoad?: boolean } | null;

  return telemetry?.OnPitRoad === false;
}

function startTickLoop(): void {
  stopTickLoop();

  const fire = (): void => {
    // Gates are re-read on every tick rather than captured at registration,
    // so toggling either off mid-episode silences the cue within one interval
    // without any push path from the settings listener. That is the same
    // latency the spotter's reminder loop has, and buying it down would mean
    // another cross-package coupling that can disagree with this check.
    if (!deps.getMasterEnabled() || !deps.getCueEnabled()) {
      stopTickLoop();

      return;
    }

    if (leftPitRoad()) {
      deps.logger?.debug("Pit-speeding cue stopped: no longer on pit road");
      stopTickLoop();

      return;
    }

    // Unlike radar, keep the loop alive when playback fails. Radar can afford
    // to drop the timer because the next `radar.changed` re-drives it within
    // seconds; this cue has no such retry — its only other input is the
    // `ended` that closes the episode — so dropping the timer here would lose
    // the whole warning if the audio device happened to be starting up.
    // Bounded by `ended`, so the worst case is a 1 Hz no-op for one episode.
    getAudio().playOnChannel(AudioChannel.Radar, PIT_SPEEDING_CLIP);

    tickTimer = setTimeout(fire, PIT_SPEEDING_TICK_INTERVAL_MS);
  };

  // Leading edge — the first tick is immediate. A repeating warning that waits
  // out its own interval before the first beep is a warning that arrives late.
  fire();
}

function handleStarted(): void {
  if (!deps.getMasterEnabled() || !deps.getCueEnabled()) return;

  startTickLoop();
}

/**
 * Stop the loop. The in-flight clip is not cut — it finishes naturally, which
 * matches radar's master-gate contract and costs at most one short tick. It
 * also keeps this engine from calling `stopChannel` on a channel the radar
 * engine shares.
 */
function handleEnded(): void {
  stopTickLoop();
}

export function registerPitSpeedingEngine(bus: IEventBus, nextDeps: PitSpeedingDeps): void {
  if (registeredBus !== null) {
    if (registeredBus !== bus) {
      throw new Error(
        "registerPitSpeedingEngine called with a different event bus than the initial registration. All callers must share the same bus instance.",
      );
    }

    deps = nextDeps;

    return;
  }

  deps = nextDeps;
  registeredBus = bus;
  bus.subscribe("pitSpeeding.started", handleStarted);
  bus.subscribe("pitSpeeding.ended", handleEnded);
}

/** @internal Exported for test isolation only. */
export function _resetPitSpeedingEngine(): void {
  stopTickLoop();
  deps = DEFAULT_DEPS;
  registeredBus = null;
}
