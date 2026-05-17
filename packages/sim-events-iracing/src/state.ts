/**
 * Translator state struct — carries the "previous tick" data needed to
 * detect transitions. Held by the translator singleton and passed to each
 * diff module on every tick.
 *
 * Initial state uses sentinel values (negative / null / empty sets) so the
 * first tick after connect seeds without firing spurious transition events.
 */
import { type IncidentType, type RadarState, TrackWetness } from "@iracedeck/event-bus";

export type MaterialSample = {
  t: number; // timestamp (ms since epoch)
  material: number; // TrkSurf-like enum value
};

/** Per-service debounce tracker for single-bit pit-service toggles. */
export type ServiceDebounceState = {
  pendingAt: number; // 0 = stable; >0 = ms timestamp of most recent flip
  lastSeen: boolean; // most recent observed bit value
};

export type TranslatorState = {
  // ── Pit lane / stall ────────────────────────────────────────────────────
  pitLaneInitialized: boolean;
  lastOnPitRoad: boolean;
  lastInPitStall: boolean;
  approachExitingSuppressed: boolean;
  approachAlertFired: boolean;
  /**
   * Whether the current lap began at pit exit. Set true by `diffPitLane`
   * when emitting `pitLane.exited`; cleared by `diffLifecycle` when
   * emitting `lap.started`. Used by the qualifying lap-invalidation
   * snapshot (issue #567) to suppress the callout on the session out-lap
   * and any mid-session post-pit-exit lap — neither is a timed attempt.
   */
  lapStartedFromPits: boolean;

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

  // ── Track wetness (issue #526) ──────────────────────────────────────────
  // Tracks `TelemetryData.TrackWetness` across ticks so the diff can emit one
  // `track.wetness.changed` per real state transition. Seeded silently on
  // first tick; transitions involving Unknown are suppressed by the diff.
  trackWetnessInitialized: boolean;
  lastTrackWetness: TrackWetness;

  // ── Pit-service status (issue #479) ─────────────────────────────────────
  // Tracks PlayerCarPitSvStatus across ticks so the diff can emit one event
  // per transition. Seeded silently on first tick / off-track / in pit stall
  // for the same reason `lastPitSvFlags` is — the user isn't responsible for
  // those state changes and the engineer should stay silent on connect /
  // garage returns. Closing transitions (* → None) are suppressed in the
  // diff itself, not via baseline juggling.
  pitStatusInitialized: boolean;
  lastPitSvStatus: number; // PitSvStatus enum value

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
  // Latch for the transient `PlayerIncidents` byte (issue #530). iRacing
  // sets the IncidentFlags byte for ~one 16 ms tick then clears it, BEFORE
  // PlayerCarMyIncidentCount visibly increments (~32 ms / 2 frames later).
  // The diff caches the most recent classified type and consumes it when
  // the count delta arrives. Stale entries are rejected via timestamp;
  // `pendingIncidentTypeAt` is 0 when no type is pending.
  pendingIncidentType: IncidentType | null;
  pendingIncidentTypeAt: number; // 0 = no pending; >0 = ms timestamp captured at
  // Burst-coalesce buffer (issue #530). A single physical incident in
  // iRacing (one crash) often arrives as a stream of count increments
  // over ~hundreds of ms — e.g. off-track (1x) → out-of-control (2x) →
  // collision-with-car (4x). Without coalescing, each step fires a
  // separate callout and the engineer talks over himself. We hold the
  // most recent classification + accumulated delta in a buffer and only
  // emit once `INCIDENT_BURST_QUIET_MS` has passed without a new
  // increment, or once `INCIDENT_BURST_MAX_MS` has passed since the
  // first increment in the burst (hard cap so a sustained roll can't
  // delay the announcement indefinitely). `incidentBurstFirstAt` is 0
  // when no burst is pending.
  incidentBurstType: IncidentType | null;
  incidentBurstDelta: number;
  incidentBurstFirstAt: number; // 0 = no pending burst; >0 = ms timestamp of first increment
  incidentBurstLatestAt: number; // ms timestamp of most recent increment in this burst

  // ── Damage (issue #489) ─────────────────────────────────────────────────
  // Rising-edge detection for `EngineWarnings & (MandRepNeeded | OptRepNeeded)`
  // with a debounce window. The baseline is the last *emitted* state — once
  // damage has been announced, we hold that baseline until the bits clear so
  // sustained damage doesn't re-fire. Clear → damage cycles re-fire because
  // the baseline drops back to false on the falling edge (no event emitted).
  damageInitialized: boolean;
  damageBaseline: boolean; // true = damage announced and held
  damagePendingAt: number; // 0 = stable; >0 = ms timestamp of most recent flip
  damagePendingValue: boolean; // value the pending flip is moving toward

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
  // `driver.firstOnTrack` is tracked on the translator instance, not here —
  // it's a connection-lifetime milestone that must survive the per-tick
  // state resets the replay guard performs (see `diffFirstOnTrack` in
  // `translator.ts`).
  lifecycleInitialized: boolean;
  lastSessionNum: number | null;
  lastEngineRunning: boolean;
  lastLap: number;

  // ── Lap completion (issue #555) ─────────────────────────────────────────
  // Tracks `LapCompleted` (counter) and `LapBestLapTime` across ticks so the
  // diff can emit one `lap.completed` per real lap completion and decide if
  // the lap was the new session best. Seeded silently on first tick — without
  // it, connecting mid-session would synthesize a spurious completion event.
  // `lastLapBestLapTime` stores 0 when no valid lap has happened yet (the
  // iRacing sentinel — matches `LapBestLapTime` being unset).
  //
  // `lastLapSessionNum` is tracked independently of `lastSessionNum` (used by
  // diffLifecycle) so the lap diff can detect session boundaries on its own
  // schedule and wipe the lap-completed tracking — a fast practice PB must
  // not carry into qualifying or the race.
  lapCompletedInitialized: boolean;
  lastLapCompletedCounter: number;
  lastLapBestLapTime: number;
  lastLapSessionNum: number | null;
  /**
   * `LapLastLapTime` at the moment of the last emission. Used to detect when
   * iRacing has refreshed `LapLastLapTime` for the just-completed lap: when
   * `LapCompleted` increments, iRacing sometimes lags one or two ticks
   * before updating `LapLastLapTime`, and reading the stale prior-lap value
   * here would publish a duplicate `lap.completed` (with stale `lapTime`,
   * `isBest: false`, and `previousBest === lapTime`). Waiting until the
   * value strictly changes guarantees we publish each lap exactly once with
   * its own time.
   */
  lastEmittedLapTime: number;
  /**
   * Position baselines captured at the previous `lap.completed` emission
   * (issue #566). `0` is the sentinel for "no baseline yet" — mirroring how
   * `lastLapBestLapTime` uses `0` to mean "no prior best". Cleared by the
   * session-change reset alongside the other lap baselines so a position
   * gain in practice doesn't carry into qualifying.
   */
  lastLapPosition: number;
  lastLapClassPosition: number;
  /**
   * Timestamp (ms since epoch) when the lap diff first detected a settled
   * lap-time refresh but `ResultsPositions` had not yet caught up (issue
   * #566). The diff defers the `lap.completed` emit until standings sync,
   * but with a hard timeout (`LAP_RESULTS_SYNC_MAX_WAIT_MS`) so a stale or
   * missing `ResultsPositions` never permanently swallows a lap. `0` while
   * not pending; reset on emit and on session-change / disconnect.
   */
  lapResultsPendingSince: number;
  /**
   * Lap counter value (`LapCompleted`) at the most recent position change
   * (issue #569). Used to compute `lapsSincePositionChange` on the
   * `lap.completed` payload, which the race-status callout uses to drive its
   * every-3-laps cadence. `-1` until the first change is detected — before
   * then the diff omits `lapsSincePositionChange` from the payload (no
   * baseline yet).
   *
   * "Effective" position drives the change detection: class in multi-class
   * series, overall in single-class. The counter resets on every detected
   * change so the every-3 cadence restarts cleanly when the driver gains or
   * loses a place.
   */
  lastPositionChangeLap: number;
  /**
   * Once-per-session latch for `race.finished` (issue #569). Set the first
   * time `lap.completed` fires in a race session after iRacing raised the
   * checkered flag. Cleared on session change / disconnect so a later race
   * session re-arms the latch.
   */
  raceFinishedFired: boolean;
};

