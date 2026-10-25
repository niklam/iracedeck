import { getGlobalSettings } from "@iracedeck/settings";

/**
 * The 0–100 volume globals of iRaceDeck's own audio, read and clamped, and the
 * step they move by.
 *
 * A leaf of its own, re-exported by `audio-volume.ts` (which every caller
 * imports them from), so that `volume-tick.ts` can read the Radar Volume an
 * iRacing step ticks at without importing `audio-volume.ts`, which imports the
 * tick module to tick its own steps (#1455). The plugins' Rollup config fails
 * the build on a cycle among our own sources.
 */

/** Volume step per key press, in 0–100 units. */
export const VOLUME_STEP = 5;
/** Lowest persisted volume (silent). */
export const VOLUME_MIN = 0;
/** Highest persisted volume (full). */
export const VOLUME_MAX = 100;

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
