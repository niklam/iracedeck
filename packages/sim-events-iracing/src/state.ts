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

/** Per-service debounce tracker for single-bit pit-service toggles. */
export type ServiceDebounceState = {
  pendingAt: number; // 0 = stable; >0 = ms timestamp of most recent flip
  lastSeen: boolean; // most recent observed bit value
};

/**
 * Committed pit-service snapshot used by the pit-readback diff (issue #476).
 * Captured on `pitLane.entered` and refreshed on every user-intent toggle
 * event (`pitService.toggled` / `tireService.changed` / `tireService.compoundChanged`)
 * so it reflects the driver's intent — not the bit-cleared post-service
 * state visible at exit. Held in state so the delayed pit-exit fire reads
 * the same snapshot the entry / refire emits used.
 */
export type PitReadbackCommittedSnapshot = {
  fuel: { queued: boolean };
  tires: { lf: boolean; rf: boolean; lr: boolean; rr: boolean };
  compoundChange: { from: number; to: number } | null;
  fastRepair: { queued: boolean; available: boolean };
  windshield: { queued: boolean; available: boolean };
  limiterEngaged: boolean;
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
  lastPitSvFlags: number; // For tire & pit-service bits this is the BASELINE (last emitted), not "previous tick".
  lastPitSvCompound: number;
  lastLimiterActive: boolean;
  lastP2PActive: boolean;
  lastDrsActive: boolean;
  // Pit-service debounce — coalesce iRacing's multi-tick transitions and
  // the user's rapid intent oscillations (e.g. accidental tap-tap on a
  // button). Each service tracks its own last-seen value and the
  // timestamp of the most recent flip; an event emits only after the bit
  // has been stable for the debounce window.
  fuelDebounce: ServiceDebounceState;
  windshieldDebounce: ServiceDebounceState;
  fastRepairDebounce: ServiceDebounceState;
  // Tire debounce — same model but over a 4-bit set rather than a single bit.
  lastSeenTireFlags: number; // most recent observed tire bits (any tick)
  lastTireChangeAt: number; // 0 = stable; >0 = ms timestamp of most recent tire flag flip

  // ── Pit-service readback (issue #476) ──────────────────────────────────
  pitReadbackInitialized: boolean;
  pitReadbackPrevOnPitRoad: boolean;
  pitReadbackExitFireAt: number; // 0 = none scheduled; >0 = ms timestamp to emit at
  /**
   * Pit-action confirmation cooldown. While `now < pitActionCooldownUntil`,
   * per-toggle confirmation scenarios stay silent. Set on `pitLane.exited`
   * (matches the readback exit delay so pit-actions don't blurt over the
   * pending "to confirm" beat) and on pre-start transitions (so iRacing's
   * grid-load pit-flag seeding doesn't fire phantom callouts).
   */
  pitActionCooldownUntil: number;
  /**
   * Pre-start auto-readback. Set on the pre-start enter transition and
   * fires once `now >= pitReadbackPreStartFireAt`. The snapshot is
   * built fresh from current telemetry at fire time so any toggle the
   * user makes during the muted-pit-actions window is reflected in
   * the recap (otherwise the user could change fuel/tires on the grid
   * and still hear a stale plan from grid entry).
   */
  pitReadbackPreStartFireAt: number;
  /**
   * Tracks the iRacing pre-start state (`PaceMode === SingleFileStart |
   * DoubleFileStart` AND `SessionState === ParadeLaps | Warmup |
   * GetInCar`) for edge detection. Reference: `ir_isPreStart()` in the
   * iRacing pit-board project.
   */
  lastTickInPreStart: boolean;

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
    fuelDebounce: { pendingAt: 0, lastSeen: false },
    windshieldDebounce: { pendingAt: 0, lastSeen: false },
    fastRepairDebounce: { pendingAt: 0, lastSeen: false },
    lastSeenTireFlags: 0,
    lastTireChangeAt: 0,

    pitReadbackInitialized: false,
    pitReadbackPrevOnPitRoad: false,
    pitReadbackExitFireAt: 0,
    pitActionCooldownUntil: 0,
    pitReadbackPreStartFireAt: 0,
    lastTickInPreStart: false,

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
