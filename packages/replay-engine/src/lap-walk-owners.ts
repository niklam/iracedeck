/**
 * The two lap walks' cursor owners (#1467): Jump to Fastest Lap's and Jump to
 * Race Start's searches, the two that ride on the camera's car. A camera
 * switch cancels these and no other owner — a record jump's run, a marker
 * jump's or the paced search's is left standing.
 */
import { cancelReplayCursorOwnerIf } from "./replay-cursor.js";

/** The owner name the Jump to Fastest Lap walk claims the replay cursor under. */
export const FASTEST_LAP_WALK_OWNER = "jump-to-fastest-lap walk";

/** The owner name a Jump to Race Start press claims the replay cursor under while it searches for the pole car's lap 1. */
export const RACE_START_WALK_OWNER = "jump-to-race-start walk";

/** The lap walks: the cursor owners a camera switch cancels. */
export const LAP_WALK_OWNERS: readonly string[] = [FASTEST_LAP_WALK_OWNER, RACE_START_WALK_OWNER];

/**
 * Cancels a lap walk that holds the replay cursor, and no other owner, naming
 * `by`. Returns the cancelled walk's owner name, or null when none stood.
 */
export function cancelLapWalks(by: string): string | null {
  return cancelReplayCursorOwnerIf(LAP_WALK_OWNERS, by);
}
