/**
 * Race Engineer voice preview (moved out of the Pit Crew action in #992 so
 * the settings window's Test button can reach it too).
 *
 * Play the engineer-voice preview sequence on the Voice bus:
 *
 *   <driver name>? <combined greeting clip>
 *
 * Lets the user audition the active voice + radio filter + current bus
 * volume. Skips the driver-name clip when no name is available (e.g. fresh
 * install before names are pushed). `greeting-01` needs TTS generation —
 * `pnpm --filter @iracedeck/audio-assets generate` produces it per voice.
 * Until then the sequence silently stops at the missing step.
 *
 * It plays through `playVoiceLine` (issue #1698): with the scenario engine up
 * it is a clip fire under {@link VOICE_TEST_FIRE_ID}, arbitrated with the
 * callouts — Test pressed while the engineer speaks cuts a callout that is not
 * heavier than NORMAL (which comes back after it) and a Test still playing,
 * and yields to a heavier call; with the engine not initialised it plays
 * straight onto the Voice channel, as before.
 *
 * The name clip comes from `driverNameClipPath`, so a voice pack that records
 * names only as takes (`names/<name>-01.mp3`) is heard here too (#1173).
 */
import type { PlayClipsResult, PlayClipsWhenBusy } from "@iracedeck/audio-scenarios";
import { driverNameClipPath } from "@iracedeck/audio-scenarios/pit-crew";
import { resolveActiveDriverName, resolveActiveRaceEngineerVoice } from "@iracedeck/settings";

import { playVoiceLine, readJsonStringArray } from "./audio-toggles.js";

/** The fire id the Test plays under: a namespace no contract uses. */
export const VOICE_TEST_FIRE_ID = "preview.voice-test";

/**
 * What the Test does on a Voice bus that is not free (issue #1698): the user
 * pressed the button, so it cuts in. The one place to change it, should the
 * Test rather wait for a quiet radio (`"skip"`).
 */
const VOICE_TEST_WHEN_BUSY: PlayClipsWhenBusy = "interrupt";

/**
 * What the Test did: started (`"playing"`), found a heavier call holding the
 * radio and played nothing (`"bus-busy"`), or found no voice to play
 * (`"no-voice"`).
 */
export type VoiceTestResult = PlayClipsResult | "no-voice";

/**
 * Play the voice preview. `onComplete` runs once when it is over, however it
 * ends, and never on `"bus-busy"` or `"no-voice"`, where nothing started — the
 * caller clears its in-flight flag on those answers itself.
 */
export function playRaceEngineerVoiceTest(onComplete?: () => void): VoiceTestResult {
  const voice = resolveActiveRaceEngineerVoice(readJsonStringArray("_raceEngineerVoices"));

  if (!voice) return "no-voice";

  const driverName = resolveActiveDriverName(readJsonStringArray("_driverNames"), "driver");

  const paths = [
    ...(driverName ? [driverNameClipPath(voice, driverName)] : []),
    `voice/${voice}/welcome/greeting-01.mp3`,
  ];

  return playVoiceLine(VOICE_TEST_FIRE_ID, paths, {
    whenBusy: VOICE_TEST_WHEN_BUSY,
    ...(onComplete ? { onComplete } : {}),
  });
}
