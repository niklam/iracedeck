/**
 * Race Engineer voice plumbing: the sequence player, its JSON-list reader, the
 * toggle acknowledgment, and the corner-name callout opt-in.
 *
 * Extracted from Pit Crew for issue #782 so the Audio Controls dial's
 * Mute/Unmute and the Pit Crew toggle keys share one pathway (the same move
 * #590 made for the volume steppers). The master gates themselves moved on to
 * `feature-gates.ts` (issue #1007), which owns the side effects of a gate
 * change so a settings-window checkbox behaves exactly like a deck key; this
 * module keeps the voice plumbing those acknowledgments ride on. Pit Crew
 * re-exports {@link playVoiceSequence} for its own preview/radio-check paths
 * and test back-compat.
 */
import { AudioBus, AudioChannel, getAudio } from "@iracedeck/audio-service";
import { getGlobalSettings, resolveActiveRaceEngineerVoice, updateGlobalSettings } from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";

import {
  applyRaceEngineerAudio,
  isRaceEngineerEnabled,
  readRaceEngineerVolume,
  setRaceEngineerToggleInFlight,
} from "./audio-volume.js";

/**
 * Read the per-callout opt-in for the Race Engineer toggle acknowledgment
 * (issue #554). Defaults to enabled — only an explicit `false` opts out, so
 * a fresh install (no persisted setting) and existing users get the ack
 * without editing settings. Read live on every toggle so the PI checkbox
 * takes effect immediately without re-registering anything.
 */
export function isToggleAckEnabled(): boolean {
  return (getGlobalSettings() as Record<string, unknown>).calloutEnabledToggleRaceEngineer !== false;
}

/**
 * Read a JSON-array global-settings value (used for the runtime-pushed
 * voice + driver-name lists). Returns an empty array if missing or
 * malformed — callers treat that as "list not available yet" and skip
 * the dependent path rather than throw.
 */
