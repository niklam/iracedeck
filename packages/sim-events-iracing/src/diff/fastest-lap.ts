/**
 * The fastest lap of the race in the player's class (issue #1571).
 * Design: docs/superpowers/specs/2026-11-01-issue-1571-fastest-lap-of-the-race.md.
 *
 * Keeps the race's class record in the translator state's `fastestLap` slice
 * (`fastestLap.record`: the time, the holder and whether it is the player,
 * issue #1588) and publishes
 * `fastestLap.set` whenever it falls. Two ways in, one record:
 *
 * - **Every car but the player: the scan.** Per-car baselines of
 *   `CarIdxBestLapTime`, the sim's own judgement of which of a car's laps
 *   count. A car whose value moves to a new positive value below the record
 *   takes it; the lap that set it is the car's `CarIdxLapCompleted` on that
 *   tick (the best refreshes after the crossing, as `CarIdxLastLapTime` does,
 *   so the counter already names the lap just completed). Two cars lowering
 *   the record on one tick produce one event, for the faster. A value that is
 *   not positive never changes a baseline or the record: a car that leaves
 *   the world keeps its baseline and, if it holds the record, keeps the
 *   record — a lap already run does not stop being the fastest because the
 *   car that ran it has gone. The pace car and every car of another class
 *   are skipped.
 * - **The player: the judge.** Never taken from the scan. `diffLaps` calls
 *   the judge {@link createFastestLapJudge} builds, on the tick it emits
 *   `lap.completed`, with that payload's own lap and time, and only for a
 *   lap iRacing took as a new best (`isBest`, issue #1582) — every fastest
 *   lap of the race is one, so that is where whether the lap counted is
 *   decided. So whether the player's lap is the fastest of the race is known
 *   on that payload and the time spoken is the time the lap-time calls
 *   speak. A lap
 *   that passes sets the record to the player and leaves a claim
 *   (`fastestLap.claim`) that {@link diffFastestLap} publishes later in the
 *   same tick, before any gate of its own, so a claim never survives into a
 *   later tick. When `CarIdxBestLapTime[player]` later refreshes to the same
 *   value nothing happens: the player is not scanned.
 *
 * **The scan holds while the player's lap awaits its judgement.** The two
 * ways in run on different clocks: the scan reads every tick, while the
 * judge runs only when `diffLaps` emits, which trails the crossing by the
 * `LapLastLapTime` refresh and then by up to `LAP_RESULTS_SYNC_MAX_WAIT_MS`
 * for the standings. Unheld, a rival crossing inside that window with a lap
 * slower than the player's but faster than the record would be announced as
 * taking the record — "from you", when the record was the player's — and the
 * player's faster lap would then take it back at the emit. So from the tick
 * the player's `LapCompleted` runs ahead of the count `diffLaps` last emitted
 * for ({@link playerLapAwaitsJudgement}), the scan neither advances a
 * baseline nor emits: a remote best that moved meanwhile is seen as new on
 * the first tick after the judge, against the record as the judge left it.
 * The hold is bounded by {@link FASTEST_LAP_HOLD_MAX_MS} from that tick, so
 * a crossing that never emits (a time that never refreshes) cannot freeze
 * the scan. A lap iRacing refused emits too (issue #1582), so its emit ends
 * the hold like any other. The cap is a little past the longest a counted
 * lap can trail its crossing, and equal to the longest a refused lap after a
 * refused lap can (its 2 s wait, then the standings wait): the hold may then
 * release a tick before that emit, which changes nothing, because a refused
 * lap never moves the record.
 * A lap-0 crossing never holds: the judge refuses it whatever its time, so
 * there is nothing to wait for.
 *
 * **One eligibility predicate** ({@link isEligibleRecordLap}) decides which
 * laps can enter the record, for the scan and for the player alike: a race
 * session, past the green, a completed-lap count of at least 1, and a
 * positive time. On a rolling start `CarIdxLastLapTime` is the parade lap,
 * and whether the best carries it into lap 1 is unknown; a lap-0 crossing is
 * refused for everyone, which costs nothing and removes the question. The
 * baselines still absorb every positive value a tick carries, eligible or
 * not, so a value seen while a car's count was 0 is never read as new once
 * the car becomes eligible.
 *
 * **Seeding.** The first eligible tick of a connect or a session seeds
 * silently: the record is the minimum eligible `CarIdxBestLapTime` over the
 * class, the player's car included on this first seed only, and every
 * baseline is the value it holds. A replay glance wipes the baselines and
 * keeps the record (and the first-seed mark): the first live tick back
 * re-seeds the baselines and silently absorbs any remote car whose best is
 * now below the kept record — it becomes the holder, with no event, since the
 * lap was run while nobody was watching. The player's value is not read on a
 * re-seed: the player's laps reach the record through the judge alone.
 *
 * **Race sessions only, live ticks only.** The diff runs after the replay
 * guard and emits nothing outside a race or before the green (the
 * `diffOpponentPit` shape). It runs after `resolveCanonicalOrder`, which the
 * payload's positions read, and after `diffLaps`, which leaves the claim.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import {
  classPositionFromOrder,
  getCarNumberFromSessionInfo,
  isPreGreen,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";

import type { FastestLapRecord, FastestLapState } from "../state.js";
import { type FastestLapJudge, LAP_RESULTS_SYNC_MAX_WAIT_MS, LAP_TIME_REFRESH_ALLOWANCE_MS } from "./laps.js";
import type { EmitFn } from "./types.js";

/** The events {@link diffFastestLap} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const FASTEST_LAP_EVENTS = ["fastestLap.set"] as const satisfies readonly SimEventName[];

/**
 * The longest the remote scan holds for the player's lap (issue #1571): the
 * refresh allowance plus the standings wait `diffLaps` then runs, which is
 * the longest a `lap.completed` can trail the crossing by — a refused lap's
 * included, whose wait for a time `diffLaps` bounds by the same allowance
 * (issue #1582). 5 s today. A crossing still unjudged after this never emits
 * — a lap-0 crossing, a lap whose time never refreshes — and the scan
 * resumes.
 */
