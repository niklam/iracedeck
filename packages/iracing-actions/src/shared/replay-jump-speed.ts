/**
 * The speed a replay jump leaves the replay at (#1276): the **Replay jump
 * playback** global setting, and the speed it resolves to. Its own module so
 * that both the jump sequence (`replay-jump-playback.ts`) and the replay
 * command gate (`replay-command-gate.ts`, #1430), which applies the same step
 * after a search that waited behind a jump, read one rule without importing
 * each other.
 */
import { parseReplayJumpPlayback, type ReplayJumpPlayback } from "@iracedeck/app-constants";
import { getGlobalSettings } from "@iracedeck/settings";

/** A replay speed in the units `setPlaySpeed` takes: in slow motion `speed` is the divisor (5 = 1/5x). 0 is paused. */
export interface ReplaySpeed {
  readonly speed: number;
  readonly slowMotion: boolean;
}

export const PAUSED: ReplaySpeed = { speed: 0, slowMotion: false };
export const NORMAL_SPEED: ReplaySpeed = { speed: 1, slowMotion: false };

/** The live **Replay jump playback** setting; anything unreadable is `remember`. */
export function readReplayJumpPlayback(): ReplayJumpPlayback {
  return parseReplayJumpPlayback((getGlobalSettings() as Record<string, unknown>).replayJumpPlayback);
}

/**
 * @internal Exported for testing
 *
 * The speed a jump should leave the replay at.
 */
export function resolveReplayJumpSpeed(mode: ReplayJumpPlayback, captured: ReplaySpeed): ReplaySpeed {
  switch (mode) {
    case "play":
      return NORMAL_SPEED;
    case "stopped":
      return PAUSED;
    case "remember":
      return captured;
  }
}

/** Two speeds are the same when the numbers match; the slow-motion flag means nothing on a paused replay. */
export function isSameSpeed(a: ReplaySpeed, b: ReplaySpeed): boolean {
  return a.speed === b.speed && (a.speed === 0 || a.slowMotion === b.slowMotion);
}
