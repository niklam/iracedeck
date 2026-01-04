/**
 * iRacing SDK Type Definitions
 * TypeScript version of irsdk_defines.h from the official iRacing SDK
 */

// ============================================================================
// Constants
// ============================================================================

export const IRSDK_DATAVALIDEVENTNAME = "Local\\IRSDKDataValidEvent";
export const IRSDK_MEMMAPFILENAME = "Local\\IRSDKMemMapFileName";
export const IRSDK_BROADCASTMSGNAME = "IRSDK_BROADCASTMSG";

export const IRSDK_MAX_BUFS = 4;
export const IRSDK_MAX_STRING = 32;
export const IRSDK_MAX_DESC = 64;

export const IRSDK_UNLIMITED_LAPS = 32767;
export const IRSDK_UNLIMITED_TIME = 604800.0;

export const IRSDK_VER = 2;

// ============================================================================
// Status
// ============================================================================

export enum StatusField {
  Connected = 1,
}

// ============================================================================
// Variable Types
// ============================================================================

export enum VarType {
  Char = 0,
  Bool = 1,
  Int = 2,
  BitField = 3,
  Float = 4,
  Double = 5,
}

export const VarTypeBytes: Record<VarType, number> = {
  [VarType.Char]: 1,
  [VarType.Bool]: 1,
  [VarType.Int]: 4,
  [VarType.BitField]: 4,
  [VarType.Float]: 4,
  [VarType.Double]: 8,
};

// ============================================================================
// Track Location & Surface
// ============================================================================

export enum TrkLoc {
  NotInWorld = -1,
  OffTrack = 0,
  InPitStall = 1,
  AproachingPits = 2,
  OnTrack = 3,
}

export enum TrkSurf {
  NotInWorld = -1,
  Undefined = 0,
  Asphalt1 = 1,
  Asphalt2 = 2,
  Asphalt3 = 3,
  Asphalt4 = 4,
  Concrete1 = 5,
  Concrete2 = 6,
  RacingDirt1 = 7,
  RacingDirt2 = 8,
  Paint1 = 9,
  Paint2 = 10,
  Rumble1 = 11,
  Rumble2 = 12,
  Rumble3 = 13,
  Rumble4 = 14,
  Grass1 = 15,
  Grass2 = 16,
  Grass3 = 17,
  Grass4 = 18,
  Dirt1 = 19,
  Dirt2 = 20,
  Dirt3 = 21,
  Dirt4 = 22,
  Sand = 23,
  Gravel1 = 24,
  Gravel2 = 25,
  Grasscrete = 26,
  Astroturf = 27,
}

// ============================================================================
// Session State
// ============================================================================

export enum SessionState {
  Invalid = 0,
  GetInCar = 1,
  Warmup = 2,
  ParadeLaps = 3,
  Racing = 4,
  Checkered = 5,
  CoolDown = 6,
}

// ============================================================================
// Car Left/Right (Spotter)
// ============================================================================

export enum CarLeftRight {
  Off = 0,
  Clear = 1,
  CarLeft = 2,
  CarRight = 3,
  CarLeftRight = 4,
  TwoCarsLeft = 5,
  TwoCarsRight = 6,
}

// ============================================================================
// Pit Service
// ============================================================================

export enum PitSvStatus {
  None = 0,
  InProgress = 1,
  Complete = 2,
  TooFarLeft = 100,
  TooFarRight = 101,
  TooFarForward = 102,
  TooFarBack = 103,
  BadAngle = 104,
  CantFixThat = 105,
}

export enum PitSvFlags {
  LFTireChange = 0x0001,
  RFTireChange = 0x0002,
  LRTireChange = 0x0004,
  RRTireChange = 0x0008,
  FuelFill = 0x0010,
  WindshieldTearoff = 0x0020,
  FastRepair = 0x0040,
}

// ============================================================================
// Pace Mode & Flags
// ============================================================================

export enum PaceMode {
  SingleFileStart = 0,
  DoubleFileStart = 1,
  SingleFileRestart = 2,
  DoubleFileRestart = 3,
  NotPacing = 4,
}

export enum PaceFlags {
  EndOfLine = 0x0001,
  FreePass = 0x0002,
  WavedAround = 0x0004,
}

// ============================================================================
// Track Wetness
// ============================================================================

export enum TrackWetness {
  Unknown = 0,
  Dry = 1,
  MostlyDry = 2,
  VeryLightlyWet = 3,
  LightlyWet = 4,
  ModeratelyWet = 5,
  VeryWet = 6,
  ExtremelyWet = 7,
}

// ============================================================================
// Incidents
// ============================================================================

