/**
 * The two lap walks' cursor owners (#1467): Jump to Fastest Lap's and Jump to
 * Race Start's searches, the two that ride on the camera's car. A camera
 * switch interrupts these and no other owner (`interruptLapWalks`, #1428 /
 * #1435): the walk stops its search and puts the replay back, and a record
 * jump's run, a marker jump's or the paced search's is left standing.
 * Leaving the replay cancels them instead (`replay-left.ts`): a walk stops
 * with nothing to put back into, where a record jump keeps its target and
 * waits out its own wait.
 */
import { cancelReplayCursorOwnerIf, interruptReplayCursorOwnerIf } from "./replay-cursor.js";
import { onReplayLeft, REPLAY_LEFT_CANCEL } from "./replay-left.js";

/** The owner name the Jump to Fastest Lap walk claims the replay cursor under. */
export const FASTEST_LAP_WALK_OWNER = "jump-to-fastest-lap walk";

/** The owner name a Jump to Race Start press claims the replay cursor under while it searches for the pole car's lap 1. */
export const RACE_START_WALK_OWNER = "jump-to-race-start walk";

/** The lap walks: the cursor owners a camera switch interrupts. */
export const LAP_WALK_OWNERS: readonly string[] = [FASTEST_LAP_WALK_OWNER, RACE_START_WALK_OWNER];

/**
 * Cancels a lap walk that holds the replay cursor, and no other owner, naming
 * `by`: the walk sends nothing more. Returns the cancelled walk's owner name,
 * or null when none stood.
 */
export function cancelLapWalks(by: string): string | null {
  return cancelReplayCursorOwnerIf(LAP_WALK_OWNERS, by);
}

/**
 * Interrupts a lap walk that holds the replay cursor, and no other owner,
 * naming `by` (#1428 / #1435): a camera switch. The walk keeps its claim,
 * stops its search at its next await and puts the replay back. Nothing is
 * taken: the pending jump speed, the dial's pending speed and
 * `onReplayCursorTaken` are left alone. Returns the interrupted walk's owner
 * name, or null when none stood or it was already interrupted.
 */
export function interruptLapWalks(by: string): string | null {
  return interruptReplayCursorOwnerIf(LAP_WALK_OWNERS, by);
}

// A walk stops when the replay is left (#1467): it unwinds at its next await and its press resolves as cancelled.
onReplayLeft(() => {
  cancelLapWalks(REPLAY_LEFT_CANCEL);
});
