/**
 * The translator's state as the Telemetry Snapshot records it (issue #1387).
 *
 * Take Snapshot writes what the plugin had computed at the press beside the
 * telemetry it computed it from, so a support case can tell a wrong input
 * from a wrong calculation. This module is the SHAPE of the translator's
 * section: curated keys first (`fuel`, `order`, `gaps`, `opponentFlags`,
 * `caution`, `session`), then `raw` — the whole `TranslatorState` and the
 * instance's own flags, uncurated.
 *
 * `readSimState()` in `translator.ts` gathers the parts, because the
 * translator instance is visible only there; everything here is pure. Three
 * properties the snapshot relies on:
 *
 * - **Nothing is copied.** The result holds the live objects — the lap
 *   history, the traces, the Sets in the raw state. The JSON-safe encoder in
 *   `@iracedeck/diagnostics` copies them at the press, synchronously, before
 *   another tick can land. A caller that keeps the result instead holds
 *   state the next tick mutates.
 * - **Nothing but data.** No bus, controller, logger or closure is ever put
 *   in the result; the two closures in {@link SimStateParts} are called here
 *   and dropped.
 * - **No stability promise under `raw`.** Its field names are the code's and
 *   may change in any release; the curated keys are what a schema bump covers.
 *
 * The two halves fail apart. The curated half calls accessors and does
 * arithmetic, so a defect can make it throw; the raw half only reads fields.
 * When the curated half throws, the reader answers the degraded shape —
 * `raw` and a `curatedError` saying why — instead of throwing itself, because
 * the raw state is the dump that explains exactly that kind of defect
 * ({@link buildDegradedSimState}).
 *
 * Spec: `docs/superpowers/specs/2026-10-10-issue-1387-snapshot-plugin-state.md`.
 */
