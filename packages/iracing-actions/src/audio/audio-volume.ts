import type { FrameOptions } from "@iracedeck/audio-scenarios";
import { isBackgroundTestInFlight, stopRaceEngineerScenarios } from "@iracedeck/audio-scenarios/pit-crew";
import { AudioBus, AudioChannel, getAudio } from "@iracedeck/audio-service";
import { frameOptionsFromSettings, getGlobalSettings, updateGlobalSettings } from "@iracedeck/settings";

import {
  readBackgroundVolume,
  readRaceEngineerVolume,
  readRadarVolume,
  VOLUME_MAX,
  VOLUME_MIN,
  VOLUME_STEP,
} from "./audio-levels.js";
import { playVolumeTick } from "./volume-tick.js";

// The readers and the step constants live in the `audio-levels.ts` leaf (so the
// tick module can read Radar Volume without a cycle); every caller keeps
// importing them from here.
export { readBackgroundVolume, readRaceEngineerVolume, readRadarVolume, VOLUME_MAX, VOLUME_MIN, VOLUME_STEP };

/**
 * Shared volume + audio-bus helpers for iRaceDeck's own audio (Race Engineer
 * voice on {@link AudioBus.Voice}, pit ambience/SFX on
 * {@link AudioBus.Background}, directional Radar ticks on
 * {@link AudioBus.Alerts}).
 *
 * Both the Pit Crew action (toggles + Radar Volume mode) and the Audio
 * Controls action (Race Engineer / Radar volume buttons) step the same global
 * settings and apply them to the same buses, so the read/step/apply logic and
 * the Race Engineer master-gate state live here as the single source of truth.
 * Keeping the master-gate in-flight bypass flags next to
 * {@link applyRaceEngineerAudio} ensures a volume nudge from either action
 * respects an in-flight Voice Test / toggle acknowledgment the same way.
 */

// ─── Race Engineer master-gate in-flight bypass flags ────────────────────────

/**
 * One master-gate bypass: whether its line is playing, and the generation of
 * the claim that owns it (see {@link claimRaceEngineerBypass}).
 */
type Bypass = { inFlight: boolean; generation: number };

/**
 * The two bypasses {@link applyRaceEngineerAudio} honours.
 *
 * - `test` — the Race Engineer voice Test preview is playing. Tracked at
 *   module scope so the global-settings listener (which calls
 *   {@link applyRaceEngineerAudio} whenever any global changes) doesn't
 *   re-mute {@link AudioBus.Voice} mid-preview when Race Engineer is off —
 *   moving the volume slider during the test would otherwise cut it off.
 * - `toggle` — a Race Engineer toggle acknowledgment ("going silent" /
 *   "resuming") is playing. Same mechanic: {@link AudioBus.Voice} stays
 *   audible even though the master gate just flipped to off, so the ack clip
 *   plays through (issue #554).
 */
export type RaceEngineerBypass = "test" | "toggle";

const bypasses: Record<RaceEngineerBypass, Bypass> = {
  test: { inFlight: false, generation: 0 },
  toggle: { inFlight: false, generation: 0 },
};

/**
 * Raise a bypass for one line and return its release: the release clears the
 * flag and re-applies {@link applyRaceEngineerAudio}, but only while this claim
 * is still the flag's newest — a later claim, a direct set, or the release
 * having already run makes it a no-op (issue #1698).
 *
 * The release is the line's completion callback, and through the scenario
 * engine a completion can arrive late and out of order: a key-press line
 * plays with `whenBusy: "interrupt"`, so a second press cuts the first line
 * inside the new `playClips` call, after the new claim has raised the flag
 * and before the new line takes the bus. Without the generation, the first
 * line's release would clear the flag the second line just raised and
 * re-apply the gate under it — the Race Engineer toggled off, on and off
 * quickly would mute its own "going silent". With it, each line's release
 * clears only its own claim, and the newest line's completion is the one that
 * puts the bus back.
 *
 * One mechanism for both flags, since both hang on the same completion.
 */
export function claimRaceEngineerBypass(kind: RaceEngineerBypass): () => void {
  const bypass = bypasses[kind];
  const generation = ++bypass.generation;
  bypass.inFlight = true;

  return () => {
    if (bypass.generation !== generation) return;

    // Bumped so this release, called again, finds itself stale.
    bypass.generation++;
    bypass.inFlight = false;
    applyRaceEngineerAudio();
  };
}

/**
 * Set a bypass flag directly. Invalidates every outstanding claim on it, so
 * a release still pending from before can no longer touch the flag.
 */
