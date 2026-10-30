/**
 * The press sound player (#269): the clips and the channel behind deck-core's
 * press sound wrapper.
 *
 * deck-core's `withPressSounds` decides WHEN a press plays which sound and
 * reads the mode and the sim connection itself; it plays through the delegate
 * `initPressSounds` installs, and `plugin-runtime`'s `registerActions`
 * installs {@link playPressSound}. This module only says what a sound is and
 * where it plays, so it reads neither the mode nor the connection: the
 * settings window's Test buttons call it directly, so the driver can hear both
 * sounds before choosing one.
 *
 * Deck feedback, like the volume step tick (#1455) it sits beside: it plays on
 * {@link AudioChannel.Feedback}, the mixer channel that belongs to no bus, at
 * the tick's level rule — Radar Volume, never below the tick's floor. A press
 * sound and a tick share the channel, so one replaces the other; they never
 * meet on one press (every volume step declares no press sound), only when a key is
 * pressed while another surface's tick train runs, where losing one short
 * bleep is acceptable. A press sound does not queue behind the tick's spacing,
 * which would delay a bleep by up to 70 ms behind a spin on another dial.
 *
 * Spec: docs/superpowers/specs/2026-10-28-issue-269-press-sounds.md
 */
import { AudioChannel, getAudio } from "@iracedeck/audio-service";
import type { PressSound } from "@iracedeck/deck-core";

import { readRadarVolume } from "./audio-levels.js";
import { volumeTickLevel } from "./volume-tick.js";

/**
 * The clip per sound, relative to the plugin's audio root: `tap` is the single
 * bleep, one short note, and `long` the double bleep at the long-press
 * threshold, two of the same note.
 *
 * Both were generated for this feature (rendered from a description in the
 * spec, then picked by ear), so they carry no third-party licence and have no
 * `THIRD-PARTY-LICENSES.md` entry. WAV, not MP3: an MP3 frame's encoder delay
 * and padding are about as long as a bleep's note, which would make it late.
 * `sfx/` is copied into the plugins unchanged.
 */
export const PRESS_SOUND_CLIPS: Readonly<Record<PressSound, string>> = {
  tap: "sfx/IRD-press-tap.wav",
  long: "sfx/IRD-press-long.wav",
};

/**
 * Play one press sound on the Feedback channel at the Radar Volume level,
 * floored like the volume tick, so a low radar level does not lose the sound.
 * Never throws: it runs on the press's own synchronous path and inside the
 * wrapper's threshold timer.
 */
export function playPressSound(sound: PressSound): void {
  try {
    getAudio().playOnChannelAtLevel(
      AudioChannel.Feedback,
      PRESS_SOUND_CLIPS[sound],
      volumeTickLevel(readRadarVolume()) / 100,
    );
  } catch {
    // A press sound must never break the press it reports on. The one throw
    // here is an audio service that is not initialized yet; a failed play
    // itself returns false and is logged by the service.
  }
}
