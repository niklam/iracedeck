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
 * **A position the sim did not send is not the player leaving.** The player's
 * lap position is unavailable on a tick whose `CarIdxLapDistPct` is missing or
 * no array, whose player entry is missing or the player's index unknown, or
 * whose entry is no lap position that is not negative: not a number, not
 * finite, or clearly past the line. Such a tick holds the episode: no
 * evaluation, nothing said, and the next readable tick evaluates as soon as
 * the interval allows. Only a gap that lasts
 * {@link TRAFFIC_PIT_EXIT_POSITION_GRACE_MS} ends it: ending on one tick would
 * lose the call for the rest of that exit, since with the player already out
 * of the stall no departure edge can start another. A definite not-in-world
 * reading is the player leaving and ends it at once: `PlayerTrackSurface`
 * `NotInWorld`, or the player's position negative (the sim's −1).
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
 *
 * **Where the player is, along the lap.** Every distance is the forward one,
 * in driving direction, never the shorter way round: a stall may lie more than
 * half a lap before `blendEnd` (a pit road along both straights of a short
 * oval), where the shorter way reads backwards. The player's own position is
 * read through `normalizeLapPosition`: on the start/finish line the sim reads
 * 1 or a hair past it, with the time already restarted, which is that hair
 * past 0, so a pit exit across the line runs on through it. The player is short of
 * `pitRoadEnd` while the forward distance to `blendEnd` exceeds the forward
 * distance from `pitRoadEnd` to `blendEnd`. The player is past `blendEnd` once
 * back on the racing surface (`AproachingPits` → `OnTrack` is the very edge
 * the landmark is learned from), or at it, or less than
 * {@link TRAFFIC_PIT_EXIT_LANDMARK_SLACK_M} beyond it with the surface not yet
 * flipped, which is a landmark learned a few metres early: a forward distance
 * a hair under a whole lap is a player just past the line, not a lap short of
 * it. A `pitRoadEnd` learned within that slack after `blendEnd` (a pit lane
 * ending straight onto the track makes both on one tick) is the same point,
 * with no time between them. So no ETA ever carries a lap the player is not
 * going to drive.
 * No player-class reference anywhere, no pit speed limit or no track length
 * means no ETA: no callout, one debug line per episode. Never a guess.
 *
 * **The verdict,** evaluated every {@link TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS}:
 * every car on the racing surface is timed to `blendEnd` through
 * `computeTrafficArrivals` — the landmark's time for its class, the class
 * curve at `blendEnd`, the player-class time at `blendEnd` scaled to its
 * class — but a car standing still, which that leaves out (its module
 * header): timed at reference pace, a car stopped short of the blend would
 * read as arriving with the player however long it stood there. `traffic` when a timed car's arrival less the player's ETA lies in
 * `[−before, +after]` (both ends inclusive), or when any car is untimed: a
 * car nobody can time is never a clear. `clear` otherwise.
 * Telemetry without the per-car arrays the model reads is no verdict at all
 * (`computeTrafficArrivals` answers `null`): no call, one debug line per
 * episode, and the next evaluation tries again.
 *
 * **Every crossing in the window.** The arrival model answers only the NEXT
 * arrival, in [0, lap), while a car crosses `blendEnd` once every class lap.
 * So each timed car's crossings are tested at `seconds + k × classLap − eta`
 * with the car's own class lap (`resolveClassLapTime`), from `k = −1` up to
 * the first crossing past `+after`, which covers every crossing in
 * `[eta − before, eta + after]`. The one before the next (`k = −1`) is the
 * before side looking back: once the player's ETA is under `before`, part of
 * the before window lies in the past, and a car that crossed half a second
 * ago, reading a lap away, is practically alongside. The later ones matter
 * when the ETA is longer than a class lap (a long pit lane, a short lap):
 * there a car's next crossing can come well before the player while its
 * crossing a lap later lands in the window. A car whose class lap is unknown
 * has only its next crossing tested. A car is in the window when any crossing
 * is, and the reported nearest is the nearest crossing tested.
 *
 * **When it speaks** (amended 2026-11-11: the call is made at the stall). At
 * the episode's first evaluation, which is the departure tick itself whenever
 * the landmarks and the ETA resolve there, however far off the merge is: the
 * call is made the moment the player leaves the pit box, early enough to act
 * on and ahead of the readback and tire lines it trumps. An evaluation that
 * cannot resolve them stays silent and the first one that can makes the call.
 * After that, again only when the verdict flips before the player reaches
 * `blendEnd` and the flip holds for {@link TRAFFIC_PIT_EXIT_FLIP_CONFIRM_EVALUATIONS}
 * evaluations in a row: both lines cut in, so a car wobbling across an edge
 * of the window would otherwise have "traffic" and "clear" cut each other in
 * turn. An evaluation with no verdict (no landmarks, no ETA, no per-car
 * arrays) breaks the row, so the count starts again after it; a tick without
 * the player's position makes no evaluation and leaves the row as it was. The
 * lines speak no number; `seconds` (the nearest timed car's arrival relative
 * to the player's, to a tenth, negative before) is for logs and the harness.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import {
  normalizePitLanePct,
  PIT_LANE_TOLERANCE_M,
  type PitLaneResolvedLandmark,
  pitLaneTolerancePct,
} from "@iracedeck/track-data";

