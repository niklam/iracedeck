/**
 * Rejoining from a stop (issue #1113, spec decisions 2 and 3 as amended on
 * 2026-11-11): while the player is stopped or crawling on the circuit, which
 * fixed band the nearest coming car is in. Publishes `traffic.rejoin`. The
 * engineer alerts, never instructs: no line tells a stopped driver to hold or
 * to go.
 *
 * **The episode.** It starts once every entry gate has held, with the car
 * below {@link TRAFFIC_CRAWL_MPS}, for {@link TRAFFIC_REJOIN_ENTRY_DWELL_MS}.
 * Every gate is a positive read, so a field the sim did not send keeps the
 * engineer quiet rather than guessing: live in the car (`IsOnTrack` true),
 * `PlayerTrackSurface` the racing surface or beside it (`OnTrack` /
 * `OffTrack`), `OnPitRoad` not true, `IsInGarage` not true, a readable
 * `SessionState` past the green (`isPreGreen` false, which keeps the grid
 * out), a readable speed and a player position on the lap. No incident
 * precondition: a stall, a stop to avoid a crash and an unscored spin need
 * the same answer. It ends silently once the car has been above
 * {@link TRAFFIC_REJOIN_MOVING_MPS} for {@link TRAFFIC_REJOIN_END_DWELL_MS}
 * in a row, every gate holding: a tick a gate fails restarts that run, as a
 * tick at or below the speed does. The gap between the two speeds is the
 * hysteresis, so a car creeping through
 * a gravel trap does not flicker in and out of an episode. It ends silently
 * at once when the player leaves the car or is in the garage, and on any
 * other gate failing only once that failure has held for
 * {@link TRAFFIC_REJOIN_GATE_GRACE_MS}: a tick or two the sim did not send or
 * misread (a `Speed` dropout, a surface flicker at the edge of the run-off) is
 * not the end of the stop, and ending on it would start a new episode after the
 * entry dwell and repeat the entry line about the same cars. While a gate
 * fails, nothing is evaluated or said.
 *
 * **The band.** On entry and then every {@link TRAFFIC_REJOIN_EVAL_INTERVAL_MS},
 * every car on the racing surface is timed to the player's lap position P
 * through `computeTrafficArrivals`: its class's learned curve at P first, then
 * the player's own `CarIdxEstTime` scaled to its class. A car standing still
 * behind the player — the other car of a multi-car incident, a stalled car —
 * is not coming, and `computeTrafficArrivals` leaves it out (its module
 * header): timed at reference pace it would read as arriving now for as long
 * as it stood there, pin the band at `rightBehind` and hide every car really
 * coming. The nearest timed arrival `s` names the band: `rightBehind` under
 * {@link TRAFFIC_REJOIN_RIGHT_BEHIND_S}, `near` under
 * {@link TRAFFIC_REJOIN_OVER_TEN_S} with N the whole seconds rounded down (2
 * to 9, the cautious direction: a car at 4.9 s is "about four seconds"),
 * `overTen` under {@link TRAFFIC_REJOIN_CLEAR_S}, and `clear` from there on or
 * with no timed car. The edges are fixed, not settings, because the lines name
 * them, and they are `@iracedeck/event-bus`'s, beside the payload: the Race
 * Engineer's lines read the same constants, so the two sides cannot drift.
 *
 * **When it speaks**, never on every evaluation:
 * - **Entry:** the episode's first band, always, so silence never means clear.
 * - **A closer band:** whenever the nearest car moves into one.
 * - **Near counting down:** the first call into `near` is `first: true` ("Car
 *   coming, about N seconds"); while still `near`, a `first: false` call ("Now
 *   N seconds") each time N has dropped by {@link TRAFFIC_REJOIN_COUNT_STEP_S}
 *   or more since the last spoken N. A different, closer car becoming the
 *   nearest is counted by the same rule.
 * - **After a close car:** once the car the last close call (`near` or
 *   `rightBehind`) was about has gone by, the next car's band is said once:
 *   `overTen` or `clear` in the usual case, and the next car's own close call
 *   (a `near` with `first: true`) when it is close too. The car has gone by
 *   when no source times it any more, it has stopped (left out as standing
 *   still), or it has wrapped round the lap past the player: an approaching
 *   car's arrival only falls, so one that rose by more than
 *   {@link TRAFFIC_REJOIN_PASSED_RISE_S} since the last evaluation that timed
 *   it, or reached the clear band, went by. A car seen going by stays gone
 *   until the next line is spoken, however near it reads on its way round
 *   again. A close car that stops is therefore followed by the next car's
 *   band, and is a new car coming, with a closer band of its own, once it
 *   moves again.
 * - **Otherwise** a band moving away is not re-announced: a car whose arrival
 *   drifts from 9.8 s to 10.2 s is still the same car coming.
 *
 * **A lap shorter than the clear band** (a short oval, a dirt track: about
 * 15 s or less). Every timed car is then under 15 s away, so `clear` is said
 * only with no timed car on track, and a car that has gone by re-times as the
 * lap less a second or so, under the clear band: it is known to have gone by
 * from its arrival rising, never from reaching 15 s. Nothing else here
 * assumes a lap of any length; the rise is caught on any lap longer than about
 * twice {@link TRAFFIC_REJOIN_PASSED_RISE_S}.
 *
 * **Untimed cars.** A car no source can time withholds the two reassuring
 * lines, `overTen` and `clear`, and nothing else: timed cars still get their
 * `near` and `rightBehind`. A withheld line is not marked as spoken, so it is
 * said at the first evaluation that can say it. It is logged once per episode
 * at debug with each untimed car's reason, which is all an untimed car alone
 * ever produces (spec decision 5: never invent a number).
 *
 * **No per-car arrays.** Telemetry without an array the arrival model reads
 * (`computeTrafficArrivals` answers `null`) is no picture at all, never an
 * empty track: that evaluation says nothing, marks nothing spoken and leaves
 * the close car as it was, so the first evaluation with the arrays says what
 * it would have. Logged once per episode at debug.
 */
