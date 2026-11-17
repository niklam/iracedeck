/**
 * Leaving the pits (issue #1113, spec decision 5): whether a car on track will
 * reach the end of the exit blend about when the player does. Publishes
 * `traffic.pitExit`.
 *
 * **The episode.** From the player driving out of the stall — the edge
 * `diffPitLane`'s `pitStall.departed` is read from, `PlayerCarInPitStall` true
 * then false with `OnPitRoad` true, read here from the telemetry against a
 * baseline of this module's own, never off the bus — until the player is past
 * the learned `blendEnd`, or back on the racing surface. Leaving the car
 * (`IsOnTrack` not true), a tow or a reset (`NotInWorld`, or back in the
 * stall) ends it too. Every end is silent.
 *
 * **The landmarks.** It needs both `pitRoadEnd` and `blendEnd` from #1112's
 * learner; with either unlearned it stays silent and logs once per episode at
 * debug. Never a position from a default pit-lane fraction (#1112's no-guess
 * rule).
 *
 * **The player's arrival at `blendEnd` (ETA),** with `T(x)` the player's
 * class's reference time at `x` — a landmark's own `estTimeByClass` for that
 * class first, else the class's learned curve:
 * - on pit road and short of `pitRoadEnd`: the distance to `pitRoadEnd` along
 *   the lap times the track length, at the pit speed limit, plus
 *   `T(blendEnd) − T(pitRoadEnd)`. The second half runs at racing reference
 *   pace while the player is still accelerating, so it runs early; the
 *   lopsided window (below) is what allows for that.
 * - past `pitRoadEnd` (or off pit road): `T(blendEnd) − T(player)`, with
 *   `T(player)` from the curve at the player's position, else the player's own
 *   `CarIdxEstTime` — the same quantity measured directly.
 * A span that crosses the start/finish line adds the class's reference lap.
 * Which phase applies is read from `OnPitRoad` AND the position against
 * `pitRoadEnd`, so the player-level `OnPitRoad` (which reads correctly; the
 * per-car `CarIdxOnPitRoad` is the one #1112 measured stuck true) and a
 * landmark learned a little late cannot keep the pit-road formula running
 * past the end of pit road between them.
 * No player-class reference anywhere, no pit speed limit or no track length
 * means no ETA: no callout, one debug line per episode. Never a guess.
 *
 * **The verdict,** evaluated every {@link TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS}:
 * every car on the racing surface is timed to `blendEnd` through
 * `computeTrafficArrivals` — the landmark's time for its class, the class
 * curve at `blendEnd`, the player-class time at `blendEnd` scaled to its
 * class. `traffic` when a timed car's arrival less the player's ETA lies in
 * `[−before, +after]` (both ends inclusive), or when any car is untimed: a
 * car nobody can time is never a clear. `clear` otherwise.
 *
 * **The before side looks back.** The arrival model answers only the NEXT
 * arrival, in [0, lap): a car that crossed `blendEnd` half a second ago reads
 * a lap away. Once the player's ETA is under `before`, part of the before
 * window lies in the past, and that car is practically alongside. So each
 * timed car's previous crossing is tested too, at `seconds − classLap − eta`
 * with the car's own class lap (`resolveClassLapTime`); a car whose class lap
 * is unknown has only its next crossing tested. A car is in the window when
 * either crossing is, and the reported nearest considers both.
 *
 * **When it speaks** (amended 2026-11-11: the call is made at the stall). At
 * the episode's first evaluation, which is the departure tick itself whenever
 * the landmarks and the ETA resolve there, however far off the merge is: the
 * call is made the moment the player leaves the pit box, early enough to act
 * on and ahead of the readback and tire lines it trumps. An evaluation that
 * cannot resolve them stays silent and the first one that can makes the call.
 * After that, again only when the verdict flips before the player reaches
 * `blendEnd`. The lines speak no number; `seconds` (the nearest timed car's
 * arrival relative to the player's, to a tenth, negative before) is for logs
 * and the harness.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { type PitLaneResolvedLandmark, pitLaneSignedDeltaPct } from "@iracedeck/track-data";

import { createTrafficPitExitState, type TrafficArrivalState, type TrafficPitExitState } from "../state.js";
import { isRacingSurface } from "./track-surface.js";
import {
  computeTrafficArrivals,
  curveReferenceSource,
  elapsed,
  isFiniteNumber,
  isLapFraction,
  landmarkReferenceSource,
  referenceTimeAt,
  resolveCarClassId,
  resolveClassLapTime,
  scaledReferenceSource,
  type TimedArrival,
  type TrafficClassInfo,
  type TrafficTelemetry,
  type UntimedArrival,
} from "./traffic-arrival.js";
import type { EmitFn } from "./types.js";

/** The events {@link diffTrafficPitExit} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const TRAFFIC_PIT_EXIT_EVENTS = ["traffic.pitExit"] as const satisfies readonly SimEventName[];

/**
 * How often an episode re-times the cars (ms): once a second, a fraction of a
 * window measured in seconds, and few enough evaluations that the per-car
 * arrival walk costs nothing.
 */
