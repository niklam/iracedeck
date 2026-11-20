/**
 * Rejoining from a stop (issue #1113, spec decisions 2 and 3 as amended on
 * 2026-11-11 and 2026-11-20): while the player is stopped or crawling on the
 * circuit, whether a car is coming within ten seconds, and how close.
 * Publishes `traffic.rejoin`, and `traffic.rejoinTowed` when the car is taken
 * off the track mid-stop. The engineer alerts, never instructs: no line tells
 * a stopped driver to hold or to go, and none reassures him (amended
 * 2026-11-20): he speaks only to warn, so on rejoin silence means no car is
 * under ten seconds away.
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
 * on any gate failing other than the car being taken off the track (below)
 * only once that failure has held for {@link TRAFFIC_REJOIN_GATE_GRACE_MS}: a
 * tick or two the sim did not send or misread (a `Speed` dropout, a surface
 * flicker at the edge of the run-off or the pit entry) is not the end of the
 * stop, and ending on it would start a new episode after the entry dwell and
 * repeat the first call about the same cars. A failure that outlasted the
 * grace ends the episode whether the next tick fails or not: the first tick
 * with every gate holding again after the grace, with no tick in between (the
 * sim sent none), ends it as a failing tick at the grace limit would have, and
 * starts a fresh entry dwell. While a gate fails, nothing is evaluated or
 * said.
 *
 * **A tow or a reset ends it at once and cuts the line** (amended
 * 2026-11-20). The car taken off the track without being driven off — out of
 * the world (`PlayerTrackSurface` `NotInWorld`, the tick a tow or a reset
 * passes on its way to the stall), in its pit stall (`InPitStall`), the
 * player out of the car (`IsOnTrack` not true) or in the garage — ends the
 * episode on that tick, with no grace, and publishes `traffic.rejoinTowed`,
 * which the Race Engineer's rejoin lines end on (`endsOn`): a line playing
 * stops, and one waiting is dropped. These are definite readings, never a
 * blip: `traffic-pit-exit.ts` ends its own episode on the same ones. Every
 * other end — driving off, a gate failing past its grace — is silent and
 * leaves a line in flight to finish. Nothing else is published on that tick
 * (the path returns before any evaluation), so the trigger never follows its
 * end within one tick, which `race-engineer-wiring`'s `ends-on-order.test.ts`
 * relies on.
 *
 * **The band.** On entry and then every {@link TRAFFIC_REJOIN_EVAL_INTERVAL_MS},
 * every car on the racing surface is timed to the player's lap position P
 * through `computeTrafficArrivals`: its class's learned curve at P first, then
 * the player's own `CarIdxEstTime` scaled to its class. A car standing still
 * behind the player — the other car of a multi-car incident, a stalled car —
 * is not coming, and `computeTrafficArrivals` leaves it out (its module
 * header): timed at reference pace it would read as arriving now for as long
 * as it stood there, pin the band at `rightBehind` and hide every car really
 * coming. A car no source can time is left out too, never given a number
 * (spec decision 5). The nearest timed arrival `s` names the band:
 * `rightBehind` under {@link TRAFFIC_REJOIN_RIGHT_BEHIND_S}, `near` under
 * {@link TRAFFIC_REJOIN_OVER_TEN_S} with N the whole seconds rounded down (2
 * to 9, the cautious direction: a car at 4.9 s is "about four seconds"), and
 * no band from there on or with no timed car. The edges are fixed, not
 * settings, because the lines name them, and they are
 * `@iracedeck/event-bus`'s, beside the payload: the Race Engineer's lines read
 * the same constants, so the two sides cannot drift.
 *
 * **When it speaks**, never on every evaluation, and never with no band:
 * - **A first call:** the first band since the episode started, or since the
 *   car or the group the last call was about went by.
 * - **A closer band:** whenever the nearest car moves into one.
 * - **Near counting down:** the first call into `near` is `first: true` ("Car
 *   coming, about N seconds"); while still `near`, a `first: false` call ("Now
 *   N seconds") each time N has dropped by {@link TRAFFIC_REJOIN_COUNT_STEP_S}
 *   or more since the last spoken N, while the nearest car is still the one
 *   the last call was about. A different, closer car becoming the nearest is
 *   said by the same drop-by-3 rule, but as a first call (`first: true`): the
 *   driver has not heard of it, so a count would describe a car he never
 *   heard of as "getting closer". Its later counts are updates about it.
 * - **After a close car:** once the car the last close call (`near` or
 *   `rightBehind`) was about has gone by, the call is forgotten, and the next
 *   car is said only when it has a band, as a new first call (a `near` with
 *   `first: true`, `rightBehind` or `pack`): at once when it already has one,
 *   otherwise whenever it comes under ten seconds. The car has gone by when no
 *   source times it any more, it has stopped (left out as standing still), or
 *   it has wrapped round the lap past the player: an approaching car's arrival
 *   only falls, so one that rose by more than
 *   {@link TRAFFIC_REJOIN_PASSED_RISE_S} since the last evaluation that timed
 *   it, or reached {@link TRAFFIC_REJOIN_GONE_S} once it had been under
 *   {@link TRAFFIC_REJOIN_OVER_TEN_S}, went by. Arrivals are compared within
 *   one reference tier only: a car re-timed by another tier (the scaled
 *   reference giving way to its class's own curve, which can move it seconds
 *   at once) is a new baseline, never a pass, and on that evaluation it has
 *   gone by only when its position wrapped past the player
 *   ({@link TRAFFIC_REJOIN_PASSED_WRAP_PCT}). A close car that stops is
 *   therefore gone, and a new car coming, with a first call of its own, once
 *   it moves again under ten seconds away.
 * - **Otherwise** a band moving away is not re-announced: a car whose arrival
 *   drifts from 9.8 s to 10.2 s is still the same car coming, and is not
 *   introduced again when it drifts back.
 *
 * **A pack is one call** (amended 2026-11-18, after a pack of nine cars going
 * by a stopped player at Tsukuba drew "Car right behind you" nine times, once
 * a second, each car re-arming the line after a close car for the next).
 * Whenever the nearest timed car is under {@link TRAFFIC_REJOIN_OVER_TEN_S}
 * and at least one more timed car arrives within
 * {@link TRAFFIC_REJOIN_PACK_GAP_S} behind it, the call is `pack` in place of
 * the nearest car's band. The pack is a chain over the timed arrivals in
 * order: a car belongs to it while it arrives within the gap of the car before
 * it, so a car 1.5 s behind the last of it joins and one 2.5 s behind does
 * not. Untimed cars never make a pack (the chain is timed cars only).
 * - **When:** wherever a band would be said: as a first call, the one after a
 *   close car included, and as a closer band. The pack ranks closer than
 *   `rightBehind`, so a pack forming behind a car already announced as `near`
 *   or `rightBehind` is said once too, rather than left unsaid because its
 *   nearest car was.
 * - **While it goes by, nothing:** no count, no `rightBehind` for each car, no
 *   first call between them, and no line about a car outside it.
 * - **Its cars** are followed one by one with the close car's rule (an arrival
 *   rising past {@link TRAFFIC_REJOIN_PASSED_RISE_S}, or reaching
 *   {@link TRAFFIC_REJOIN_GONE_S} once it has been under
 *   {@link TRAFFIC_REJOIN_OVER_TEN_S}, has gone by and stays gone; a change of
 *   tier is a new baseline; one untimed or no longer a candidate is gone while
 *   it stays so). The last cars of a long pack may be beyond
 *   {@link TRAFFIC_REJOIN_GONE_S} when it is said, and are still coming, and
 *   one that joined at that edge is not retired by noise across it. A car that
 *   comes within the gap behind the last of its cars still coming joins it, so
 *   a pack still streaming by is not over; a car of it already gone by never
 *   joins again, so on a lap shorter than the pack takes to go by, its first
 *   cars coming round again neither hold it open nor start it again.
 * - **After it:** once every car of it has gone by, the call is forgotten, as
 *   for a lone car: the next car under ten seconds is a new first call, or a
 *   new `pack` for the next group. A pack that comes round again on a short
 *   lap is that next group, as a lone car coming round again is a new car
 *   coming.
 *
 * **A short lap** (a short oval, a dirt track: about 15 s or less). A car
 * that has gone by re-times as the lap less a second or so, which can be under
 * {@link TRAFFIC_REJOIN_GONE_S}: it is known to have gone by from its arrival
 * rising, never from reaching that edge. Nothing else here assumes a lap of
 * any length; the rise is caught on any lap longer than about twice
 * {@link TRAFFIC_REJOIN_PASSED_RISE_S}.
 *
 * **No per-car arrays.** Telemetry without an array the arrival model reads
 * (`computeTrafficArrivals` answers `null`) is no picture at all, never an
 * empty track: that evaluation says nothing, marks nothing spoken and leaves
 * the close car as it was, so the first evaluation with the arrays says what
 * it would have. Logged once per episode at debug.
 */
