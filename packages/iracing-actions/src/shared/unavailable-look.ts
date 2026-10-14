/**
 * The "unavailable" look of a key whose press would do nothing right now:
 * Replay Markers' Next / Previous with no marker that way (#1162), Replay
 * Control's Jump to Race Start in a replay with no race session (#1354).
 *
 * It is the key's own icon, overrides and all, with every colour but the
 * background turned grey, border included, and the artwork and title faded by
 * `assembleIcon`'s `dimmed` — so a customised key still reads as itself, only
 * switched off.
 */
import { hexToGrayscale } from "@iracedeck/deck-core";

/** What an unavailable key hands `assembleIcon` in place of its resolved colours and border. */
export interface UnavailableLook<B extends { borderColor: string }> {
  colors: Record<string, string>;
  border: B;
  dimmed: true;
}

/**
 * Every colour slot but the background in grey — so a coloured override turns
 * grey rather than only fading — the border's colour with them, and `dimmed`.
 */
export function unavailableLook<B extends { borderColor: string }>(
  colors: Record<string, string>,
  border: B,
): UnavailableLook<B> {
  return {
    colors: Object.fromEntries(
      Object.entries(colors).map(([slot, value]) => [slot, slot === "backgroundColor" ? value : hexToGrayscale(value)]),
    ),
    border: { ...border, borderColor: hexToGrayscale(border.borderColor) },
    dimmed: true,
  };
}