import { isPostRace, type ReplayState, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { CautionLineup } from "./diff/caution-lineup.js";
import {
  estimateFuelLapsLeft,
  type FuelLapsLeftEstimate,
  type FuelRaceCoverage,
  resolveFuelRaceCoverage,
} from "./diff/fuel-laps-left.js";
import type { FuelLap, FuelLapTracker, FuelStats } from "./diff/fuel-laps.js";
import type { CautionEpisode, CautionPhase, RaceFinishResult, TranslatorState } from "./state.js";
import type { TrackDirection } from "./track-type.js";
import type { GapNeighbor, LiveGaps, LiveOpponentFlags, LivePosition } from "./translator.js";

/**
 * Why the laps-of-fuel-left count is compared with no race distance: the
 * states in which `resolveFuelRaceCoverage` has no meaningful answer, each of
 * which `diffFuelLapsLeft` returns on before it would call it.
 *
 * - `"not-a-race-session"` — there is no race to cover. The lap counter and
 *   the clock mean something else outside a race, and the timed side is a
 *   model of how a race finishes.
 * - `"race-over"` — the chequered flag is out or the field is cooling down.
 * - `"final-lap"` — the player has started their own final lap
 *   (`playerFinalLapStarted`). The coverage arithmetic assumes they have not:
 *   under the white flag it counts at least one more lap for the player to
 *   start, which on the final lap would call a tank that finishes the race
 *   one lap short.
 */
export type SimFuelCoverageSkip = "not-a-race-session" | "race-over" | "final-lap";

/**
 * What the laps-of-fuel-left callout's formula gives for one tick: every step
 * of the count, then the remaining race distance it is compared with and the
 * verdict — `covered` is the diff's own `count >= remainingLaps`.
 *
 * The count stands in any session. The comparison does not: where it has no
 * meaningful answer its four keys are `null` and `coverageSkipped` says why.
 * That is different from a race whose limits are unknown, which is compared
 * (`coverageSkipped: null`) against `remainingLaps: Infinity`.
 */
export type SimFuelLapsLeftNow = FuelLapsLeftEstimate &
  (
    | (FuelRaceCoverage & { covered: boolean; coverageSkipped: null })
    | {
        lapsNeededAfterCurrent: null;
        timedLapsAfterCurrent: null;
        remainingLaps: null;
        covered: null;
        coverageSkipped: SimFuelCoverageSkip;
      }
  );

/** The translator instance's own flags — the ones that live beside `TranslatorState`, not in it. */
export type SimInstanceFlags = {
  lastTickInReplay: boolean;
  lastObservedSessionNum: number | null;
  firstOnTrackSeeded: boolean;
  firstOnTrackFired: boolean;
  freshConnectFireChecked: boolean;
  freshConnectReplaySkipLogged: boolean;
  pitSpeedLimitMps: number;
  pitSpeedLimitKey: string;
};

/** The player's place in the race, by each source that states one. */
export type SimOrderState = {
  /** The canonical live order, 1-based rank by car index (`getLiveRacePositions()`). */
  positions: number[] | null;
  /** The player's live position (`getLivePosition()`). */
  player: LivePosition | null;
  /** The qualifying grid slot (`getStartingGridPosition()`). */
  startingGrid: { overall: number; class: number } | null;
  /** The official finish, once the player has taken the flag (`getRaceFinishResult()`). */
  raceFinish: RaceFinishResult | null;
};

/** The current full-course caution, as the three caution accessors report it. */
export type SimCautionState = {
  phase: CautionPhase;
  episode: CautionEpisode | null;
  lineup: CautionLineup | null;
};

/** What the translator knows about the session the car is in. */
export type SimSessionState = {
  /** iRacing's raw session type ("Race", "Lone Qualify", …), `""` while unknown. */
  type: string;
  trackDirection: TrackDirection;
  standingStart: boolean;
  /** Whether the pit-action confirmations are out of their cooldown, at the moment of the read. */
  pitActionsAllowed: boolean;
  /** The settled repair state, `null` before the damage diff has seeded. */
  damageRepairNeeded: boolean | null;
  raceFinished: boolean;
};

/** The uncurated half: the whole `TranslatorState`, the instance's own flags and the controller's replay state. */
export type SimRawState = { state: TranslatorState; instance: SimInstanceFlags; replay: ReplayState };

/**
 * The translator's state for one Telemetry Snapshot (issue #1387), in one of
 * three shapes:
 *
 * - `{ initialized: false }` and nothing else while there is no translator.
 * - The **degraded** shape, `{ initialized: true, curatedError, raw }`, when
 *   building the curated half threw. Recognised by its `curatedError` key.
 * - The **full** shape otherwise.
 */
export type SimStateSnapshot =
  | { initialized: false }
  | {
      initialized: true;
      /**
       * Why the curated keys are missing: the message of what was thrown while
       * building them. Deliberately not named `error` — the snapshot's
       * collector writes `{ error }` in place of a section whose reader threw
       * outright, and a section that still carries `raw` must not read as that.
       */
      curatedError: string;
      /**
       * As in the full shape, except that `replay` is `null` when reading the
       * controller's replay state is itself what threw.
       */
      raw: Omit<SimRawState, "replay"> & { replay: ReplayState | null };
    }
  | {
      initialized: true;
      /**
       * `SessionTick` of the translator's latest telemetry, `null` when it has
       * none. Equal to the snapshot's own `telemetry.SessionTick` when both
       * describe one tick.
       */
      sessionTick: number | null;
      /**
       * A replay is on screen by the controller's debounced replay state
       * (#1324), the read the translator's replay guard makes: while it holds,
       * the guard returns before any diff runs, so the state below is the
       * wiped one, not a reading of the latest tick. It is read at the press,
       * and the exit grace runs on wall time, so it can have just expired
       * since the last tick; `raw.replay` holds the whole state.
       */
      inReplay: boolean;
      fuel: {
        /** The valid-lap window `stats` is taken over — the callout's, not a Session Info key's. */
        windowLaps: number;
        stats: FuelStats;
        /** Every recorded lap, valid or not, oldest first. */
        history: FuelLap[];
        /** The lap segment in progress. */
        tracker: Omit<FuelLapTracker, "history">;
        lapsLeft: {
          /**
           * The callout's formula at THIS tick, or `null` when its arithmetic
           * has no inputs: no telemetry, an unusable `FuelLevel`, a `Lap` or
           * `LapDistPct` that is not a position on a lap (both read -1 while
           * the car is not in the world), or no validated average. Not what
           * was spoken — the callout samples once per lap, at mid-lap;
           * `announced` is what it said.
           */
          now: SimFuelLapsLeftNow | null;
          /** The callout's latches. */
          announced: {
            lastAnnouncedCount: number | null;
            lastSampledLap: number;
            raceCoveredAnnounced: boolean;
          };
        };
      };
      order: SimOrderState;
      gaps: LiveGaps | null;
      opponentFlags: LiveOpponentFlags | null;
      caution: SimCautionState;
      session: SimSessionState;
      raw: SimRawState;
    };

/** What `readSimState()` gathers from the translator instance for {@link buildSimState}. */
export type SimStateParts = {
  telemetry: TelemetryData | null;
  /** The controller's debounced replay state (#1324), read at the press. */
  replay: ReplayState;
  fuel: {
    windowLaps: number;
    /** `handleTick`'s own `isRaceSession`, which `diffFuelLapsLeft` returns on first. */
    isRaceSession: boolean;
    /** The stats the laps-of-fuel-left diff reads, over `windowLaps`. */
    stats: FuelStats;
    tracker: FuelLapTracker;
    /** The margin closure the diff is handed. Called only when there is an estimate to subtract it from. */
    getMarginLaps: () => number;
    /** The leader-lap resolver the diff is handed. Called only when the timed side is computed. */
    getLeaderLapTimeS: () => number | null;
  };
  order: SimOrderState;
  gaps: LiveGaps | null;
  opponentFlags: LiveOpponentFlags | null;
  caution: SimCautionState;
  session: SimSessionState;
  state: TranslatorState;
  instance: SimInstanceFlags;
};

/**
 * Whether the race-coverage comparison has an answer for this tick, or why
 * not — see {@link SimFuelCoverageSkip}. The order is the diff's own: the
 * session first, then the two it tests together.
 */
function resolveCoverageSkip(
  telemetry: TelemetryData,
  isRaceSession: boolean,
  state: TranslatorState,
): SimFuelCoverageSkip | null {
  if (!isRaceSession) return "not-a-race-session";

  if (isPostRace(telemetry)) return "race-over";

  if (state.playerFinalLapStarted) return "final-lap";

  return null;
}

/**
 * The laps-of-fuel-left figure for `telemetry`, by the two functions the diff
 * itself calls. It answers "what would the formula say now", so each of
 * `diffFuelLapsLeft`'s early returns is sorted into one of two kinds, and the
 * reader honours only the first:
 *
 * **A precondition of the arithmetic** — without it the functions return a
 * number that means nothing.
 *
 * - The input checks: a finite, non-negative `FuelLevel`; a finite `Lap` that
 *   is not negative; a finite `LapDistPct`. `Lap` is no operand, but a
 *   negative one is the car-not-in-world sentinel, under which `LapDistPct`
 *   reads -1 too and `1 − LapDistPct` would count two laps left of this one.
 * - `LapDistPct >= 0`. The diff never states it, because its mid-lap sample
 *   only runs at 0.5 and above; read at any tick, the reader has to.
 * - A validated, positive average.
 * - For the COVERAGE half only: a race session, not post-race, and the player
 *   not on their final lap ({@link resolveCoverageSkip}). The count stands
 *   without them, so the figure is kept and the comparison is marked skipped.
 *
 * **A gate on when the callout speaks** — the arithmetic is as good on either
 * side of it, so the reader ignores it.
 *
 * - The silent seed, the rising mid-lap crossing and the once-per-lap latch:
 *   when the diff samples.
 * - `isLiveOnTrack`: whom it speaks to. Its two arithmetic cases are covered
 *   elsewhere — a car not in the world by the sentinel checks above, a replay
 *   by `inReplay`, which says of every figure in the section that it is not
 *   the live race.
 * - Everything after the arithmetic: the suppression at coverage, the
 *   10-count ceiling and the descending-only rule decide what is said.
 */
function resolveLapsLeftNow(
  telemetry: TelemetryData | null,
  fuel: SimStateParts["fuel"],
  state: TranslatorState,
): SimFuelLapsLeftNow | null {
  if (telemetry === null) return null;

  const fuelLevel = telemetry.FuelLevel;
  const distPct = telemetry.LapDistPct;
  const lap = telemetry.Lap;
  const { stats } = fuel;

  if (
    typeof fuelLevel !== "number" ||
    !Number.isFinite(fuelLevel) ||
    fuelLevel < 0 ||
    typeof distPct !== "number" ||
    !Number.isFinite(distPct) ||
    distPct < 0 ||
    typeof lap !== "number" ||
    !Number.isFinite(lap) ||
    lap < 0
  ) {
    return null;
  }

  if (stats.avg === null || stats.avg <= 0) return null;

  const estimate = estimateFuelLapsLeft(fuelLevel, distPct, stats.avg, fuel.getMarginLaps());
  const coverageSkipped = resolveCoverageSkip(telemetry, fuel.isRaceSession, state);

  if (coverageSkipped !== null) {
    return {
      ...estimate,
      lapsNeededAfterCurrent: null,
      timedLapsAfterCurrent: null,
      remainingLaps: null,
      covered: null,
      coverageSkipped,
    };
  }

  const coverage = resolveFuelRaceCoverage(telemetry, stats, estimate.lapFractionRemaining, fuel.getLeaderLapTimeS);

  return { ...estimate, ...coverage, covered: estimate.count >= coverage.remainingLaps, coverageSkipped: null };
}

/** The longest reason {@link buildDegradedSimState} records; a message is a sentence, not a dump. */
const CURATED_ERROR_MAX_LENGTH = 300;
const UNKNOWN_REASON = "unknown error";

/** The text of a primitive, `""` for anything else. Cannot throw: an object's own conversion is never called. */
function textOf(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value.trim();
    case "number":
    case "bigint":
    case "boolean":
    case "symbol":
      return String(value);
    default:
      return "";
  }
}