import {
  type SimEventName,
  TRAFFIC_REJOIN_CLEAR_S,
  TRAFFIC_REJOIN_OVER_TEN_S,
  TRAFFIC_REJOIN_RIGHT_BEHIND_S,
  type TrafficRejoin,
  type TrafficRejoinVerdict,
} from "@iracedeck/event-bus";
import { isPreGreen, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import { createTrafficRejoinState, type TrafficArrivalState, type TrafficRejoinState } from "../state.js";
import { isRacingSurface } from "./track-surface.js";
import {
  computeTrafficArrivals,
  curveReferenceSource,
  elapsed,
  isFiniteNumber,
  normalizeLapPosition,
  resolveCarClassId,
  scaledReferenceSource,
  type TimedArrival,
  TRAFFIC_CRAWL_MPS,
  type TrafficArrival,
  type TrafficClassInfo,
  type TrafficTelemetry,
  type UntimedArrival,
} from "./traffic-arrival.js";
import type { EmitFn } from "./types.js";

/** The events {@link diffTrafficRejoin} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const TRAFFIC_REJOIN_EVENTS = ["traffic.rejoin"] as const satisfies readonly SimEventName[];

/**
 * How long the car must stay under the crawl speed, every gate holding, before
 * the episode starts (ms): a spin that ends with the car already pulling away,
 * or the instant of zero speed in a three-point turn, is not a rejoin.
 */
export const TRAFFIC_REJOIN_ENTRY_DWELL_MS = 1_500;

/**
 * Above this speed (m/s, about 29 km/h) the car counts as moving again. Well
 * above the crawl speed ({@link TRAFFIC_CRAWL_MPS}), so the band between them is the hysteresis: a car
 * creeping through gravel at walking pace stays in its episode.
 */
export const TRAFFIC_REJOIN_MOVING_MPS = 8;

/** How long the car must stay above the moving speed before the episode ends (ms): rejoined, not a lurch. */
export const TRAFFIC_REJOIN_END_DWELL_MS = 2_000;

/**
 * How long an entry gate other than leaving the car or the garage must keep
 * failing before a running episode ends (ms). Many times a blip at 60 Hz (a
 * tick or two of a field the sim did not send or misread), so a blip keeps the
 * episode and its record of what was said; short enough that a real change,
 * such as rolling onto pit road, ends it within a second, with nothing spoken
 * in between.
 */
export const TRAFFIC_REJOIN_GATE_GRACE_MS = 1_000;

/**
 * How often an episode re-times the cars (ms): once a second, the resolution
 * the spoken whole seconds have. Each evaluation may or may not speak.
 */
export const TRAFFIC_REJOIN_EVAL_INTERVAL_MS = 1_000;

/**
 * How far the spoken whole seconds of a `near` car must drop (s) before "Now
 * N" is said: the maintainer's "each time N has dropped by 3 or more", so a
 * car closing from 9 is counted at 6 and 3, never second by second.
 */
export const TRAFFIC_REJOIN_COUNT_STEP_S = 3;

/**
 * How far the close car's arrival must rise (s) from one evaluation that
 * timed it to the next for the car to count as gone by (module header). A car
 * coming at any pace has an arrival that falls; what can lift it without the
 * car going by is noise in its `CarIdxEstTime`, whose offset is a car's own
 * and steady (±0.2 s typically, about 1 s at worst; `traffic-arrival.ts`), so
 * it moves far less than that between two evaluations a second apart, and
 * the wrap at the start/finish line on a class lap from `CarClassEstLapTime`,
 * which is up to 0.9 s short of where the time restarts (Spa). 2 s clears
 * both together. Wrapping past the player lifts it by the lap less the car's
 * progress either side of the player, about two seconds, so any lap longer
 * than 4 s shows it, the shortest dirt oval included.
 */
export const TRAFFIC_REJOIN_PASSED_RISE_S = 2;

/** The telemetry the rejoin detector reads: the gates, the speed and the arrival model's arrays. */
export type TrafficRejoinTelemetry = TrafficTelemetry &
  Pick<TelemetryData, "IsOnTrack" | "IsInGarage" | "OnPitRoad" | "PlayerTrackSurface" | "SessionState" | "Speed">;

/** Which entry gate refused a tick, named in the episode-end debug line. */
type RejoinGate = "notInCar" | "inGarage" | "surface" | "pitRoad" | "preGreen" | "noSpeed" | "noPosition";

type Band = TrafficRejoinVerdict;

/** Each band's closeness: a lower rank is a closer car. */
const BAND_RANK: Record<Band, number> = { rightBehind: 0, near: 1, overTen: 2, clear: 3 };

/** Why an evaluation speaks, named in its debug line. */
type SpeakReason = "entry" | "closer band" | "count" | "after a close car";

/**
 * Whether a failed gate ends a running episode at once rather than after
 * {@link TRAFFIC_REJOIN_GATE_GRACE_MS} (module header): leaving the car and the
 * garage are what the player did, not a reading that blipped.
 */
function endsAtOnce(gate: RejoinGate): boolean {
  return gate === "notInCar" || gate === "inGarage";
}

/** The first entry gate the tick fails, or `null` when every one holds (module header). */
function failedGate(telemetry: TrafficRejoinTelemetry, playerCarIdx: number): RejoinGate | null {
  if (telemetry.IsOnTrack !== true) return "notInCar";

  if (telemetry.IsInGarage === true) return "inGarage";

  if (!isRacingSurface(telemetry.PlayerTrackSurface)) return "surface";

  if (telemetry.OnPitRoad === true) return "pitRoad";

  if (typeof telemetry.SessionState !== "number" || isPreGreen(telemetry)) return "preGreen";

  if (!isFiniteNumber(telemetry.Speed)) return "noSpeed";

  if (playerLapPosition(telemetry, playerCarIdx) === null) return "noPosition";

  return null;
}

/**
 * The player's lap position in [0, 1), `null` when unknown: on the
 * start/finish line, read as 1 or a hair past it, it is that hair past 0
 * (`normalizeLapPosition`), so a car stopped on the line is on the lap.
 */
function playerLapPosition(telemetry: TrafficRejoinTelemetry, playerCarIdx: number): number | null {
  return normalizeLapPosition(playerCarIdx >= 0 ? telemetry.CarIdxLapDistPct?.[playerCarIdx] : undefined);
}

/** "car 5 at 4.62 s via curve", or what stands in for it when no car was timed. */
function describeNearest(nearest: TimedArrival | null): string {
  return nearest === null
    ? "no timed car"
    : `nearest car ${nearest.carIdx} at ${nearest.seconds.toFixed(2)} s via ${nearest.source}`;
}

/** "; standing still: car 4, car 6", or nothing when no car was left out as standing still. */
function describeStationary(stationary: readonly number[]): string {
  return stationary.length === 0 ? "" : `; standing still: ${stationary.map((carIdx) => `car ${carIdx}`).join(", ")}`;
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
 * @param trackLengthMeters `WeekendInfo.TrackLength` in metres (`resolveTrackLengthMeters`), `null` while unknown: what turns a car's measured progress into a speed, without which no car is left out as standing still.
 */
export function diffTrafficRejoin(
  episode: TrafficRejoinState,
  curves: Readonly<TrafficArrivalState>,
  telemetry: TrafficRejoinTelemetry,
  playerCarIdx: number,
  classes: TrafficClassInfo | null,
  trackLengthMeters: number | null,
  now: number,
  emit: EmitFn<(typeof TRAFFIC_REJOIN_EVENTS)[number]>,
  logger: ILogger,
): void {
  const gate = failedGate(telemetry, playerCarIdx);

  if (gate !== null) {
    if (episode.active && !endsAtOnce(gate)) {
      if (episode.gateFailedSince === null || episode.gateFailedSince > now) {
        if (episode.gateFailedSince === null) logger.debug(`Rejoin: gate failed (${gate}), episode held`);

        episode.gateFailedSince = now;
      }

      // The moving dwell is a continuous run of gated ticks: one a gate broke
      // starts again from the next tick that moves, so a blip in the middle
      // never lets a shorter renewed run end the episode.
      episode.movingSince = null;

      if (elapsed(now, episode.gateFailedSince) < TRAFFIC_REJOIN_GATE_GRACE_MS) return;
    }

    // Outside an episode any failure restarts the entry dwell; inside one, the
    // failure ends it at once (the car left, the garage) or has outlasted the grace.
    if (episode.active) logger.debug(`Rejoin: episode ended (${gate})`);

    Object.assign(episode, createTrafficRejoinState());

    return;
  }

  if (episode.gateFailedSince !== null) {
    logger.debug(`Rejoin: gates hold again after ${elapsed(now, episode.gateFailedSince)} ms, episode kept`);
    episode.gateFailedSince = null;
  }

  // The gate checked both.
  const speed = telemetry.Speed as number;
  const pct = playerLapPosition(telemetry, playerCarIdx) as number;

  if (!episode.active) {
    if (speed >= TRAFFIC_CRAWL_MPS) {
      episode.slowSince = null;

      return;
    }

    if (episode.slowSince === null || episode.slowSince > now) episode.slowSince = now;

    if (elapsed(now, episode.slowSince) < TRAFFIC_REJOIN_ENTRY_DWELL_MS) return;

    Object.assign(episode, createTrafficRejoinState(), { active: true });
    logger.debug(`Rejoin: episode started (pct=${pct.toFixed(4)}, speed=${speed.toFixed(1)} m/s)`);
    evaluate(episode, curves, telemetry, pct, playerCarIdx, classes, trackLengthMeters, now, emit, logger);

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

  // A wall clock that stepped back evaluates now: waiting the interval out
  // from a time still ahead would stop every evaluation for as long as the step.
  if (episode.lastEvalAt !== null && episode.lastEvalAt > now) episode.lastEvalAt = null;

  if (episode.lastEvalAt !== null && elapsed(now, episode.lastEvalAt) < TRAFFIC_REJOIN_EVAL_INTERVAL_MS) return;

  evaluate(episode, curves, telemetry, pct, playerCarIdx, classes, trackLengthMeters, now, emit, logger);
}

/** The band of the nearest timed arrival (module header); `clear` with no timed car. */
function bandOf(seconds: number | null): Band {
  if (seconds === null || seconds >= TRAFFIC_REJOIN_CLEAR_S) return "clear";

  if (seconds < TRAFFIC_REJOIN_RIGHT_BEHIND_S) return "rightBehind";

  return seconds < TRAFFIC_REJOIN_OVER_TEN_S ? "near" : "overTen";
}

/**
 * Whether the car the last close call was about has gone by (module header);
 * `false` with no such call. Follows that car's arrival in
 * `episode.closeCarSeconds` while it is still coming, and leaves it once the
 * car has gone by, so the car stays gone on its way round again. A car
 * untimed or no longer a candidate (left the track, standing still) is gone
 * while it stays so, and is compared with its last timed arrival when it is
 * timed again.
 */
function closeCarGone(episode: TrafficRejoinState, arrivals: readonly TrafficArrival[]): boolean {
  if (episode.closeCarIdx === null) return false;

  const car = arrivals.find((arrival) => arrival.carIdx === episode.closeCarIdx);

  if (car === undefined || !car.timed) return true;

  const last = episode.closeCarSeconds;

  if ((last !== null && car.seconds - last > TRAFFIC_REJOIN_PASSED_RISE_S) || car.seconds >= TRAFFIC_REJOIN_CLEAR_S) {
    return true;
  }

  episode.closeCarSeconds = car.seconds;

  return false;
}

/** Why this evaluation speaks, by the rules in the module header; `null` when it stays quiet. */
function speakReason(
  episode: TrafficRejoinState,
  band: Band,
  wholeSeconds: number | null,
  closeGone: boolean,
): SpeakReason | null {
  if (episode.spokenBand === null) return "entry";

  if (closeGone) return "after a close car";

  if (BAND_RANK[band] < BAND_RANK[episode.spokenBand]) return "closer band";

  if (
    band === "near" &&
    episode.spokenBand === "near" &&
    wholeSeconds !== null &&
    episode.spokenSeconds !== null &&
    episode.spokenSeconds - wholeSeconds >= TRAFFIC_REJOIN_COUNT_STEP_S
  ) {
    return "count";
  }

  return null;
}

/** "near 6 s (first)", "rightBehind": the payload as its debug line names it. */
function describePayload(payload: TrafficRejoin): string {
  return payload.verdict === "near"
    ? `near ${payload.seconds} s (${payload.first ? "first" : "count"})`
    : payload.verdict;
}

/** One evaluation: time the cars to P, take the band, and speak by the rules (module header). */
function evaluate(
  episode: TrafficRejoinState,
  curves: Readonly<TrafficArrivalState>,
  telemetry: TrafficRejoinTelemetry,
  pct: number,
  playerCarIdx: number,
  classes: TrafficClassInfo | null,
  trackLengthMeters: number | null,
  now: number,
  emit: EmitFn<(typeof TRAFFIC_REJOIN_EVENTS)[number]>,
  logger: ILogger,
): void {
  episode.lastEvalAt = now;

  const playerClass = resolveCarClassId(telemetry, classes, playerCarIdx);
  const playerEstTime = telemetry.CarIdxEstTime?.[playerCarIdx];
  const sources = [
    curveReferenceSource(curves, pct),
    scaledReferenceSource(isFiniteNumber(playerEstTime) ? playerEstTime : null, playerClass, classes),
  ];
  const stationary: number[] = [];
  const arrivals = computeTrafficArrivals(
    curves,
    pct,
    sources,
    telemetry,
    playerCarIdx,
    classes,
    trackLengthMeters,
    stationary,
  );

  // No per-car arrays is no picture at all, never an empty track: nothing is
  // said or marked spoken, and the close car is not followed, so the first
  // evaluation with the arrays judges afresh (module header).
  if (arrivals === null) {
    if (!episode.arraysMissingLogged) {
      episode.arraysMissingLogged = true;
      logger.debug("Rejoin: silent, the per-car arrays are missing");
    }

    return;
  }

  const untimed = arrivals.filter((a): a is UntimedArrival => !a.timed);
  let nearest: TimedArrival | null = null;

  for (const arrival of arrivals) {
    if (arrival.timed && (nearest === null || arrival.seconds < nearest.seconds)) nearest = arrival;
  }

  const band = bandOf(nearest?.seconds ?? null);
  // Only `near` has a nearest car in [2, 10), so its whole seconds are 2 to 9.
  const wholeSeconds = band === "near" && nearest !== null ? Math.floor(nearest.seconds) : null;
  // Every evaluation, spoken or not, so the close car's arrival is followed from one to the next.
  const closeGone = closeCarGone(episode, arrivals);
  const reason = speakReason(episode, band, wholeSeconds, closeGone);

  if (reason === null) return;

  if ((band === "overTen" || band === "clear") && untimed.length > 0) {
    if (!episode.untimedLogged) {
      episode.untimedLogged = true;
      logger.debug(
        `Rejoin: ${band} withheld by untimed cars: ${describeUntimed(untimed)} (${describeNearest(nearest)}; ${reason}${describeStationary(stationary)})`,
      );
    }

    return;
  }

  // `wholeSeconds` is set exactly when the band is `near`.
  const payload: TrafficRejoin =
    band === "near" ? { verdict: band, seconds: wholeSeconds as number, first: reason !== "count" } : { verdict: band };

  emit({ event: "traffic.rejoin", data: payload });
  logger.debug(
    `Rejoin: emit ${describePayload(payload)} (${describeNearest(nearest)}; ${reason}${describeStationary(stationary)})`,
  );
  episode.spokenBand = band;
  episode.spokenSeconds = wholeSeconds;
  const close = (band === "near" || band === "rightBehind") && nearest !== null ? nearest : null;

  episode.closeCarIdx = close?.carIdx ?? null;
  episode.closeCarSeconds = close?.seconds ?? null;
}