export enum IncidentFlags {
  // Incident report flags (first byte)
  RepNoReport = 0x0000,
  RepOutOfControl = 0x0001,
  RepOffTrack = 0x0002,
  RepOffTrackOngoing = 0x0003,
  RepContactWithWorld = 0x0004,
  RepCollisionWithWorld = 0x0005,
  RepCollisionWithWorldOngoing = 0x0006,
  RepContactWithCar = 0x0007,
  RepCollisionWithCar = 0x0008,

  // Incident penalty flags (second byte)
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  PenNoReport = 0x0000,
  PenZeroX = 0x0100,
  PenOneX = 0x0200,
  PenTwoX = 0x0300,
  PenFourX = 0x0400,
}

export const INCIDENT_REP_MASK = 0x000000ff;
export const INCIDENT_PEN_MASK = 0x0000ff00;

// ============================================================================
// Engine Warnings (Bitfield)
// ============================================================================

export enum EngineWarnings {
  WaterTempWarning = 0x0001,
  FuelPressureWarning = 0x0002,
  OilPressureWarning = 0x0004,
  EngineStalled = 0x0008,
  PitSpeedLimiter = 0x0010,
  RevLimiterActive = 0x0020,
  OilTempWarning = 0x0040,
  MandRepNeeded = 0x0080,
  OptRepNeeded = 0x0100,
}

// ============================================================================
// Session Flags (Bitfield)
// ============================================================================

export enum Flags {
  // Global flags
  Checkered = 0x00000001,
  White = 0x00000002,
  Green = 0x00000004,
  Yellow = 0x00000008,
  Red = 0x00000010,
  Blue = 0x00000020,
  Debris = 0x00000040,
  Crossed = 0x00000080,
  YellowWaving = 0x00000100,
  OneLapToGreen = 0x00000200,
  GreenHeld = 0x00000400,
  TenToGo = 0x00000800,
  FiveToGo = 0x00001000,
  RandomWaving = 0x00002000,
  Caution = 0x00004000,
  CautionWaving = 0x00008000,

  // Driver black flags
  Black = 0x00010000,
  Disqualify = 0x00020000,
  Servicible = 0x00040000,
  Furled = 0x00080000,
  Repair = 0x00100000,
  DqScoringInvalid = 0x00200000,

  // Start lights
  StartHidden = 0x10000000,
  StartReady = 0x20000000,
  StartSet = 0x40000000,
  StartGo = 0x80000000,
}

// ============================================================================
// Camera State (Bitfield)
// ============================================================================

export enum CameraState {
  IsSessionScreen = 0x0001,
  IsScenicActive = 0x0002,
  CamToolActive = 0x0004,
  UIHidden = 0x0008,
  UseAutoShotSelection = 0x0010,
  UseTemporaryEdits = 0x0020,
  UseKeyAcceleration = 0x0040,
  UseKey10xAcceleration = 0x0080,
  UseMouseAimMode = 0x0100,
}

// ============================================================================
// Broadcast Messages
// ============================================================================

export enum BroadcastMsg {
  CamSwitchPos = 0,
  CamSwitchNum = 1,
  CamSetState = 2,
  ReplaySetPlaySpeed = 3,
  ReplaySetPlayPosition = 4,
  ReplaySearch = 5,
  ReplaySetState = 6,
  ReloadTextures = 7,
  ChatCommand = 8,
  PitCommand = 9,
  TelemCommand = 10,
  FFBCommand = 11,
  ReplaySearchSessionTime = 12,
  VideoCapture = 13,
  Last = 14,
}

export enum ChatCommandMode {
  Macro = 0,
  BeginChat = 1,
  Reply = 2,
  Cancel = 3,
}

export enum PitCommandMode {
  Clear = 0,
  WS = 1,
  Fuel = 2,
  LF = 3,
  RF = 4,
  LR = 5,
  RR = 6,
  ClearTires = 7,
  FR = 8,
  ClearWS = 9,
  ClearFR = 10,
  ClearFuel = 11,
  TC = 12,
}

export enum TelemCommandMode {
  Stop = 0,
  Start = 1,
  Restart = 2,
}

export enum ReplayStateMode {
  EraseTape = 0,
  Last = 1,
}

export enum ReloadTexturesMode {
  All = 0,
  CarIdx = 1,
}

export enum ReplaySearchMode {
  ToStart = 0,
  ToEnd = 1,
  PrevSession = 2,
  NextSession = 3,
  PrevLap = 4,
  NextLap = 5,
  PrevFrame = 6,
  NextFrame = 7,
  PrevIncident = 8,
  NextIncident = 9,
  Last = 10,
}

export enum ReplayPosMode {
  Begin = 0,
  Current = 1,
  End = 2,
  Last = 3,
}

export enum FFBCommandMode {
  MaxForce = 0,
  Last = 1,
}

export enum CameraFocusMode {
  FocusAtIncident = -3,
  FocusAtLeader = -2,
  FocusAtExiting = -1,
  FocusAtDriver = 0,
}

