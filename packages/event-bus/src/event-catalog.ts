/**
 * Canonical sim-event catalog.
 *
 * The event catalog is the single source of truth for the names and shapes
 * of events that flow through `@iracedeck/event-bus`. Publishers and
 * subscribers both index into `SimEventMap` by event name and receive a
 * fully typed envelope.
 *
 * See `docs/plans/2026-04-19-audio-architecture-design.md` §6 for the
 * rationale behind the event names and the transition/value-change split.
 */

/**
 * Event envelope. Every published sim event carries the name, timestamp,
 * the current-tick telemetry snapshot, and an event-specific payload.
 *
 * `TTelemetry` defaults to `unknown` so this package stays sim-agnostic:
 * the canonical `SimEventMap` below binds every entry at the default. Sim
 * translators that want typed telemetry on subscribers' envelopes declare
 * their own bound envelope (e.g. `SimEvent<TEvent, TData, TelemetryData>`)
 * and expose it via a parallel typed map; the bus itself dispatches on
 * event name and does not need to know the telemetry type.
 */
export type SimEvent<TEvent extends string, TData, TTelemetry = unknown> = {
  event: TEvent;
  timestamp: number;
  telemetry: TTelemetry;
  data: TData;
};

/**
 * Payload type for events that carry no event-specific data beyond the
 * envelope. Pure transition events (e.g. `pitLane.entered`, `engine.startup`)
 * use this permanently; events that need a payload bind a concrete shape
 * in their catalog entry.
 */
export type EmptySimEventPayload = Record<string, never>;

/**
 * Proximity radar state. Sim-agnostic string union so future translators
 * (AC, rFactor, …) can emit the same `radar.changed` shape without
 * redefining it.
 */
export type RadarState = "clear" | "left" | "right" | "both" | "two-left" | "two-right";

/** Pit service toggle categories that can be individually enabled/disabled. */
export type PitServiceKind = "fuel" | "windshield" | "fastRepair";

/**
 * Pit-box count-in distance marks (issue #600). One per spoken cue as the
 * driver closes on their pit box: `five`..`one` are the numeric countdown,
 * `pit-now` is the final "stop here" cue. Sim-agnostic string union so any
 * future translator can emit the same `pitBox.countdown` shape; the audio
 * scenario maps each mark to its own clip. The marks are spaced by remaining
 * distance to the box (`DriverPitTrkPct`), not by time, so the count tracks
 * the approach regardless of pit-lane speed.
 */
export type PitBoxMark = "five" | "four" | "three" | "two" | "one" | "pit-now";

/** Flag scope — "local" is a sector/area yellow, "full" is a full-course yellow. */
export type FlagScope = "local" | "full";

/**
 * Pre-start countdown thresholds (issue #480). One value per spoken number as
 * the standing-start `SessionTimeRemain` crosses each mark in the trustworthy
 * pre-start window. Sim-agnostic literal union (mirrors {@link PitBoxMark}) so
 * any future translator can emit the same `startLight.countdown.raised` shape;
 * the audio scenario maps each value to its own clip.
 */
export type StartCountdownSeconds = 90 | 60 | 30 | 10;

/**
 * Canonical incident-report type (issue #530). Maps the report byte of
 * iRacing's `irsdk_IncidentFlags` onto a sim-agnostic discriminator so future
 * translators (AC, ACC, …) can emit the same `incident.occurred` shape.
 *
 * The audio-scenarios catalog branches one scenario per value:
 *   - OffTrack       — track-limits nudge
 *   - OutOfControl   — composure / get-it-back
 *   - ContactWorld   — light wall rub, no penalty
 *   - CollisionWorld — heavier wall hit, deterministic 2x penalty
 *   - ContactCar     — light car rub, no penalty
 *   - CollisionCar   — heavier car hit, deterministic 4x penalty
 *
 * `RepOffTrackOngoing` (0x03) and `RepCollisionWithWorldOngoing` (0x06) are
 * not surfaced — iRacing's own header notes they are never emitted by the
 * sim. `RepNoReport` (0x00) is suppressed because it carries no actionable
 * type information.
 */
export type IncidentType =
  | "off-track"
  | "out-of-control"
  | "contact-world"
  | "collision-world"
  | "contact-car"
  | "collision-car";