/**
 * Why the curated half failed, as a bounded, non-empty string: the thrown
 * value's `message`, else its `name`, else the value itself when it is a
 * primitive. The rule of `describeThrown` in `@iracedeck/diagnostics`, which
 * writes the collector's own error entries — restated because this package
 * does not import diagnostics — so a reason reads the same whichever wrote it.
 * Total: it runs inside a `catch`, and anything can be thrown.
 */
function describeFailure(thrown: unknown): string {
  try {
    const reason =
      typeof thrown !== "object" || thrown === null
        ? textOf(thrown)
        : textOf((thrown as { message?: unknown }).message) || textOf((thrown as { name?: unknown }).name);

    return (reason || UNKNOWN_REASON).slice(0, CURATED_ERROR_MAX_LENGTH);
  } catch {
    // A getter or a Proxy trap on the thrown value.
    return UNKNOWN_REASON;
  }
}

/**
 * The degraded shape: the raw half and the reason the curated half is
 * missing. `readSimState()` answers it when anything it calls for the curated
 * keys throws, so one broken accessor costs the keys it feeds and not the
 * state that would explain it. Cannot throw: it reads nothing but what it is
 * handed, and {@link describeFailure} is total.
 */
export function buildDegradedSimState(
  raw: Omit<SimRawState, "replay"> & { replay: ReplayState | null },
  thrown: unknown,
): SimStateSnapshot {
  return { initialized: true, curatedError: describeFailure(thrown), raw };
}

