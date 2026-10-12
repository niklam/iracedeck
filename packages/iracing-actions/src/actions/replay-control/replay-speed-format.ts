/**
 * Replay speed text: the keypad's speed setting format and how a speed reads
 * on a key or a dial. Kept apart from the action so the dial surface and its
 * modes (#1316) can import them without importing the action that owns them;
 * `replay-control.ts` re-exports both, so its API is unchanged.
 */

/**
 * @internal Exported for testing
 *
 * Parses a speed setting value into speed and slowMotion flag.
 * Format: "1"-"16" for normal speeds, "s2"-"s16" for slow-motion (1/Nx).
 */
export function parseSpeedSetting(value: string): { speed: number; slowMotion: boolean } {
  if (value.startsWith("s")) {
    const speed = parseInt(value.slice(1), 10);

    return { speed: isNaN(speed) ? 2 : Math.max(2, Math.min(speed, 16)), slowMotion: true };
  }

  const speed = parseInt(value, 10);

  return { speed: isNaN(speed) ? 1 : Math.max(1, Math.min(speed, 16)), slowMotion: false };
}

/**
 * @internal Exported for testing
 *
 * Formats a speed value for display.
 */
export function formatSpeedDisplay(speed: number, slowMotion: boolean): string {
  if (speed === 0) return "PAUSED";

  if (slowMotion && speed < 0) return `-1/${Math.abs(speed)}x`;

  if (slowMotion) return `1/${Math.abs(speed)}x`;

  if (speed < 0) return `${speed}x`;

  return `${speed}x`;
}

/**
 * The play-direction marks of {@link formatPlayCaption}: U+25BA and U+25C4,
 * the two pointers the bundled Arimo carries. The look-alike U+25B6 / U+25C0
 * are not in it and draw as empty boxes wherever the dial's screen is
 * rasterized with the bundled fonts (a Stream Dock knob).
 */
const PLAY_FORWARD_MARK = "►";
const PLAY_REVERSE_MARK = "◄";

/**
 * Formats a playing speed as a direction mark and its magnitude — `► 4x`,
 * `◄ 1/4x` — for the dial's resume caption and hold preview (#1316), where
 * the arrow says which way the replay will run. A speed of 0 has no direction;
 * callers pass a non-zero one.
 */
export function formatPlayCaption(speed: number, slowMotion: boolean): string {
  return `${speed < 0 ? PLAY_REVERSE_MARK : PLAY_FORWARD_MARK} ${formatSpeedDisplay(Math.abs(speed), slowMotion)}`;
}
