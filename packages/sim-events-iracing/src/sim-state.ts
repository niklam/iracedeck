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
 * Spec: `docs/superpowers/specs/2026-10-10-issue-1387-snapshot-plugin-state.md`.
 */
import type { ReplayState, TelemetryData } from "@iracedeck/iracing-sdk";

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
 * What the laps-of-fuel-left callout's formula gives for one tick: every step
 * of the count, the remaining race distance it is compared with, and the
 * verdict. `covered` is the diff's own `count >= remainingLaps`.
 */
export type SimFuelLapsLeftNow = FuelLapsLeftEstimate & FuelRaceCoverage & { covered: boolean };

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

/**
 * The translator's state for one Telemetry Snapshot (issue #1387).
 * `{ initialized: false }` and nothing else while there is no translator.
 */
export type SimStateSnapshot =
  | { initialized: false }
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
           * The callout's formula at THIS tick, or `null` when it has no
           * inputs: no telemetry, an unusable `FuelLevel` or `LapDistPct`, or
           * no validated average. Not what was spoken — the callout samples
           * once per lap, at mid-lap; `announced` is what it said.
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
      raw: { state: TranslatorState; instance: SimInstanceFlags; replay: ReplayState };
    };

/** What `readSimState()` gathers from the translator instance for {@link buildSimState}. */
export type SimStateParts = {
  telemetry: TelemetryData | null;
  /** The controller's debounced replay state (#1324), read at the press. */
  replay: ReplayState;
  fuel: {
    windowLaps: number;
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
 * The laps-of-fuel-left figure for `telemetry`, by the two functions the diff
 * itself calls. The input checks are the diff's own, minus its gates: this
 * answers "what would the formula say now", so the race-session, live-in-car
 * and mid-lap-sample conditions do not apply — only the ones without which
 * there is no arithmetic to do.
 */
function resolveLapsLeftNow(telemetry: TelemetryData | null, fuel: SimStateParts["fuel"]): SimFuelLapsLeftNow | null {
  if (telemetry === null) return null;

  const fuelLevel = telemetry.FuelLevel;
  const distPct = telemetry.LapDistPct;
  const { stats } = fuel;

  if (
    typeof fuelLevel !== "number" ||
    !Number.isFinite(fuelLevel) ||
    fuelLevel < 0 ||
    typeof distPct !== "number" ||
    !Number.isFinite(distPct)
  ) {
    return null;
  }

  if (stats.avg === null || stats.avg <= 0) return null;

  const estimate = estimateFuelLapsLeft(fuelLevel, distPct, stats.avg, fuel.getMarginLaps());
  const coverage = resolveFuelRaceCoverage(telemetry, stats, estimate.lapFractionRemaining, fuel.getLeaderLapTimeS);

  return { ...estimate, ...coverage, covered: estimate.count >= coverage.remainingLaps };
}

/**
 * Shape the gathered parts into the snapshot's `sim` section. Pure: it reads
 * the parts, calls the two closures at most once each, and writes nothing.
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
        now: resolveLapsLeftNow(telemetry, parts.fuel),
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
 */
export function simStateHeadline(state: SimStateSnapshot): Array<readonly [string, string]> {
  if (!state.initialized) return [["Sim state", "not initialized"]];

  const { stats, lapsLeft } = state.fuel;
  const { player } = state.order;
  const announced = lapsLeft.announced.lastAnnouncedCount;

  return [
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