export const FASTEST_LAP_HOLD_MAX_MS = LAP_TIME_REFRESH_ALLOWANCE_MS + LAP_RESULTS_SYNC_MAX_WAIT_MS;

/**
 * Whether a lap can enter the record (issue #1571, decision 1): a race
 * session, past the green, the car's completed-lap count at least 1, and a
 * positive, finite time. The one predicate for the scan and the player's
 * judge alike, so the two can never admit different laps.
 */
export function isEligibleRecordLap(
  isRaceSession: boolean,
  telemetry: TelemetryData,
  lapsCompleted: number,
  lapTime: number,
): boolean {
  return isRaceSession && !isPreGreen(telemetry) && lapsCompleted >= 1 && Number.isFinite(lapTime) && lapTime > 0;
}

/**
 * Judge the player's just-completed lap against the record (issue #1571,
 * decision 2, as #1582 amends it): a new record when the lap passes
 * {@link isEligibleRecordLap} and the time is below the record. Validity is
 * not read here: `diffLaps` asks only of a lap iRacing took as a new best,
 * which a lap it refused never is, nor the race start lap. A lap that
 * passes updates the record to the player and leaves the claim for
 * {@link diffFastestLap} to publish later in the same tick. Returns whether
 * it passed, which is exactly `lap.completed.isClassFastestLapOfRace`.
 */
export function resolvePlayerFastestLap(
  slice: FastestLapState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  playerCarIdx: number,
  isRaceSession: boolean,
  lap: number,
  lapTime: number,
): boolean {
  if (playerCarIdx < 0) return false;

  if (!isEligibleRecordLap(isRaceSession, telemetry, lap, lapTime)) return false;

  const previous = slice.record;

  if (previous !== null && lapTime >= previous.lapTime) return false;

  const record: FastestLapRecord = {
    lapTime,
    carIdx: playerCarIdx,
    isPlayer: true,
    carNumber: getCarNumberFromSessionInfo(sessionInfo, playerCarIdx),
  };
  slice.record = record;
  slice.claim = { lap, record, previous };

  return true;
}

/**
 * The narrow judge `diffLaps` is handed (issue #1571, decision 2): closed
 * over the `fastestLap` slice, the tick's session and telemetry, so
 * `laps.ts` reaches the record only through `(lap, lapTime) => boolean` and
 * never imports this module. The one writer of the slice outside
 * {@link diffFastestLap} (issue #1588): it writes `record` and `claim` from
 * inside the `diffLaps` call, into the same object `diffFastestLap` reads
 * later in the tick.
 */
export function createFastestLapJudge(
  slice: FastestLapState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  playerCarIdx: number,
  isRaceSession: boolean,
): FastestLapJudge {
  return (lap, lapTime) =>
    resolvePlayerFastestLap(slice, telemetry, sessionInfo, playerCarIdx, isRaceSession, lap, lapTime);
}

type FastestLapPayload = {
  carIdx: number;
  isPlayer: boolean;
  lap: number;
  lapTime: number;
  previous?: { carIdx: number; lapTime: number; isPlayer: boolean; carNumber?: string };
  carNumber?: string;
  position?: number;
  playerPosition?: number;
  playerLapsCompleted: number;
  isMultiClass?: boolean;
};

