/**
 * How long the replay actions wait for iRacing to act on a replay command.
 * One home for the numbers, because the Jump to Fastest Lap walk, its record
 * jump and the shared jump sequence (`replay-jump-playback.ts`, #1276) all
 * time their waits from the same `fastestLapSearchDelayMs` setting.
 */
import { getGlobalSettings } from "@iracedeck/settings";

/**
 * The shortest a jump waits for the pause, and for a landing that is not
 * getting any nearer (#1275). The walk's `fastestLapSearchDelayMs × 4` alone
 * would give a 200 ms wait at the setting's 50 ms minimum; a longer wait costs
 * nothing on success and only delays the warning on a failure.
 */
export const RECORD_JUMP_MIN_TIMEOUT_MS = 3000;

/**
 * How often a jump reads the telemetry while it waits for its pause and for
 * its landing. Shorter than the walk's settle poll because a jump on a playing
 * replay holds the picture still for both waits: the sim answers within a
 * tick or two, and the SDK reads it every 10 ms.
 */
export const REPLAY_JUMP_POLL_MS = 20;

/**
 * The longest a jump waits for its landing while the cursor is still moving
 * towards it. iRacing covers a jump at most `maxFramesToSearchPerUpdate`
 * frames per update (2048 by default), so one across a 24-hour recording runs
 * for well under a minute; past two, something else is moving the cursor.
 */
export const REPLAY_JUMP_MAX_WAIT_MS = 120_000;

/**
 * Multiplier applied to the configured `fastestLapSearchDelayMs` to cap how
 * long the walk waits for a command to settle: an absolute jump until
 * `ReplayFrameNum` reads the frame that was sent (with `SessionNum` out of the
 * `-1` transient iRacing publishes while the cursor lands, issue #607), a
 * search until the frame has moved and held. The cap is `delay × 4` (default
 * 1.6 s). A jump that has not settled by then aborts the walk — the old
 * clock-only wait accepted the previous frame's telemetry and bisected the
 * wrong bracket (#1203). A search that has not moved by then is a legitimate
 * no-op at the buffer's edge (`nextSession` in the last session). Observed
 * first-jump transient is ~514 ms after a paused-replay `setPlayPosition`.
 */
export const STABILIZATION_TIMEOUT_MULTIPLIER = 4;

/**
 * Interval the waits poll `getCurrentTelemetry()` at while a command settles,
 * and the hold a moved search frame must keep across two reads. 50 ms is ~3
 * sim ticks at 60 Hz — short enough to catch the transition promptly without
 * spinning.
 */
export const STABILIZATION_POLL_INTERVAL_MS = 50;

/**
 * Default minimum gap after a replay lap-search broadcast before the next
 * command, when the `fastestLapSearchDelayMs` global setting isn't set. Even
 * when the replay is paused, the manual Next Lap / Previous Lap actions
 * exhibit the same drift when pressed in rapid succession: iRacing appears to
 * be resolving the exact lap-boundary position asynchronously after each
 * `ReplaySearch` and a follow-up broadcast that arrives before that work
 * finishes leaves the cursor parked mid-lap. 400 ms is the empirical default
 * that works reliably; slower machines and longer tracks can raise it via
 * Common Settings → Replay → Fastest Lap Search Delay. Since #1203 it is also
 * the timeout base for absolute jumps (`× STABILIZATION_TIMEOUT_MULTIPLIER`)
 * rather than their wait.
 */
const REPLAY_LAP_SEARCH_GAP_DEFAULT_MS = 400;

const REPLAY_LAP_SEARCH_GAP_MIN_MS = 50;
const REPLAY_LAP_SEARCH_GAP_MAX_MS = 1000;

/**
 * Reads the live `fastestLapSearchDelayMs` global setting, clamped to the
 * accepted range. Falls back to {@link REPLAY_LAP_SEARCH_GAP_DEFAULT_MS} on
 * any non-numeric value so a corrupted persisted value can't break the
 * walker.
 */
export function readFastestLapSearchDelayMs(): number {
  const raw = (getGlobalSettings() as Record<string, unknown>).fastestLapSearchDelayMs;
  const value = typeof raw === "number" ? raw : Number(raw);

  if (!Number.isFinite(value)) return REPLAY_LAP_SEARCH_GAP_DEFAULT_MS;

  return Math.min(Math.max(value, REPLAY_LAP_SEARCH_GAP_MIN_MS), REPLAY_LAP_SEARCH_GAP_MAX_MS);
}

/**
 * How long one jump waits for its pause to show, and for its landing once the
 * cursor has stopped moving: the walk's `delay × 4`, and never less than
 * {@link RECORD_JUMP_MIN_TIMEOUT_MS}.
 */
export function readReplayJumpTimeoutMs(): number {
  return Math.max(RECORD_JUMP_MIN_TIMEOUT_MS, readFastestLapSearchDelayMs() * STABILIZATION_TIMEOUT_MULTIPLIER);
}
