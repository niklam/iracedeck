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
 * framing cutting each other several times a second. `AudioChannel.Radar` is the one
 * channel whose other producer suppresses ITSELF on pit road.
 *
 * That is not the same as the channel being free, and the difference matters:
 * radar's `forceClear()` does not merely fall silent, it calls
 * `stopChannel(AudioChannel.Radar)`. Entering pit road with a car alongside is
 * the ordinary case, so the radar teardown lands on the same tick this cue
 * starts — which is why `diffPitSpeeding` is sequenced AFTER `diffRadar` in
 * the translator, so the clear is published first and this cue's opening tick
 * is not cut. A `setRadarEnabled(false)` arriving mid-episode can still
 * truncate one tick; the loop reschedules, so the cost is bounded at one
 * shortened beep.
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
 * The warning tone, chosen by ear from six candidates during #912's hardware
 * testing. Mono, 48 kHz, 160 ms — short enough that at the cadence below it
 * cannot overlap or truncate itself, leaving ~140 ms of silence between ticks.
 *
 * **The shipped asset is the generated source at −6 dB**, rendered as:
 *
 * ```text
 * ffmpeg -i <source> -af volume=-6dB -c:a pcm_s16le -ar 48000 -ac 1  *        -map_metadata -1 -fflags +bitexact -flags +bitexact <asset>
 * ```
 *
 * The gain is stated as an ABSOLUTE figure against that source, not as a
 * delta against whatever is currently in the repo: a further adjustment
 * re-renders from the source with a new absolute number. Attenuating the
 * committed file again would work once and then compound, each pass drifting
 * further from anything reproducible.
 *
 * The bitexact flags are not decoration. Without them ffmpeg writes a
 * `LIST/INFO/ISFT` chunk naming its own version, which bakes the toolchain
 * into the asset — a re-render from a different ffmpeg would then differ from
 * this file even at an identical gain, turning a no-op into a binary diff. As
 * rendered the file carries only `fmt ` and `data`.
 *
 * It is baked into the asset rather than applied at playback because
 * `playOnChannel` takes no per-play gain — it uses the channel volume — so the
 * alternatives were widening a shared API or moving `setChannelVolume(Radar,
 * …)` around each play, which would fight both the radar engine and the user's
 * own Radar slider.
 *
 * Kept as `.wav` rather than converted to `.mp3` like its `sfx/` neighbours.
 * It is 15 KB, so the size argument for mp3 does not arise, and an mp3
 * decoder's priming delay is a real cost on a 160 ms tick fired three times a
 * second where the attack IS the signal. The build copies everything outside
 * `voice/` verbatim and miniaudio decodes wav natively, so nothing else cares.
 *
 * It lives at the `sfx/` root rather than in `sfx/radar/` because it is not a
 * radar sound — the cue only ever borrowed one while it had no tone of its own.
 *
 * Generated for this feature rather than sourced, so it carries no third-party
 * licence obligation and needs no `THIRD-PARTY-LICENSES.md` entry. Noted here
 * because an unattributed binary in `sfx/` invites exactly that question, and
 * the file cannot answer it — by construction it carries no metadata.
 */
export const PIT_SPEEDING_CLIP = "sfx/IRD-pit-speed-warning.wav";

/**
 * Repeat cadence while the condition holds.
 *
 * 300 ms, settled by ear on hardware alongside the tone above. It shipped for
 * review at 1000 ms, which "feels lazy" for a warning you are meant to react
 * to immediately; 500 ms was the first correction and 300 ms the one that
 * stuck. The tone is 160 ms, so this still leaves ~140 ms of silence between
 * ticks and the cue reads as a beeper rather than a buzz.
 *
 * **Before treating this as a matter of taste, know what else it sets.** The
 * interval doubles as the worst-case latency of every live check in the loop
 * below: a gate switched off, a driver leaving pit road, a frozen sim.
 * Cutting the cadence sharpened all three, and raising it would slow all three by
 * the same factor — so a request to make the beeping less frequent is a safety
 * change, not a comfort one, and wants the checks decoupled from the cadence
 * rather than a bigger number here.
 */
export const PIT_SPEEDING_TICK_INTERVAL_MS = 300;

export type PitSpeedingDeps = {
  /** `pitCrewRaceEngineerEnabled` — read live, see the file header. */
  getMasterEnabled: () => boolean;
  /** `calloutEnabledPitSpeedingCue` — read live. */
  getCueEnabled: () => boolean;
  logger?: ILogger;
};

type Snapshot = { OnPitRoad?: boolean; SessionTick?: number } | null;

const DEFAULT_DEPS: PitSpeedingDeps = {
  getMasterEnabled: () => true,
  getCueEnabled: () => true,
};