export const TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS = 1_000;

/** The two landmarks the detector reads, as `resolvePitLaneLandmarks` gives them; `null` while unlearned. */
export type TrafficPitExitLandmarks = {
  readonly pitRoadEnd: PitLaneResolvedLandmark | null;
  readonly blendEnd: PitLaneResolvedLandmark | null;
};

/**
 * What the detector reads besides its episode and the telemetry: other
 * families' facts, each resolved by `handleLiveSteps` for the tick.
 */
export type TrafficPitExitFacts = {
  /** The player's car index (`resolvePlayerCarIdx`), `-1` when unknown. */
  readonly playerCarIdx: number;
  /** The class lap times and each car's class (`resolveTrafficClassInfo`), `null` without session info. */
  readonly classes: TrafficClassInfo | null;
  /** `WeekendInfo.TrackLength` in metres (`resolveTrackLengthMeters`), `null` while unknown. */
  readonly trackLengthMeters: number | null;
  /** The pit-road speed limit in m/s (`resolvePitSpeedLimit`); `0` while unknown. */
  readonly pitSpeedLimitMps: number;
  /**
   * The learned landmarks (`resolvePitLaneLandmarks` over the instance's
   * learner, #1112), `null` until a track is loaded. A function so the
   * landmark view is built only at an evaluation, not on every tick.
   */
  readonly readLandmarks: () => TrafficPitExitLandmarks | null;
};

/** The windows the episode reads, live at each evaluation; each closure is the plugin's sanitized setting. */
export type TrafficPitExitWindows = {
  /** `trafficPitExitBeforeSeconds`: a car arriving up to this long before the player is traffic. */
  getBeforeSeconds: () => number;
  /** `trafficPitExitAfterSeconds`: a car arriving up to this long after the player is traffic. */
  getAfterSeconds: () => number;
};

/** The telemetry the pit-exit detector reads: the stall edge, the end conditions and the arrival model's arrays. */
export type TrafficPitExitTelemetry = TrafficTelemetry &
  Pick<TelemetryData, "IsOnTrack" | "OnPitRoad" | "PlayerCarInPitStall" | "PlayerTrackSurface">;

/** Why there is no ETA this evaluation, named in the once-per-episode debug line. */
type NoEtaReason = "noPlayerClass" | "noReference" | "noClassLap" | "noTrackLength" | "noPitSpeedLimit";

/** Why a running episode ends on this tick, read before the landmarks; `null` while it runs on. */
function endReason(telemetry: TrafficPitExitTelemetry, playerPct: unknown): string | null {
  if (telemetry.IsOnTrack !== true) return "left the car";

  if (telemetry.PlayerCarInPitStall === true) return "back in the stall";

  if (isRacingSurface(telemetry.PlayerTrackSurface)) return "on the racing surface";

  if (!isLapFraction(playerPct)) return "not in world";

  return null;
}

/**
 * The pit-exit detector's per-tick step: watches the stall edge, runs the
 * episode and its evaluations, and emits `traffic.pitExit` by the rules in
 * the module header. Owns `episode` (`state.trafficPitExit`) and writes
 * nothing else; its stall baseline is written last.
 *
 * @param episode The pit-exit episode, mutated in place.
 * @param curves The per-class reference curves (`state.trafficArrival`, written by `updateTrafficReferenceCurves` earlier in the tick), read only.
 */
