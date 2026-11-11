/**
 * Rejoining from a stop (issue #1113, spec decisions 2 and 3): while the
 * player is stopped or crawling on the circuit, whether a car is coming, and
 * how soon. Publishes `traffic.rejoin`.
 *
 * **The episode.** It starts once every entry gate has held, with the car
 * below {@link TRAFFIC_REJOIN_CRAWL_MPS}, for {@link TRAFFIC_REJOIN_ENTRY_DWELL_MS}.
 * Every gate is a positive read, so a field the sim did not send keeps the
 * engineer quiet rather than guessing: live in the car (`IsOnTrack` true),
 * `PlayerTrackSurface` the racing surface or beside it (`OnTrack` /
 * `OffTrack`), `OnPitRoad` not true, `IsInGarage` not true, a readable
 * `SessionState` past the green (`isPreGreen` false, which keeps the grid
 * out), a readable speed and a player position on the lap. No incident
 * precondition: a stall, a stop to avoid a crash and an unscored spin need
 * the same answer. It ends silently when any gate fails, or once the car has
 * been above {@link TRAFFIC_REJOIN_MOVING_MPS} for
 * {@link TRAFFIC_REJOIN_END_DWELL_MS}: the gap between the two speeds is the
 * hysteresis, so a car creeping through a gravel trap does not flicker in and
 * out of an episode.
 *
 * **The verdict.** On entry and then every
 * {@link TRAFFIC_REJOIN_EVAL_INTERVAL_MS}, every car on the racing surface is
 * timed to the player's lap position P through `computeTrafficArrivals`: its
 * class's learned curve at P first, then the player's own `CarIdxEstTime`
 * scaled to its class. The nearest timed arrival gives `hold` at or inside
 * the hold window, `notice` at or inside the notice window, `clear` beyond it
 * (or with no car at all). The hold window is clamped to the notice window
 * here: the two are separate settings and neither sanitizer rewrites the
 * other.
 *
 * **When it speaks.** On the episode's first verdict, on a verdict change,
 * and when the nearest arrival has moved by
 * {@link TRAFFIC_REJOIN_REANNOUNCE_DELTA_S} or more since the value last
 * spoken (`notice` and `hold` only: a clear line carries the window, not an
 * arrival) — never on every evaluation. After a hold, the first evaluation
 * with nothing timed inside the hold window says `go` instead of the table's
 * verdict, once; the table's verdict at that moment becomes the baseline, so
 * the evaluations after it speak only on the ordinary rules.
 *
 * **Untimed cars.** A car no source can time only withholds `clear` (and the
 * `go` that also says clear): timed cars still give their notice and hold. A
 * clear withheld that way — untimed cars the only ones, or the timed ones all
 * beyond the notice window — emits nothing, and is logged once per episode at
 * debug with each car's reason (spec decision 5: never invent a number).
 *
 * **The seconds.** Whole seconds, rounded down, the cautious direction: a car
 * at 4.9 s is "four seconds". At least 2 for a notice and 1 for a hold, the
 * bottoms of their clip ranges; a clear speaks the notice window.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import { isPreGreen, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import { createTrafficRejoinState, type TrafficArrivalState, type TrafficRejoinState } from "../state.js";
import { isRacingSurface } from "./track-surface.js";
import {
  computeTrafficArrivals,
  curveReferenceSource,
  resolveCarClassId,
  scaledReferenceSource,
  type TrafficArrival,
  type TrafficClassInfo,
  type TrafficTelemetry,
} from "./traffic-arrival.js";
import type { EmitFn } from "./types.js";

/** The events {@link diffTrafficRejoin} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const TRAFFIC_REJOIN_EVENTS = ["traffic.rejoin"] as const satisfies readonly SimEventName[];

/**
 * Below this speed (m/s, about 11 km/h) the car counts as stopped or crawling.
 * Far under the slowest corner of any road course (a hairpin is taken at 50
 * km/h or more) and under any caution or formation pace, so a moving race car
 * never reads as one, while a car rolling backwards after a spin or creeping
 * out of the gravel still does.
 */
export const TRAFFIC_REJOIN_CRAWL_MPS = 3;

/**
 * How long the car must stay under the crawl speed, every gate holding, before
 * the episode starts (ms): a spin that ends with the car already pulling away,
 * or the instant of zero speed in a three-point turn, is not a rejoin.
 */
export const TRAFFIC_REJOIN_ENTRY_DWELL_MS = 1_500;

/**
 * Above this speed (m/s, about 29 km/h) the car counts as moving again. Well
 * above the crawl speed, so the band between them is the hysteresis: a car
 * creeping through gravel at walking pace stays in its episode.
 */
export const TRAFFIC_REJOIN_MOVING_MPS = 8;

/** How long the car must stay above the moving speed before the episode ends (ms): rejoined, not a lurch. */
export const TRAFFIC_REJOIN_END_DWELL_MS = 2_000;

/**
 * How often an episode re-times the cars (ms): once a second, the resolution
 * the spoken whole seconds have. Each evaluation may or may not speak.
 */
export const TRAFFIC_REJOIN_EVAL_INTERVAL_MS = 1_000;