import {
  type SimEventName,
  TRAFFIC_REJOIN_OVER_TEN_S,
  TRAFFIC_REJOIN_RIGHT_BEHIND_S,
  type TrafficRejoin,
  type TrafficRejoinVerdict,
} from "@iracedeck/event-bus";
import { isPreGreen, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { normalizePitLanePct } from "@iracedeck/track-data";

import {
  createTrafficRejoinState,
  type TrafficArrivalState,
  type TrafficRejoinFollowedCar,
  type TrafficRejoinState,
} from "../state.js";
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
} from "./traffic-arrival.js";
import type { EmitFn } from "./types.js";

/**
 * How close behind the car before it (s of predicted arrival) a car must
 * arrive to be one of a pack with it (module header; spec amendment
 * 2026-11-18): the maintainer's 2 s. Two cars 1.5 s apart are a pack, two
 * 2.5 s apart a car and then the next.
 */
export const TRAFFIC_REJOIN_PACK_GAP_S = 2;

/**
 * The events {@link diffTrafficRejoin} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`.
 * `traffic.rejoinTowed` is the end the rejoin lines' `endsOn` names, never published on a tick that publishes
 * `traffic.rejoin` (module header).
 */
export const TRAFFIC_REJOIN_EVENTS = [
  "traffic.rejoin",
  "traffic.rejoinTowed",
] as const satisfies readonly SimEventName[];

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
 * How long an entry gate other than the car being taken off the track (a tow,
 * a reset, leaving the car, the garage) must keep failing before a running
 * episode ends (ms). Many times a blip at 60 Hz (a
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

/**
 * How far a followed car's forward lap distance to the player must rise (lap
 * fraction) from one evaluation to the next for the car to count as gone by
 * when its arrival cannot be compared, because a different reference tier
 * timed it (module header): half a lap. A car coming from behind closes on
 * the player, so that distance only falls; going by turns it from a sliver
 * into a hair under a lap, a rise of the lap less the ground the car covers in
 * a second, more than half a lap on any lap longer than two seconds. Noise in
 * a lap position is metres.
 */
export const TRAFFIC_REJOIN_PASSED_WRAP_PCT = 0.5;

/**
 * How far a followed car's arrival must read (s), once it has been under
 * {@link TRAFFIC_REJOIN_OVER_TEN_S}, for it to count as gone by without a
 * rise past {@link TRAFFIC_REJOIN_PASSED_RISE_S} (module header): a car that
 * crept away a little at a time, or one re-timed a lap away. The old clear
 * band's edge (spec, 2026-11-11), kept as the detector's own once the clear
 * line went (amended 2026-11-20): a car of a pack that joined at the 10 s
 * edge is not retired by noise across it, and one 15 s away is no longer the
 * car the last call was about.
 */
export const TRAFFIC_REJOIN_GONE_S = 15;

/** The telemetry the rejoin detector reads: the gates, the speed and the arrival model's arrays. */
export type TrafficRejoinTelemetry = TrafficTelemetry &
  Pick<TelemetryData, "IsOnTrack" | "IsInGarage" | "OnPitRoad" | "PlayerTrackSurface" | "SessionState" | "Speed">;

/** Which entry gate refused a tick, named in the episode-end debug line. */
type RejoinGate =
  "notInCar" | "inGarage" | "notInWorld" | "inPitStall" | "surface" | "pitRoad" | "preGreen" | "noSpeed" | "noPosition";

/** The verdicts the detector speaks; an evaluation with no car under ten seconds has no band and says nothing. */
type Band = TrafficRejoinVerdict;

/**
 * Each band's closeness: a lower rank is a closer car. A pack ranks closest of
 * all, so it is said as a closer band over a lone car already announced, and
 * nothing outranks it while it goes by (module header).
 */
const BAND_RANK: Record<Band, number> = { pack: 0, rightBehind: 1, near: 2 };

/** Why an evaluation speaks, named in its debug line. */
type SpeakReason = "entry" | "first call" | "closer band" | "count" | "a nearer car" | "after a close car";

/**
 * Whether a failed gate is the car taken off the track (module header): a tow
 * or a reset (out of the world, or in the pit stall), leaving the car, or the
 * garage. It ends a running episode at once rather than after
 * {@link TRAFFIC_REJOIN_GATE_GRACE_MS} — each is a definite reading, not one
 * that blipped — and publishes `traffic.rejoinTowed`, which cuts a rejoin line
 * in flight.
 */
function takenOffTrack(gate: RejoinGate): boolean {
  return gate === "notInCar" || gate === "inGarage" || gate === "notInWorld" || gate === "inPitStall";
}

/** The first entry gate the tick fails, or `null` when every one holds (module header). */
function failedGate(telemetry: TrafficRejoinTelemetry, playerCarIdx: number): RejoinGate | null {
  if (telemetry.IsOnTrack !== true) return "notInCar";

  if (telemetry.IsInGarage === true) return "inGarage";

  if (telemetry.PlayerTrackSurface === TrkLoc.NotInWorld) return "notInWorld";

  if (telemetry.PlayerTrackSurface === TrkLoc.InPitStall) return "inPitStall";

  if (!isRacingSurface(telemetry.PlayerTrackSurface)) return "surface";

  if (telemetry.OnPitRoad === true) return "pitRoad";

  // A finite number only: `NaN` is a number and `isPreGreen` reads it as past the green.
  if (!isFiniteNumber(telemetry.SessionState) || isPreGreen(telemetry)) return "preGreen";

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

/**
 * The rejoin detector's per-tick step: runs the entry dwell, the episode and
 * its evaluations, and emits `traffic.rejoin` and `traffic.rejoinTowed` by
 * the rules in the module header. Owns `episode` (`state.trafficRejoin`) and writes nothing else.
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
    const towed = takenOffTrack(gate);

    if (episode.active && !towed) {
      if (episode.gateFailedSince === null || episode.gateFailedSince > now) {
        if (episode.gateFailedSince === null) logger.debug(`gate failed (${gate}), episode held`);

        episode.gateFailedSince = now;
      }

      // The moving dwell is a continuous run of gated ticks: one a gate broke
      // starts again from the next tick that moves, so a blip in the middle
      // never lets a shorter renewed run end the episode.
      episode.movingSince = null;

      if (elapsed(now, episode.gateFailedSince) < TRAFFIC_REJOIN_GATE_GRACE_MS) return;
    }

    // Outside an episode any failure restarts the entry dwell; inside one, the
    // failure ends it at once (the car taken off the track) or has outlasted
    // the grace. Only the first cuts a rejoin line in flight (module header);
    // nothing else is emitted on this tick.
    if (episode.active && towed) {
      emit({ event: "traffic.rejoinTowed", data: {} });
      logger.debug(`episode ended (${gate}), the car taken off the track: rejoin lines cut`);
    } else if (episode.active) {
      logger.debug(`episode ended (${gate})`);
    }

    // Written last (the package's step rule): an emit that threw is retried
    // on the next tick, which still fails the gate.
    Object.assign(episode, createTrafficRejoinState());

    return;
  }

  if (episode.gateFailedSince !== null) {
    const failedFor = elapsed(now, episode.gateFailedSince);

    if (failedFor < TRAFFIC_REJOIN_GATE_GRACE_MS) {
      logger.debug(`gates hold again after ${failedFor} ms, episode kept`);
      episode.gateFailedSince = null;
    } else {
      // The failure outlasted the grace with no tick in between to end it (the
      // sim sent nothing): it ends here, as a failing tick at the grace limit
      // would have, and this tick starts a fresh entry dwell below.
      logger.debug(`episode ended (gate failed for ${failedFor} ms)`);
      Object.assign(episode, createTrafficRejoinState());
    }
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
    logger.debug(`episode started (pct=${pct.toFixed(4)}, speed=${speed.toFixed(1)} m/s)`);
    evaluate(episode, curves, telemetry, pct, playerCarIdx, classes, trackLengthMeters, emit, logger);
    // Written last (the package's step rule): an evaluation that threw is
    // retried on the next tick rather than a second later.
    episode.lastEvalAt = now;

    return;
  }

  if (speed > TRAFFIC_REJOIN_MOVING_MPS) {
    if (episode.movingSince === null || episode.movingSince > now) episode.movingSince = now;

    if (elapsed(now, episode.movingSince) >= TRAFFIC_REJOIN_END_DWELL_MS) {
      logger.debug(`episode ended (moving at ${speed.toFixed(1)} m/s)`);
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

  evaluate(episode, curves, telemetry, pct, playerCarIdx, classes, trackLengthMeters, emit, logger);
  // Written last, as on entry: a throw is retried on the next tick.
  episode.lastEvalAt = now;
}

/**
 * The pack the timed arrivals make (module header): the nearest car and every
 * car chained behind it within {@link TRAFFIC_REJOIN_PACK_GAP_S} of the one
 * before, when the nearest is under {@link TRAFFIC_REJOIN_OVER_TEN_S} and at
 * least one more is chained; `null` otherwise.
 *
 * @param timed The timed arrivals in arrival order, nearest first.
 */
function packOf(timed: readonly TimedArrival[]): TimedArrival[] | null {
  const first = timed[0];

  if (first === undefined || first.seconds >= TRAFFIC_REJOIN_OVER_TEN_S) return null;

  const chain = [first];

  for (const car of timed.slice(1)) {
    if (car.seconds - chain[chain.length - 1].seconds > TRAFFIC_REJOIN_PACK_GAP_S) break;

    chain.push(car);
  }

  return chain.length > 1 ? chain : null;
}

/** The band of the nearest timed arrival (module header); `null`, nothing to say, at ten seconds or more or with no timed car. */
function bandOf(seconds: number | null): Band | null {
  if (seconds === null || seconds >= TRAFFIC_REJOIN_OVER_TEN_S) return null;

  return seconds < TRAFFIC_REJOIN_RIGHT_BEHIND_S ? "rightBehind" : "near";
}

/** Where the cars stand this evaluation: what a followed car is measured against. */
type FollowContext = {
  readonly arrivals: readonly TrafficArrival[];
  readonly telemetry: TrafficRejoinTelemetry;
  /** The player's lap position, in [0, 1). */
  readonly playerPct: number;
  readonly logger: ILogger;
};

/**
 * The forward lap distance from car `carIdx` to the player, in driving
 * direction, in [0, 1); `null` when the car's lap position is unreadable.
 * Small for a car just behind the player, a hair under a whole lap for one
 * just past it.
 */
function distanceToPlayer(ctx: FollowContext, carIdx: number): number | null {
  const position = normalizeLapPosition(ctx.telemetry.CarIdxLapDistPct?.[carIdx]);

  return position === null ? null : normalizePitLanePct(ctx.playerPct - position);
}

/** A car to follow from a timed arrival: its arrival, tier and position now, still coming. */
function followed(car: TimedArrival, ctx: FollowContext): TrafficRejoinFollowedCar {
  return {
    carIdx: car.carIdx,
    seconds: car.seconds,
    source: car.source,
    toPlayerPct: distanceToPlayer(ctx, car.carIdx),
    beenClose: car.seconds < TRAFFIC_REJOIN_OVER_TEN_S,
    passed: false,
  };
}

/**
 * One evaluation of a followed car (module header): `passed` when it has just
 * been seen going by (and `member.passed` is set), `away` when it is untimed
 * or no longer a candidate (left the track, standing still: gone while it
 * stays so, compared with its last timed arrival when it is timed again), and
 * `coming` otherwise, with its arrival, position and closeness moved on.
 *
 * Going by is read from the arrival, compared only within one reference tier:
 * a rise past {@link TRAFFIC_REJOIN_PASSED_RISE_S}, or reaching
 * {@link TRAFFIC_REJOIN_GONE_S} once it has been under {@link TRAFFIC_REJOIN_OVER_TEN_S}. An
 * arrival from another tier (the scaled reference giving way to the class's
 * own curve once a car of the class has driven past the player) is not
 * comparable, so it is a new baseline rather than a rise; on that evaluation
 * only the car's position can say it went by: its forward distance to the
 * player rising past {@link TRAFFIC_REJOIN_PASSED_WRAP_PCT}.
 */
function followCar(member: TrafficRejoinFollowedCar, ctx: FollowContext): "passed" | "away" | "coming" {
  const car = ctx.arrivals.find((arrival) => arrival.carIdx === member.carIdx);

  if (car === undefined || !car.timed) return "away";

  const toPlayer = distanceToPlayer(ctx, car.carIdx);

  if (car.source !== member.source) {
    const wrapped =
      toPlayer !== null &&
      member.toPlayerPct !== null &&
      toPlayer - member.toPlayerPct > TRAFFIC_REJOIN_PASSED_WRAP_PCT;

    if (wrapped) {
      member.passed = true;

      return "passed";
    }

    ctx.logger.debug(
      `car ${car.carIdx} re-timed at ${car.seconds.toFixed(2)} s via ${car.source} (was ${member.seconds.toFixed(2)} s via ${member.source}), a new baseline`,
    );
    Object.assign(member, followed(car, ctx));

    return "coming";
  }

  const rose = car.seconds - member.seconds > TRAFFIC_REJOIN_PASSED_RISE_S;
  const reachedGone =
    member.beenClose && member.seconds < TRAFFIC_REJOIN_GONE_S && car.seconds >= TRAFFIC_REJOIN_GONE_S;

  if (rose || reachedGone) {
    member.passed = true;

    return "passed";
  }

  member.seconds = car.seconds;
  member.toPlayerPct = toPlayer;
  member.beenClose ||= car.seconds < TRAFFIC_REJOIN_OVER_TEN_S;

  return "coming";
}

/**
 * Whether the car the last close call was about, or every car of the group
 * the last `pack` call was about, has gone by (module header); `false` with no
 * such call standing. Follows that car ({@link followCar}) while it is still
 * coming; one untimed or no longer a candidate is gone. The caller forgets the
 * call once this says so, so a car seen going by is never followed again: on
 * its way round it is a new car coming.
 */
function closeCarGone(episode: TrafficRejoinState, timed: readonly TimedArrival[], ctx: FollowContext): boolean {
  if (episode.packCars.length > 0) return packGone(episode, timed, ctx);

  if (episode.closeCar === null) return false;

  return followCar(episode.closeCar, ctx) !== "coming";
}

/**
 * Whether every car of the pack the last line was about has gone by (module
 * header), each followed by the close car's rule ({@link followCar}). While
 * one is still coming, a car arriving within {@link TRAFFIC_REJOIN_PACK_GAP_S}
 * behind the last of them still coming joins the pack, and the next behind it
 * in turn; a car of the pack gone by never joins again. The group is gone once
 * none of its cars is still coming.
 *
 * @param timed The timed arrivals in arrival order, nearest first.
 */
function packGone(episode: TrafficRejoinState, timed: readonly TimedArrival[], ctx: FollowContext): boolean {
  let tail: TrafficRejoinFollowedCar | null = null;

  for (const member of episode.packCars) {
    if (member.passed || followCar(member, ctx) !== "coming") continue;

    if (tail === null || member.seconds >= tail.seconds) tail = member;
  }

  if (tail === null) return true;

  const members = new Set(episode.packCars.map((member) => member.carIdx));

  for (const car of timed) {
    if (members.has(car.carIdx) || car.seconds < tail.seconds) continue;

    if (car.seconds - tail.seconds > TRAFFIC_REJOIN_PACK_GAP_S) break;

    tail = followed(car, ctx);
    episode.packCars.push(tail);
    members.add(car.carIdx);
    ctx.logger.debug(
      `pack grows to ${episode.packCars.length} cars (car ${car.carIdx} at ${car.seconds.toFixed(2)} s)`,
    );
  }

  return false;
}

/**
 * Why this evaluation speaks a band, by the rules in the module header; `null`
 * when it stays quiet. With no call standing (`spokenBand` `null`) any band is
 * a first call: on the episode's first evaluation, after a close car or a
 * group has gone by on this one, or whenever a car comes under ten seconds
 * later. A drop of {@link TRAFFIC_REJOIN_COUNT_STEP_S} in `near` is a
 * `count` only while the nearest car is still the one the last call was about
 * (`episode.closeCar`); about a different car it is `a nearer car`, a first
 * call, since the driver has not heard of it.
 *
 * @param nearestCarIdx The nearest timed car's index, `null` with no timed car.
 */
function speakReason(
  episode: TrafficRejoinState,
  band: Band,
  wholeSeconds: number | null,
  nearestCarIdx: number | null,
  closeGone: boolean,
): SpeakReason | null {
  if (episode.spokenBand === null) {
    if (closeGone) return "after a close car";

    return episode.lastEvalAt === null ? "entry" : "first call";
  }

  if (BAND_RANK[band] < BAND_RANK[episode.spokenBand]) return "closer band";

  if (
    band === "near" &&
    episode.spokenBand === "near" &&
    wholeSeconds !== null &&
    episode.spokenSeconds !== null &&
    episode.spokenSeconds - wholeSeconds >= TRAFFIC_REJOIN_COUNT_STEP_S
  ) {
    return episode.closeCar !== null && episode.closeCar.carIdx === nearestCarIdx ? "count" : "a nearer car";
  }

  return null;
}

/** "near 6 s (first)", "rightBehind": the payload as its debug line names it. */
function describePayload(payload: TrafficRejoin): string {
  return payload.verdict === "near"
    ? `near ${payload.seconds} s (${payload.first ? "first" : "count"})`
    : payload.verdict;
}

/** "9 cars, first at 1.20 s, last at 9.20 s": a pack as its debug line names it. */
function describePack(pack: readonly TimedArrival[]): string {
  const first = pack[0].seconds.toFixed(2);
  const last = pack[pack.length - 1].seconds.toFixed(2);

  return `${pack.length} cars, first at ${first} s, last at ${last} s`;
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
  emit: EmitFn<(typeof TRAFFIC_REJOIN_EVENTS)[number]>,
  logger: ILogger,
): void {
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
      logger.debug("silent, the per-car arrays are missing");
    }

    return;
  }

  // Nearest first; the sort is stable, so a tie keeps the arrivals' own order.
  const timed = arrivals.filter((a): a is TimedArrival => a.timed).sort((a, b) => a.seconds - b.seconds);
  const nearest = timed[0] ?? null;
  const pack = packOf(timed);
  const band: Band | null = pack !== null ? "pack" : bandOf(nearest?.seconds ?? null);
  // Only `near` has a nearest car in [2, 10), so its whole seconds are 2 to 9.
  const wholeSeconds = band === "near" && nearest !== null ? Math.floor(nearest.seconds) : null;
  // Every evaluation, spoken or not, so the close car's arrival (or each pack
  // car's) is followed from one to the next, and a pack going by grows.
  const ctx: FollowContext = { arrivals, telemetry, playerPct: pct, logger };
  const closeGone = closeCarGone(episode, timed, ctx);

  // The car or the group the last call was about has gone by: the call is
  // forgotten, so the next band is a first call, now or whenever one comes
  // (module header).
  if (closeGone) {
    logger.debug(
      `${episode.packCars.length > 0 ? "the group" : `car ${episode.closeCar?.carIdx}`} has gone by (${describeNearest(nearest)}${describeStationary(stationary)})`,
    );
    episode.spokenBand = null;
    episode.spokenSeconds = null;
    episode.closeCar = null;
    episode.packCars = [];
  }

  // No car under ten seconds: nothing to warn about, and silence says so.
  if (band === null) return;

  const reason = speakReason(episode, band, wholeSeconds, nearest?.carIdx ?? null, closeGone);

  if (reason === null) return;

  // `wholeSeconds` is set exactly when the band is `near`. Only a count of the
  // same car is an update; every other `near` call introduces its car.
  const payload: TrafficRejoin =
    band === "near" ? { verdict: band, seconds: wholeSeconds as number, first: reason !== "count" } : { verdict: band };

  emit({ event: "traffic.rejoin", data: payload });
  logger.debug(
    `emit ${describePayload(payload)} (${pack !== null ? describePack(pack) : describeNearest(nearest)}; ${reason}${describeStationary(stationary)})`,
  );
  episode.spokenBand = band;
  episode.spokenSeconds = wholeSeconds;
  const close = (band === "near" || band === "rightBehind") && nearest !== null ? nearest : null;

  episode.closeCar = close === null ? null : followed(close, ctx);
  episode.packCars = (pack ?? []).map((car) => followed(car, ctx));
}
