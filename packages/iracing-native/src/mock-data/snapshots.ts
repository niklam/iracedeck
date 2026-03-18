/**
 * Mock telemetry snapshots.
 *
 * Three snapshots that rotate every few seconds to simulate a car
 * driving around the track. These are placeholder values — replace
 * with real telemetry captures for more accurate simulation.
 */
import { Flags, PitSvFlags, SessionState, TrkLoc } from "../defines.js";
import type { MockSnapshotValues } from "./telemetry.js";

/** Create a 64-element array with default value, setting specific car values */
function carArray(defaultVal: number, carValues: Record<number, number>): number[] {
  const arr = new Array<number>(64).fill(defaultVal);

  for (const [idx, val] of Object.entries(carValues)) {
    arr[Number(idx)] = val;
  }

  return arr;
}

function carBoolArray(defaultVal: boolean, carValues: Record<number, boolean>): boolean[] {
  const arr = new Array<boolean>(64).fill(defaultVal);

  for (const [idx, val] of Object.entries(carValues)) {
    arr[Number(idx)] = val;
  }

  return arr;
}

/**
 * Snapshot 1: Mid-straight (Kemmel Straight)
 * High speed, high RPM, full throttle, 5th gear
 */
export const SNAPSHOT_MID_STRAIGHT: MockSnapshotValues = {
  // Session
  SessionTime: 245.0,
  SessionTick: 14700,
  SessionNum: 0,
  SessionState: SessionState.Racing,
  SessionFlags: Flags.Green,
  SessionTimeRemain: 3355.0,

  // Player car
  PlayerCarIdx: 0,
  PlayerCarPosition: 1,
  PlayerCarClassPosition: 1,
  PlayerCarInPitStall: false,
  PlayerTrackSurface: TrkLoc.OnTrack,
  PlayerCarMyIncidentCount: 0,

  // Vehicle state
  Speed: 75.5, // ~272 km/h
  RPM: 7800.0,
  Gear: 5,
  Throttle: 1.0,
  Brake: 0.0,
  Clutch: 1.0,
  SteeringWheelAngle: 0.02,
  FuelLevel: 85.5,
  FuelLevelPct: 0.777,
  FuelUsePerHour: 42.5,
  OilTemp: 98.0,
  WaterTemp: 82.0,
  Voltage: 13.8,
  EngineWarnings: 0,

  // Lap & timing
  Lap: 3,
  LapCompleted: 2,
  LapDistPct: 0.35,
  LapCurrentLapTime: 48.2,
  LapBestLapTime: 137.5,
  LapLastLapTime: 138.2,
  LapDeltaToBestLap: -0.3,
  LapDeltaToBestLap_OK: true,

  // On track status
  IsOnTrack: true,
  IsOnTrackCar: true,
  IsInGarage: false,
  OnPitRoad: false,
  PitstopActive: false,

  // Pit service
  PitSvFlags:
    PitSvFlags.FuelFill |
    PitSvFlags.LFTireChange |
    PitSvFlags.RFTireChange |
    PitSvFlags.LRTireChange |
    PitSvFlags.RRTireChange,
  PitSvFuel: 50.0,
  PitRepairLeft: 0.0,
  PitOptRepairLeft: 0.0,
  FastRepairAvailable: 1,
  FastRepairUsed: 0,

  // Physics
  LatAccel: 0.5,
  LongAccel: 2.1,

  // Camera
  CamCarIdx: 0,
  CamGroupNumber: 6,

  // Car index arrays
  CarIdxLap: carArray(-1, { 0: 3, 1: 3, 2: 2 }),
  CarIdxLapDistPct: carArray(-1, { 0: 0.35, 1: 0.32, 2: 0.28 }),
  CarIdxOnPitRoad: carBoolArray(false, {}),
  CarIdxPosition: carArray(0, { 0: 1, 1: 2, 2: 3 }),
  CarIdxClassPosition: carArray(0, { 0: 1, 1: 2, 2: 3 }),
  CarIdxTrackSurface: carArray(TrkLoc.NotInWorld, { 0: TrkLoc.OnTrack, 1: TrkLoc.OnTrack, 2: TrkLoc.OnTrack }),

  // Display
  DisplayUnits: 1, // Metric

  // Environment
  AirTemp: 25.56,
  TrackTempCrew: 32.22,
  Skies: 1, // Partly Cloudy
};