/**
 * Canonical track-wetness state (issue #526). Mirrors iRacing's
 * `irsdk_TrackWetness` enum but lives here on the sim-agnostic bus so future
 * adapters (AC, ACC, …) can map their own concepts onto the same shape.
 * `Unknown` represents the period before the sim has reported a state — events
 * never fire for transitions involving it.
 */
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

/**
 * Pit-service readback snapshot — the queued-services view the readback
 * scenarios speak to (issue #476). Lives next to the catalog because it's
 * shared between the sim translator (which builds it from current
 * telemetry) and the audio scenarios (which read it at fire time via a
 * resolver closure). Sim-agnostic: any future translator can populate the
 * same shape.
 *
 * Decoupled from `pitService.readbackRequested` event payload (which now
 * carries only `reason`) so that deferred replay reads a fresh snapshot
 * at the moment the engineer speaks rather than the one frozen into the
 * original event.
 */
export type PitReadbackSnapshot = {
  fuel: { queued: boolean };
  tires: { lf: boolean; rf: boolean; lr: boolean; rr: boolean };
  compoundChange: { from: number; to: number } | null;
  fastRepair: { queued: boolean; available: boolean };
  windshield: { queued: boolean; available: boolean };
  limiterEngaged: boolean;
  /**
   * Whether the player's car HAS a pit limiter at all — derived from the
   * presence of the `dcPitSpeedLimiterToggle` driver-control field via
   * `hasPitLimiter` (issue #637). Distinct from `limiterEngaged` (limiter
   * currently on). Used by the readback to gate the "don't forget your
   * limiter" pre-opener so cars without a limiter never hear limiter chatter
   * (issue #639). Sim-agnostic boolean so future translators can map their
   * own capability model onto the same readback shape.
   */
  hasPitLimiter: boolean;
  /**
   * Whether the player's car currently has damage that requires repair —
   * `EngineWarnings & (MandRepNeeded | OptRepNeeded)`. Used by the readback
   * to gate the fast-repair slot: the engineer stays silent about repairs
   * on a clean car, regardless of whether the user happened to queue
   * fast-repair (issue #489). Sim-agnostic boolean so future translators
   * can map their own damage model onto the same readback shape.
   */
  hasDamage: boolean;
};

/**
 * Telemetry-derived half of the session-start readout snapshot (issues #542,
 * #668). Built by the sim translator from live telemetry + session info at the
 * time the session.changed event fires, read at fire time by the session-start
 * scenario via a
 * resolver closure (same deferred-snapshot pattern as {@link PitReadbackSnapshot}).
 *
 * Units are resolved here, not in the scenario: the translator reads iRacing's
 * `DisplayUnits` and converts pit speed / temperatures into the user's display
 * unit so the engineer matches the sim. `pitSpeedLimit` is the exact rounded
 * integer — never stepped — because a rounded-up value would imply a false
 * pit-speed-penalty risk; the scenario skips the pit-speed clause when the
 * value isn't a clip it can speak.
 */
export type SessionStartConditions = {
  sessionType: "practice" | "qualifying" | "race";
  /** Exact pit speed limit in `speedUnit`, rounded to the nearest integer. */
  pitSpeedLimit: number;
  speedUnit: "kmh" | "mph";
  /** Track temperature in `tempUnit`, rounded to the nearest integer. */
  trackTemp: number;
  /** Air temperature in `tempUnit`, rounded to the nearest integer. */
  airTemp: number;
  tempUnit: "celsius" | "fahrenheit";
  wetness: TrackWetness;
};

/**
 * Full session-start snapshot the scenario speaks to (issue #542):
 * {@link SessionStartConditions} plus the driver name, which is not
 * telemetry-derived — each plugin composes it from the Property Inspector
 * "Your Name" picker (falling back to `"driver"`).
 */
export type SessionStartSnapshot = SessionStartConditions & {
  driverName: string;
};

