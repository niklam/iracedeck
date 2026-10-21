/**
 * The replay speed a surface shows (#1467, Decision 4 of
 * `docs/superpowers/specs/2026-10-20-issue-1467-replay-engine-package.md`):
 * the speed waiting in the replay command gate's slot while one is held,
 * otherwise the live speed the speed state resolves. Every reader — the
 * keys' icons, the dial, a key's next speed step — reads this one.
 *
 * Its own module because the gate feeds the speed state: the gate imports
 * `replay-speed-state`, so the combined read cannot live in either without a
 * cycle.
 */
import { waitingReplaySpeed } from "./replay-command-gate.js";
import type { ReplaySpeed } from "./replay-jump-speed.js";
import { resolveLiveSpeed } from "./replay-speed-state.js";

/**
 * The speed to show now: a speed the gate holds for what is under way to
 * land, which is what the replay has been asked to do, or else
 * `telemetrySpeed` (the latest reading's, null when it carries none) under a
 * speed just sent that telemetry has not shown yet. A speed the gate dropped
 * was never sent, so it never shows.
 */
export function shownReplaySpeed(telemetrySpeed: ReplaySpeed | null, nowMs: number): ReplaySpeed {
  return waitingReplaySpeed() ?? resolveLiveSpeed(telemetrySpeed, nowMs);
}
