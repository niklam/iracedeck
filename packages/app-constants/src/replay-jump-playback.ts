/**
 * Replay jump playback (issue #1276).
 *
 * What the replay does once a jump has landed — Replay Control's Jump to
 * Fastest Lap and Replay Markers' Previous / Next Marker:
 *
 * - `remember` — carries on at the speed it had before the press: paused stays
 *                paused, and 1x, slow motion, fast-forward and rewind continue
 *                at the same speed and direction from the new spot.
 * - `play`     — plays at 1x.
 * - `stopped`  — paused on the new spot.
 *
 * In the `app-constants` leaf because the settings schema, the action code that
 * reads the cache and the settings window's select (pinned by a test in
 * `pi-components`) all name the same three values.
 */

export const REPLAY_JUMP_PLAYBACK_MODES = ["remember", "play", "stopped"] as const;

export type ReplayJumpPlayback = (typeof REPLAY_JUMP_PLAYBACK_MODES)[number];

export const DEFAULT_REPLAY_JUMP_PLAYBACK: ReplayJumpPlayback = "remember";

/**
 * Fold any stored value into a mode. An unknown one — a value a later version
 * added, or a damaged file — reads as the default rather than throwing, because
 * a single throwing field aborts the whole settings parse (#896).
 */
export function parseReplayJumpPlayback(value: unknown): ReplayJumpPlayback {
  if (typeof value === "string" && (REPLAY_JUMP_PLAYBACK_MODES as readonly string[]).includes(value)) {
    return value as ReplayJumpPlayback;
  }

  return DEFAULT_REPLAY_JUMP_PLAYBACK;
}
