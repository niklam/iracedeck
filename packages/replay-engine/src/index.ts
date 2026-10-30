/**
 * @iracedeck/replay-engine (#1467): the iRacing replay engine, injected once
 * by plugin-runtime's `initReplay` phase.
 */
export {
  _configureReplayEngine,
  _resetReplayEngineEnv,
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
export { configureReplayEngine } from "./replay-engine-configure.js";
export { _resetReplayLeft } from "./replay-left.js";
export {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  cancelReplayCursorOwnerIf,
  claimReplayCursor,
  clearReplayJumpSpeed,
  currentReplayCursorOwner,
  endReplayCursorInterrupts,
  interruptReplayCursorOwnerIf,
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
  noteReplaySpeedSent,
  noteTelemetrySpeed,
  onReplaySpeedChanged,
  rememberedSpeed,
  resolveLiveSpeed,
  reverseRememberedSpeed,
} from "./replay-speed-state.js";
export { shownReplaySpeed } from "./replay-speed-view.js";
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
export {
  _resetCameraSwitchWaiter,
  type CameraSwitchJumps,
  type CameraSwitchOptions,
  isCameraSwitchWaiting,
  requestCameraSwitch,
} from "./camera-switch-waiter.js";
export {
  cancelLapWalks,
  FASTEST_LAP_WALK_OWNER,
  interruptLapWalks,
  LAP_WALK_OWNERS,
  RACE_START_WALK_OWNER,
} from "./lap-walk-owners.js";
export {
  _activeLapPress,
  _resetLapPress,
  isLapPressWindingDown,
  isLapPressInFlight,
  LapWalkInterrupted,
  runJumpToFrame,
} from "./lap-press.js";
export {
  _getFastestLapSessionCache,
  _resetFastestLapSessionCache,
  computeFastestLapBisectionProbe,
  LAP_START_APPROACH_FRAMES,
} from "./lap-walk.js";
export {
  findFastestLapForCar,
  jumpToRecordedLapStart,
  type LapPressResult,
  pressJumpToFastestLap,
  readSubSessionId,
} from "./fastest-lap-press.js";
export { canJumpToRaceStart, pressJumpToRaceStart } from "./race-start-press.js";
export { formatLapOfLaps, sessionLapCount } from "./replay-lap-count.js";
export { formatPlayCaption, formatSpeedDisplay, parseSpeedSetting } from "./replay-speed-format.js";
export { _resetReplayEngine } from "./replay-engine-reset.js";
export {
  _resetReplayCommandGate,
  getReplayGateRecord,
  getReplayGateView,
  isReplayJumpSequenceOpen,
  isReplayMoveUnderWay,
  pressReplayCommand,
  readReplayPosition,
  type ReplayGateCommand,
  type ReplayGateEndClass,
  type ReplayGateEndReason,
  type ReplayGateFactEnd,
  type ReplayGateNotice,
  type ReplayGateRecord,
  type ReplayGateView,
  type ReplayOwnedSendResult,
  type ReplayPressOptions,
  type ReplayPressResult,
  type ReplaySearchKind,
  type ReplaySettledOutcome,
  sendOwnedReplayCommand,
  subscribeReplayGate,
  waitForReplayJumpsToSettle,
  waitForReplaySettled,
  waitingReplaySpeed,
} from "./replay-command-gate.js";
export {
  applyReplayJumpPlayback,
  beginReplayJump,
  describeReplayJump,
  noteReplayJumpLanded,
  type ReplayJump,
  type ReplayJumpApplied,
  type ReplayJumpBeginOptions,
  type ReplayJumpOptions,
  type ReplayJumpOutcome,
  type ReplayJumpReport,
  type ReplayJumpStopReason,
  runReplayJump,
} from "./replay-jump-playback.js";
export {
  _resetReplaySearchQueue,
  isReplaySearchRunning,
  onReplaySearchChange,
  pendingReplaySearch,
  queueReplaySearch,
  type ReplaySearchPending,
  type ReplaySearchTarget,
  type ReplaySearchTurn,
} from "./replay-search-queue.js";
export {
  type IncidentObserverHost,
  type IncidentSearchPress,
  type ObservedIncidentListing,
  observeIncidentSearch,
} from "./replay-incident-observer.js";
export {
  type RecordedEntry,
  recordedIndexAt,
  type RecordedSpanRule,
  type RecordedWalkMissReason,
  type RecordedWalkResult,
  type ReplayWalkDirection,
  resolveReplayWalkAnchor,
  resolveReplayWalkStart,
  type ReplayWalkStart,
  walkRecordedEntries,
  walkRecordedIndex,
} from "./replay-record-walk.js";
export {
  findRecordStep,
  listRecord,
  NO_CAR_IDX,
  RECORD_STEPS,
  type RecordListing,
  type RecordStepMode,
  type RecordStepResult,
  type RecordStepSource,
  type RecordStepSpec,
  stepRecordListing,
} from "./replay-record-step.js";