/**
 * Telemetry-derived half of the race-start readout snapshot (issue #568).
 * Built by the sim translator at the moment the race-start scenario fires
 * (~3 s after a `session.changed` lands in a race session) and read at fire
 * time via a resolver closure (same deferred-snapshot pattern as
 * {@link SessionStartConditions}).
 *
 * Differs from {@link SessionStartConditions} in two ways:
 *   - No `pitSpeedLimit` / `speedUnit`. Race start doesn't speak the pit
 *     limit — the driver heard it during practice / qualifying and the
 *     opening lap is full-attack. Dropped to keep the readout tight.
 *   - Adds `playerCarPosition` — the grid position iRacing assigns from the
 *     qualifying result (or starting grid lineup for race-only events).
 *     `undefined` when telemetry hasn't populated `PlayerCarPosition` yet;
 *     the scenario then skips the position clause and speaks the greeting +
 *     conditions only.
 *
 * Sim-agnostic: any future translator can populate the same shape.
 */
export type RaceStartConditions = {
  /** Track temperature in `tempUnit`, rounded to the nearest integer. */
  trackTemp: number;
  /** Air temperature in `tempUnit`, rounded to the nearest integer. */
  airTemp: number;
  tempUnit: "celsius" | "fahrenheit";
  wetness: TrackWetness;
  /** Grid position (`PlayerCarPosition`), or `undefined` if not yet populated. */
  playerCarPosition: number | undefined;
};

/**
 * Full race-start snapshot the scenario speaks to (issue #568):
 * {@link RaceStartConditions} plus the driver name, which is not
 * telemetry-derived — each plugin composes it from the Property Inspector
 * "Your Name" picker (falling back to `"driver"`).
 */
export type RaceStartSnapshot = RaceStartConditions & {
  driverName: string;
};

/**
 * Snapshot the qualifying lap-invalidation scenario reads at fire time
 * (issue #567). Built by the sim translator from the latest telemetry tick
 * plus the active session info. `sessionType: "qualifying"` is the only
 * value that gates the callout open — `practice`, `race`, and `undefined`
 * all suppress it.
 *
 * `lapLimited` is the build-side classification of `SessionLapsTotal <
 * UNLIMITED_LAPS` (32767 is iRacing's "time-limited" sentinel). The
 * scenario doesn't re-check the sentinel; the translator resolves it once.
 *
 * `lapsRemaining` is the **effective attempts remaining AFTER the current
 * (about-to-be-invalidated) lap finishes** — not iRacing's raw
 * `SessionLapsRemainEx`, which counts the current lap. The translator
 * pre-adjusts (subtracts 1, clamped to 0) so a 2-lap qual on the first
 * flying lap reports `1`, the second flying lap reports `0` (out-of-laps
 * tail), etc. Snapshot authors that don't have this quirk (test fixtures,
 * harness) populate the field directly with the post-adjustment value.
 *
 * `lapCompleted` is the per-lap latch key — iRacing resets it per session,
 * so the latch composite `(sessionNum, lapCompleted)` rolls over cleanly on
 * session change.
 *
 * `lapStartedFromPits` is the pit-exit lap detector. The translator sets it
 * to `true` between `pitLane.exited` and the next `lap.started`, covering
 * both the session out-lap (driver exited the pit box at session start) and
 * any mid-session post-pit-exit lap. Neither is a timed attempt, so an
 * incident there shouldn't fire the "this lap will be invalidated" line.
 *
 * Sim-agnostic: any future translator can populate the same shape.
 */
export type QualifyingInvalidationSnapshot = {
  sessionType: "practice" | "qualifying" | "race" | undefined;
  sessionNum: number | undefined;
  lapsRemaining: number | undefined;
  lapLimited: boolean;
  lapCompleted: number;
  lapStartedFromPits: boolean;
};

/**
 * Discriminated union of every event the bus knows about, keyed by event
 * name. Each entry binds an event name to its payload type — adding an
 * event means adding an entry here.
 */
