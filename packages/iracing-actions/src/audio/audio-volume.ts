import type { FrameOptions } from "@iracedeck/audio-scenarios";
import { isBackgroundTestInFlight, stopRaceEngineerScenarios } from "@iracedeck/audio-scenarios/pit-crew";
import { AudioBus, AudioChannel, getAudio } from "@iracedeck/audio-service";
import { frameOptionsFromSettings, getGlobalSettings, updateGlobalSettings } from "@iracedeck/deck-core";

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

/** Volume step per key press, in 0–100 units. */
export const VOLUME_STEP = 5;
/** Lowest persisted volume (silent). */
export const VOLUME_MIN = 0;
/** Highest persisted volume (full). */
export const VOLUME_MAX = 100;

// ─── Race Engineer master-gate in-flight bypass flags ────────────────────────

/**
 * Whether the Race Engineer voice Test preview is currently playing. Tracked
 * at module scope so the global-settings listener (which calls
 * {@link applyRaceEngineerAudio} whenever any global changes) doesn't re-mute
 * {@link AudioBus.Voice} mid-preview when Race Engineer is off — moving the
 * volume slider during the test would otherwise cut it off.
 */
let raceEngineerTestInFlight = false;

/**
 * Whether a Race Engineer toggle acknowledgment ("going silent" / "resuming")
 * is currently playing. Same bypass mechanic as {@link raceEngineerTestInFlight}:
 * when true, {@link applyRaceEngineerAudio} leaves {@link AudioBus.Voice}
 * audible even though the master gate just flipped to off, so the ack clip
 * plays through. See issue #554.
 */
let raceEngineerToggleInFlight = false;

/** Set the Race Engineer Voice Test bypass flag. */
export function setRaceEngineerTestInFlight(value: boolean): void {
  raceEngineerTestInFlight = value;
}

/** Set the Race Engineer toggle-acknowledgment bypass flag. */
export function setRaceEngineerToggleInFlight(value: boolean): void {
  raceEngineerToggleInFlight = value;
}

// ─── Feature gates ───────────────────────────────────────────────────────────

/**
 * Whether the Race Engineer voice is enabled. Both feature gates default to
 * off — fresh installs and never-toggled setups stay quiet until the user
 * opts in. Only an explicit `true` (set when the user presses the toggle)
 * enables the feature. Key renamed from `raceEngineerEnabled` for issue #515.
 */
export function isRaceEngineerEnabled(): boolean {
  return (getGlobalSettings() as Record<string, unknown>).pitCrewRaceEngineerEnabled === true;
}

/** Whether the directional Radar ticks are enabled. Renamed from `radarEnabled` (issue #515). */
export function isRadarEnabled(): boolean {
  return (getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled === true;
}

/**
 * The radio frame's two opt-outs (issue #1064), read live: Radio beeps and
 * Pit ambience. Deck-core's `frameOptionsFromSettings` is the ONE rule —
 * the same one the plugins' `getFrameOptions` hand the engine — so the
 * Background preview drops exactly what a real callout's frame drops.
 */
export function readFrameOptions(): FrameOptions {
  return frameOptionsFromSettings(getGlobalSettings());
}

// ─── Volume readers ──────────────────────────────────────────────────────────

/**
 * Read a 0–100 volume global. Defaults to {@link VOLUME_MAX} when missing or
 * unparseable so a very early startup (cache not yet hydrated) plays at full
 * volume rather than silently; rounds and clamps to the valid range.
 */
function readVolume(key: string): number {
  const raw = (getGlobalSettings() as Record<string, unknown>)[key];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : VOLUME_MAX;

  if (!Number.isFinite(n)) return VOLUME_MAX;

  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, Math.round(n)));
}

/** Current Radar tick volume (0–100). */
export function readRadarVolume(): number {
  return readVolume("radarVolume");
}

/** Current Race Engineer voice volume (0–100). */
export function readRaceEngineerVolume(): number {
  return readVolume("raceEngineerVolume");
}

/** Current pit ambience / walkie-talkie SFX volume (0–100). */
export function readBackgroundVolume(): number {
  return readVolume("backgroundVolume");
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

  const voiceUnmuted = enabled || raceEngineerTestInFlight || raceEngineerToggleInFlight;
  const backgroundUnmuted = enabled || isBackgroundTestInFlight();

  getAudio().setBusVolume(AudioBus.Voice, voiceUnmuted ? voice : 0);
  getAudio().setBusVolume(AudioBus.Background, backgroundUnmuted ? background : 0);
}

// ─── Volume stepping ─────────────────────────────────────────────────────────

function clampVolume(value: number): number {
  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, value));
}

/**
 * Step the global `radarVolume` by `steps × VOLUME_STEP` (signed — a dial may
 * deliver several detents per event), persist it, and apply it to
 * {@link AudioBus.Alerts}. A no-op (no persist, no bus write) when already
 * clamped at the boundary. Returns the resulting volume.
 */
export function stepRadarVolumeBy(steps: number): number {
  const current = readRadarVolume();
  const next = clampVolume(current + steps * VOLUME_STEP);

  if (next === current) return current;

  updateGlobalSettings({ radarVolume: next });
  applyRadarVolume();

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
 * respected). A no-op when already clamped at the boundary. Returns the
 * resulting volume.
 */
export function stepRaceEngineerVolumeBy(steps: number): number {
  const current = readRaceEngineerVolume();
  const next = clampVolume(current + steps * VOLUME_STEP);

  if (next === current) return current;

  updateGlobalSettings({ raceEngineerVolume: next });
  applyRaceEngineerAudio();

  return next;
}

/** Single-step convenience over {@link stepRaceEngineerVolumeBy}. */
export function stepRaceEngineerVolume(direction: "up" | "down"): number {
  return stepRaceEngineerVolumeBy(direction === "up" ? 1 : -1);
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
 * The third is the one that is easy to miss. `stopChannel` drops the one-shot
 * completion callback a voice Test installs, so a preview interrupted here
 * would never run its own cleanup and `raceEngineerTestInFlight` would stay
 * true — a stuck bypass holding {@link AudioBus.Voice} unmuted while the master
 * gate says off. Nothing is audible in that state today, since callouts are
 * gated before they reach the bus; it is a trap waiting for the first Voice
 * path that is not. Clearing the flag and re-applying puts the bus back where
 * the gate says it belongs.
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
    // BOTH flags, not just the Test one. `playToggleAck` sets
    // `raceEngineerToggleInFlight` and relies on the same voice-sequence
    // completion chain that `stopChannel` severs — the scenario engine never
    // touches it — so interrupting a master-toggle acknowledgement strands it
    // by the identical mechanism the comment above describes for its twin. The
    // first version of this function cleared one and missed the other, which is
    // the whole reason a single function exists instead of three call sites.
    setRaceEngineerTestInFlight(false);
    setRaceEngineerToggleInFlight(false);
    applyRaceEngineerAudio();
  }
}