/**
 * Shape the gathered parts into the snapshot's `sim` section. Pure: it reads
 * the parts, calls the two closures at most once each, and writes nothing.
 * Always the full shape; it throws what a closure throws, and the reader
 * turns that into the degraded one.
 */
export function buildSimState(parts: SimStateParts): SimStateSnapshot {
  const { telemetry, state } = parts;
  // Rest, not delete: the tracker is the translator's live object.
  const { history, ...tracker } = parts.fuel.tracker;
  const sessionTick = telemetry?.SessionTick;

  return {
    initialized: true,
    sessionTick: typeof sessionTick === "number" ? sessionTick : null,
    inReplay: parts.replay.inReplay,
    fuel: {
      windowLaps: parts.fuel.windowLaps,
      stats: parts.fuel.stats,
      history,
      tracker,
      lapsLeft: {
        now: resolveLapsLeftNow(telemetry, parts.fuel, state),
        announced: {
          lastAnnouncedCount: state.fuelCalloutLastAnnouncedCount,
          lastSampledLap: state.fuelCalloutLastSampledLap,
          raceCoveredAnnounced: state.fuelCalloutRaceCoveredAnnounced,
        },
      },
    },
    order: parts.order,
    gaps: parts.gaps,
    opponentFlags: parts.opponentFlags,
    caution: parts.caution,
    session: parts.session,
    raw: { state, instance: parts.instance, replay: parts.replay },
  };
}