export type SimEventMap = {
  // ── Transition events (§6.1) — fire once on change ────────────────────────
  "pitLane.approaching": SimEvent<"pitLane.approaching", EmptySimEventPayload>;
  "pitLane.entered": SimEvent<"pitLane.entered", EmptySimEventPayload>;
  "pitLane.exited": SimEvent<"pitLane.exited", EmptySimEventPayload>;
  "pitStall.entered": SimEvent<"pitStall.entered", EmptySimEventPayload>;
  "pitStall.departed": SimEvent<"pitStall.departed", EmptySimEventPayload>;
  /**
   * Pit-box count-in (issue #600). Fired once per distance mark as the player
   * drives down pit road toward their own pit box: "five" (120 m remaining),
   * "four" (100 m), "three" (80 m), "two" (60 m), "one" (40 m), and "pit-now"
   * (20 m). The translator derives the box position from
   * `SessionInfo.DriverInfo.DriverPitTrkPct` and the remaining distance from
   * `LapDistPct` × track length, emitting each mark exactly once per pit-road
   * visit (the spoken-marks set resets when the car leaves pit road). The audio
   * scenario plays one clip per {@link PitBoxMark}; all six share `family:
   * "pit-box"` so a faster approach that crosses two marks in quick succession
   * preempts the in-flight clip cleanly.
   */
  "pitBox.countdown": SimEvent<"pitBox.countdown", { mark: PitBoxMark }>;
  /**
   * Pit-service readback request (issue #476). Fired by the sim translator
   * at three moments during a pit stop:
   *   - "entry"        — first onPitRoad off→on transition
   *   - "entry-refire" — any pit-service / tire-service / compound toggle
   *                      while still on pit road, so the running readback
   *                      is preempted and replaced with the new snapshot
   *   - "exit"         — pitLane.exited + a settle delay (default 4500 ms)
   *
   * The payload carries only the trigger reason. The queued-services
   * snapshot the readback speaks to is read at fire time via a resolver
   * closure passed into the audio-scenarios catalog, NOT pulled from the
   * event payload (issue #481). Reading at fire time keeps the recap
   * fresh under deferred replay (busy-bus low-priority deferral or a
   * higher-priority preempt that stashes the readback for later).
   */
  "pitService.readbackRequested": SimEvent<
    "pitService.readbackRequested",
    { reason: "entry" | "entry-refire" | "exit" }
  >;

  "flag.yellow.raised": SimEvent<"flag.yellow.raised", { scope: FlagScope }>;
  "flag.yellow.cleared": SimEvent<"flag.yellow.cleared", EmptySimEventPayload>;
  "flag.blue.raised": SimEvent<"flag.blue.raised", EmptySimEventPayload>;
  "flag.green.raised": SimEvent<"flag.green.raised", EmptySimEventPayload>;
  "flag.checkered.raised": SimEvent<"flag.checkered.raised", EmptySimEventPayload>;
  "flag.black.raised": SimEvent<"flag.black.raised", EmptySimEventPayload>;
  "flag.white.raised": SimEvent<"flag.white.raised", EmptySimEventPayload>;
  "flag.red.raised": SimEvent<"flag.red.raised", EmptySimEventPayload>;
  /**
   * Track-debris flag (`Flags.Debris`). Persistent until the flag drops;
   * we only fire on the raised transition since downstream consumers
   * today (engineer voice callouts) don't need a paired clear event.
   */
  "flag.debris.raised": SimEvent<"flag.debris.raised", EmptySimEventPayload>;
  /**
   * Meatball flag — orange-and-black ("come to pits, your car has a
   * problem"). Maps to iRacing's `Flags.Repair` bit. Same single-edge
   * shape as the other driver-targeted flags.
   */
  "flag.meatball.raised": SimEvent<"flag.meatball.raised", EmptySimEventPayload>;
  // ── Missing session flags (issue #480) — race-progression, driver-black, caution ─
  "flag.crossed.raised": SimEvent<"flag.crossed.raised", EmptySimEventPayload>;
  // `one-pace-lap-to-go` is the rolling-start "one pace lap to go" cue. It is
  // NOT driven by iRacing's `OneLapToGreen` bit (that bit is "formation in
  // progress", set for the whole parade and re-set in cool-down — issue #657);
  // the translator emits it from a start/finish-crossing heuristic instead.
  "flag.one-pace-lap-to-go.raised": SimEvent<"flag.one-pace-lap-to-go.raised", EmptySimEventPayload>;
  "flag.green-held.raised": SimEvent<"flag.green-held.raised", EmptySimEventPayload>;
  "flag.ten-to-go.raised": SimEvent<"flag.ten-to-go.raised", EmptySimEventPayload>;
  "flag.five-to-go.raised": SimEvent<"flag.five-to-go.raised", EmptySimEventPayload>;
  "flag.disqualify.raised": SimEvent<"flag.disqualify.raised", EmptySimEventPayload>;
  "flag.furled.raised": SimEvent<"flag.furled.raised", EmptySimEventPayload>;
  /**
   * Fired when an ANNOUNCED furled black-flag warning is withdrawn — the
   * falling edge of the `Furled` bit, gated on `flag.furled.raised` having
   * actually fired for the current episode (issue #669). A transient flicker
   * (e.g. running briefly off track) that never survived the raise debounce
   * fires neither event.
   */
  "flag.furled.cleared": SimEvent<"flag.furled.cleared", EmptySimEventPayload>;
  "flag.dq-scoring-invalid.raised": SimEvent<"flag.dq-scoring-invalid.raised", EmptySimEventPayload>;
  "flag.yellow-waving.raised": SimEvent<"flag.yellow-waving.raised", EmptySimEventPayload>;
  "flag.caution-waving.raised": SimEvent<"flag.caution-waving.raised", EmptySimEventPayload>;

  /**
   * Start-light family (issue #480). The race-start gantry lights and the
   * numeric pre-start countdown. The two gantry states fire on the rising
   * edge of iRacing's `StartReady` / `StartGo` bits — the start procedure is
   * Ready → Set → Go, and the heads-up line belongs on Ready (issue #673 moved
   * it off `StartSet`, which lights too late to be useful; nothing is spoken
   * at Set anymore). The countdown fires once per crossed threshold during the
   * standing-start pre-start window (one event per number, see
   * {@link StartCountdownSeconds}). All carry `family: "start-light"` so the
   * audio scenarios preempt cleanly.
   */
  "startLight.start-ready.raised": SimEvent<"startLight.start-ready.raised", EmptySimEventPayload>;
  "startLight.start-go.raised": SimEvent<"startLight.start-go.raised", EmptySimEventPayload>;
  "startLight.countdown.raised": SimEvent<"startLight.countdown.raised", { seconds: StartCountdownSeconds }>;

  // Rolling-start: pace car begins moving the field into the formation/parade lap (issue #660).
  "rollingStart.pace-car-moving.raised": SimEvent<"rollingStart.pace-car-moving.raised", EmptySimEventPayload>;

  "tireService.changed": SimEvent<"tireService.changed", { added: string[]; removed: string[]; current: string[] }>;
  /**
   * Tire compound selection changed in pit service. `from`/`to` are
   * sim-defined numeric ids — the bus stays sim-agnostic and lets each
   * translator define its own number space. iRacing uses `0=dry, 1=wet`
   * (per `iracing-sdk/README.md` / `pit.tireCompound(compound)`); future
   * adapters may expose richer compound rosters.
   */
  "tireService.compoundChanged": SimEvent<"tireService.compoundChanged", { from: number; to: number }>;
  "pitService.toggled": SimEvent<"pitService.toggled", { service: PitServiceKind; on: boolean }>;
  /**
   * Pit-service status transition (issue #479). Fired by the sim translator
   * on every change to the player's pit-service status (idle / in-progress /
   * complete / positioning errors / can't-fix-that). `from`/`to` are
   * sim-defined numeric ids — the bus stays sim-agnostic. iRacing uses the
   * `irsdk_PitSvStatus` enum (`@iracedeck/iracing-sdk` re-exports it as
   * `PitSvStatus`). Closing transitions (`* → None`) are suppressed by the
   * translator so the silent idle state never fires.
   */
  "pitService.statusChanged": SimEvent<"pitService.statusChanged", { from: number; to: number }>;
  "carControl.drsToggled": SimEvent<"carControl.drsToggled", { on: boolean }>;
  "carControl.p2pToggled": SimEvent<"carControl.p2pToggled", { on: boolean }>;
  "carControl.limiterToggled": SimEvent<"carControl.limiterToggled", { on: boolean }>;
  "limiter.dropped": SimEvent<"limiter.dropped", EmptySimEventPayload>;
  "limiter.missing": SimEvent<"limiter.missing", EmptySimEventPayload>;
  "limiter.speeding": SimEvent<"limiter.speeding", EmptySimEventPayload>;

  /**
   * Damage requiring repair was just observed on the player's car after the
   * debounce window settled (issue #489). Triggered on the rising edge of
   * `EngineWarnings & (MandRepNeeded | OptRepNeeded)`; clear → damage
   * cycles re-fire as fresh `raised` events. No paired `cleared` event —
   * audio scenarios only need the rising edge.
   */
  "damage.repairNeeded.raised": SimEvent<"damage.repairNeeded.raised", EmptySimEventPayload>;

  /**
   * Player incident bumped the count (issue #530). `delta` carries the raw
   * count delta (1 / 2 / 4 in iRacing's scoring) so consumers that only care
   * about magnitude can use it directly. `type` carries the {@link IncidentType}
   * discriminator so audio scenarios can branch one callout per category
   * (off-track nudge, composure prompt, light contact, penalty-bearing
   * collision). Translators must omit emission when the incident type is
   * unknown — every fire MUST set `type`.
   */
  "incident.occurred": SimEvent<"incident.occurred", { delta: number; type: IncidentType }>;
  "offTrack.started": SimEvent<"offTrack.started", EmptySimEventPayload>;
  "offTrack.ended": SimEvent<"offTrack.ended", EmptySimEventPayload>;

  /**
   * Player gained a race position and held the new spot for the sustainment
   * window (issue #574). The original gain-only event (`{ carIdx, sustained }`)
   * has been extended with position context so the Race Engineer scenario can
   * speak the resulting position without a separate snapshot pull.
   *
   * `position` / `previousPosition` are the overall (1-indexed) race positions
   * before and after the pass settled; `gapBehindMeters` is the physical gap
   * to the just-passed car at the emission tick (derived from
   * `CarIdxLapDistPct` × track length, omitted when track length isn't yet
   * parsed). `isLeader` is `position === 1` and surfaces the "we're now
   * leading race" branch without re-checking. The class-position fields
   * mirror `lap.completed` (#566) so multi-class consumers can pick the
   * class rank via `isMultiClass`.
   */
  "overtake.completed": SimEvent<
    "overtake.completed",
    {
      /** Player's own car index (for correlation only). */
      carIdx: number;
      /** Hold duration in milliseconds (≥ OVERTAKE_HOLD_MS). */
      sustained: number;
      /** Overall race position after the pass settled (1-based). */
      position: number;
      /** Overall race position before the pass started (1-based). */
      previousPosition: number;
      /** Physical gap in meters to the just-passed car at emission tick, when computable. */
      gapBehindMeters?: number;
      /** True iff `position === 1` after the pass. */
      isLeader: boolean;
      /** Class position (1-indexed) after the pass, when class info is available. */
      classPosition?: number;
      /** Class position (1-indexed) before the pass, when class info is available. */
      previousClassPosition?: number;
      /** True iff the current session has more than one car class on track. */
      isMultiClass?: boolean;
      /**
       * True iff at least one of the positions gained was vacated by a car that
       * left the world WITHOUT finishing the race — a retirement / DNF /
       * disconnect — rather than by a genuine on-track pass (issue #603). The
       * Race Engineer plays only the position readout ("We're currently P[n]")
       * and suppresses the "Nice pass" reaction. Omitted (treated as `false`)
       * for a normal pass. Single-class only — in multi-class the diff detects
       * on `PlayerCarClassPosition`, which iRacing recomputes correctly when a
       * car leaves, so no retirement attribution is needed there.
       */
      fromRetirement?: boolean;
    }
  >;
  /**
   * Player lost a race position and the new (worse) spot has held for the
   * sustainment window (issue #574). Counterpart to `overtake.completed`;
   * shares the gating rules (race-only, on-track, not under caution, not a
   * sim-glitch jump > OVERTAKE_MAX_JUMP, plus a 10 m physical-gap gate).
   * `gapAheadMeters` is the distance to the overtaker (now ahead of the
   * player) at the emission tick.
   */
  "overtake.lost": SimEvent<
    "overtake.lost",
    {
      /** Player's own car index (for correlation only). */
      carIdx: number;
      /** Hold duration in milliseconds (≥ OVERTAKE_HOLD_MS). */
      sustained: number;
      /** Overall race position after the loss settled (1-based, > previousPosition). */
      position: number;
      /** Overall race position before the loss started (1-based, < position). */
      previousPosition: number;
      /** Physical gap in meters to the overtaker (now ahead) at emission tick, when computable. */
      gapAheadMeters?: number;
      /** Class position (1-indexed) after the loss, when class info is available. */
      classPosition?: number;
      /** Class position (1-indexed) before the loss, when class info is available. */
      previousClassPosition?: number;
      /** True iff the current session has more than one car class on track. */
      isMultiClass?: boolean;
    }
  >;

  "driver.firstOnTrack": SimEvent<"driver.firstOnTrack", EmptySimEventPayload>;
  "session.changed": SimEvent<"session.changed", { from: number; to: number }>;
  "engine.startup": SimEvent<"engine.startup", EmptySimEventPayload>;
  "lap.started": SimEvent<"lap.started", { lap: number }>;
  /**
   * A timed lap was just completed (issue #555). Fires once per lap when the
   * sim publishes `LapLastLapTime` for the lap just crossed at S/F. Carries a
   * rich payload so future lap-related callouts (delta-to-PB, consistency,
   * pace, time-remaining) can subscribe without further bus changes.
   *
   * `isBest` is true iff this lap is the new session best (the sim's
   * `LapBestLapTime` strictly decreased on this transition or transitioned
   * 0 → non-zero). `isFirstValid` is true iff the driver had no prior best
   * lap before this transition — used by the engineer voice to switch the
   * intro line ("That was your best lap yet" vs "That lap was"). Both flags
   * may be true simultaneously on the driver's first valid lap of a session.
   *
   * Sentinel suppression: the translator must not emit for pace laps
   * (`LapCompleted < 0`) or for ticks where `LapLastLapTime <= 0`.
   */
  "lap.completed": SimEvent<
    "lap.completed",
    {
      /** Lap number just completed (`LapCompleted`). */
      lap: number;
      /** Lap time in seconds (`LapLastLapTime`). */
      lapTime: number;
      /** True iff this lap is the new session best. */
      isBest: boolean;
      /** True iff this is the driver's first valid lap of the session. */
      isFirstValid: boolean;
      /** Current session best after this lap, if any. */
      bestLapTime?: number;
      /** Session best before this lap, if there was one. */
      previousBestLapTime?: number;
      /** Laps remaining in the session (`SessionLapsRemainEx`), if lap-limited. */
      lapsRemaining?: number;
      /** Time remaining in the session in seconds (`SessionTimeRemain`), if time-limited. */
      timeRemaining?: number;
      /** Current session type, if resolvable. */
      sessionType?: "practice" | "qualifying" | "race";
      /**
       * Overall position at lap completion (issue #566). The sim translator
       * sources this **standings-first** from
       * `SessionInfo.Sessions[current].ResultsPositions[player].Position`, with
       * a fallback to the live `PlayerCarPosition` telemetry field when
       * standings haven't caught up to the lap counter within the
       * sync-wait timeout. Omitted entirely when neither source has a valid
       * position. Together with {@link previousPosition} powers the
       * position-change callout. `classPosition` is the parallel field for
       * multi-class series — consumers decide which to use via {@link isMultiClass}.
       */
      position?: number;
      /**
       * Overall position before this lap, if a baseline was established
       * (issue #566). Captured from the previous emission's resolved
       * {@link position} (whichever source it came from). `undefined` on the
       * driver's first valid lap of the session — combined with `isFirstValid`,
       * the position-change scenario treats "no previous position" as a
       * "better" trigger.
       */
      previousPosition?: number;
      /**
       * Class position at lap completion (issue #566). Standings-first
       * (`ResultsPositions[player].ClassPosition`, converted from iRacing's
       * 0-indexed value to 1-indexed on the wire) with a fallback to live
       * `PlayerCarClassPosition` telemetry. Same omission semantics as {@link position}.
       */
      classPosition?: number;
      /**
       * Class position before this lap, if a baseline was established (issue #566).
       * Captured from the previous emission's resolved {@link classPosition}.
       */
      previousClassPosition?: number;
      /**
       * True iff the current session has more than one car class on track
       * (issue #566). Derived from `SessionInfo.DriverInfo.Drivers[].CarClassID`
       * with the pace car filtered out. Position-aware callouts use this to pick
       * `classPosition` over `position`.
       */
      isMultiClass?: boolean;
      /**
       * Number of laps completed since the driver's effective position last
       * changed (issue #569). `0` on the lap where the change was detected,
       * `1` on the next lap, etc. Omitted when no baseline has been
       * established (e.g. driver's first valid lap of the session).
       *
       * The race-status callout uses this to fire the every-3-laps
       * status update during races: a value of N where `N > 0 && N % 3 === 0`
       * triggers the announcement.
       *
       * "Effective" position uses the same class-vs-overall pick as the
       * other position fields above (driven by {@link isMultiClass}).
       */
      lapsSincePositionChange?: number;
      /**
       * True iff iRacing considers the just-completed lap valid for standings
       * purposes (no track-limits invalidation, no pit-lane violation, etc.).
       * Derived from `LapDeltaToBestLap_OK` and the session-best/optimal/last
       * variants at the lap-completion tick (issue #572). `undefined` when
       * the translator can't determine validity — consumers should treat
       * `undefined` as valid (don't suppress callouts on a missing signal).
       *
       * The position-change callout uses this to prefix the readout with
       * "That lap didn't count." and force the worse-framing intro when the
       * lap is invalid.
       */
      lapIsValid?: boolean;
    }
  >;
  /**
   * Effective position changed (issue #569). Fires once per lap when the
   * driver's effective position differs from the previous emission. Plumbing
   * for future per-change race-position callouts — no audio consumer ships
   * with this issue. `previousPosition` is the value the change moved away
   * from; both overall and class are carried so consumers can pick per
   * {@link isMultiClass}.
   *
   * Sentinel: not emitted on the driver's first valid lap of the session
   * (no baseline to compare against).
   */
  "position.changed": SimEvent<
    "position.changed",
    {
      /** Lap that completed when the change was detected. */
      lap: number;
      /** New overall position. */
      position: number;
      /** Overall position before this lap. */
      previousPosition: number;
      /** New class position (1-indexed). */
      classPosition?: number;
      /** Class position before this lap (1-indexed). */
      previousClassPosition?: number;
      /** True iff the current session has more than one car class. */
      isMultiClass?: boolean;
    }
  >;
  /**
   * Race session has ended for the driver (issue #569). Fires once per race
   * session, on the first `lap.completed` after iRacing raised the checkered
   * flag in a race session. Carries the final positions so the race-end
   * callout can speak the result. Reset on session change / disconnect, so a
   * later race session re-arms the latch.
   */
  "race.finished": SimEvent<
    "race.finished",
    {
      /** Final overall position. */
      position: number;
      /** Final class position (1-indexed). */
      classPosition?: number;
      /** True iff the current session has more than one car class. */
      isMultiClass?: boolean;
    }
  >;

  // ── Value-change events (§6.2) — emit new state when derived value changes
  "radar.changed": SimEvent<"radar.changed", { from: RadarState; to: RadarState }>;
  /**
   * Pit road opened or closed for the player (issue #655). Emitted on a real
   * `PitsOpen` boolean transition: `to === true` → pit road is now open,
   * `to === false` → pit road is now closed. The translator gates emission to
   * race sessions (the field-bunching caution phase is the meaningful case) and
   * suppresses it while watching a replay (`isReplayOnlySession`, #604). Two
   * audio scenarios branch on `to` rather than two separate events — the same
   * value-change shape as {@link radar.changed} / `pitService.statusChanged`.
   */
  "pitsOpen.changed": SimEvent<"pitsOpen.changed", { from: boolean; to: boolean }>;
  "fuel.lapsRemaining.crossed": SimEvent<"fuel.lapsRemaining.crossed", { threshold: number; laps: number }>;
  /**
   * Track-wetness state changed (issue #526). Emitted on every step change in
   * the sim's track-wetness state. `from`/`to` carry the canonical
   * {@link TrackWetness} enum values. The translator suppresses transitions
   * involving `Unknown` (Unknown ↔ x) so subscribers only see real changes.
   */
  "track.wetness.changed": SimEvent<"track.wetness.changed", { from: TrackWetness; to: TrackWetness }>;
};

/** All event names the catalog supports. */
export type SimEventName = keyof SimEventMap;

/** The full envelope type for a given event name. */
export type SimEventOf<T extends SimEventName> = SimEventMap[T];
