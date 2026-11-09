/**
 * Imperative pit exit cue (issue #1161) — one short tone the moment the player
 * crosses the pit exit line, where the pit speed limit ends, so the driver
 * knows they can get on the throttle without looking at the dash.
 *
 * Code-owned, like the pit-road speeding tick (#912) it is modelled on, and
 * for the same two reasons: a tone has no wording for a voice pack to own, and
 * a scriptless voice must not silence it. So it plays direct through
 * `getAudio().playOnChannel(...)` rather than through the scenario engine's
 * `fire(...)`, never contends for the Voice bus, and needs no family weight:
 * the "Limiter still on" line (~1.5 s later) and the "To confirm: …" exit
 * readback (+4.5 s) that follow the same edge neither preempt it nor wait for
 * it.
 *
 * Unlike the speeding cue it is a one-shot: one event, at most one play, and
 * no timer. The trigger is `pitLane.exited`, the player's `OnPitRoad` on→off
 * edge, which falls exactly where the pit speed limit ends (settled with the
 * maintainer, 2026-09-13). There is no speed threshold — a car queueing out of
 * a closed exit still crosses the line.
 *
 * **Channel.** `AudioChannel.Cue`, routed to the Alerts bus at the Radar
 * channel's mix ratio, so the beep follows the Radar Volume slider as the
 * speeding tick does. Not `AudioChannel.Radar` itself: the proximity radar
 * resumes the moment the car leaves pit road, and `playOnChannel` replaces
 * whatever is playing on a channel, so a radar tick landing just after the
 * edge would cut the beep to nothing.
 *
 * Because `applyRaceEngineerAudio()` deliberately leaves the Alerts bus
 * unmuted when the Race Engineer master is off, the master check below is
 * load-bearing rather than defence in depth: without it the beep would play
 * with the engineer switched off.
 */
