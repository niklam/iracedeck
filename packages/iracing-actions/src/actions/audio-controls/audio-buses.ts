/**
 * The iRaceDeck-internal audio buses behind the Audio Controls action.
 *
 * Race Engineer voice and Radar ticks are plugin-owned: their level is a
 * global setting applied straight to the audio engine, and their Mute /
 * Unmute is the same feature gate the Pit Crew keys flip — no iRacing binding
 * is involved. Both surfaces (keypad keys and the dial, #782) drive them, so
 * the per-bus wiring lives here rather than in either surface: adding a bus is
 * one entry, and neither surface branches on the category name.
 */
import type { ILogger } from "@iracedeck/logger";

import {
  isRaceEngineerEnabled,
  isRadarEnabled,
  readRaceEngineerVolume,
  readRadarVolume,
  stepRaceEngineerVolumeBy,
  stepRadarVolumeBy,
} from "../../audio/audio-volume.js";
import { toggleRaceEngineerFeature, toggleRadarFeature } from "../../audio/feature-gates.js";
import type { InternalAudioCategory } from "./audio-controls-settings.js";

/** One plugin-owned audio bus. */
export interface InternalAudioBus {
  /** Steps the 0–100 level by a signed detent count; returns the new level. */
  stepBy(steps: number): number;
  /** Current 0–100 level (the dial strip's bar). */
  read(): number;
  /** Feature-gate state (the strip's dimmed OFF rendering). */
  isEnabled(): boolean;
  /** Flips the feature gate — the dial's Mute / Unmute for this bus. */
  toggle(logger: ILogger): void;
}

/** Internal category → its bus. The only place these helpers are wired up. */
export const INTERNAL_AUDIO_BUSES: Record<InternalAudioCategory, InternalAudioBus> = {
  "race-engineer": {
    stepBy: stepRaceEngineerVolumeBy,
    read: readRaceEngineerVolume,
    isEnabled: isRaceEngineerEnabled,
    toggle: toggleRaceEngineerFeature,
  },
  radar: {
    stepBy: stepRadarVolumeBy,
    read: readRadarVolume,
    isEnabled: isRadarEnabled,
    toggle: toggleRadarFeature,
  },
};