/** A car's effective position from the canonical order: class space in a multi-class race, overall otherwise. */
function effectivePosition(
  positions: number[],
  carClasses: number[] | undefined,
  carIdx: number,
  isMultiClass: boolean,
): number {
  return isMultiClass ? classPositionFromOrder(positions, carClasses, carIdx) : (positions[carIdx] ?? 0);
}

/** The player's completed-lap count as `lap.completed` reports it (`LapCompleted`), `0` before the first crossing. */
function playerLapsCompleted(telemetry: TelemetryData): number {
  const laps = telemetry.LapCompleted;

  return typeof laps === "number" && Number.isFinite(laps) && laps > 0 ? laps : 0;
}

function positiveOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Whether the remote scan holds this tick because the player has crossed
 * the line and that lap has not been judged yet (issue #1571). "Crossed but
 * not judged" is read off what is honestly there: the lap diff is seeded
 * (`lapsJudgedThrough` is not `null`; it runs before this diff on every tick,
 * so an unseeded lap diff means no crossing it will ever emit for) and the
 * player's `LapCompleted` is at least 1 and ahead of `lapsJudgedThrough`, the
 * count `diffLaps` last emitted for. The crossing's time is this diff's own,
 * taken on the first tick the count ran ahead and kept in the slice's
 * `hold`; a new count starts a new hold, and the hold clears the tick the
 * counts agree again. Past {@link FASTEST_LAP_HOLD_MAX_MS} the scan resumes
 * with the hold still recorded, so the same unjudged crossing cannot hold
 * again.
 *
 * @param lapsJudgedThrough The player's `LapCompleted` count `diffLaps` last
 *   emitted `lap.completed` for (its `lastLapCompletedCounter`, written only
 *   in `laps.ts`), or `null` while the lap diff is unseeded
 *   (`lapCompletedInitialized` false). `handleTick` reads it when this step
 *   runs, after `diffLaps` (issue #1588).
 */
export function playerLapAwaitsJudgement(
  slice: FastestLapState,
  telemetry: TelemetryData,
  now: number,
  lapsJudgedThrough: number | null,
): boolean {
  const laps = telemetry.LapCompleted;
  const pending =
    lapsJudgedThrough !== null &&
    typeof laps === "number" &&
    Number.isFinite(laps) &&
    laps >= 1 &&
    laps > lapsJudgedThrough;

  if (!pending) {
    slice.hold = null;

    return false;
  }

  if (slice.hold === null || slice.hold.lap !== laps) {
    slice.hold = { lap: laps, since: now };
  }

  return now - slice.hold.since < FASTEST_LAP_HOLD_MAX_MS;
}

/**
 * Per-tick record maintenance and `fastestLap.set` emission (issue #1571).
 *
 * Order inside the tick: the player's claim first, whatever the gates say,
 * then the race and pre-green gates, then the seed, then the hold for the
 * player's unjudged lap, then the scan. Baselines are per car and advance
 * element-wise; the scan reads only the player's class, skipping the player
 * (judged on `lap.completed`) and the pace car. `now` is the tick's clock,
 * the same value `diffLaps` is handed, and only the hold reads it, with
 * `lapsJudgedThrough` (see {@link playerLapAwaitsJudgement}).
 */
export function diffFastestLap(
  slice: FastestLapState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  playerCarIdx: number,
  paceCarIdx: number | null,
  isRaceSession: boolean,
  isMultiClass: boolean | null,
  positions: number[],
  emit: EmitFn<(typeof FASTEST_LAP_EVENTS)[number]>,
  now: number,
  lapsJudgedThrough: number | null,
): void {
  const carClasses = telemetry.CarIdxClass;
  const projection = isMultiClass === true;

  // The player's claim, left by the judge earlier this tick: published and
  // cleared before any gate below, so it can neither survive into a later
  // tick nor be lost to a gate the judge already applied.
  const claim = slice.claim;
  slice.claim = null;

  if (claim !== null) {
    emit({
      event: "fastestLap.set",
      data: buildPayload(claim.record, claim.lap, claim.previous, positions, carClasses, {
        playerCarIdx,
        projection,
        isMultiClass,
        // For the player's own record the count is the lap itself, so its
        // own `lap.completed` never drops it at the audio layer's gate.
        playerLapsCompleted: claim.lap,
      }),
    });
  }

  // Race sessions only, past the green, with a player to scope the class by.
  if (!isRaceSession || isPreGreen(telemetry) || playerCarIdx < 0) return;

  const best = telemetry.CarIdxBestLapTime;
  const completed = telemetry.CarIdxLapCompleted;
  const playerClass = carClasses?.[playerCarIdx];

  if (!best || !completed || !carClasses || typeof playerClass !== "number") return;

  const inClass = (carIdx: number): boolean => carIdx !== paceCarIdx && carClasses[carIdx] === playerClass;

  // Seed: the first eligible tick of a connect or a session (the first seed,
  // which reads the player's car too), or the first live tick after a replay
  // glance (a re-seed, which reads only the remote cars). Silent either way:
  // a connect mid-race and a lap run during a glance are not news.
  if (!slice.baselinesSeeded) {
    slice.baselinesSeeded = true;
    const firstSeed = !slice.raceSeeded;
    slice.raceSeeded = true;
    slice.baselines = [];

    for (let carIdx = 0; carIdx < best.length; carIdx++) {
      const value = positiveOrNull(best[carIdx]);
      slice.baselines[carIdx] = value ?? 0;

      if (value === null || !inClass(carIdx)) continue;

      if (carIdx === playerCarIdx && !firstSeed) continue;

      if (!isEligibleRecordLap(isRaceSession, telemetry, completed[carIdx] ?? -1, value)) continue;

      if (slice.record === null || value < slice.record.lapTime) {
        slice.record = {
          lapTime: value,
          carIdx,
          isPlayer: carIdx === playerCarIdx,
          carNumber: getCarNumberFromSessionInfo(sessionInfo, carIdx),
        };
      }
    }

    return;
  }

  // The hold: the player has crossed and `diffLaps` has not emitted that lap
  // yet, so the judge has not seen it. Nothing moves — no baseline, no event
  // — and a remote best that changes meanwhile is read on the first tick
  // after the judge, against the record as the judge leaves it. Bounded, so
  // a crossing that never emits cannot freeze the scan.
  if (playerLapAwaitsJudgement(slice, telemetry, now, lapsJudgedThrough)) return;

  // The scan: one candidate per tick, the fastest of the cars whose value
  // moved below the record. Every positive value advances its baseline,
  // eligible or not; only an eligible one can take the record.
  let candidate: { carIdx: number; lapTime: number } | null = null;

  for (let carIdx = 0; carIdx < best.length; carIdx++) {
    const value = positiveOrNull(best[carIdx]);

    if (value === null || value === slice.baselines[carIdx]) continue;

    slice.baselines[carIdx] = value;

    if (carIdx === playerCarIdx || !inClass(carIdx)) continue;

    if (!isEligibleRecordLap(isRaceSession, telemetry, completed[carIdx] ?? -1, value)) continue;

    if (slice.record !== null && value >= slice.record.lapTime) continue;

    if (candidate === null || value < candidate.lapTime) candidate = { carIdx, lapTime: value };
  }

  if (candidate === null) return;

  const previous = slice.record;
  const record: FastestLapRecord = {
    lapTime: candidate.lapTime,
    carIdx: candidate.carIdx,
    isPlayer: false,
    carNumber: getCarNumberFromSessionInfo(sessionInfo, candidate.carIdx),
  };
  slice.record = record;

  emit({
    event: "fastestLap.set",
    data: buildPayload(record, completed[candidate.carIdx] ?? 0, previous, positions, carClasses, {
      playerCarIdx,
      projection,
      isMultiClass,
      playerLapsCompleted: playerLapsCompleted(telemetry),
    }),
  });
}

function buildPayload(
  record: FastestLapRecord,
  lap: number,
  previous: FastestLapRecord | null,
  positions: number[],
  carClasses: number[] | undefined,
  ctx: { playerCarIdx: number; projection: boolean; isMultiClass: boolean | null; playerLapsCompleted: number },
): FastestLapPayload {
  const data: FastestLapPayload = {
    carIdx: record.carIdx,
    isPlayer: record.isPlayer,
    lap,
    lapTime: record.lapTime,
    playerLapsCompleted: ctx.playerLapsCompleted,
  };

  if (previous !== null) {
    data.previous = { carIdx: previous.carIdx, lapTime: previous.lapTime, isPlayer: previous.isPlayer };

    if (previous.carNumber !== null) data.previous.carNumber = previous.carNumber;
  }

  if (record.carNumber !== null) data.carNumber = record.carNumber;

  const position = effectivePosition(positions, carClasses, record.carIdx, ctx.projection);

  if (position > 0) data.position = position;

  if (ctx.playerCarIdx >= 0) {
    const playerPosition = effectivePosition(positions, carClasses, ctx.playerCarIdx, ctx.projection);

    if (playerPosition > 0) data.playerPosition = playerPosition;
  }

  if (ctx.isMultiClass !== null) data.isMultiClass = ctx.isMultiClass;

  return data;
}
