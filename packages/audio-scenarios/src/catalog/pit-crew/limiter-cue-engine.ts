/**
 * Imperative limiter-on cue (issue #1272) — one short tone the moment the
 * player's pit limiter engages, anywhere on track, the pit box included, so a
 * driver pressing the button at speed on the pit approach knows it took
 * without looking at the dash.
 *
 * Code-owned, like the pit-road speeding tick (#912) and the pit exit beep
 * (#1161) it sits beside, and for the same two reasons: a tone has no wording
 * for a voice pack to own, and a scriptless voice must not silence it. So it
 * plays direct through `getAudio().playOnChannel(...)` rather than through the
 * scenario engine's `fire(...)`, never contends for the Voice bus, and needs
 * no family weight: the pit entry readback and the delayed "Limiter off on
 * pit road" warning neither preempt it nor wait for it.
 *
 * A one-shot, like the exit beep: one event, at most one play, and no timer.
 * The trigger is `carControl.limiterToggled` with `on: true`, the
 * `EngineWarnings.PitSpeedLimiter` bit's off→on edge; the on→off edge is
 * silent. No debounce: a quick on→off→on is two engagements and two beeps.
 *
 * **It trusts the event and reads no telemetry.** Every silence the spec names
 * is the translator's (`diff/toggles.ts`): the first tick after a connect, a
 * restart, a session change or a replay seeds the baseline silently, so a
 * limiter already on does not beep; so does every tick out of the car; and the
 * limiter's baseline follows the bit silently while pit service is active or
 * the car is out of the world (a tow or reset), and for 500 ms after either.
 * Unlike the exit beep, there is no edge here whose own tick can be the wrong
 * moment, so a second check in the engine would only be a second answer to a
 * question the translator owns (`race-engineer-callouts.md`, #1324). It also
 * keeps the harness shortcut audible without a telemetry patch.
 *
 * **Not gated on `hasPitLimiter`.** #639's gate is about wording: it keeps a
 * sentence about a limiter away from a car without one. A tone has no
 * wording, and the edge is its own capability check: a car that cannot
 * engage a limiter never produces it. Gating on `dcPitSpeedLimiterToggle`
 * would add a second, different source of truth for the same bit (the event
 * reads `EngineWarnings`, the gate a driver control) and could only ever
 * silence a real engagement, including the pit-limiter driving aid's
 * automatic one, which the maintainer wants to beep.
 *
 * **Channel.** `AudioChannel.Cue`, routed to the Alerts bus at the Radar
 * channel's mix ratio, so the beep follows the Radar Volume slider. Not
 * `AudioChannel.Radar` itself: on the circuit the proximity radar ticks every
 * 180–250 ms with a car alongside, and on pit road the speeding tick loops on
 * Radar; `playOnChannel` replaces whatever is playing on a channel, so a tick
 * landing just after the press would cut the beep to nothing. It shares Cue
 * with the exit beep, which follows a different moment and cannot
 * realistically coincide with it.
 *
 * Because `applyRaceEngineerAudio()` deliberately leaves the Alerts bus
 * unmuted when the Race Engineer master is off, the master check below is
 * load-bearing rather than defence in depth: without it the beep would play
 * with the engineer switched off.
 */