export function createInitialState(): TranslatorState {
  return {
    pitLaneInitialized: false,
    lastOnPitRoad: false,
    lapStartedFromPits: false,
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

    trackWetnessInitialized: false,
    lastTrackWetness: TrackWetness.Unknown,

    pitStatusInitialized: false,
    lastPitSvStatus: 0, // PitSvStatus.None

    limiterInitialized: false,
    lastOnPitRoadForLimiter: false,
    lastLimiterOnPitRoad: false,
    speedingWarnedAt: 0,

    lastIncidentCount: -1,
    offTrackStartedAt: 0,
    offTrackWarnedThisExcursion: false,
    materialHistory: [],
    offTrackPending: false,
    pendingIncidentType: null,
    pendingIncidentTypeAt: 0,
    incidentBurstType: null,
    incidentBurstDelta: 0,
    incidentBurstFirstAt: 0,
    incidentBurstLatestAt: 0,

    damageInitialized: false,
    damageBaseline: false,
    damagePendingAt: 0,
    damagePendingValue: false,

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
    lastSessionNum: null,
    lastEngineRunning: false,
    lastLap: -1,

    lapCompletedInitialized: false,
    lastLapCompletedCounter: -1,
    lastLapBestLapTime: 0,
    lastLapSessionNum: null,
    lastEmittedLapTime: 0,
    lastLapPosition: 0,
    lastLapClassPosition: 0,
    lapResultsPendingSince: 0,
    lastPositionChangeLap: -1,
    raceFinishedFired: false,
  };
}
