/**
 * @iracedeck/iracing-sdk
 *
 * iRacing SDK for Node.js - telemetry reading and broadcast commands
 */

// Main SDK class
export { IRacingSDK } from "./IRacingSDK.js";

// SDK Controller (manages connections and subscribers)
export { SDKController, TelemetryCallback } from "./SDKController.js";

// Interfaces for dependency injection
export type { INativeSDK } from "./interfaces.js";

// Factory functions for easy SDK creation
export { createSDK, createCommands, type SDKBundle, type Commands } from "./factory.js";

// Re-export logger types for convenience
export { ILogger, consoleLogger, silentLogger, LogLevel } from "@iracedeck/logger";

// Types and enums
export {
  // Constants
  IRSDK_MAX_BUFS,
  IRSDK_MAX_STRING,
  IRSDK_MAX_DESC,
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
export { resolveTemplate, resolvePathValue } from "./template-resolver.js";
export {
  buildTemplateContext,
  buildTemplateContextFromData,
  splitDriverName,
  findNearestDriverOnTrack,
  findDriverByRacePosition,
  formatTimeRemaining,
  type TemplateContext,
  type DriverFields,
  type SelfDriverFields,
} from "./template-context.js";