function setBypass(kind: RaceEngineerBypass, value: boolean): void {
  bypasses[kind].generation++;
  bypasses[kind].inFlight = value;
}

/**
 * Set the Race Engineer Voice Test bypass flag directly, outside any claim —
 * {@link stopRaceEngineerPlayback} and tests. A line that plays uses
 * {@link claimRaceEngineerBypass}.
 */
export function setRaceEngineerTestInFlight(value: boolean): void {
  setBypass("test", value);
}

/**
 * Set the Race Engineer toggle-acknowledgment bypass flag directly, outside
 * any claim — {@link stopRaceEngineerPlayback} and tests. A line that plays
 * uses {@link claimRaceEngineerBypass}.
 */
export function setRaceEngineerToggleInFlight(value: boolean): void {
  setBypass("toggle", value);
}

// ─── Feature gates ───────────────────────────────────────────────────────────

/**
 * Whether the Race Engineer voice is enabled. Both feature gates default to
 * off — fresh installs and never-toggled setups stay quiet until the user
 * opts in. Only an explicit `true` (set when the user presses the toggle)
 * enables the feature. Key renamed from `raceEngineerEnabled` for issue #515.
 */
export function isRaceEngineerEnabled(): boolean {
  return getGlobalSettings().pitCrewRaceEngineerEnabled === true;
}

/** Whether the directional Radar ticks are enabled. Renamed from `radarEnabled` (issue #515). */
export function isRadarEnabled(): boolean {
  return getGlobalSettings().pitCrewRadarEnabled === true;
}

/**
 * The radio frame's two opt-outs (issue #1064), read live: Radio beeps and
 * Pit ambience. `@iracedeck/settings`' `frameOptionsFromSettings` is the ONE rule —
 * the same one the plugins' `getFrameOptions` hand the engine — so the
 * Background preview drops exactly what a real callout's frame drops.
 */
export function readFrameOptions(): FrameOptions {
  return frameOptionsFromSettings(getGlobalSettings());
}

// ─── Bus application ─────────────────────────────────────────────────────────

/**
 * Copy the current global `radarVolume` onto {@link AudioBus.Alerts}. Called on
 * every Pit Crew mount so the live audio bus matches persisted settings, and
 * whenever any action steps the radar volume.
 */
export function applyRadarVolume(): void {
  getAudio().setBusVolume(AudioBus.Alerts, readRadarVolume() / 100);
}

/**
 * Apply the Race Engineer master gate to the relevant audio buses:
 *   - {@link AudioBus.Voice} — engineer voice clips, acks, toggle confirmations.
 *   - {@link AudioBus.Background} — pit ambient loop and walkie-talkie SFX.
 *
 * When the gate is on, Voice tracks `raceEngineerVolume` and Background tracks
 * `backgroundVolume` (issue #471 — separate slider so users with audio-
 * processing sensitivities can dial the background under the voice without
 * losing it entirely). When the gate is off, both buses are silenced UNLESS a
 * slider Test preview or a toggle acknowledgment is currently playing — those
 * are explicit "I want to hear this regardless of the master gate" actions.
 * {@link AudioBus.Alerts} (radar) is intentionally untouched — it has its own
 * toggle.
 */
export function applyRaceEngineerAudio(): void {
  const enabled = isRaceEngineerEnabled();
  const voice = readRaceEngineerVolume() / 100;
  const background = readBackgroundVolume() / 100;

  const voiceUnmuted = enabled || bypasses.test.inFlight || bypasses.toggle.inFlight;
  const backgroundUnmuted = enabled || isBackgroundTestInFlight();

  getAudio().setBusVolume(AudioBus.Voice, voiceUnmuted ? voice : 0);
  getAudio().setBusVolume(AudioBus.Background, backgroundUnmuted ? background : 0);
}

// ─── Volume stepping ─────────────────────────────────────────────────────────

function clampVolume(value: number): number {
  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, value));
}

/**
 * The volume step tick for a level that moved from `current` to `next`
 * (#1455): one tick per step actually applied, each at the level that step
 * reached, so the last is at `next`. Rounded up,
 * so a level the Settings window left off the 5-grid (52 → 57, 98 → 100)
 * still counts the step it took. The callers return before this when the
 * level did not move, so a press at 0 or 100 is silent: twenty ticks down
 * from 100 and then nothing means 0.
 *
 * Here rather than in the surfaces, so every one of them — the Audio Controls
 * keys and their hold-repeat, the dial, the Pit Crew key's Radar Volume mode,
 * and any added later — ticks exactly once per step without remembering to.
 * Not gated by the Race Engineer or radar switch: the tick is deck feedback.
 */
