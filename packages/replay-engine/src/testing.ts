/**
 * Test helpers shared with `iracing-actions`' tests (#1467); never imported by
 * production code. Reached as `@iracedeck/replay-engine/testing`.
 *
 * Besides the helpers, the test hooks and the engine names only tests reach
 * (#1502): the main barrel carries what production imports and no more, so a
 * `_reset*` / `_configure*` hook is never callable from production code.
 */
export { _configureReplayEngine } from "./replay-engine-env.js";
export {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  claimReplayCursor,
  pendingReplayJumpSpeed,
} from "./replay-cursor.js";
export { clearReplayTarget, pendingReplayTarget, replayTargetGiveUpMs } from "./replay-position-state.js";
export { _resetReplaySpeedState, noteReplaySpeedSent, resolveLiveSpeed } from "./replay-speed-state.js";
export { _resetCameraSwitchWaiter, isCameraSwitchWaiting } from "./camera-switch-waiter.js";
export { cancelLapWalks, FASTEST_LAP_WALK_OWNER, RACE_START_WALK_OWNER } from "./lap-walk-owners.js";
export { _activeLapPress } from "./lap-press.js";
export { _getFastestLapSessionCache } from "./lap-walk.js";
export { jumpToRecordedLapStart } from "./fastest-lap-press.js";
export { isReplayJumpSequenceOpen } from "./replay-command-gate.js";
export {
  type CursorTestEvent,
  cursorTestEvent,
  type ReplayCursorProbe,
  stageReplayCursorProbe,
} from "./replay-cursor.test-support.js";
export { type SteppedReplayState, steppedReplayState, withSteppedReplayState } from "./replay-state.test-support.js";
export {
  fakeReplay,
  type FakeReplay,
  type FakeReplayOptions,
  THROWN_OFFSET,
} from "./replay-command-gate.test-support.js";
export { resetEngine, type ReplayEngineTestOverrides } from "./replay-engine-reset.test-support.js";
export {
  type LapBuffer,
  type LapBufferReplay,
  type LapBufferTarget,
  multiSessionBuffer,
  type SessionLayout,
  singleSessionBuffer,
} from "./lap-walk-buffer.test-support.js";
export {
  FRAMES_PER_LAP,
  IN_RACE,
  POLE_CAR,
  RACE_LAP_1_LINE,
  RACE_START,
  type RaceWeekend,
  type RaceWeekendCommands,
  type RaceWeekendController,
  type RaceWeekendOptions,
  raceWeekendReplay,
  type RaceWeekendSession,
  VIEWED_CAR,
  WEEKEND,
  WEEKEND_TYPES,
} from "./race-weekend-replay.test-support.js";
export {
  type ReplayLeftControllerReads,
  replayLeftController,
  type WatchedReplayController,
  watchReplayLeft,
} from "./replay-left.test-support.js";
