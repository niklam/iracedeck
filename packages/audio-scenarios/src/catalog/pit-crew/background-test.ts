/**
 * PI Test-button helper for the Background Volume slider (issue #471).
 *
 * Plays a representative `AudioBus.Background` preview so the user can
 * audition their slider value: walkie-talkie tick-open on `AudioChannel.SFX`,
 * pit ambient loop on `AudioChannel.Ambient`, then tick-close after a short
 * window. Mirrors the `radio` frame the engine wraps every real pit-crew
 * voice scenario in (issue #1064), so the user hears exactly what the bus
 * carries during normal operation (sans voice) — including the user's two
 * frame switches: with Radio beeps off the ticks are dropped, with Pit
 * ambience off the loop is, and with both off there is nothing to preview,
 * so the sequence completes on the spot.
 *
 * Idempotent against double-press — a second call while a sequence is in
 * flight is a no-op. The optional `onComplete` callback fires after the
 * close-tick is dispatched, letting the caller restore bus volumes that
 * were temporarily forced for the preview (e.g. when the Race Engineer
 * master gate would otherwise hold Background at 0).
 */
import { AudioChannel, getAudio } from "@iracedeck/audio-service";

import type { FrameOptions } from "../../interpreter.js";

const TICK_OPEN = "sfx/IRD-tick-open.mp3";
const TICK_CLOSE = "sfx/IRD-tick-close.mp3";
const AMBIENT_LOOP = "sfx/IRD-ambient-pit.mp3";

/** How long the ambient loop plays between the open and close ticks. */
const TEST_DURATION_MS = 2500;

/** Both switches on: what the preview played before the switches existed. */
const EVERYTHING: FrameOptions = { beeps: true, ambience: true };

let testInFlight = false;
let testTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * @param options The user's frame switches (`getFrameOptions` in the
 *   plugins): `beeps` keeps the ticks, `ambience` keeps the loop — the same
 *   two things the engine drops from the real frame. Defaults to both on.
 */
export function playBackgroundTest(onComplete?: () => void, options: FrameOptions = EVERYTHING): void {
  if (testInFlight) return;

  const { beeps, ambience } = options;

  // Nothing to audition: don't hold the in-flight flag (and the Background
  // bus bypass with it) for a silent window.
  if (!beeps && !ambience) {
    onComplete?.();

    return;
  }

  testInFlight = true;

  const audio = getAudio();

  if (beeps) audio.playOnChannel(AudioChannel.SFX, TICK_OPEN);

  if (ambience) audio.playOnChannel(AudioChannel.Ambient, AMBIENT_LOOP, true);

  testTimer = setTimeout(() => {
    if (ambience) audio.stopChannel(AudioChannel.Ambient);

    if (beeps) audio.playOnChannel(AudioChannel.SFX, TICK_CLOSE);

    testInFlight = false;
    testTimer = null;
    onComplete?.();
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
