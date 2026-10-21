/**
 * The speed a replay jump leaves the replay at (#1276): the **Replay jump
 * playback** global setting, and the speed it resolves to. Its own module so
 * that both the jump sequence (`replay-jump-playback.ts`) and the replay
 * command gate (`replay-command-gate.ts`, #1430), which applies the same step
 * after a search that waited behind a jump, read one rule without importing
 * each other.
 */
import { parseReplayJumpPlayback, type ReplayJumpPlayback } from "@iracedeck/app-constants";

import { engineEnv } from "./replay-engine-env.js";

/** A replay speed in the units `setPlaySpeed` takes: in slow motion `speed` is the divisor (5 = 1/5x). 0 is paused. */
export interface ReplaySpeed {
  readonly speed: number;
  readonly slowMotion: boolean;
}

export const PAUSED: ReplaySpeed = { speed: 0, slowMotion: false };
export const NORMAL_SPEED: ReplaySpeed = { speed: 1, slowMotion: false };

/** The live **Replay jump playback** setting; anything unreadable is `remember`. */
export function readReplayJumpPlayback(): ReplayJumpPlayback {
  return parseReplayJumpPlayback(engineEnv().settings.replayJumpPlayback());
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

/** How close two speed values must be to count as the same speed. */
const SAME_SPEED_EPSILON = 1e-6;

/**
 * A replay speed as one signed number: 8x is 8, -1/4x (`{ -4, true }`) is
 * -0.25, paused is 0, whatever the slow-motion flag says.
 */
function speedValue(s: ReplaySpeed): number {
  if (s.speed === 0) return 0;

  return s.slowMotion ? Math.sign(s.speed) / Math.abs(s.speed) : s.speed;
}

/** Whether two replay speeds are the same speed, whatever shape each was written in. */
export function isSameSpeed(a: ReplaySpeed, b: ReplaySpeed): boolean {
  return Math.abs(speedValue(a) - speedValue(b)) < SAME_SPEED_EPSILON;
}
