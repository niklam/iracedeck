/**
 * Maps a native elevation-status probe (issue #610) to a PI warning record.
 *
 * The decision is pure and structurally typed (only `mismatch` is read) so it
 * lives in deck-core without a dependency on `@iracedeck/iracing-native`, and
 * both plugins share the exact same wording.
 *
 * The message intentionally carries NO leading emoji — the `ird-warnings`
 * banner renders a level icon (⚠️) itself, so adding one here would double it.
 */
import type { PiWarning } from "./pi-warnings.js";

export const ELEVATION_WARNING_ID = "elevation-mismatch";

export const ELEVATION_WARNING_MESSAGE =
  "iRacing seems to be running as Administrator while iRaceDeck is not. " +
  "Run Stream Deck as Administrator (or run iRacing without Administrator) so that buttons reach iRacing.";

export function evaluateElevationWarning(status: { mismatch: boolean }): PiWarning | null {
  if (!status.mismatch) return null;

  return { id: ELEVATION_WARNING_ID, level: "warning", message: ELEVATION_WARNING_MESSAGE };
}