export function readJsonStringArray(key: string): string[] {
  const raw = (getGlobalSettings() as Record<string, unknown>)[key];

  if (typeof raw !== "string" || raw.length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * Chain-play a sequence of clip paths on `AudioChannel.Voice`. Registers
 * the next-step `onChannelComplete` before each `playOnChannel` so the
 * sequence keeps stepping naturally as each clip ends. A failed
 * `playOnChannel` (e.g. clip missing — likely until the user has run
 * `pnpm --filter @iracedeck/audio-assets generate`) silently breaks the
 * chain at that step rather than throwing; the user just hears the
 * earlier clips.
 */
/** @internal Exported for testing the chain-completion + failure paths. */
export function playVoiceSequence(paths: readonly string[], onComplete?: () => void): boolean {
  if (paths.length === 0) return false;

  let idx = 0;
  let finished = false;

  // Idempotent terminal — guards against `onComplete` firing twice (once via
  // the failure path below and again if a stale `playStep` registration is
  // re-entered by a later, unrelated Voice completion).
  const finish = (): void => {
    if (finished) return;

    finished = true;
    onComplete?.();
  };

  const playStep = (): void => {
    // A previous step may have already finished (e.g. mid-chain playback
    // failure). The completion callback registered before that failure is
    // still live in `audio-service`; if any later Voice clip plays through
    // the engine, it will re-fire `playStep`. Bail out so we don't try to
    // resume an abandoned sequence.
    if (finished) return;

    if (idx >= paths.length) {
      finish();

      return;
    }

    const path = paths[idx++];

    // Always register the next-step callback — when `idx` has reached the
    // end on the next invocation, `playStep` will fire `onComplete`. Without
    // this on the last clip, the chain ends silently and callers can't tell
    // the preview is over (used by the RE Volume Test in-flight tracking).
    getAudio().onChannelComplete(AudioChannel.Voice, playStep);

    const ok = getAudio().playOnChannel(AudioChannel.Voice, path);

    // If the clip failed to start (e.g. file missing — likely until the
    // user has run `pnpm --filter @iracedeck/audio-assets generate`), the
    // native layer never fires the channel-complete callback, so the chain
    // would otherwise hang forever and `onComplete` would never run. Fire
    // it synchronously so callers (and any in-flight flag they're tracking)
    // can clean up.
    if (!ok) {
      finish();
    }
  };

  playStep();

  return true;
}

/**
 * Play a toggle acknowledgment clip (`going-silent-01` /
 * `resuming-01`) on `AudioChannel.Voice`. Sets
 * `raceEngineerToggleInFlight` so `applyRaceEngineerAudio` keeps Voice
 * audible regardless of the master gate, forces the Voice bus to the
 * current `raceEngineerVolume`, and clears the flag + re-applies audio
 * when the clip finishes (or fails to start — `playVoiceSequence` fires
 * `onComplete` synchronously on a missing-clip failure so the flag
 * never gets stuck).
 *
 * Skipped silently when no voice is available (fresh install before
 * the voice list has been pushed); the toggle itself still applies so
 * the user's gate state can never desync from the audio state.
 */
export function playToggleAck(clipName: "going-silent-01" | "resuming-01", logger: ILogger): void {
  const voice = resolveActiveRaceEngineerVoice(readJsonStringArray("_raceEngineerVoices"));

  if (!voice) {
    logger.debug(`Toggle ack ${clipName} skipped — no voice available`);

    return;
  }

  setRaceEngineerToggleInFlight(true);
  // Force Voice to the slider value so the ack is audible regardless of
  // the master gate. Mirrors how the Voice Test bypasses the gate.
  getAudio().setBusVolume(AudioBus.Voice, readRaceEngineerVolume() / 100);

  playVoiceSequence([`voice/${voice}/toggle/${clipName}.mp3`], () => {
    setRaceEngineerToggleInFlight(false);
    applyRaceEngineerAudio();
  });
}

/**
 * Whether the corner-name callouts (issue #888) are enabled. Reads the SAME
 * per-callout opt-in the PI checkbox writes (`calloutEnabledCornerNames`), so
 * the Pit Crew Corner Names key and the checkbox mirror one value. Defaults
 * to enabled — only an explicit `false` opts out (the callout family's
 * natural baseline).
 */
export function isCornerNamesEnabled(): boolean {
  return (getGlobalSettings() as Record<string, unknown>).calloutEnabledCornerNames !== false;
}

/**
 * Per-callout opt-in for the Corner Names toggle acknowledgment (issue #897).
 * Same defaults-to-enabled live-read shape as {@link isToggleAckEnabled}.
 */
export function isCornerNamesToggleAckEnabled(): boolean {
  return (getGlobalSettings() as Record<string, unknown>).calloutEnabledToggleCornerNames !== false;
}

/**
 * Flip the corner-name callout opt-in (issue #897) — the pathway behind the
 * Pit Crew Corner Names toggle key. Returns the NEW state.
 *
 * The corner-name scenario reads the opt-in live on every event arrival, so
 * persisting the flip is the whole toggle — nothing to stop or re-register,
 * and an in-flight clip plays through (the #554 opt-in semantics).
 *
 * The acknowledgment plays only when the Race Engineer master gate is on:
 * unlike the master toggle this flip never mutes the Voice bus, so no
 * in-flight bypass or bus-volume force is needed — with the master on, Voice
 * is already at the slider value. Master off means a silent flip (the
 * engineer is off the air). Skipped silently when no voice is available.
 */
export function toggleCornerNamesFeature(logger: ILogger): boolean {
  const next = !isCornerNamesEnabled();
  logger.info(`Corner name callouts ${next ? "enabled" : "disabled"}`);

  updateGlobalSettings({ calloutEnabledCornerNames: next });

  if (isRaceEngineerEnabled() && isCornerNamesToggleAckEnabled()) {
    const voice = resolveActiveRaceEngineerVoice(readJsonStringArray("_raceEngineerVoices"));

    if (voice) {
      playVoiceSequence([`voice/${voice}/toggle/corner-names-${next ? "on" : "off"}-01.mp3`]);
    } else {
      logger.debug("Corner names toggle ack skipped — no voice available");
    }
  }

  return next;
}