function formatGap(neighbor: GapNeighbor | null): string {
  if (neighbor === null) return "none";

  if (neighbor.gapSeconds !== null) return `${neighbor.gapSeconds.toFixed(1)} s (car ${neighbor.carIdx})`;

  if (neighbor.lapDelta !== 0) {
    return `${neighbor.lapDelta} ${Math.abs(neighbor.lapDelta) === 1 ? "lap" : "laps"} apart (car ${neighbor.carIdx})`;
  }

  return `no reading (car ${neighbor.carIdx})`;
}

/**
 * The label/value rows the snapshot's Markdown report shows for this section:
 * fuel per lap with its sample count, laps of fuel left with the last
 * announced count, live position, the gaps ahead and behind, and the caution
 * phase. Fuel is in litres, the tracker's own unit.
 *
 * While a replay is on screen a `Replay` row comes first, so it is read
 * before the figures it qualifies: they are made from the replay's frame and
 * from a state the replay guard has wiped, under labels such as "Live
 * position". A state that is not initialized, or whose curated half could not
 * be built, answers one `Sim state` row saying so.
 */
export function simStateHeadline(state: SimStateSnapshot): Array<readonly [string, string]> {
  if (!state.initialized) return [["Sim state", "not initialized"]];

  if ("curatedError" in state) {
    return [["Sim state", `figures unavailable (${state.curatedError}); the raw state is in the JSON file`]];
  }

  const { stats, lapsLeft } = state.fuel;
  const { player } = state.order;
  const announced = lapsLeft.announced.lastAnnouncedCount;
  const replayRow: Array<readonly [string, string]> = state.inReplay
    ? [["Replay", "A replay was on screen when this snapshot was taken. The figures below are not the live race."]]
    : [];

  return [
    ...replayRow,
    [
      "Fuel per lap",
      stats.avg === null
        ? "no valid laps"
        : `${stats.avg.toFixed(2)} L (${stats.samples} valid ${stats.samples === 1 ? "lap" : "laps"})`,
    ],
    [
      "Laps of fuel left",
      `${lapsLeft.now === null ? "no estimate" : lapsLeft.now.count} (last announced: ${announced ?? "none"})`,
    ],
    [
      "Live position",
      player === null
        ? "unknown"
        : player.isMultiClass && player.classPosition > 0
          ? `P${player.position} (P${player.classPosition} in class)`
          : `P${player.position}`,
    ],
    ["Gap ahead", formatGap(state.gaps?.ahead ?? null)],
    ["Gap behind", formatGap(state.gaps?.behind ?? null)],
    ["Caution phase", state.caution.phase],
  ];
}
