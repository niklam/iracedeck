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

/** Flag scope — "local" is a sector/area yellow, "full" is a full-course yellow. */
export type FlagScope = "local" | "full";

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
 * Telemetry-derived half of the session-start ("car entry") readout snapshot
 * (issue #542). Built by the sim translator from the first-on-track telemetry
 * tick + session info, read at fire time by the session-start scenario via a
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

  "overtake.completed": SimEvent<"overtake.completed", { carIdx: number; sustained: number }>;

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
    }
  >;

  // ── Value-change events (§6.2) — emit new state when derived value changes
  "radar.changed": SimEvent<"radar.changed", { from: RadarState; to: RadarState }>;
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