import { AudioChannel, getAudio } from "@iracedeck/audio-service";
import type { IEventBus, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import type { TelemetryData } from "@iracedeck/sim-events-iracing";

/**
 * The pit exit tone, chosen by ear from six candidates during #1161. A rising
 * perfect fourth: E6 (1318.51 Hz) for 60 ms, a 10 ms gap, then A6 (1760 Hz)
 * for 100 ms — pure sine, flat sustain, a 3 ms linear attack and a 10 ms
 * linear release on each note, 170 ms in all. Mono, 48 kHz. Rising is the
 * meaning: this tone says "limit's off", unlike `IRD-pit-speed-warning.wav`,
 * which says "too fast", and #1272's limiter-on beep is to mirror it falling.
 *
 * The source is rendered as:
 *
 * ```text
 * ffmpeg -f lavfi -i "aevalsrc=exprs='0.89*(between(t,0,0.06)*min(1,(t-0)/0.003)*min(1,(0.06-t)/0.01)*(1*sin(2*PI*1318.51*t))+between(t,0.07,0.17)*min(1,(t-0.07)/0.003)*min(1,(0.17-t)/0.01)*(1*sin(2*PI*1760*t)))':s=48000:d=0.17" \
 *        -c:a pcm_s16le -ar 48000 -ac 1 -map_metadata -1 -fflags +bitexact -flags +bitexact <source>
 * ```
 *
 * **The shipped asset is that source at −19 dB**, rendered as:
 *
 * ```text
 * ffmpeg -i <source> -af volume=-19dB -c:a pcm_s16le -ar 48000 -ac 1 \
 *        -map_metadata -1 -fflags +bitexact -flags +bitexact <asset>
 * ```
 *
 * −19 dB matches its maximum EBU R128 momentary loudness (−25.9 LUFS) to that
 * of one tick of `IRD-pit-speed-warning.wav` (−26.0 LUFS), which plays through
 * the same Alerts bus at the same mix ratio, so the two pit-lane tones
 * sit at one level under the Radar Volume slider. Peak −20.0 dBFS, RMS
 * −23.8 dBFS.
 *
 * The gain is stated as an ABSOLUTE figure against the source, not as a delta
 * against whatever is currently in the repo: a further adjustment re-renders
 * from the source with a new absolute number, since attenuating the committed
 * file again would compound with every pass. The bitexact flags keep ffmpeg
 * from writing a `LIST/INFO/ISFT` chunk naming its own version, so a re-render
 * from another ffmpeg at the same gain is byte-identical; the file carries
 * only `fmt ` and `data`. The gain is baked into the asset because
 * `playOnChannel` takes no per-play gain.
 *
 * Kept as `.wav` rather than `.mp3`, as the speeding tick is: it is 16 KB,
 * and an mp3 decoder's priming delay would land on a cue whose whole value is
 * marking an instant. The build copies everything outside `voice/` verbatim
 * and miniaudio decodes wav natively.
 *
 * Generated for this feature rather than sourced, so it carries no third-party
 * licence obligation and needs no `THIRD-PARTY-LICENSES.md` entry.
 */
export const PIT_EXIT_CLIP = "sfx/IRD-pit-exit.wav";

export type PitExitCueDeps = {
  /** `pitCrewRaceEngineerEnabled` — read live at each event, see the file header. */
  getMasterEnabled: () => boolean;
  /** `calloutEnabledPitExitCue` — read live at each event. */
  getCueEnabled: () => boolean;
  logger?: ILogger;
};

/**
 * What the last `pitLane.exited` did, for the Telemetry Snapshot: whether the
 * tone was asked for, or which gate kept it silent. `null` until the first
 * event after registration.
 */
export type PitExitCueOutcome =
  "played" | "master-off" | "cue-off" | "not-in-car" | "replay" | "playback-failed" | "playback-refused";

/** The two telemetry fields the cue reads, as an envelope may (or may not) carry them. */
type Snapshot = Pick<Partial<TelemetryData>, "IsOnTrack" | "IsReplayPlaying">;

const DEFAULT_DEPS: PitExitCueDeps = {
  getMasterEnabled: () => true,
  getCueEnabled: () => true,
};

let deps: PitExitCueDeps = DEFAULT_DEPS;
let registeredBus: IEventBus | null = null;
let lastOutcome: PitExitCueOutcome | null = null;

/**
 * The envelope's telemetry — the snapshot of the very tick whose `OnPitRoad`
 * edge published the event — or `null` when it carries none. The bus types it
 * `unknown` to stay sim-agnostic, so anything that is not an object reads as
 * missing rather than being trusted.
 */
function snapshotOf(event: SimEventOf<"pitLane.exited">): Snapshot | null {
  const telemetry: unknown = event.telemetry;

  return typeof telemetry === "object" && telemetry !== null ? (telemetry as Snapshot) : null;
}

/**
 * Which telemetry gate silences this edge, if any.
 *
 * Both are checked as POSITIVE reads, never as "not the safe value": missing
 * or unknown telemetry plays, following #912's precedent that unknown data
 * must not silence a cue. That also keeps the cue audible from the scenario
 * harness when nothing real sits behind a published event.
 *
 * - `IsOnTrack === false` — the player is not in the car. A driver cannot
 *   leave a moving car, so a real drive-out never reads this; a tow or reset
 *   that clears `OnPitRoad` does.
 * - `IsReplayPlaying === true` — a replay. The translator already suppresses
 *   events while one plays; this keeps the cue honest if one ever reaches it.
 */
function telemetryGate(snapshot: Snapshot | null): "not-in-car" | "replay" | null {
  if (snapshot?.IsOnTrack === false) return "not-in-car";

  if (snapshot?.IsReplayPlaying === true) return "replay";

  return null;
}

function handleExited(event: SimEventOf<"pitLane.exited">): void {
  // Read live at the event, never captured at registration, so a toggle takes
  // effect on the next pit exit with no push path from the settings listener.
  if (!deps.getMasterEnabled()) {
    lastOutcome = "master-off";
    deps.logger?.debug("Pit exit cue skipped: the Race Engineer is off");

    return;
  }

  if (!deps.getCueEnabled()) {
    lastOutcome = "cue-off";
    deps.logger?.debug("Pit exit cue skipped: the Pit exit beep is off");

    return;
  }

  const gate = telemetryGate(snapshotOf(event));

  if (gate !== null) {
    lastOutcome = gate;
    deps.logger?.debug(
      gate === "not-in-car"
        ? "Pit exit cue skipped: telemetry reports the player is not in the car"
        : "Pit exit cue skipped: a replay is playing",
    );

    return;
  }

  // `getAudio()` throws when the audio service is not initialised, and the
  // on-demand playback device (#849) can be torn down at any moment. The bus
  // isolates a throwing handler, but a lost beep is the whole cost here, so it
  // is caught and logged rather than reported as a subscriber failure.
  try {
    if (!getAudio().playOnChannel(AudioChannel.Cue, PIT_EXIT_CLIP)) {
      lastOutcome = "playback-refused";
      deps.logger?.debug(`Pit exit cue playback refused for ${PIT_EXIT_CLIP}`);

      return;
    }
  } catch (err) {
    lastOutcome = "playback-failed";
    deps.logger?.debug(`Pit exit cue playback failed: ${String(err)}`);

    return;
  }

  lastOutcome = "played";
  deps.logger?.info("Pit exit cue played");
}

export function registerPitExitCueEngine(bus: IEventBus, nextDeps: PitExitCueDeps): void {
  if (registeredBus !== null) {
    if (registeredBus !== bus) {
      throw new Error(
        "registerPitExitCueEngine called with a different event bus than the initial registration. All callers must share the same bus instance.",
      );
    }

    deps = nextDeps;

    return;
  }

  deps = nextDeps;
  registeredBus = bus;
  bus.subscribe("pitLane.exited", handleExited);
}

/** @internal Exported for test isolation only. */
export function _resetPitExitCueEngine(): void {
  deps = DEFAULT_DEPS;
  registeredBus = null;
  lastOutcome = null;
}

/**
 * This file's module state, for the Telemetry Snapshot (issue #1387). A pure
 * read, and safe before `registerPitExitCueEngine`. The bus is reported as
 * `registered`; `deps` is closures and a logger and is left out.
 */
export function readPitExitCueDebugState(): { registered: boolean; lastOutcome: PitExitCueOutcome | null } {
  return { registered: registeredBus !== null, lastOutcome };
}