/**
 * Snapshot 2: Braking zone (La Source)
 * Heavy braking, downshift, low speed
 */
export const SNAPSHOT_BRAKING: MockSnapshotValues = {
  ...SNAPSHOT_MID_STRAIGHT,
  SessionTime: 248.0,
  SessionTick: 14880,

  Speed: 22.2, // ~80 km/h (hard braking)
  RPM: 4200.0,
  Gear: 2,
  Throttle: 0.0,
  Brake: 0.95,
  SteeringWheelAngle: -0.45,
  FuelLevel: 85.2,
  FuelLevelPct: 0.775,

  LapDistPct: 0.38,
  LapCurrentLapTime: 51.2,
  LapDeltaToBestLap: -0.1,

  LatAccel: -8.5,
  LongAccel: -35.0,

  CarIdxLapDistPct: carArray(-1, { 0: 0.38, 1: 0.34, 2: 0.3 }),
};

/**
 * Snapshot 3: Pit entry
 * Low speed, pit road, speed limiter active
 */
export const SNAPSHOT_PIT_ENTRY: MockSnapshotValues = {
  ...SNAPSHOT_MID_STRAIGHT,
  SessionTime: 380.0,
  SessionTick: 22800,

  PlayerTrackSurface: TrkLoc.AproachingPits,

  Speed: 16.7, // ~60 km/h (pit speed limit)
  RPM: 3500.0,
  Gear: 3,
  Throttle: 0.3,
  Brake: 0.0,
  SteeringWheelAngle: 0.1,
  FuelLevel: 25.0,
  FuelLevelPct: 0.227,
  EngineWarnings: 0x0010, // PitSpeedLimiter

  Lap: 4,
  LapCompleted: 3,
  LapDistPct: 0.12,
  LapCurrentLapTime: 16.8,
  LapLastLapTime: 137.8,

  OnPitRoad: true,

  LatAccel: 0.0,
  LongAccel: 0.0,

  CarIdxLap: carArray(-1, { 0: 4, 1: 4, 2: 3 }),
  CarIdxLapDistPct: carArray(-1, { 0: 0.12, 1: 0.45, 2: 0.4 }),
  CarIdxOnPitRoad: carBoolArray(false, { 0: true }),
  CarIdxTrackSurface: carArray(TrkLoc.NotInWorld, { 0: TrkLoc.AproachingPits, 1: TrkLoc.OnTrack, 2: TrkLoc.OnTrack }),
};

/**
 * Snapshot 4: Yellow flag (full course caution)
 */
export const SNAPSHOT_YELLOW_FLAG: MockSnapshotValues = {
  ...SNAPSHOT_MID_STRAIGHT,
  SessionTime: 420.0,
  SessionTick: 25200,
  SessionFlags: Flags.Yellow | Flags.Caution,
  Speed: 33.3, // ~120 km/h (slowing under caution)
  Throttle: 0.4,
};

/**
 * Snapshot 5: Blue flag (about to be lapped)
 */
export const SNAPSHOT_BLUE_FLAG: MockSnapshotValues = {
  ...SNAPSHOT_MID_STRAIGHT,
  SessionTime: 460.0,
  SessionTick: 27600,
  SessionFlags: Flags.Green | Flags.Blue,
  PlayerCarPosition: 3,
  PlayerCarClassPosition: 3,
};

/**
 * Snapshot 6: Yellow + Blue flags (caution while being lapped)
 */
export const SNAPSHOT_YELLOW_BLUE_FLAG: MockSnapshotValues = {
  ...SNAPSHOT_MID_STRAIGHT,
  SessionTime: 500.0,
  SessionTick: 30000,
  SessionFlags: Flags.Yellow | Flags.Caution | Flags.Blue,
  Speed: 33.3,
  Throttle: 0.4,
  PlayerCarPosition: 3,
  PlayerCarClassPosition: 3,
};

/**
 * All snapshots in rotation order.
 * Includes flag snapshots so the flag overlay can be tested on non-Windows platforms.
 */
export const MOCK_SNAPSHOTS: MockSnapshotValues[] = [
  SNAPSHOT_MID_STRAIGHT,
  SNAPSHOT_BRAKING,
  SNAPSHOT_PIT_ENTRY,
  SNAPSHOT_YELLOW_FLAG,
  SNAPSHOT_BLUE_FLAG,
  SNAPSHOT_YELLOW_BLUE_FLAG,
];