import { AudioChannel, getAudio } from "@iracedeck/audio-service";
import type { IEventBus, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";

/**
 * The limiter-on tone, chosen by ear from five candidates during #1272. The
 * exact mirror of the pit exit beep (`PIT_EXIT_CLIP` in
 * `pit-exit-cue-engine.ts`), a falling perfect fourth: A6 (1760 Hz) for 60 ms,
 * a 10 ms gap, then E6 (1318.51 Hz) for 100 ms — pure sine, flat sustain, a
 * 3 ms linear attack and a 10 ms linear release on each note, 170 ms in all.
 * Mono, 48 kHz. Falling is the meaning: this tone says "now held", where the
 * exit beep's rising says "limit's off", and neither sounds like
 * `IRD-pit-speed-warning.wav`'s "too fast" tick.
 *
 * The source is rendered as:
 *
 * ```text
 * ffmpeg -f lavfi -i "aevalsrc=exprs='0.89*(between(t,0,0.06)*min(1,(t-0)/0.003)*min(1,(0.06-t)/0.01)*(1*sin(2*PI*1760*t))+between(t,0.07,0.17)*min(1,(t-0.07)/0.003)*min(1,(0.17-t)/0.01)*(1*sin(2*PI*1318.51*t)))':s=48000:d=0.17" \
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
 * −19 dB puts its maximum EBU R128 momentary loudness at −26.2 LUFS, against
 * −26.0 LUFS for one tick of `IRD-pit-speed-warning.wav` on the same Alerts
 * bus at the same mix ratio, so the pit-lane tones sit at one level under the
 * Radar Volume slider. Peak −20.0 dBFS, RMS −23.8 dBFS.
 *
 * The rest of the reasoning is `PIT_EXIT_CLIP`'s and holds unchanged:
 * the gain is ABSOLUTE against the source, never a delta against the
 * committed file; the bitexact flags leave only the `fmt ` and `data` chunks,
 * so a re-render is byte-identical; the gain is baked in because
 * `playOnChannel` takes no per-play gain; it stays a `.wav`, since an mp3
 * decoder's priming delay would land on a cue whose whole value is marking an
 * instant; and it was generated for this feature, so it carries no
 * third-party licence obligation and needs no `THIRD-PARTY-LICENSES.md` entry.
 */
export const LIMITER_ON_CLIP = "sfx/IRD-pit-limiter-on.wav";

export type LimiterCueDeps = {
  /** `pitCrewRaceEngineerEnabled` — read live at each event, see the file header. */
  getMasterEnabled: () => boolean;
  /** `calloutEnabledLimiterEngagedCue` — read live at each event. */
  getCueEnabled: () => boolean;
  logger?: ILogger;
};

/**
 * What the last `carControl.limiterToggled` did, for the Telemetry Snapshot:
 * whether the tone was asked for, or why it stayed silent (`off-edge` is the
 * limiter switching off, which never beeps). `null` until the first event
 * after registration.
 */
export type LimiterCueOutcome =
  "played" | "off-edge" | "master-off" | "cue-off" | "playback-failed" | "playback-refused";

const DEFAULT_DEPS: LimiterCueDeps = {
  getMasterEnabled: () => true,
  getCueEnabled: () => true,
};

let deps: LimiterCueDeps = DEFAULT_DEPS;
let registeredBus: IEventBus | null = null;
let lastOutcome: LimiterCueOutcome | null = null;

function handleToggled(event: SimEventOf<"carControl.limiterToggled">): void {
  // The off edge is checked first: it is no engagement, whatever the gates say.
  if (!event.data.on) {
    lastOutcome = "off-edge";

    return;
  }

  // Read live at the event, never captured at registration, so a toggle takes
  // effect on the next engagement with no push path from the settings listener.
  if (!deps.getMasterEnabled()) {
    lastOutcome = "master-off";
    deps.logger?.debug("Limiter cue skipped: the Race Engineer is off");

    return;
  }

  if (!deps.getCueEnabled()) {
    lastOutcome = "cue-off";
    deps.logger?.debug("Limiter cue skipped: the Limiter on beep is off");

    return;
  }

  // `getAudio()` throws when the audio service is not initialised, and the
  // on-demand playback device (#849) can be torn down at any moment. The bus
  // isolates a throwing handler, but a lost beep is the whole cost here, so it
  // is caught and logged rather than reported as a subscriber failure.
  try {
    if (!getAudio().playOnChannel(AudioChannel.Cue, LIMITER_ON_CLIP)) {
      lastOutcome = "playback-refused";
      deps.logger?.debug(`Limiter cue playback refused for ${LIMITER_ON_CLIP}`);

      return;
    }
  } catch (err) {
    lastOutcome = "playback-failed";
    deps.logger?.debug(`Limiter cue playback failed: ${String(err)}`);

    return;
  }

  lastOutcome = "played";
  deps.logger?.info("Limiter cue played");
}

export function registerLimiterCueEngine(bus: IEventBus, nextDeps: LimiterCueDeps): void {
  if (registeredBus !== null) {
    if (registeredBus !== bus) {
      throw new Error(
        "registerLimiterCueEngine called with a different event bus than the initial registration. All callers must share the same bus instance.",
      );
    }

    deps = nextDeps;

    return;
  }

  deps = nextDeps;
  registeredBus = bus;
  bus.subscribe("carControl.limiterToggled", handleToggled);
}

/** @internal Exported for test isolation only. */
export function _resetLimiterCueEngine(): void {
  deps = DEFAULT_DEPS;
  registeredBus = null;
  lastOutcome = null;
}

/**
 * This file's module state, for the Telemetry Snapshot (issue #1387). A pure
 * read, and safe before `registerLimiterCueEngine`. The bus is reported as
 * `registered`; `deps` is closures and a logger and is left out.
 */
export function readLimiterCueDebugState(): { registered: boolean; lastOutcome: LimiterCueOutcome | null } {
  return { registered: registeredBus !== null, lastOutcome };
}
