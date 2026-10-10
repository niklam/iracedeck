/**
 * @iracedeck/iracing-sdk
 *
 * iRacing SDK for Node.js - telemetry reading and broadcast commands
 */

// Main SDK class
export { IRacingSDK } from "./IRacingSDK.js";

// SDK Controller (manages connections and subscribers)
export { SDKController, TELEMETRY_INTERVAL_MS, TelemetryCallback } from "./SDKController.js";

// Interfaces for dependency injection
export type { ChatSendTiming, INativeSDK } from "./interfaces.js";

// Factory functions for easy SDK creation
export { createSDK, createCommands, type SDKBundle, type Commands, type SDKFactoryOptions } from "./factory.js";

// Re-export logger types for convenience
export { ILogger, consoleLogger, silentLogger, LogLevel } from "@iracedeck/logger";

// Types and enums
export {
  // Constants
  IRSDK_MAX_BUFS,
  IRSDK_MAX_STRING,
  IRSDK_MAX_DESC,
  IRSDK_UNLIMITED_LAPS,
  IRSDK_UNLIMITED_TIME,
  INCIDENT_REP_MASK,
  INCIDENT_PEN_MASK,

  // Types
  VarType,
  StatusField,
  VarHeader,
  VarBuf,
  IRSDKHeader,
  TelemetryData,
  SessionInfo,

  // Enums
  EngineWarnings,
  Flags,
  TrkLoc,
  TrkSurf,
  SessionState,
  CameraState,
  PitSvFlags,
  PitSvStatus,
  PaceMode,
  PaceFlags,
  CarLeftRight,
  TrackWetness,
  IncidentFlags,
  Skies,
  DisplayUnits,
  EnterExitReset,

  // Utility functions
  hasFlag,
  hasAllFlags,
  hasAnyFlag,
  getActiveFlags,
  getActiveFlagNames,
  addFlag,
  addFlags,
  removeFlag,
  removeFlags,
  toggleFlag,
  setFlag,
} from "./types.js";

// Commands
export {
  // Base class
  BroadcastCommand,

  // Command classes
  CameraCommand,
  ReplayCommand,
  PitCommand,
  ChatCommand,
  TelemCommand,
  TextureCommand,
  FFBCommand,
  VideoCaptureCommand,

  // Constants and enums
  BroadcastMsg,
  ChatCommandMode,
  PitCommandMode,
  TelemCommandMode,
  ReplayStateMode,
  ReloadTexturesMode,
  ReplaySearchMode,
  ReplayPosMode,
  FFBCommandMode,
  CameraFocusMode,
  VideoCaptureMode,
  IRSDK_BROADCAST_MSG_NAME,
} from "./commands/index.js";

// Template variable system
export { resolveTemplate } from "./template-resolver.js";
export {
  buildTemplateContext,
  buildTemplateContextFromData,
  splitDriverName,
  findNearestDriverOnTrack,
  findDriverByRacePosition,
  type LivePositionsSource,
  templateContextFromMaps,
  type TemplateContext,
  type TemplateLookup,
  type TemplateValue,
} from "./template-context.js";

// Track utilities
export { carInWorld, findNearestCarOnTrack, type FindNearestCarOptions, nearestCarGapMeters } from "./track-utils.js";

// Position utilities
export { calculateRacePositions, classPositionFromOrder } from "./position-utils.js";

// Replay speed encoding (#1202)
export { replaySpeedFromTelemetry, replaySpeedToSdk } from "./replay-speed.js";

// Gap utilities (#933)
export {
  appendProgressSample,
  classifyGapTrend,
  crossingTimeAt,
  GAP_TRACE_MIN_STEP,
  GAP_TRACE_SPAN_LAPS,
  type GapTrendDirection,
  lapDeltaBetween,
  type ProgressSample,
  type ProgressTrace,
  recentProgressRate,
  resolveClassNeighbors,
  type StandingsNeighbors,
} from "./gap-utils.js";

// Wind utilities (#947). Only the symbols with production consumers are
// re-exported here — the rest stay module-local so they don't become public
// API nothing calls; the unit tests import them from the module directly.
export {
  absoluteWindBearingDeg,
  compassPoint,
  formatWindSpeed,
  isCalmWind,
  normalizeDegrees,
  relativeWindAngleDeg,
  type WindSpeedUnit,
} from "./wind-utils.js";

// Qualifying-grid utilities (#974) — the pre-green starting order from session YAML
export {
  calculateGridPositions,
  extractQualifyResults,
  type QualifyResult,
  type QualifyResultEntry,
} from "./grid-utils.js";

// iRating estimation utilities (#268, #872)
export {
  calculateIRatingChanges,
  calculateSof,
  estimateIRatingChanges,
  type IRatingEstimateInput,
  type IRatingEstimateOrderSources,
  type IRatingEstimates,
  type IRatingFieldDriver,
  type IRatingRaceResult,
  resolveIRatingEstimateOrder,
} from "./irating-utils.js";

// Flag utilities
export { type FlagInfo, FLAG_DEFINITIONS, resolveActiveFlag, resolveAllActiveFlags } from "./flag-utils.js";

// Penalty flag utilities (#936)
export { decodePenaltyFlags, PENALTY_FLAG_MASK, type CarPenaltyFlags } from "./penalty-flag-utils.js";

// Telemetry feature detection (car-capability + session-phase helpers), and
// the debounced replay state (#1324): the pure rule here, the holder that
// sequences it (`ReplayStateTracker`) below — `SDKController` keeps the
// production instance, the harness mock and the action tests' stand-in one each
export {
  getTireChangeGranularity,
  hasPitLimiter,
  hasVisor,
  hasWipers,
  initialReplayState,
  isLiveOnTrack,
  isPenaltyFlagActive,
  isPostRace,
  isPreGreen,
  nextReplayState,
  REPLAY_EXIT_GRACE_MS,
  replayLeftForLive,
  type ReplayState,
  replayStateAt,
  resolveReplayFrame,
  type TireChangeGranularity,
} from "./telemetry-features.js";
export { ReplayStateTracker } from "./replay-state-tracker.js";

// Session limits (#1109) — sentinel decoding and the whichever-ends-sooner
// rule shared by the fuel callouts, Session Info and the template context,
// and the one clock formatter the last two show the time side through (#1292)
export {
  type BindingLimit,
  bindingLapsToGo,
  formatSessionClock,
  resolveBindingLimit,
  resolveLapsRemaining,
  resolveShownTimeRemainingS,
  resolveTimeRemainingS,
} from "./session-limit.js";

// Session info utilities
export {
  type CameraGroup,
  type CameraInGroup,
  type CarNumberTargetClass,
  classifyCarNumberTarget,
  getCameraGroupsFromSessionInfo,
  getCamerasInGroup,
  getCarNumberFromSessionInfo,
  getCarNumberRawFromSessionInfo,
  getPlayerCarNumberFromSessionInfo,
  getAllCarNumbers,
  isReplayOnlySession,
} from "./session-utils.js";

// Telemetry snapshot formatting utilities
export {
  type DriverInfo,
  type MarkdownSection,
  type SnapshotEnvelope,
  buildDriverDetailsTable,
  buildDriverList,
  buildMarkdownTable,
  buildPlayerTelemetry,
  buildSnapshotEnvelope,
  formatSnapshotJson,
  generateMarkdown,
  getSessionIdentification,
  SNAPSHOT_INLINE_OBJECT_MAX_KEYS,
  snapshotBaseName,
  snapshotTimestamp,
  trkLocToString,
} from "./snapshot.js";
