/**
 * Race Engineer voice preview (moved out of the Pit Crew action in #992 so
 * the settings window's Test button can reach it too).
 *
 * Play the engineer-voice preview sequence on `AudioChannel.Voice`:
 *
 *   <driver name>? <combined greeting clip>
 *
 * Lets the user audition the active voice + radio filter + current bus
 * volume. Skips the driver-name clip when no name is available (e.g. fresh
 * install before names are pushed). `greeting-01` needs TTS generation —
 * `pnpm --filter @iracedeck/audio-assets generate` produces it per voice.
 * Until then `playVoiceSequence` silently stops at the missing step.
 *
 * Returns false only when no voice is available — callers log a warning.
 */
import { resolveActiveDriverName, resolveActiveRaceEngineerVoice } from "@iracedeck/deck-core";

import { playVoiceSequence, readJsonStringArray } from "./audio-toggles.js";

export function playRaceEngineerVoiceTest(onComplete?: () => void): boolean {
  const voice = resolveActiveRaceEngineerVoice(readJsonStringArray("_raceEngineerVoices"));

  if (!voice) return false;

  const driverName = resolveActiveDriverName(readJsonStringArray("_driverNames"), "driver");

  const paths = [
    ...(driverName ? [`voice/${voice}/names/${driverName}.mp3`] : []),
    `voice/${voice}/welcome/greeting-01.mp3`,
  ];

  return playVoiceSequence(paths, onComplete);
}