export enum VideoCaptureMode {
  TriggerScreenShot = 0,
  StartVideoCapture = 1,
  EndVideoCapture = 2,
  ToggleVideoCapture = 3,
  ShowVideoTimer = 4,
  HideVideoTimer = 5,
}

// ============================================================================
// Additional Enums (not in irsdk_defines.h but commonly used)
// ============================================================================

export enum Skies {
  Clear = 0,
  PartlyCloudy = 1,
  MostlyCloudy = 2,
  Overcast = 3,
}

export enum DisplayUnits {
  English = 0,
  Metric = 1,
}

export enum EnterExitReset {
  Enter = 0,
  Exit = 1,
  Reset = 2,
}

// ============================================================================
// Structures
// ============================================================================

export interface VarHeader {
  type: VarType;
  offset: number;
  count: number;
  countAsTime: boolean;
  name: string;
  desc: string;
  unit: string;
}

export interface VarBuf {
  tickCount: number;
  bufOffset: number;
}

export interface IRSDKHeader {
  ver: number;
  status: number;
  tickRate: number;
  sessionInfoUpdate: number;
  sessionInfoLen: number;
  sessionInfoOffset: number;
  numVars: number;
  varHeaderOffset: number;
  numBuf: number;
  bufLen: number;
}

// ============================================================================
// Telemetry Data Interface
// ============================================================================

/**
 * Parsed telemetry data from iRacing
 * All properties are optional as availability depends on car/session type
 */
export interface TelemetryData {
  [key: string]: number | boolean | string | number[] | boolean[] | undefined;

  // Environment
  AirDensity?: number;
  AirPressure?: number;
  AirTemp?: number;
  FogLevel?: number;
  RelativeHumidity?: number;
  Skies?: number;
  SolarAltitude?: number;
  SolarAzimuth?: number;
  TrackTempCrew?: number;
  TrackWetness?: number;
  WindDir?: number;
  WindVel?: number;
  Precipitation?: number;
  WeatherDeclaredWet?: boolean;

  // Driver Inputs
  Brake?: number;
  BrakeRaw?: number;
  BrakeABSactive?: boolean;
  Clutch?: number;
  ClutchRaw?: number;
  Throttle?: number;
  ThrottleRaw?: number;
  SteeringWheelAngle?: number;
  SteeringWheelAngleMax?: number;
  HandbrakeRaw?: number;

  // Vehicle State
  Gear?: number;
  RPM?: number;
  Speed?: number;
  FuelLevel?: number;
  FuelLevelPct?: number;
  FuelUsePerHour?: number;
  FuelPress?: number;
  OilLevel?: number;
  OilPress?: number;
  OilTemp?: number;
  WaterLevel?: number;
  WaterTemp?: number;
  Voltage?: number;
  ManifoldPress?: number;
  EngineWarnings?: number;

  // Physics
  LatAccel?: number;
  LongAccel?: number;
  VertAccel?: number;
  VelocityX?: number;
  VelocityY?: number;
  VelocityZ?: number;
  Pitch?: number;
  PitchRate?: number;
  Roll?: number;
  RollRate?: number;
  Yaw?: number;
  YawNorth?: number;
  YawRate?: number;

  // Tire Data - Left Front
  LFcoldPressure?: number;
  LFtempCL?: number;
  LFtempCM?: number;
  LFtempCR?: number;
  LFwearL?: number;
  LFwearM?: number;
  LFwearR?: number;
  LFshockDefl?: number;
  LFshockVel?: number;
  LFbrakeLinePress?: number;

  // Tire Data - Right Front
  RFcoldPressure?: number;
  RFtempCL?: number;
  RFtempCM?: number;
  RFtempCR?: number;
  RFwearL?: number;
  RFwearM?: number;
  RFwearR?: number;
  RFshockDefl?: number;
  RFshockVel?: number;
  RFbrakeLinePress?: number;

  // Tire Data - Left Rear
  LRcoldPressure?: number;
  LRtempCL?: number;
  LRtempCM?: number;
  LRtempCR?: number;
  LRwearL?: number;
  LRwearM?: number;
  LRwearR?: number;
  LRshockDefl?: number;
  LRshockVel?: number;
  LRbrakeLinePress?: number;

  // Tire Data - Right Rear
  RRcoldPressure?: number;
  RRtempCL?: number;
  RRtempCM?: number;
  RRtempCR?: number;
  RRwearL?: number;
  RRwearM?: number;
  RRwearR?: number;
  RRshockDefl?: number;
  RRshockVel?: number;
  RRbrakeLinePress?: number;

