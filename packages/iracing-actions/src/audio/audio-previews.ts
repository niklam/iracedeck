/**
 * Audio preview runner (issue #992).
 *
 * The three "Test" buttons — radar sweep, engineer voice, background bed —
 * used to be edge-triggered inside the Pit Crew action's onDidReceiveSettings
 * (a hidden per-action field bumped to Date.now()). The settings window has
 * no action context, so the sequences live here, callable from BOTH the
 * action (same trigger as before) and the window's `audioPreview` command.
 * One place owns the bus-forcing and in-flight bookkeeping.
 */
import { playBackgroundTest, playRadarTest } from "@iracedeck/audio-scenarios/pit-crew";
import { AudioBus, getAudio } from "@iracedeck/audio-service";
import type { ILogger } from "@iracedeck/logger";

import {
  applyRaceEngineerAudio,
  readBackgroundVolume,
  readFrameOptions,
  readRaceEngineerVolume,
  setRaceEngineerTestInFlight,
} from "./audio-volume.js";
import { playRaceEngineerVoiceTest } from "./voice-test.js";

export const AUDIO_PREVIEW_KINDS = ["radar", "voice", "background"] as const;
export type AudioPreviewKind = (typeof AUDIO_PREVIEW_KINDS)[number];

/** Type guard for a page-supplied kind (the window sends it as a string). */
export function isAudioPreviewKind(value: unknown): value is AudioPreviewKind {
  return typeof value === "string" && (AUDIO_PREVIEW_KINDS as readonly string[]).includes(value);
}

export function runAudioPreview(kind: AudioPreviewKind, logger: ILogger): void {
  switch (kind) {
    case "radar":
      logger.info("Playing radar test: left → right → both");
      playRadarTest();
      break;

    case "voice": {
      logger.info("Playing race engineer voice test");

      // Force the Voice bus to the slider value so the preview is audible even
      // when Race Engineer is off (the master gate would otherwise hold it at
      // 0). Set the in-flight flag first so any global-settings listener firing
      // mid-preview (e.g. user dragging the volume slider) doesn't re-mute the
      // bus via applyRaceEngineerAudio.
      setRaceEngineerTestInFlight(true);
      getAudio().setBusVolume(AudioBus.Voice, readRaceEngineerVolume() / 100);

      const started = playRaceEngineerVoiceTest(() => {
        setRaceEngineerTestInFlight(false);
        applyRaceEngineerAudio();
      });

      if (!started) {
        setRaceEngineerTestInFlight(false);
        applyRaceEngineerAudio();
        logger.warn("Race engineer voice test skipped — no voice available");
      }

      break;
    }

    case "background":
      logger.info("Playing background test");
      // isBackgroundTestInFlight (set inside playBackgroundTest) bypasses the
      // Background-mute branch of applyRaceEngineerAudio while the preview is
      // playing, so dragging the slider mid-preview updates the bus volume live
      // instead of cutting the test off (#471). The frame switches are read
      // live too, so the preview drops what the real frame drops (#1064).
      getAudio().setBusVolume(AudioBus.Background, readBackgroundVolume() / 100);
      playBackgroundTest(() => applyRaceEngineerAudio(), readFrameOptions());
      break;
  }
}
