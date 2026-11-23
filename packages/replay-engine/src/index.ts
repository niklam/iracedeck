/**
 * @iracedeck/replay-engine (#1467): the iRacing replay engine, injected once
 * by plugin-runtime's `initReplay` phase.
 *
 * The production surface (#1502): only what a production source outside the
 * engine imports, and the types those functions take or return. The test
 * hooks (`_reset*`, `_configure*`) and the names only other packages' tests
 * reach are on `@iracedeck/replay-engine/testing`; a name only the engine's
 * own tests reach is on neither, imported by relative path. The env itself
 * (`engineEnv`, `engineReads`, `engineLogger`, `setReplayEngineEnv`) is on
 * neither, so only the engine's own modules can reach the injected replay
 * surface.
 *
 * `index.test.ts` holds this file to that, both ways (#1502, #1661): no name
 * here is a `_` hook; every engine type an exported signature names is
 * exported; every value is imported by name by a production source outside
 * the engine (tests, test support, `./testing` entries and `__fixtures__` do
 * not count); and every type is too, unless it is a contract type, one a
 * signature names or a contract type's own declaration does. A production
 * source imports this barrel by name only: a namespace import, `export *`, a
 * default or side-effect import, an empty `import {}` or `export {}`, a
 * dynamic `import(…)` or `require(…)` and a whole-module `import("…")` type
 * are refused, since they name nothing to count.
 */
export { configureReplayEngine } from "./replay-engine-configure.js";
export type { ReplayEngineController, ReplayEngineEnv } from "./replay-engine-env.js";
export type { ReplayCursorClaim } from "./replay-cursor.js";
export { planFrameMove, type FrameMove } from "./replay-frame-move.js";
export { isSameSpeed, PAUSED, type ReplaySpeed } from "./replay-jump-speed.js";
export type { ReplayPosition } from "./replay-position-state.js";
export { isSeeking, type ReplaySeekSample } from "./replay-seek.js";
export { REPLAY_JUMP_MAX_WAIT_MS } from "./replay-timing.js";
export {
  keepDialPendingSpeed,
  onReplaySpeedChanged,
  REPLAY_SPEED_HOLD_MS,
  rememberedSpeed,
  reverseRememberedSpeed,
} from "./replay-speed-state.js";
export { shownReplaySpeed } from "./replay-speed-view.js";
export { isRaceStartUnavailable, lastListedSessionNum } from "./green-flag-target.js";
export { type CameraSwitchOptions, requestCameraSwitch } from "./camera-switch-waiter.js";
export { runJumpToFrame } from "./lap-press.js";
export { LAP_START_APPROACH_FRAMES } from "./lap-walk.js";
export { type LapPressResult, pressJumpToFastestLap } from "./fastest-lap-press.js";
export { canJumpToRaceStart, pressJumpToRaceStart } from "./race-start-press.js";
export { formatLapOfLaps, sessionLapCount } from "./replay-lap-count.js";
export { formatPlayCaption, formatSpeedDisplay, parseSpeedSetting } from "./replay-speed-format.js";
export {
  getReplayGateRecord,
  type ReplayGateRecord,
  getReplayGateView,
  type ReplayGateView,
  pressReplayCommand,
  readReplayPosition,
  type ReplayPressOptions,
  type ReplayGateCommand,
  type ReplayGateEndReason,
  type ReplayGateFactEnd,
  type ReplayGateNotice,
  type ReplayPressResult,
  type ReplaySettledOutcome,
  subscribeReplayGate,
  waitForReplaySettled,
} from "./replay-command-gate.js";
export {
  beginReplayJump,
  describeReplayJump,
  type ReplayJump,
  type ReplayJumpBeginOptions,
  type ReplayJumpOptions,
  type ReplayJumpOutcome,
  type ReplayJumpReport,
  runReplayJump,
} from "./replay-jump-playback.js";
export {
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
  observeIncidentSearch,
} from "./replay-incident-observer.js";
export {
  recordedIndexAt,
  type RecordedEntry,
  type RecordedSpanRule,
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