let deps: PitSpeedingDeps = DEFAULT_DEPS;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let registeredBus: IEventBus | null = null;
/** True between `pitSpeeding.started` and `pitSpeeding.ended`, gates aside. */
let episodeActive = false;
/** Last `SessionTick` this loop observed — see `simFrozen`. */
let lastSessionTick: number | null = null;

function stopTickLoop(): void {
  if (tickTimer !== null) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }

  lastSessionTick = null;
}

/**
 * Second stop condition, and the reason this engine reads telemetry at all:
 * the diff ends the episode on every exit it can observe, and the translator's
 * teardowns cover the exits that stop ticks reaching the diff — but both of
 * those need the translator to still be running.
 *
 * Checked as a POSITIVE `false`, never as "not true". Missing or unknown
 * telemetry keeps playing, following the precedent that unknown data must not
 * silence a warning — and it is also what keeps the cue auditionable from the
 * scenario harness, where no real telemetry sits behind the shortcut buttons.
 */
function leftPitRoad(snapshot: Snapshot): boolean {
  return snapshot?.OnPitRoad === false;
}

/**
 * The hole that a positive `OnPitRoad === false` cannot close (found in the
 * #912 review). `SDKController` dedupes on `SessionTick`, so a paused or hung
 * sim notifies no subscribers: the diff stops running and can never publish
 * `ended`, no disconnect fires, and `getLatestTelemetry()` keeps returning the
 * frozen snapshot — which still says the driver is speeding on pit road. Every
 * stop path depends on something advancing, so a frozen sim defeats all of
 * them at once and the tick would beep over a paused game forever.
 *
 * iRacing advances `SessionTick` at ~60 Hz while this loop runs at ~3 Hz, so
 * a single unchanged reading between two cue ticks is already conclusive.
 *
 * The response is to fall SILENT rather than to stop: unpausing must resume
 * the warning, and the episode is still live — the driver is still speeding.
 * Stopping outright would leave the rest of the episode unwarned, because the
 * diff holds `pitSpeedingActive` and will not re-emit `started`.
 *
 * When the field is absent the guard disables itself, which is correct rather
 * than merely safe: `SDKController` only dedupes when `SessionTick` is
 * defined, so a build without it delivers every poll and the diff keeps
 * running normally.
 */
function simFrozen(snapshot: Snapshot): boolean {
  const tick = snapshot?.SessionTick;

  if (typeof tick !== "number") {
    lastSessionTick = null;

    return false;
  }

  if (tick === lastSessionTick) return true;

  lastSessionTick = tick;

  return false;
}

function startTickLoop(): void {
  stopTickLoop();

  const fire = (): void => {
    const snapshot = getLatestTelemetry() as Snapshot;

    if (leftPitRoad(snapshot)) {
      deps.logger?.info("Pit-speeding cue stopped");
      deps.logger?.debug("Pit-speeding cue stopped: telemetry reports the car is no longer on pit road");
      stopTickLoop();

      return;
    }

    // Gates are re-read on every tick rather than captured at registration, so
    // a mid-episode toggle takes effect within one interval with no push path
    // from the settings listener. The loop is KEPT ALIVE while gated rather
    // than stopped — the spotter's reminder-loop shape — so re-enabling the
    // engineer part-way through an episode resumes the warning instead of
    // leaving the rest of it silent.
    const gated = !deps.getMasterEnabled() || !deps.getCueEnabled();

    if (!gated && !simFrozen(snapshot)) {
      // A throw here would be an unhandled exception in a bare timer callback,
      // which ends the plugin process — `getAudio()` throws when the audio
      // service is not initialised, and the on-demand playback device (#849)
      // can be torn down mid-episode. Losing a tick is acceptable; losing the
      // plugin is not. The return value is deliberately ignored: unlike radar,
      // which is re-driven by the next `radar.changed` within seconds, this
      // cue has no retry path other than the `ended` that closes the episode,
      // so dropping the timer on a transient failure would lose the whole
      // warning.
      try {
        getAudio().playOnChannel(AudioChannel.Radar, PIT_SPEEDING_CLIP);
      } catch (err) {
        deps.logger?.debug(`Pit-speeding cue playback failed: ${String(err)}`);
      }
    }

    tickTimer = setTimeout(fire, PIT_SPEEDING_TICK_INTERVAL_MS);
  };

  // Leading edge — the first tick is immediate. A repeating warning that waits
  // out its own interval before the first beep is a warning that arrives late.
  fire();
}

function handleStarted(): void {
  episodeActive = true;
  deps.logger?.info("Pit-speeding cue started");
  startTickLoop();
}

/**
 * Stop the loop. The in-flight clip is not cut — it finishes naturally, which
 * matches radar's master-gate contract and costs at most one short tick. It
 * also keeps this engine from calling `stopChannel` on a channel the radar
 * engine shares.
 */
function handleEnded(): void {
  if (episodeActive) deps.logger?.info("Pit-speeding cue stopped");

  episodeActive = false;
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
  episodeActive = false;
}
