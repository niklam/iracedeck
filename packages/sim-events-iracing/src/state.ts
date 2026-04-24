/**
 * Translator state struct — carries the "previous tick" data needed to
 * detect transitions. Held by the translator singleton and passed to each
 * diff module on every tick.
 *
 * Initial state uses sentinel values (negative / null / empty sets) so the
 * first tick after connect seeds without firing spurious transition events.
 */
import type { RadarState } from "@iracedeck/event-bus";

export type MaterialSample = {
  t: number; // timestamp (ms since epoch)
  material: number; // TrkSurf-like enum value
};

export type TranslatorState = {
  // ── Pit lane / stall ────────────────────────────────────────────────────
  pitLaneInitialized: boolean;
  lastOnPitRoad: boolean;
  lastInPitStall: boolean;
  approachExitingSuppressed: boolean;
  approachAlertFired: boolean;

  // ── Flags ───────────────────────────────────────────────────────────────
  flagStateInitialized: boolean;
  activeFlags: Set<string>;
  lastYellowScope: "local" | "full" | null;

  // ── Toggles (pit service, car control) ──────────────────────────────────
  toggleStateInitialized: boolean;
  lastPitSvFlags: number;
  lastPitSvCompound: number;
  lastLimiterActive: boolean;
  lastP2PActive: boolean;
  lastDrsActive: boolean;

  // ── Pit limiter warnings ────────────────────────────────────────────────
  limiterInitialized: boolean;
  lastOnPitRoadForLimiter: boolean;
  lastLimiterOnPitRoad: boolean;
  speedingWarnedAt: number;

  // ── Incidents / off-track ───────────────────────────────────────────────
  lastIncidentCount: number; // -1 = not seeded
  offTrackStartedAt: number; // 0 = on track
  offTrackWarnedThisExcursion: boolean;
  materialHistory: MaterialSample[];
  offTrackPending: boolean; // true between offTrack.started and offTrack.ended

  // ── Overtakes ───────────────────────────────────────────────────────────
  overtakeInitialized: boolean;
  lastPosition: number;
  pendingOvertakePos: number;
  pendingOvertakeTime: number;
  lastConfirmedOvertakeCarIdx: number;

  // ── Radar ─────────────────────────────────────────────────────────────
  radarState: RadarState;

  // ── Fuel thresholds ─────────────────────────────────────────────────────
  fuelLastLap: number;
  fuelAtLapStart: number | null;
  fuelHistory: number[];
  fuelFiredThresholds: Set<number>;
  lastLapsRemaining: number | null;

  // ── Lifecycle ───────────────────────────────────────────────────────────
  lifecycleInitialized: boolean;
  firstOnTrackFired: boolean;
  lastSessionNum: number | null;
  lastEngineRunning: boolean;
  lastLap: number;
};

export function createInitialState(): TranslatorState {
  return {
    pitLaneInitialized: false,
    lastOnPitRoad: false,
    lastInPitStall: false,
    approachExitingSuppressed: false,
    approachAlertFired: false,

    flagStateInitialized: false,
    activeFlags: new Set(),
    lastYellowScope: null,

    toggleStateInitialized: false,
    lastPitSvFlags: 0,
    lastPitSvCompound: 0,
    lastLimiterActive: false,
    lastP2PActive: false,
    lastDrsActive: false,

    limiterInitialized: false,
    lastOnPitRoadForLimiter: false,
    lastLimiterOnPitRoad: false,
    speedingWarnedAt: 0,

    lastIncidentCount: -1,
    offTrackStartedAt: 0,
    offTrackWarnedThisExcursion: false,
    materialHistory: [],
    offTrackPending: false,

    overtakeInitialized: false,
    lastPosition: -1,
    pendingOvertakePos: -1,
    pendingOvertakeTime: 0,
    lastConfirmedOvertakeCarIdx: -1,

    radarState: "clear",

    fuelLastLap: -1,
    fuelAtLapStart: null,
    fuelHistory: [],
    fuelFiredThresholds: new Set(),
    lastLapsRemaining: null,

    lifecycleInitialized: false,
    firstOnTrackFired: false,
    lastSessionNum: null,
    lastEngineRunning: false,
    lastLap: -1,
  };
}
