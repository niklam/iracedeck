/**
 * @iracedeck/replay-engine (#1467): the iRacing replay engine, injected once
 * by plugin-runtime's `initReplay` phase.
 */
export {
  _configureReplayEngine,
  _resetReplayEngineEnv,
  configureReplayEngine,
  engineEnv,
  engineLogger,
  engineReads,
  type ReplayCameraSurface,
  type ReplayCommandSurface,
  type ReplayEngineController,
  type ReplayEngineEnv,
  type ReplayEngineReads,
  type ReplayEngineSettings,
} from "./replay-engine-env.js";
export {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  cancelReplayCursorOwnerIf,
  claimReplayCursor,
  clearReplayJumpSpeed,
  currentReplayCursorOwner,
  onReplayCursorTaken,
  pendingReplayJumpSpeed,
  recordReplayJumpSpeed,
  type ReplayCursorClaim,
  type ReplayJumpSpeed,
} from "./replay-cursor.js";
export { planFrameMove, frameBeside, JUMP_END_MARGIN_FRAMES, type FrameMove } from "./replay-frame-move.js";
export {
  isSameSpeed,
  NORMAL_SPEED,
  PAUSED,
  readReplayJumpPlayback,
  type ReplaySpeed,
  resolveReplayJumpSpeed,
} from "./replay-jump-speed.js";
export {
  _resetReplayPositionState,
  clearReplayTarget,
  markReplayTargetSent,
  pendingReplayTarget,
  pendingReplayTargetPosition,
  recordReplayTarget,
  REPLAY_TARGET_GIVE_UP_MS,
  type ReplayPosition,
  type ReplayTarget,
  type ReplayTargetDetails,
  type ReplayTargetSettlement,
  replayTargetGiveUpMs,
  resolveReplayPosition,
  settleReplayTarget,
} from "./replay-position-state.js";
export {
  isLandedOn,
  isPaused,
  isSeeking,
  replaySeekWaitMs,
  type ReplaySeekOptions,
  type ReplaySeekOutcome,
  type ReplaySeekSample,
  seekReplayFrame,
  type ReplayWaitOptions,
  type ReplayWaitOutcome,
  waitForReplay,
} from "./replay-seek.js";
export {
  HOLD_GAP_MS,
  readFastestLapSearchDelayMs,
  readReplayJumpTimeoutMs,
  RECORD_JUMP_MIN_TIMEOUT_MS,
  REPLAY_JUMP_MAX_WAIT_MS,
  REPLAY_JUMP_POLL_MS,
  STABILIZATION_POLL_INTERVAL_MS,
  STABILIZATION_TIMEOUT_MULTIPLIER,
} from "./replay-timing.js";
export {
  _resetReplaySpeedState,
  clearDialPendingSpeed,
  DIAL_SPEED_HOLD_MS,
  keepDialPendingSpeed,
  noteDialSpeedSent,
  noteTelemetrySpeed,
  rememberedSpeed,
  resolveLiveSpeed,
  reverseRememberedSpeed,
} from "./replay-speed-state.js";
export {
  acceptsGreenFallbackLanding,
  GREEN_APPROACH_FRAMES,
  GREEN_FALLBACK_MIN_LAP_DIST,
  greenApproachFrame,
  type GreenFallbackCar,
  type GreenFlagTarget,
  isRaceStartUnavailable,
  lastListedSessionNum,
  resolveGreenFallbackCar,
  resolveGreenFlagTarget,
  resolvePoleCarIdx,
} from "./green-flag-target.js";
export { halvingProbeFrames } from "./lap-walk-probes.js";
export { formatLapOfLaps, sessionLapCount } from "./replay-lap-count.js";
export { formatPlayCaption, formatSpeedDisplay, parseSpeedSetting } from "./replay-speed-format.js";