import { createTrafficPitExitState, type TrafficArrivalState, type TrafficPitExitState } from "../state.js";
import { isRacingSurface } from "./track-surface.js";
import {
  computeTrafficArrivals,
  curveReferenceSource,
  elapsed,
  isFiniteNumber,
  landmarkReferenceSource,
  normalizeLapPosition,
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

/**
 * How many evaluations in a row a flipped verdict must reach before it is
 * spoken: two, so a flip is heard one evaluation (a second) after it is first
 * seen and has held for about two seconds of the picture. A car whose
 * predicted arrival sits at an edge of the window wobbles across it by a few
 * tenths between evaluations — each car's `CarIdxEstTime` carries an offset of
 * its own that moves (±0.2 s typically, the arrival model's header), and the
 * player's ETA changes formula at the end of pit road — and both lines cut in,
 * so speaking every wobble would alternate the two over each other. A verdict
 * that holds at two evaluations is a change in the picture; one second is
 * little of a pit exit that is called from the box. The first call is never
 * held: it is made at the departure.
 */
export const TRAFFIC_PIT_EXIT_FLIP_CONFIRM_EVALUATIONS = 2;

/**
 * How long the player's lap position may stay unavailable before a running
 * episode ends (ms; module header). The rejoin detector's gate grace
 * (`TRAFFIC_REJOIN_GATE_GRACE_MS`), for the same reason: many times a blip at
 * 60 Hz, a tick or two the sim did not send, so a blip keeps the episode and
 * what it has said; and short, a single evaluation interval, so a position
 * that is really gone ends the episode about when the next evaluation was
 * due, with nothing said in between. Pit lane at the limit covers a few tens
 * of metres in it, so the first readable tick after a blip still finds the
 * player short of the blend in all but the last of an exit, where the end
 * conditions take over.
 */
export const TRAFFIC_PIT_EXIT_POSITION_GRACE_MS = 1_000;

/**
 * How far (m) a learned landmark may sit from where the player's own car
 * reads it and still count as the same point (module header): the player
 * this far past `blendEnd`, still off the racing surface, is past it rather
 * than a lap short of it, and a `pitRoadEnd` this far after `blendEnd` is at
 * it. Three times the learner's agreement tolerance
 * (`PIT_LANE_TOLERANCE_M`, 5 m): a published landmark lies within that of the
 * drive-outs that taught it (the blend line repeated within 1.6 m across two
 * cars' drive-outs at Spa, #1112), and the player's own edge falls within half
 * a tick of it, a few metres at the speed of a pit exit. A pit lane is far
 * longer, so no stall ever sits this close past the blend line.
 */
export const TRAFFIC_PIT_EXIT_LANDMARK_SLACK_M = 15;

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

/**
 * The player's lap position this tick (module header): where on the lap,
 * normalized (`normalizeLapPosition`, so a player on the start/finish line,
 * read as 1 or a hair past it, is that hair past 0); the sim's definite
 * not-in-world reading; or nothing readable, which is data the sim did not send.
 */
type PlayerPosition =
  { readonly kind: "onLap"; readonly pct: number } | { readonly kind: "notInWorld" } | { readonly kind: "unavailable" };

/** Reads the player's lap position from the tick (module header). */
function readPlayerPosition(telemetry: TrafficPitExitTelemetry, raw: unknown): PlayerPosition {
  if (telemetry.PlayerTrackSurface === TrkLoc.NotInWorld) return { kind: "notInWorld" };

  if (isFiniteNumber(raw) && raw < 0) return { kind: "notInWorld" };

  const pct = normalizeLapPosition(raw);

  return pct === null ? { kind: "unavailable" } : { kind: "onLap", pct };
}

/**
 * Why a running episode ends at once on this tick, read before the
 * landmarks; `null` while it runs on, or is held for a position the sim did
 * not send (module header).
 */
function endReason(telemetry: TrafficPitExitTelemetry, position: PlayerPosition): string | null {
  if (telemetry.IsOnTrack !== true) return "left the car";

  if (telemetry.PlayerCarInPitStall === true) return "back in the stall";

  if (isRacingSurface(telemetry.PlayerTrackSurface)) return "on the racing surface";

  if (position.kind === "notInWorld") return "not in world";

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
  const rawPlayerPct: unknown = facts.playerCarIdx >= 0 ? telemetry.CarIdxLapDistPct?.[facts.playerCarIdx] : undefined;
  const position = readPlayerPosition(telemetry, rawPlayerPct);
  const departed = episode.lastInPitStall === true && inStall === false && telemetry.OnPitRoad === true;

  if (departed) {
    if (episode.active) logger.debug("PitExit: episode ended (left the stall again)");

    Object.assign(episode, createTrafficPitExitState(), { active: true });
    logger.debug(
      `PitExit: episode started (left the stall at pct=${isFiniteNumber(rawPlayerPct) ? rawPlayerPct.toFixed(4) : "?"})`,
    );
  }

  if (episode.active) {
    const reason = endReason(telemetry, position);

    if (reason !== null) {
      end(episode, reason, logger);
    } else if (position.kind === "unavailable") {
      holdWithoutPosition(episode, now, logger);
    } else if (position.kind === "onLap") {
      if (episode.positionUnavailableSince !== null) {
        logger.debug(
          `PitExit: player position back after ${elapsed(now, episode.positionUnavailableSince)} ms, episode kept`,
        );
        episode.positionUnavailableSince = null;
      }

      // A wall clock that stepped back evaluates now: waiting the interval out
      // from a time still ahead would stop every evaluation for as long as the step.
      if (episode.lastEvalAt !== null && episode.lastEvalAt > now) episode.lastEvalAt = null;

      if (episode.lastEvalAt === null || elapsed(now, episode.lastEvalAt) >= TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS) {
        evaluate(episode, curves, telemetry, position.pct, facts, windows, now, emit, logger);
      }
    }
  }

  episode.lastInPitStall = typeof inStall === "boolean" ? inStall : null;
}

/**
 * A tick without a readable player position (module header): holds the
 * episode, with no evaluation, and ends it silently once the gap has lasted
 * {@link TRAFFIC_PIT_EXIT_POSITION_GRACE_MS}. A wall clock that stepped back
 * restarts the gap from now, so the step neither ends it early nor holds it on.
 */
function holdWithoutPosition(episode: TrafficPitExitState, now: number, logger: ILogger): void {
  if (episode.positionUnavailableSince === null || episode.positionUnavailableSince > now) {
    if (episode.positionUnavailableSince === null) logger.debug("PitExit: player position unavailable, episode held");

    episode.positionUnavailableSince = now;
  }

  const gap = elapsed(now, episode.positionUnavailableSince);

  if (gap >= TRAFFIC_PIT_EXIT_POSITION_GRACE_MS) end(episode, `player position unavailable for ${gap} ms`, logger);
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

/** The forward distance along the lap from `from` to `to`, in driving direction, in [0, 1). */
function forwardPct(from: number, to: number): number {
  return normalizePitLanePct(to - from);
}

/** {@link TRAFFIC_PIT_EXIT_LANDMARK_SLACK_M} as a lap fraction: from the track length when known, else on the learner's own fallback length. */
function landmarkSlackPct(trackLengthMeters: number | null): number {
  return (pitLaneTolerancePct(trackLengthMeters) * TRAFFIC_PIT_EXIT_LANDMARK_SLACK_M) / PIT_LANE_TOLERANCE_M;
}

/** Where the player is against the two landmarks, as forward lap fractions (module header). */
type ExitPosition = {
  /** From the player to `blendEnd`: more than 0 and at most a lap less the slack. */
  readonly toBlendEnd: number;
  /** From `pitRoadEnd` to `blendEnd`; 0 for a `pitRoadEnd` learned within the slack after `blendEnd`. */
  readonly pitRoadEndToBlendEnd: number;
};

/** Where the player is against the landmarks (module header); `null` once at or past `blendEnd`. */
function exitPosition(
  playerPct: number,
  pitRoadEnd: PitLaneResolvedLandmark,
  blendEnd: PitLaneResolvedLandmark,
  slackPct: number,
): ExitPosition | null {
  const toBlendEnd = forwardPct(playerPct, blendEnd.pct);

  if (toBlendEnd === 0 || toBlendEnd > 1 - slackPct) return null;

  const pitRoadEndToBlendEnd = forwardPct(pitRoadEnd.pct, blendEnd.pct);

  return { toBlendEnd, pitRoadEndToBlendEnd: pitRoadEndToBlendEnd > 1 - slackPct ? 0 : pitRoadEndToBlendEnd };
}

/** The player's arrival at `blendEnd` (module header), or why it cannot be known. */
function playerEta(
  curves: Readonly<TrafficArrivalState>,
  telemetry: TrafficPitExitTelemetry,
  playerPct: number,
  playerClass: number | null,
  facts: TrafficPitExitFacts,
  pitRoadEnd: PitLaneResolvedLandmark,
  blendEnd: PitLaneResolvedLandmark,
  position: ExitPosition,
): Eta {
  if (playerClass === null) return { reason: "noPlayerClass" };

  const tBlend = landmarkTime(curves, blendEnd, playerClass);

  if (tBlend === null) return { reason: "noReference" };

  // Past `pitRoadEnd` is `OnPitRoad` turning false; the position check is the
  // guard against a landmark learned a little late (module header).
  if (telemetry.OnPitRoad === true && position.toBlendEnd > position.pitRoadEndToBlendEnd) {
    if (facts.trackLengthMeters === null || !(facts.trackLengthMeters > 0)) return { reason: "noTrackLength" };

    if (!(facts.pitSpeedLimitMps > 0)) return { reason: "noPitSpeedLimit" };

    const toPitRoadEnd = position.toBlendEnd - position.pitRoadEndToBlendEnd;
    let blend = 0;

    // Two landmarks at one point have no time between them.
    if (position.pitRoadEndToBlendEnd > 0) {
      const tPitRoadEnd = landmarkTime(curves, pitRoadEnd, playerClass);

      if (tPitRoadEnd === null) return { reason: "noReference" };

      const span = referenceSpan(curves, facts.classes, playerClass, pitRoadEnd.pct, blendEnd.pct, tPitRoadEnd, tBlend);

      if (span === null) return { reason: "noClassLap" };

      blend = span;
    }

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

/**
 * The most crossings of one car {@link crossingsToTest} lists: far more than
 * any real ETA spans (a minute and a half of pit lane over a ten-second oval
 * lap is about ten), so it never cuts a real list short; it bounds the walk
 * for a class lap that is no real lap time, or a window side that is not a
 * number, so an evaluation always ends.
 */
const MAX_CROSSINGS = 64;

/**
 * A timed car's crossings of `blendEnd` relative to the player's ETA (s,
 * negative before; module header): with its class lap known, one a lap apart
 * from the one before its next (`k = −1`) up to and including the first past
 * `after`; without one, its next crossing alone. A class lap that is no
 * positive finite time counts as unknown.
 */
function crossingsToTest(seconds: number, eta: number, after: number, classLap: number | null): number[] {
  const next = seconds - eta;

  if (classLap === null || !(classLap > 0) || !Number.isFinite(classLap)) return [next];

  const crossings: number[] = [];

  for (let k = -1; crossings.length < MAX_CROSSINGS; k++) {
    const relative = next + k * classLap;

    crossings.push(relative);

    if (relative > after) break;
  }

  return crossings;
}

/**
 * An evaluation with no verdict (module header): the landmarks unlearned, no
 * ETA, or no per-car arrays. A flip held back for confirmation needs that many
 * evaluations IN A ROW, and this one did not reach it, so the count starts
 * again; the spoken verdict stands.
 */
function noVerdict(episode: TrafficPitExitState): void {
  episode.flipVerdict = null;
  episode.flipEvaluations = 0;
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
    noVerdict(episode);

    if (!episode.landmarksMissingLogged) {
      episode.landmarksMissingLogged = true;
      logger.debug(
        `PitExit: silent, landmarks not learned (pitRoadEnd ${pitRoadEnd ? "learned" : "missing"}, blendEnd ${blendEnd ? "learned" : "missing"})`,
      );
    }

    return;
  }

  const position = exitPosition(playerPct, pitRoadEnd, blendEnd, landmarkSlackPct(facts.trackLengthMeters));

  if (position === null) {
    end(episode, "past blendEnd", logger);

    return;
  }

  const playerClass = resolveCarClassId(telemetry, facts.classes, facts.playerCarIdx);
  const eta = playerEta(curves, telemetry, playerPct, playerClass, facts, pitRoadEnd, blendEnd, position);

  if ("reason" in eta) {
    noVerdict(episode);

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
  const stationary: number[] = [];
  const arrivals = computeTrafficArrivals(
    curves,
    blendEnd.pct,
    sources,
    telemetry,
    facts.playerCarIdx,
    facts.classes,
    facts.trackLengthMeters,
    stationary,
  );

  // No per-car arrays is no picture at all, never an empty track: no call,
  // and the next evaluation tries again.
  if (arrivals === null) {
    noVerdict(episode);

    if (!episode.arraysMissingLogged) {
      episode.arraysMissingLogged = true;
      logger.debug("PitExit: silent, the per-car arrays are missing");
    }

    return;
  }

  const untimed = arrivals.filter((a): a is UntimedArrival => !a.timed);
  let nearest: { car: TimedArrival; relative: number } | null = null;
  let inWindow = false;

  for (const arrival of arrivals) {
    if (!arrival.timed) continue;

    for (const relative of crossingsToTest(
      arrival.seconds,
      eta.seconds,
      after,
      resolveClassLapTime(curves, facts.classes, arrival.classId),
    )) {
      if (nearest === null || Math.abs(relative) < Math.abs(nearest.relative)) nearest = { car: arrival, relative };

      if (relative >= -before && relative <= after) inWindow = true;
    }
  }

  const verdict = inWindow || untimed.length > 0 ? "traffic" : "clear";

  if (verdict === episode.spokenVerdict) {
    // The spoken verdict holds: a flip seen before it was a wobble.
    episode.flipVerdict = null;
    episode.flipEvaluations = 0;

    return;
  }

  const flip = episode.spokenVerdict !== null;

  // A flip is spoken only once it has held (module header); the first call never waits.
  if (flip) {
    episode.flipEvaluations = episode.flipVerdict === verdict ? episode.flipEvaluations + 1 : 1;
    episode.flipVerdict = verdict;

    if (episode.flipEvaluations < TRAFFIC_PIT_EXIT_FLIP_CONFIRM_EVALUATIONS) {
      logger.debug(
        `PitExit: ${verdict} at ${episode.flipEvaluations} of ${TRAFFIC_PIT_EXIT_FLIP_CONFIRM_EVALUATIONS} evaluations, ${episode.spokenVerdict} still stands`,
      );

      return;
    }
  }

  const relative = nearest === null ? null : Math.round(nearest.relative * 10) / 10;

  emit({ event: "traffic.pitExit", data: relative === null ? { verdict } : { verdict, seconds: relative } });
  logger.debug(
    `PitExit: emit ${verdict} (${flip ? "flipped" : "first call"}; eta ${eta.seconds.toFixed(2)} s on ${eta.phase}, window -${before}/+${after} s; ` +
      `${nearest === null ? "no timed car" : `nearest car ${nearest.car.carIdx} at ${nearest.relative.toFixed(2)} s via ${nearest.car.source}`}; ` +
      `untimed: ${untimed.length === 0 ? "none" : untimed.map((car) => `car ${car.carIdx} (${car.reason})`).join(", ")}` +
      `${stationary.length === 0 ? "" : `; standing still: ${stationary.map((carIdx) => `car ${carIdx}`).join(", ")}`})`,
  );
  episode.spokenVerdict = verdict;
  episode.flipVerdict = null;
  episode.flipEvaluations = 0;
}