/**
 * How far the nearest arrival must move (s) from the value last spoken before
 * an unchanged notice or hold is said again: enough that the new number is
 * news (a car at 15 s heard again at 12 s), not so little that a steadily
 * closing car is counted down second by second.
 */
export const TRAFFIC_REJOIN_REANNOUNCE_DELTA_S = 3;

/** The lowest number a notice speaks (s): the bottom of its clip range. */
export const TRAFFIC_REJOIN_MIN_NOTICE_SECONDS = 2;

/** The lowest number a hold speaks (s): the bottom of its clip range. */
export const TRAFFIC_REJOIN_MIN_HOLD_SECONDS = 1;

/** The windows the episode reads, live at each evaluation; each closure is the plugin's sanitized setting. */
export type TrafficRejoinWindows = {
  /** `trafficNoticeSeconds`: how far ahead the engineer looks. */
  getNoticeSeconds: () => number;
  /** `trafficHoldSeconds`: a car inside it means stay put; clamped to the notice window here. */
  getHoldSeconds: () => number;
};

/** The telemetry the rejoin detector reads: the gates, the speed and the arrival model's arrays. */
export type TrafficRejoinTelemetry = TrafficTelemetry &
  Pick<TelemetryData, "IsOnTrack" | "IsInGarage" | "OnPitRoad" | "PlayerTrackSurface" | "SessionState" | "Speed">;

/** Which entry gate refused a tick, named in the episode-end debug line. */
type RejoinGate = "notInCar" | "inGarage" | "surface" | "pitRoad" | "preGreen" | "noSpeed" | "noPosition";

type TableVerdict = "clear" | "notice" | "hold";

type TimedArrival = Extract<TrafficArrival, { timed: true }>;
type UntimedArrival = Extract<TrafficArrival, { timed: false }>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The first entry gate the tick fails, or `null` when every one holds (module header). */
function failedGate(telemetry: TrafficRejoinTelemetry, playerCarIdx: number): RejoinGate | null {
  if (telemetry.IsOnTrack !== true) return "notInCar";

  if (telemetry.IsInGarage === true) return "inGarage";

  if (!isRacingSurface(telemetry.PlayerTrackSurface)) return "surface";

  if (telemetry.OnPitRoad === true) return "pitRoad";

  if (typeof telemetry.SessionState !== "number" || isPreGreen(telemetry)) return "preGreen";

  if (!isFiniteNumber(telemetry.Speed)) return "noSpeed";

  const pct = playerCarIdx >= 0 ? telemetry.CarIdxLapDistPct?.[playerCarIdx] : undefined;

  if (!isFiniteNumber(pct) || pct < 0 || pct >= 1) return "noPosition";

  return null;
}

/** How long since `since` (ms); a clock that stepped back counts as just now. */
function elapsed(now: number, since: number): number {
  return Math.max(0, now - since);
}

/** "car 5 at 4.62 s via curve", or what stands in for it when no car was timed. */
function describeNearest(nearest: TimedArrival | null): string {
  return nearest === null
    ? "no timed car"
    : `nearest car ${nearest.carIdx} at ${nearest.seconds.toFixed(2)} s via ${nearest.source}`;
}

/** "car 3 (noReference), car 7 (noClass)". */
function describeUntimed(untimed: readonly UntimedArrival[]): string {
  return untimed.map((car) => `car ${car.carIdx} (${car.reason})`).join(", ");
}

/**
 * The rejoin detector's per-tick step: runs the entry dwell, the episode and
 * its evaluations, and emits `traffic.rejoin` by the rules in the module
 * header. Owns `episode` (`state.trafficRejoin`) and writes nothing else.
 *
 * @param episode The rejoin episode, mutated in place.
 * @param curves The per-class reference curves (`state.trafficArrival`, written by `updateTrafficReferenceCurves` earlier in the tick), read only.
 * @param playerCarIdx The player's car index (`resolvePlayerCarIdx`), `-1` when unknown, which fails the position gate.
 * @param classes The class lap times and each car's class (`resolveTrafficClassInfo`), `null` without session info.
 */