function tickAppliedSteps(current: number, next: number): void {
  const sign = next > current ? 1 : -1;
  const count = Math.ceil(Math.abs(next - current) / VOLUME_STEP);

  // A multi-detent dial event ticks each step at the level it passed through,
  // so a fast spin still rises or falls in loudness step by step.
  for (let i = 1; i <= count; i++) {
    playVolumeTick(sign > 0 ? "up" : "down", i === count ? next : current + sign * i * VOLUME_STEP);
  }
}

/**
 * Step the global `radarVolume` by `steps × VOLUME_STEP` (signed — a dial may
 * deliver several detents per event), persist it, and apply it to
 * {@link AudioBus.Alerts}, then tick each applied step (#1455). A no-op (no
 * persist, no bus write, no tick) when already clamped at the boundary.
 * Returns the resulting volume.
 */
export function stepRadarVolumeBy(steps: number): number {
  const current = readRadarVolume();
  const next = clampVolume(current + steps * VOLUME_STEP);

  if (next === current) return current;

  updateGlobalSettings({ radarVolume: next });
  applyRadarVolume();
  tickAppliedSteps(current, next);

  return next;
}

/** Single-step convenience over {@link stepRadarVolumeBy}. */
export function stepRadarVolume(direction: "up" | "down"): number {
  return stepRadarVolumeBy(direction === "up" ? 1 : -1);
}

/**
 * Step the global `raceEngineerVolume` by `steps × VOLUME_STEP` (signed),
 * persist it, and re-apply the Race Engineer audio gate. While Race Engineer
 * is disabled the value still updates but Voice stays muted (the gate is
 * respected) — and the step still ticks, at the value it stored (#1455). A
 * no-op (no tick either) when already clamped at the boundary. Returns the
 * resulting volume.
 */
export function stepRaceEngineerVolumeBy(steps: number): number {
  const current = readRaceEngineerVolume();
  const next = clampVolume(current + steps * VOLUME_STEP);

  if (next === current) return current;

  updateGlobalSettings({ raceEngineerVolume: next });
  applyRaceEngineerAudio();
  tickAppliedSteps(current, next);

  return next;
}

/**
 * Silence the Race Engineer completely and leave the audio state consistent
 * (issue #1100).
 *
 * The voice-pack installer calls this before a swap or a removal, because a
 * callout holding one of the pack's clips open makes the directory rename fail
 * on Windows. It lives here rather than in the three plugins because stopping
 * playback is three coupled facts about audio state, and a plugin repeating
 * them is three chances to learn only two.
 *
 * The third is the one that is easy to miss: the voice Test's bypass flag. With
 * the scenario engine up the Test plays through it (issue #1698), and the
 * `stopAll` inside `stopRaceEngineerScenarios` settles its clip fire, which runs
 * its release. With the engine not initialised it plays straight onto the
 * Voice channel, and `stopChannel` drops the one-shot completion callback that
 * sequence installed, so a preview interrupted here would never run its own
 * cleanup and the `test` bypass would stay raised — a stuck bypass holding
 * {@link AudioBus.Voice} unmuted while the master gate says off. Clearing the
 * flag regardless, and re-applying, puts the bus back where the gate says it
 * belongs; the direct set also invalidates any release still outstanding, so
 * nothing from before the stop can touch the flag after it.
 */
export function stopRaceEngineerPlayback(): void {
  try {
    stopRaceEngineerScenarios();
    getAudio().stopChannel(AudioChannel.Voice);
  } finally {
    // In a `finally` because the clearing is what makes the stop SAFE, and a
    // throw above would otherwise leave a bypass flag stuck true forever while
    // the caller's own error handling swallowed the exception.
    //
    // BOTH flags, not just the Test one. `playToggleAck` raises the `toggle`
    // bypass and hangs its release on the same completion as the Test — the
    // clip fire's settle with the engine up, the voice-sequence chain that
    // `stopChannel` severs without it — so interrupting a master-toggle
    // acknowledgement strands it by the identical mechanism the comment above
    // describes for its twin. The first version of this function cleared one
    // and missed the other, which is the whole reason a single function exists
    // instead of three call sites.
    setRaceEngineerTestInFlight(false);
    setRaceEngineerToggleInFlight(false);
    applyRaceEngineerAudio();
  }
}