  // Lap & Timing
  Lap?: number;
  LapCompleted?: number;
  LapBestLap?: number;
  LapBestLapTime?: number;
  LapLastLapTime?: number;
  LapCurrentLapTime?: number;
  LapDist?: number;
  LapDistPct?: number;
  LapDeltaToBestLap?: number;
  LapDeltaToBestLap_OK?: boolean;
  LapDeltaToOptimalLap?: number;
  LapDeltaToSessionBestLap?: number;
  RaceLaps?: number;

  // Session Info
  SessionNum?: number;
  SessionState?: number;
  SessionFlags?: number;
  SessionTime?: number;
  SessionTimeRemain?: number;
  SessionTimeTotal?: number;
  SessionTimeOfDay?: number;
  SessionLapsRemainEx?: number;
  SessionLapsTotal?: number;
  SessionUniqueID?: number;
  SessionTick?: number;

  // Player Car Info
  PlayerCarIdx?: number;
  PlayerCarPosition?: number;
  PlayerCarClassPosition?: number;
  PlayerCarClass?: number;
  PlayerCarInPitStall?: boolean;
  PlayerCarSLFirstRPM?: number;
  PlayerCarSLShiftRPM?: number;
  PlayerCarSLLastRPM?: number;
  PlayerCarSLBlinkRPM?: number;
  PlayerCarMyIncidentCount?: number;
  PlayerCarDriverIncidentCount?: number;
  PlayerCarTeamIncidentCount?: number;
  PlayerCarTowTime?: number;
  PlayerCarWeightPenalty?: number;
  PlayerCarPowerAdjust?: number;
  PlayerTrackSurface?: number;
  PlayerTrackSurfaceMaterial?: number;
  PlayerTireCompound?: number;
  PlayerFastRepairsUsed?: number;

  // On Track Status
  IsOnTrack?: boolean;
  IsOnTrackCar?: boolean;
  IsInGarage?: boolean;
  OnPitRoad?: boolean;
  CarLeftRight?: number;
  PitsOpen?: boolean;
  PitstopActive?: boolean;
  PaceMode?: number;

  // Pit Service
  PitSvFlags?: number;
  PitSvFuel?: number;
  PitSvLFP?: number;
  PitSvRFP?: number;
  PitSvLRP?: number;
  PitSvRRP?: number;
  PitSvTireCompound?: number;
  PitRepairLeft?: number;
  PitOptRepairLeft?: number;
  FastRepairAvailable?: number;
  FastRepairUsed?: number;

  // Camera & Replay
  CamCameraNumber?: number;
  CamGroupNumber?: number;
  CamCarIdx?: number;
  CamCameraState?: number;
  IsReplayPlaying?: boolean;
  ReplayFrameNum?: number;
  ReplayPlaySpeed?: number;
  ReplayPlaySlowMotion?: boolean;
  ReplaySessionNum?: number;
  ReplaySessionTime?: number;

  // Force Feedback
  SteeringFFBEnabled?: boolean;
  SteeringWheelMaxForceNm?: number;
  SteeringWheelPeakForceNm?: number;
  SteeringWheelTorque?: number;
  SteeringWheelLimiter?: number;
  SteeringWheelPctTorque?: number;
  SteeringWheelPctDamper?: number;

  // Car Index Arrays (64 cars)
  CarIdxLap?: number[];
  CarIdxLapCompleted?: number[];
  CarIdxLapDistPct?: number[];
  CarIdxTrackSurface?: number[];
  CarIdxTrackSurfaceMaterial?: number[];
  CarIdxOnPitRoad?: boolean[];
  CarIdxPosition?: number[];
  CarIdxClassPosition?: number[];
  CarIdxClass?: number[];
  CarIdxGear?: number[];
  CarIdxRPM?: number[];
  CarIdxSteer?: number[];
  CarIdxSessionFlags?: number[];
  CarIdxPaceFlags?: number[];
  CarIdxPaceLine?: number[];
  CarIdxPaceRow?: number[];
  CarIdxBestLapTime?: number[];
  CarIdxBestLapNum?: number[];
  CarIdxLastLapTime?: number[];
  CarIdxEstTime?: number[];
  CarIdxF2Time?: number[];
  CarIdxFastRepairsUsed?: number[];
  CarIdxTireCompound?: number[];
  CarIdxQualTireCompound?: number[];
  CarIdxP2P_Count?: number[];
  CarIdxP2P_Status?: boolean[];

  // Misc
  DisplayUnits?: number;
  DriverMarker?: boolean;
  PushToTalk?: boolean;
  PushToPass?: boolean;
  IsDiskLoggingEnabled?: boolean;
  IsDiskLoggingActive?: boolean;
  FrameRate?: number;
  CpuUsageFG?: number;
  CpuUsageBG?: number;
  GpuUsage?: number;
}

/**
 * Session info (YAML data parsed to object)
 */
export interface SessionInfo {
  [key: string]: unknown;
}