export function diffTrafficRejoin(
  episode: TrafficRejoinState,
  curves: Readonly<TrafficArrivalState>,
  telemetry: TrafficRejoinTelemetry,
  playerCarIdx: number,
  classes: TrafficClassInfo | null,
  windows: TrafficRejoinWindows,
  now: number,
  emit: EmitFn<(typeof TRAFFIC_REJOIN_EVENTS)[number]>,
  logger: ILogger,
): void {
  const gate = failedGate(telemetry, playerCarIdx);

  if (gate !== null) {
    if (episode.active) logger.debug(`Rejoin: episode ended (${gate})`);

    Object.assign(episode, createTrafficRejoinState());

    return;
  }

  // The gate checked both.
  const speed = telemetry.Speed as number;
  const pct = telemetry.CarIdxLapDistPct?.[playerCarIdx] as number;

  if (!episode.active) {
    if (speed >= TRAFFIC_REJOIN_CRAWL_MPS) {
      episode.slowSince = null;

      return;
    }

    if (episode.slowSince === null || episode.slowSince > now) episode.slowSince = now;

    if (elapsed(now, episode.slowSince) < TRAFFIC_REJOIN_ENTRY_DWELL_MS) return;

    Object.assign(episode, createTrafficRejoinState(), { active: true });
    logger.debug(`Rejoin: episode started (pct=${pct.toFixed(4)}, speed=${speed.toFixed(1)} m/s)`);
    evaluate(episode, curves, telemetry, pct, playerCarIdx, classes, windows, now, emit, logger);

    return;
  }

  if (speed > TRAFFIC_REJOIN_MOVING_MPS) {
    if (episode.movingSince === null || episode.movingSince > now) episode.movingSince = now;

    if (elapsed(now, episode.movingSince) >= TRAFFIC_REJOIN_END_DWELL_MS) {
      logger.debug(`Rejoin: episode ended (moving at ${speed.toFixed(1)} m/s)`);
      Object.assign(episode, createTrafficRejoinState());

      return;
    }
  } else {
    episode.movingSince = null;
  }

  if (episode.lastEvalAt !== null && elapsed(now, episode.lastEvalAt) < TRAFFIC_REJOIN_EVAL_INTERVAL_MS) return;

  evaluate(episode, curves, telemetry, pct, playerCarIdx, classes, windows, now, emit, logger);
}

/** One evaluation: time the cars to P, take the table's verdict, and speak by the rules (module header). */
function evaluate(
  episode: TrafficRejoinState,
  curves: Readonly<TrafficArrivalState>,
  telemetry: TrafficRejoinTelemetry,
  pct: number,
  playerCarIdx: number,
  classes: TrafficClassInfo | null,
  windows: TrafficRejoinWindows,
  now: number,
  emit: EmitFn<(typeof TRAFFIC_REJOIN_EVENTS)[number]>,
  logger: ILogger,
): void {
  episode.lastEvalAt = now;

  const notice = windows.getNoticeSeconds();
  const hold = Math.min(windows.getHoldSeconds(), notice);
  const playerClass = resolveCarClassId(telemetry, classes, playerCarIdx);
  const playerEstTime = telemetry.CarIdxEstTime?.[playerCarIdx];
  const sources = [
    curveReferenceSource(curves, pct),
    scaledReferenceSource(isFiniteNumber(playerEstTime) ? playerEstTime : null, playerClass, classes),
  ];
  const arrivals = computeTrafficArrivals(curves, pct, sources, telemetry, playerCarIdx, classes);
  const untimed = arrivals.filter((a): a is UntimedArrival => !a.timed);
  let nearest: TimedArrival | null = null;

  for (const arrival of arrivals) {
    if (arrival.timed && (nearest === null || arrival.seconds < nearest.seconds)) nearest = arrival;
  }

  const verdict: TableVerdict =
    nearest !== null && nearest.seconds <= hold
      ? "hold"
      : nearest !== null && nearest.seconds <= notice
        ? "notice"
        : "clear";
  const nearestSeconds = nearest?.seconds ?? null;

  // "Clear, go" after a hold: says clear too, so an untimed car withholds it.
  if (verdict !== "hold" && episode.goPending && untimed.length === 0) {
    emit({ event: "traffic.rejoin", data: { verdict: "go" } });
    logger.debug(`Rejoin: emit go (${describeNearest(nearest)}; table says ${verdict})`);
    episode.goPending = false;
    episode.lastVerdict = verdict;
    episode.lastSeconds = nearestSeconds;

    return;
  }

  if (verdict === "clear" && untimed.length > 0) {
    if (!episode.untimedLogged) {
      episode.untimedLogged = true;
      logger.debug(
        `Rejoin: clear withheld by untimed cars: ${describeUntimed(untimed)} (${describeNearest(nearest)}, notice ${notice} s)`,
      );
    }

    return;
  }

  const changed = verdict !== episode.lastVerdict;
  const moved =
    !changed &&
    verdict !== "clear" &&
    nearestSeconds !== null &&
    episode.lastSeconds !== null &&
    Math.abs(nearestSeconds - episode.lastSeconds) >= TRAFFIC_REJOIN_REANNOUNCE_DELTA_S;

  if (verdict === "hold") episode.goPending = true;

  if (!changed && !moved) return;

  let seconds: number;

  if (verdict === "clear") {
    seconds = Math.floor(notice);
    emit({ event: "traffic.rejoin", data: { verdict, windowSeconds: seconds } });
  } else {
    // Not clear, so a timed car set the verdict.
    const floor = verdict === "notice" ? TRAFFIC_REJOIN_MIN_NOTICE_SECONDS : TRAFFIC_REJOIN_MIN_HOLD_SECONDS;

    seconds = Math.max(floor, Math.floor(nearestSeconds as number));
    emit({ event: "traffic.rejoin", data: { verdict, seconds } });
  }

  logger.debug(
    `Rejoin: emit ${verdict} ${seconds} s (${describeNearest(nearest)}; ${changed ? "verdict changed" : "arrival moved"})`,
  );
  episode.lastVerdict = verdict;
  episode.lastSeconds = nearestSeconds;

  if (verdict !== "hold") episode.goPending = false;
}