export function diffTrafficPitExit(
  episode: TrafficPitExitState,
  curves: Readonly<TrafficArrivalState>,
  telemetry: TrafficPitExitTelemetry,
  facts: TrafficPitExitFacts,
  windows: TrafficPitExitWindows,
  now: number,
  emit: EmitFn<(typeof TRAFFIC_PIT_EXIT_EVENTS)[number]>,
  logger: ILogger,
): void {
  const inStall = telemetry.PlayerCarInPitStall;
  const playerPct = facts.playerCarIdx >= 0 ? telemetry.CarIdxLapDistPct?.[facts.playerCarIdx] : undefined;
  const departed = episode.lastInPitStall === true && inStall === false && telemetry.OnPitRoad === true;

  if (departed) {
    if (episode.active) logger.debug("PitExit: episode ended (left the stall again)");

    Object.assign(episode, createTrafficPitExitState(), { active: true });
    logger.debug(
      `PitExit: episode started (left the stall at pct=${isFiniteNumber(playerPct) ? playerPct.toFixed(4) : "?"})`,
    );
  }

  if (episode.active) {
    const reason = endReason(telemetry, playerPct);

    if (reason !== null) {
      end(episode, reason, logger);
    } else if (episode.lastEvalAt === null || elapsed(now, episode.lastEvalAt) >= TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS) {
      evaluate(episode, curves, telemetry, playerPct as number, facts, windows, now, emit, logger);
    }
  }

  episode.lastInPitStall = typeof inStall === "boolean" ? inStall : null;
}

/** Ends the episode silently, keeping the stall baseline (written after). */
function end(episode: TrafficPitExitState, reason: string, logger: ILogger): void {
  logger.debug(`PitExit: episode ended (${reason})`);
  Object.assign(episode, createTrafficPitExitState(), { lastInPitStall: episode.lastInPitStall });
}

/** The player's class's reference time at a landmark: its own per-class time, else the class curve there. */
function landmarkTime(
  curves: Readonly<TrafficArrivalState>,
  landmark: PitLaneResolvedLandmark,
  classId: number,
): number | null {
  const own = landmark.estTimeByClass[String(classId)];

  if (isFiniteNumber(own) && own >= 0) return own;

  return referenceTimeAt(curves.curves[String(classId)], landmark.pct);
}

/**
 * The reference time from `fromPct` to `toPct` (ahead of it) for the class:
 * `tTo − tFrom`, plus the class's reference lap when the span crosses the
 * start/finish line, where the time restarts. `null` when that lap is unknown.
 */
function referenceSpan(
  curves: Readonly<TrafficArrivalState>,
  classes: TrafficClassInfo | null,
  classId: number,
  fromPct: number,
  toPct: number,
  tFrom: number,
  tTo: number,
): number | null {
  const span = tTo - tFrom;

  if (toPct >= fromPct) return Math.max(0, span);

  const lap = resolveClassLapTime(curves, classes, classId);

  return lap === null ? null : Math.max(0, span + lap);
}

type Eta = { seconds: number; phase: "pitRoad" | "blend" } | { reason: NoEtaReason };

/** The player's arrival at `blendEnd` (module header), or why it cannot be known. */
function playerEta(
  curves: Readonly<TrafficArrivalState>,
  telemetry: TrafficPitExitTelemetry,
  playerPct: number,
  playerClass: number | null,
  facts: TrafficPitExitFacts,
  pitRoadEnd: PitLaneResolvedLandmark,
  blendEnd: PitLaneResolvedLandmark,
): Eta {
  if (playerClass === null) return { reason: "noPlayerClass" };

  const tBlend = landmarkTime(curves, blendEnd, playerClass);

  if (tBlend === null) return { reason: "noReference" };

  const toPitRoadEnd = pitLaneSignedDeltaPct(playerPct, pitRoadEnd.pct);

  if (telemetry.OnPitRoad === true && toPitRoadEnd >= 0) {
    if (facts.trackLengthMeters === null || !(facts.trackLengthMeters > 0)) return { reason: "noTrackLength" };

    if (!(facts.pitSpeedLimitMps > 0)) return { reason: "noPitSpeedLimit" };

    const tPitRoadEnd = landmarkTime(curves, pitRoadEnd, playerClass);

    if (tPitRoadEnd === null) return { reason: "noReference" };

    const blend = referenceSpan(curves, facts.classes, playerClass, pitRoadEnd.pct, blendEnd.pct, tPitRoadEnd, tBlend);

    if (blend === null) return { reason: "noClassLap" };

    return { seconds: (toPitRoadEnd * facts.trackLengthMeters) / facts.pitSpeedLimitMps + blend, phase: "pitRoad" };
  }

  const ownEstTime = telemetry.CarIdxEstTime?.[facts.playerCarIdx];
  const tPlayer =
    referenceTimeAt(curves.curves[String(playerClass)], playerPct) ??
    (isFiniteNumber(ownEstTime) && ownEstTime >= 0 ? ownEstTime : null);

  if (tPlayer === null) return { reason: "noReference" };

  const blend = referenceSpan(curves, facts.classes, playerClass, playerPct, blendEnd.pct, tPlayer, tBlend);

  return blend === null ? { reason: "noClassLap" } : { seconds: blend, phase: "blend" };
}

