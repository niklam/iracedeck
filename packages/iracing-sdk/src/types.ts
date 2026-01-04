/**
 * iRacing SDK type definitions
 * Re-exports from @iracedeck/iracing-native for convenience
 */

// Re-export all types and enums from native package
export {
  // Constants
  IRSDK_MAX_BUFS,
  IRSDK_MAX_STRING,
  IRSDK_MAX_DESC,
  IRSDK_UNLIMITED_LAPS,
  IRSDK_UNLIMITED_TIME,
  IRSDK_VER,
  INCIDENT_REP_MASK,
  INCIDENT_PEN_MASK,

  // Core types
  VarType,
  VarTypeBytes,
  StatusField,

  // Interfaces
  type VarHeader,
  type VarBuf,
  type IRSDKHeader,
  type TelemetryData,
  type SessionInfo,

  // Track enums
  TrkLoc,
  TrkSurf,

  // Session enums
  SessionState,

  // Car enums
  CarLeftRight,

  // Pit enums
  PitSvStatus,
  PitSvFlags,

  // Pace enums
  PaceMode,
  PaceFlags,

  // Weather enums
  TrackWetness,
  Skies,

  // Flag enums
  IncidentFlags,
  EngineWarnings,
  Flags,
  CameraState,

  // Display enums
  DisplayUnits,
  EnterExitReset,
} from "@iracedeck/iracing-native";

// Re-export utility functions for easy access
export {
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
} from "./utils.js";
