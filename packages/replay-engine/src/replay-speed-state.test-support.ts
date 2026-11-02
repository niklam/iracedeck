/**
 * Test support (#1427): a speed send recorded and announced in one call, as
 * the replay command gate does across its change (`recordReplaySpeedSent` the
 * moment a send goes out, `announceReplaySpeedSent` once the change is
 * complete). Production records only through the gate. Never imported by
 * production code.
 */
import type { ReplaySpeed } from "./replay-jump-speed.js";
import { announceReplaySpeedSent, recordReplaySpeedSent, type ReplaySpeedSendOptions } from "./replay-speed-state.js";

/** Records `target` as sent at `nowMs` and tells the speed state's listeners at once. */
export function noteReplaySpeedSent(target: ReplaySpeed, nowMs: number, options: ReplaySpeedSendOptions): void {
  recordReplaySpeedSent(target, nowMs, options);
  announceReplaySpeedSent(target);
}
