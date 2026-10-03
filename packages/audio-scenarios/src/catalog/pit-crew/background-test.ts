/**
 * PI Test-button helper for the Background Volume slider (issue #471).
 *
 * Plays a representative `AudioBus.Background` preview so the user can
 * audition their slider value: what a real callout would play in the
 * selected voice, minus the speech. Since #1124 that is the active voice's
 * own radio frame, asked of the engine (`playFramePreview`), which expands
 * it exactly as it does around a callout — the user's Radio beeps and Pit
 * ambience switches, frame clips on `AudioChannel.SFX`, the ambient bed on
 * `AudioChannel.Ambient` — around a short silence.
 *
 * When the engine has no frame to offer — it is not initialised, no voice is
 * selected, or the voice has no script or a frame that failed to compile —
 * the preview falls back to the built-in frame: walkie-talkie tick-open, pit
 * ambient loop, tick-close after a short window, under the same two
 * switches. The caller is told which one played, so it can say so.
 *
 * The voice-frame preview yields to the Race Engineer: a press while he
 * holds the radio plays nothing (`"busy"`) — neither the frame, which would
 * cut him, nor the fallback, which would play over him — and a callout
 * arriving mid-preview cuts it.
 *
 * Idempotent against double-press — a second call while a sequence is in
 * flight is a no-op. The optional `onComplete` callback fires once the
 * preview is over (finished, or cut by a callout or by `stopAll`), letting
 * the caller restore bus volumes that were temporarily forced for the
 * preview (e.g. when the Race Engineer master gate would otherwise hold
 * Background at 0).
 */
import { AudioChannel, getAudio } from "@iracedeck/audio-service";

import { DEFAULT_FRAME } from "../../dsl.js";
import {
  type FrameOptions,
  type FramePreviewResult,
  getScenarioEngine,
  isAudioScenariosInitialized,
} from "../../interpreter.js";

const TICK_OPEN = "sfx/IRD-tick-open.mp3";
const TICK_CLOSE = "sfx/IRD-tick-close.mp3";
const AMBIENT_LOOP = "sfx/IRD-ambient-pit.mp3";

/** How long the frame holds open — the silence where a callout's speech would be. */
const TEST_DURATION_MS = 2500;

/** Both switches on: what the preview played before the switches existed. */
const EVERYTHING: FrameOptions = { beeps: true, ambience: true };

/**
 * What a press did: played the active voice's frame, played the built-in
 * fallback, nothing because the engineer holds the radio, or nothing because
 * a preview was already in flight.
 */
export type BackgroundTestOutcome = "voice-frame" | "built-in" | "busy" | "in-flight";

let testInFlight = false;
let testTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * @param options The user's frame switches (`getFrameOptions` in the
 *   plugins), for the built-in fallback: `beeps` keeps the ticks, `ambience`
 *   keeps the loop. The engine reads the same switches itself for the
 *   voice's frame. Defaults to both on.
 */
export function playBackgroundTest(onComplete?: () => void, options: FrameOptions = EVERYTHING): BackgroundTestOutcome {
  if (testInFlight) return "in-flight";

  // Set before the engine is asked: with both switches off it completes
  // synchronously, inside the call.
  testInFlight = true;

  const finish = (): void => {
    testInFlight = false;
    onComplete?.();
  };

  let result: FramePreviewResult = "no-frame";

  try {
    if (isAudioScenariosInitialized())
      result = getScenarioEngine().playFramePreview(DEFAULT_FRAME, TEST_DURATION_MS, finish);
  } catch (err) {
    // The flag is what holds the Background bus open past the master gate;
    // a throw must not leave it set for the rest of the session.
    testInFlight = false;
    throw err;
  }

  if (result === "playing") return "voice-frame";

  if (result === "bus-busy") {
    // The engineer is on the radio: the preview yields rather than cut him
    // off, and the built-in clips would play over him.
    finish();

    return "busy";
  }

  playBuiltInFrame(finish, options);

  return "built-in";
}

/** The fallback: the plugin's own three clips, under the user's two switches. */
function playBuiltInFrame(finish: () => void, { beeps, ambience }: FrameOptions): void {
  // Nothing to audition: don't hold the in-flight flag (and the Background
  // bus bypass with it) for a silent window.
  if (!beeps && !ambience) {
    finish();

    return;
  }

  const audio = getAudio();

  if (beeps) audio.playOnChannel(AudioChannel.SFX, TICK_OPEN);

  if (ambience) audio.playOnChannel(AudioChannel.Ambient, AMBIENT_LOOP, true);

  testTimer = setTimeout(() => {
    testTimer = null;

    if (ambience) audio.stopChannel(AudioChannel.Ambient);

    if (beeps) audio.playOnChannel(AudioChannel.SFX, TICK_CLOSE);

    finish();
  }, TEST_DURATION_MS);
}

/**
 * Whether a Background test preview is currently playing. The Pit Crew
 * action checks this before letting the Race Engineer master gate mute
 * `AudioBus.Background` — without the bypass, sliding the Background
 * Volume slider mid-preview would push the bus back to 0 (RE off case)
 * and cut the preview off mid-tick.
 */
export function isBackgroundTestInFlight(): boolean {
  return testInFlight;
}

/** Reset internal state. @internal — for tests. */
export function _resetBackgroundTest(): void {
  if (testTimer !== null) {
    clearTimeout(testTimer);
    testTimer = null;
  }

  testInFlight = false;
}
