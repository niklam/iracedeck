/**
 * The replay recorders' own state (issue #1468): the previous-tick baselines
 * of the lap, green and incident records and the session record's run and
 * published list — everything `diffReplayLaps`, `diffReplayGreens`,
 * `diffReplaySessions` and `diffReplayIncidents` carry from one tick to the
 * next, and nothing else. It lives apart from `TranslatorState` because the
 * recorders are their own controller subscriber (`replay-recorder.ts`), whose
 * resets are its own: the translator's replay and per-session wipes reset
 * dozens of Race Engineer baselines on rules that are not the recorders'.
 *
 * Two lifetimes live here, and {@link resetReplayRecorderBaselines} is the
 * line between them:
 *
 * - **Baselines** (the lap, green and incident records): a previous eligible
 *   tick's readings. A session change, or either edge of a replay view, makes
 *   them meaningless, and each diff's own gate re-seeds them from the first
 *   eligible tick after, silently.
 * - **The session record**: a record of every session the connection has
 *   seen, not of the current one. It records from out-of-car ticks at the live
 *   edge, which are replay ticks, so a replay edge says nothing about its run,
 *   and a pair it has published must never be published again — or every trip
 *   between the car and the garage would publish the session's start again.
 *   Only a disconnect clears it.
 */

/**
 * One car's open lap-time wait in the replay lap record (issue #1203): the
 * crossing that started `lap + 1` opened it, and it closes on the first tick
 * `CarIdxLastLapTime` moves off `baselineS` — or untimed when `ticksLeft` runs out.
 */
export type ReplayLapTimeWait = {
  /** The completed lap the time will belong to. */
  lap: number;
  /** `CarIdxLastLapTime` (seconds) the tick before the crossing; the refresh is a change from it. */
  baselineS: number;
  /** Ticks left before the wait closes with no time. */
  ticksLeft: number;
};

/**
 * One other car's roster row as the replay incident record reads it (issue
 * #1426): its `CurDriverIncidentCount` (−1 when hidden or unreadable) and the
 * identity that count belongs to. `null` for an identity field the row lacks.
 */
export type ReplayIncidentCarReading = {
  count: number;
  userId: number | null;
  carNumberRaw: number | null;
};

/**
 * One reading of a session's start in the replay session record (issue
 * #1426): the frame the pair began at, by one live tick with session info. A
 * second such tick that agrees with it, for the same event and pair,
 * publishes.
 */
export type ReplaySessionStartCandidate = {
  /** `WeekendInfo.SubSessionID` on that tick; 0 for an offline session. */
  subSessionId: number;
  sessionNum: number;
  sessionUniqueId: number;
  /** `max(0, live frame − round(SessionTime × 60))` on that tick. */
  start: number;
};