/** One evaluation: the landmarks, the ETA, then the verdict and whether to speak it (module header). */
function evaluate(
  episode: TrafficPitExitState,
  curves: Readonly<TrafficArrivalState>,
  telemetry: TrafficPitExitTelemetry,
  playerPct: number,
  facts: TrafficPitExitFacts,
  windows: TrafficPitExitWindows,
  now: number,
  emit: EmitFn<(typeof TRAFFIC_PIT_EXIT_EVENTS)[number]>,
  logger: ILogger,
): void {
  episode.lastEvalAt = now;

  const landmarks = facts.readLandmarks();
  const pitRoadEnd = landmarks?.pitRoadEnd ?? null;
  const blendEnd = landmarks?.blendEnd ?? null;

  if (pitRoadEnd === null || blendEnd === null) {
    if (!episode.landmarksMissingLogged) {
      episode.landmarksMissingLogged = true;
      logger.debug(
        `PitExit: silent, landmarks not learned (pitRoadEnd ${pitRoadEnd ? "learned" : "missing"}, blendEnd ${blendEnd ? "learned" : "missing"})`,
      );
    }

    return;
  }

  if (pitLaneSignedDeltaPct(playerPct, blendEnd.pct) <= 0) {
    end(episode, "past blendEnd", logger);

    return;
  }

  const playerClass = resolveCarClassId(telemetry, facts.classes, facts.playerCarIdx);
  const eta = playerEta(curves, telemetry, playerPct, playerClass, facts, pitRoadEnd, blendEnd);

  if ("reason" in eta) {
    if (!episode.noEtaLogged) {
      episode.noEtaLogged = true;
      logger.debug(`PitExit: silent, no ETA to blendEnd (${eta.reason})`);
    }

    return;
  }

  const before = windows.getBeforeSeconds();
  const after = windows.getAfterSeconds();
  // `playerEta` returned a time, so the player has a class.
  const playerClassId = playerClass as number;
  const playerClassAtBlend = landmarkTime(curves, blendEnd, playerClassId);
  const sources = [
    landmarkReferenceSource(blendEnd.estTimeByClass),
    curveReferenceSource(curves, blendEnd.pct),
    scaledReferenceSource(playerClassAtBlend, playerClassId, facts.classes),
  ];
  const arrivals = computeTrafficArrivals(curves, blendEnd.pct, sources, telemetry, facts.playerCarIdx, facts.classes);
  const untimed = arrivals.filter((a): a is UntimedArrival => !a.timed);
  let nearest: { car: TimedArrival; relative: number } | null = null;
  let inWindow = false;

  for (const arrival of arrivals) {
    if (!arrival.timed) continue;

    // Its next crossing, and the one before it (module header): the before
    // window reaches into the past once the player is that close.
    const classLap = resolveClassLapTime(curves, facts.classes, arrival.classId);
    const crossings = [arrival.seconds - eta.seconds];

    if (classLap !== null) crossings.push(arrival.seconds - classLap - eta.seconds);

    for (const relative of crossings) {
      if (nearest === null || Math.abs(relative) < Math.abs(nearest.relative)) nearest = { car: arrival, relative };

      if (relative >= -before && relative <= after) inWindow = true;
    }
  }

  const verdict = inWindow || untimed.length > 0 ? "traffic" : "clear";

  if (verdict === episode.spokenVerdict) return;

  const relative = nearest === null ? null : Math.round(nearest.relative * 10) / 10;
  const flip = episode.spokenVerdict !== null;

  emit({ event: "traffic.pitExit", data: relative === null ? { verdict } : { verdict, seconds: relative } });
  logger.debug(
    `PitExit: emit ${verdict} (${flip ? "flipped" : "first call"}; eta ${eta.seconds.toFixed(2)} s on ${eta.phase}, window -${before}/+${after} s; ` +
      `${nearest === null ? "no timed car" : `nearest car ${nearest.car.carIdx} at ${nearest.relative.toFixed(2)} s via ${nearest.car.source}`}; ` +
      `untimed: ${untimed.length === 0 ? "none" : untimed.map((car) => `car ${car.carIdx} (${car.reason})`).join(", ")})`,
  );
  episode.spokenVerdict = verdict;
}
