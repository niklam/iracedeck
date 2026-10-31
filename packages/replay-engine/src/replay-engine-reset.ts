/**
 * One reset for the whole engine (#1467), for `iracing-actions`' tests: every
 * engine module's state, then the env. A module that keeps state adds its
 * reset here: `replay-engine-reset.coverage.test.ts` fails on module-level
 * state that no call reached from here writes, unless it is exempted there
 * with the reason (#1502).
 */
import { _resetCameraSwitchWaiter } from "./camera-switch-waiter.js";
import { _resetLapPress } from "./lap-press.js";
import { _resetFastestLapSessionCache } from "./lap-walk.js";
import { _resetReplayCommandGate } from "./replay-command-gate.js";
import { _resetReplayCursor } from "./replay-cursor.js";
import { _resetReplayEngineEnv } from "./replay-engine-env.js";
import { _resetReplayLeft } from "./replay-left.js";
import { _resetReplayPositionState } from "./replay-position-state.js";
import { _resetReplaySearchQueue } from "./replay-search-queue.js";
import { _resetReplaySpeedState } from "./replay-speed-state.js";

/** @internal For tests: back to an unconfigured engine with nothing under way. */
export function _resetReplayEngine(): void {
  // The queue first: ending its run ends the run's jump through the gate.
  _resetReplaySearchQueue();
  // The watch next: nothing emits into the modules while they are reset.
  _resetReplayLeft();
  _resetCameraSwitchWaiter();
  _resetLapPress();
  _resetFastestLapSessionCache();
  _resetReplayCommandGate();
  _resetReplayCursor();
  _resetReplayPositionState();
  _resetReplaySpeedState();
  _resetReplayEngineEnv();
}