export type ReplayRecorderState = {
  // ── Replay lap record (issue #1203) ───────────────────────────────────
  // A baseline (`diff/replay-laps.ts`): reset by
  // `resetReplayRecorderBaselines`, since a replay glance or a session change
  // makes every one meaningless, and the diff's own gate re-seeds on the first
  // eligible tick anyway.
  /**
   * Whether the per-car baselines below hold a live tick's values. Every
   * ineligible tick (replay on screen, replay-only session, no session, no
   * frame) clears it, so the first eligible tick after it re-seeds silently.
   */
  replayLapsSeeded: boolean;
  /** The `SessionNum` the baselines were seeded in; a change re-seeds. */
  replayLapsSessionNum: number | null;
  /** The `SessionUniqueID` the baselines were seeded in; a change re-seeds. */
  replayLapsSessionUniqueId: number | null;
  /** Previous-tick `CarIdxLapCompleted` per carIdx. */
  replayLapsLastCompleted: number[];
  /** Previous-tick `CarIdxLastLapTime` per carIdx (seconds), the lap-time wait's baseline. */
  replayLapsLastLapTime: number[];
  /**
   * Per carIdx, the lap-time wait a crossing opened: the completed lap the
   * time will belong to, the `CarIdxLastLapTime` it must change from, and the
   * ticks left before the wait closes untimed. `null` while no wait is open.
   */
  replayLapsTimeWait: Array<ReplayLapTimeWait | null>;

  // ── Replay green record (issue #1354) ─────────────────────────────────
  // A baseline (`diff/replay-greens.ts`) beside the lap record above, reset
  // with it: the baselines are a previous tick's readings, which a replay
  // glance makes meaningless, and the diff's own gate re-seeds on the first
  // eligible tick.
  /**
   * Whether the baselines below hold an eligible tick's values. Every
   * ineligible tick (a replay, no session, no frame) clears it, so the first
   * eligible tick after it re-seeds silently — even across a `Racing` flip.
   */
  replayGreensSeeded: boolean;
  /** The `SessionNum` the baselines were seeded in; a change re-seeds. */
  replayGreensSessionNum: number | null;
  /** The `SessionUniqueID` the baselines were seeded in; a change re-seeds. */
  replayGreensSessionUniqueId: number | null;
  /**
   * `SessionState` on the previous eligible tick, the race start's baseline:
   * the start is `Racing` read after `GetInCar`, `Warmup` or `ParadeLaps`. A
   * tick that carries no `SessionState` is held as `Invalid`, which is not a
   * pre-green state for that edge.
   */
  replayGreensLastSessionState: number;
  /**
   * `SessionFlags` on the previous eligible tick: the baseline a `Green`
   * rising edge is read against, and the recorder's own "a caution is out" —
   * a caution bit (`Caution` or `CautionWaving`) set on that tick. It stands
   * in for the translator's `cautionPhase`, which is wiped on every replay
   * tick, and like that phase it falls the moment neither bit is set, so a
   * restart is the green rising on the tick the caution bits drop. Re-seeded,
   * with the rest, by the first eligible tick after an ineligible one.
   */
  replayGreensLastFlags: number;

  // ── Replay session record (issue #1426) ───────────────────────────────
  // NOT a baseline (`diff/replay-sessions.ts`): UNLIKE the two records above,
  // `resetReplayRecorderBaselines` keeps it. It records from replay ticks too
  // (out of the car at the live edge), so a replay edge says nothing about its
  // readings, and a wiped published list would publish a session again on
  // every trip between the car and the garage. Its own gate breaks the run on
  // every tick it may not read. Cleared only by a disconnect.
  /**
   * The previous live tick's reading of a session's start, the run a second
   * agreeing reading publishes; `null` after an ineligible tick, a published
   * pair's tick, or a publish.
   */
  replaySessionsCandidate: ReplaySessionStartCandidate | null;
  /** `"<subSessionId>:<sessionNum>:<sessionUniqueId>"` of every pair already published; never published again. */
  replaySessionsPublished: string[];
  /**
   * The latest start published, per `SubSessionID`. A candidate start for a
   * new pair that does not come after it (beyond the agreement tolerance) is
   * a clock still reading the session before, and is refused.
   */
  replaySessionsLatestStart: Record<number, number>;

  // ── Replay incident record (issue #1426) ──────────────────────────────
  // A baseline (`diff/replay-incidents.ts`) on the lap record's gate, reset
  // with the lap and green records: its baselines are a previous eligible
  // tick's counts, which a replay view makes meaningless, and the first
  // eligible tick back re-seeds them without emitting.
  /**
   * Whether the baselines below hold an eligible tick's values. Every
   * ineligible tick clears it, so the first eligible tick after it re-seeds
   * silently.
   */
  replayIncidentsSeeded: boolean;
  /** The `SessionNum` the baselines were seeded in; a change re-seeds. */
  replayIncidentsSessionNum: number | null;
  /** The `SessionUniqueID` the baselines were seeded in; a change re-seeds. */
  replayIncidentsSessionUniqueId: number | null;
  /** `PlayerCarMyIncidentCount` on the previous eligible tick; `null` when it read none. */
  replayIncidentsLastPlayerCount: number | null;
  /**
   * Each other car's roster reading per carIdx on the previous eligible tick:
   * its `CurDriverIncidentCount` with the `UserID` and `CarNumberRaw` it
   * belongs to. A count of −1 (the sim hiding it) is no baseline, a slot whose
   * identity differs on the next tick is none either, and a slot the roster
   * did not hold is absent. The array is shared with the roster memo of
   * `diff/replay-incidents.ts` and never mutated.
   */
  replayIncidentsLastCarReadings: readonly ReplayIncidentCarReading[];
};

/**
 * The state before any tick: every baseline unseeded and the session record
 * empty. What a fresh recorder starts from and what a disconnect returns to.
 */
export function createInitialReplayRecorderState(): ReplayRecorderState {
  return {
    replayLapsSeeded: false,
    replayLapsSessionNum: null,
    replayLapsSessionUniqueId: null,
    replayLapsLastCompleted: [],
    replayLapsLastLapTime: [],
    replayLapsTimeWait: [],

    replayGreensSeeded: false,
    replayGreensSessionNum: null,
    replayGreensSessionUniqueId: null,
    replayGreensLastSessionState: 0,
    replayGreensLastFlags: 0,

    replaySessionsCandidate: null,
    replaySessionsPublished: [],
    replaySessionsLatestStart: {},

    replayIncidentsSeeded: false,
    replayIncidentsSessionNum: null,
    replayIncidentsSessionUniqueId: null,
    replayIncidentsLastPlayerCount: null,
    replayIncidentsLastCarReadings: [],
  };
}

/**
 * A state whose lap, green and incident baselines are back to their initial
 * values and whose session record is `state`'s own — the same candidate,
 * published list and latest starts, carried over by reference. The reset on a
 * session change and at either edge of a replay view (see the module comment
 * for why the session record is kept); `state` itself is not changed.
 */
export function resetReplayRecorderBaselines(state: ReplayRecorderState): ReplayRecorderState {
  return {
    ...createInitialReplayRecorderState(),
    replaySessionsCandidate: state.replaySessionsCandidate,
    replaySessionsPublished: state.replaySessionsPublished,
    replaySessionsLatestStart: state.replaySessionsLatestStart,
  };
}
