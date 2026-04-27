/**
 * PI Test-button helper for the Background Volume slider (issue #471).
 *
 * Plays a representative `AudioBus.Background` preview so the user can
 * audition their slider value: walkie-talkie tick-open on `AudioChannel.SFX`,
 * pit ambient loop on `AudioChannel.Ambient`, then tick-close after a short
 * window. Mirrors the radio-frame open/close pair that wraps every real
 * pit-crew voice scenario, so the user hears exactly what the bus carries
 * during normal operation (sans voice).
 *
 * Idempotent against double-press — a second call while a sequence is in
 * flight is a no-op. The optional `onComplete` callback fires after the
 * close-tick is dispatched, letting the caller restore bus volumes that
 * were temporarily forced for the preview (e.g. when the Race Engineer
 * master gate would otherwise hold Background at 0).
 */
import { AudioChannel, getAudio } from "@iracedeck/audio-service";

const TICK_OPEN = "sfx/IRD-tick-open.mp3";
const TICK_CLOSE = "sfx/IRD-tick-close.mp3";
const AMBIENT_LOOP = "sfx/IRD-ambient-pit.mp3";

/** How long the ambient loop plays between the open and close ticks. */
const TEST_DURATION_MS = 2500;

let testInFlight = false;

export function playBackgroundTest(onComplete?: () => void): void {
  if (testInFlight) return;

  testInFlight = true;

  const audio = getAudio();

  audio.playOnChannel(AudioChannel.SFX, TICK_OPEN);
  audio.playOnChannel(AudioChannel.Ambient, AMBIENT_LOOP, true);

  setTimeout(() => {
    audio.stopChannel(AudioChannel.Ambient);
    audio.playOnChannel(AudioChannel.SFX, TICK_CLOSE);
    testInFlight = false;
    onComplete?.();
  }, TEST_DURATION_MS);
}

/** Reset internal state. @internal — for tests. */
export function _resetBackgroundTest(): void {
  testInFlight = false;
}
