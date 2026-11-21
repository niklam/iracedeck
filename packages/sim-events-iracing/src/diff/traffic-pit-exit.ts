/**
 * Leaving the pits (issue #1113, spec decision 5): whether a car on track will
 * reach the end of the exit blend about when the player does. Publishes
 * `traffic.pitExit`, and the merge warning `traffic.pitExitMerge`.
 *
 * **The episode.** From the player driving out of the stall — the edge
 * `diffPitLane`'s `pitStall.departed` is read from, `PlayerCarInPitStall` true
 * then false with `OnPitRoad` true, read here from the telemetry against a
 * baseline of this module's own, never off the bus — until the player is past
 * the learned `blendEnd`, or back on the racing surface. Leaving the car
 * (`IsOnTrack` not true), a tow or a reset (`NotInWorld`, or back in the
 * stall) ends it too. Every end is silent. Back in the stall is
 * `PlayerCarInPitStall` true, or, on a tick that does not send the flag,
 * `PlayerTrackSurface` `InPitStall`; with the flag sent false the surface is
 * not read, since it can still say `InPitStall` for a tick after the car
 * has driven out. The stall baseline is read the same way, so a tick that
 * drops the flag while the surface still reads the stall keeps the player in
 * it and the departure after it still starts the episode; any other surface
 * with the flag unsent is no reading, and starts nothing.
 *
 * **A position the sim did not send is not the player leaving.** The player's
 * lap position is unavailable on a tick whose `CarIdxLapDistPct` is missing or
 * no array, whose player entry is missing or the player's index unknown, or
 * whose entry is no lap position that is not negative: not a number, not
 * finite, or clearly past the line. Such a tick holds the episode: no
 * evaluation, nothing said, and the next readable tick evaluates as soon as
 * the interval allows. Only a gap that lasts
 * {@link TRAFFIC_PIT_EXIT_POSITION_GRACE_MS} ends it — on the tick that
 * reaches the grace, or on the first readable tick after it when the sim sent
 * none in between, never kept for the position coming back late: ending on one tick would
 * lose the call for the rest of that exit, since with the player already out
 * of the stall no departure edge can start another. A definite not-in-world
 * reading is the player leaving and ends it at once: `PlayerTrackSurface`
 * `NotInWorld`, or the player's position negative (the sim's −1).
 *
 * **The landmarks.** It needs both `pitRoadEnd` and `blendEnd` from #1112's
 * learner; with either unlearned it stays silent and logs once per episode at
 * debug. Never a position from a default pit-lane fraction (#1112's no-guess
 * rule). Nor from a landmark kept from before a track rebuild (`source:
 * "previous"`, `resolvePublishedLandmark`): it was learned on the old
 * geometry, so neither {@link TRAFFIC_PIT_EXIT_LANDMARK_SLACK_M} nor the ETA's
 * precision holds on it. Either landmark `previous` is treated as unlearned:
 * no verdict, the flip count started again, one debug line per episode, until
 * the learner has republished both on the current geometry. Nor from a pair
 * out of driving order: `pitRoadEnd` must come before `blendEnd`, and read
 * forward from `pitRoadEnd` a `blendEnd` more than half a lap on is one that
 * lies behind it, a mislearned pair. Within
 * {@link TRAFFIC_PIT_EXIT_LANDMARK_SLACK_M} after `blendEnd` it is the same
 * point (below) and is kept; beyond that the forward distance from
 * `pitRoadEnd` to `blendEnd` would read most of a lap, every position short of
 * the blend would count as past `pitRoadEnd`, and the call and the merge check
 * would run at the departure. Such a pair is unusable like an unlearned one:
 * no verdict, the flip count started again, one debug line per episode.
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
 * past the end of pit road between them. A tick that does not send
 * `OnPitRoad` keeps the episode's last reading of it (`true` from the
 * departure, which requires it), so a missing bit never switches the phase;
 * a `false` the sim sent is the blend phase. The reading is kept before the
 * evaluation runs, so one that threw is retried on the bit its tick sent.
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
 * it. Further beyond it with the surface not yet flipped (a merge lane the
 * player holds past a landmark most cars taught earlier), the episode's own
 * progress says so: the forward distance from where it started has reached
 * the forward distance from there to `blendEnd`. Of the lap beyond `blendEnd`
 * the nearer half counts as past it and the farther half as a car rolled back
 * behind where the episode started, still short of it, so a stall more than
 * half a lap before `blendEnd` still reads as short of it. The start is the
 * departure tick's position, the stall, which is never past `blendEnd`. When
 * that tick sent none, a later position could be past it already and would
 * read as no progress, a lap short; so the start is then the player's
 * position at the first evaluation that reads the landmarks, taken only in
 * the half lap before `blendEnd` — in the half lap after it the player is
 * already past it, by the same nearer-half rule, and the episode ends
 * silently. The cost: a stall more than half a lap before `blendEnd` whose
 * departure tick sent no position gets no call for that exit.
 * A `pitRoadEnd` learned within that slack after `blendEnd` (a pit lane
 * ending straight onto the track makes both on one tick) is the same point,
 * with no time between them. So no ETA ever carries a lap the player is not
 * going to drive.
 * No player-class reference anywhere, no pit speed limit or no track length
 * means no ETA: no callout, one debug line per episode. Never a guess.
 *
 * **The verdict,** evaluated every {@link TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS}
 * (and off the schedule, below):
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
 * **The verdict settles** from the stall on, silently. The episode's first
 * evaluation with a verdict settles it at once; a different verdict settles
 * only once it holds for {@link TRAFFIC_PIT_EXIT_FLIP_CONFIRM_EVALUATIONS}
 * evaluations in a row: both lines cut in, so a car wobbling across an edge
 * of the window would otherwise have "traffic" and "clear" cut each other in
 * turn. An evaluation with no verdict (no landmarks, a landmark of a rebuilt
 * track's old geometry, no ETA, no per-car arrays) breaks the row, so the
 * count starts again after it; a tick without the player's position makes no
 * evaluation and leaves the row as it was.
 *
 * **When it speaks** (amended twice on 2026-11-20, superseding 2026-11-11's
 * call at the stall and then the same day's call at the end of pit road): the
 * driver wants it "always before pit exit, not right after", so the first
 * call is made {@link TRAFFIC_PIT_EXIT_CALL_LEAD_S} short of `pitRoadEnd`, the
 * pit exit line, saying the verdict settled by then. The time to `pitRoadEnd`
 * is the ETA's own pit-road term: the forward distance to it at the pit speed
 * limit, the same estimate, not a second one ({@link secondsToPitRoadEnd}).
 * A stall closer than that to `pitRoadEnd` is at the call point already, so
 * the call is made on the departure tick, on the first verdict, which is
 * never held. On a track whose `pitRoadEnd` and `blendEnd` are one point (a
 * pit lane ending straight onto the track) the same rule puts the call that
 * long before the merge. A player already past `pitRoadEnd` before any call
 * (landmarks arriving mid-exit, a `pitRoadEnd` learned a little late) is at
 * the call point too: past it is the ETA's blend-phase test, `OnPitRoad`
 * false or the position at or past `pitRoadEnd` (forward distance to
 * `blendEnd` no more than `pitRoadEnd`'s). With the track length or the pit
 * speed limit unknown there is no lead to measure, and the call point is
 * past `pitRoadEnd` alone; without them the pit-road ETA has no verdict to
 * speak anyway. The call point is a latch: a car rolled back behind it, or a
 * position wobbling across it, neither speaks again nor silences the call.
 * It is written once (`reachedCallPoint`). Nothing is said before it,
 * whatever has settled.
 *
 * **Off the schedule.** The call point can fall between two scheduled
 * evaluations (a lead of 3 s against an interval of 1), and a blend lane can
 * be shorter than an interval covers (0.008 of a 1,600 m lap is 13 m, under a
 * second at 60 km/h), so waiting for the next scheduled evaluation could make
 * the call late, or find the player already past `blendEnd` and end the
 * episode silent. So on every tick between two scheduled evaluations the
 * landmarks are read while either is still due: the call not yet made, or
 * the merge warning's check (below) not yet run past `pitRoadEnd`. The first
 * tick at the call point, or past `pitRoadEnd` with the merge unchecked, on
 * landmarks the evaluation can use and short of `blendEnd`, evaluates there
 * and then, as does each tick after it until the call is made and the merge
 * checked. The merge counts as checked only by an evaluation that timed every
 * car on track, or found none: one per-car `CarIdxEstTime` entry can be
 * unusable for a tick, unlike a whole array, and a car untimed on the first
 * tick of a short exit lane that comes back within the threshold on the next
 * would otherwise wait for the next scheduled evaluation, which the end of the
 * lane can beat. Such an evaluation settles a first verdict if none has settled
 * and speaks the settled one, but is no part of a flip's row: it neither
 * counts toward {@link TRAFFIC_PIT_EXIT_FLIP_CONFIRM_EVALUATIONS} nor breaks
 * the row, with or without a verdict, so a flip is never confirmed by two
 * evaluations a tick apart. Nor does it move `lastEvalAt`: the scheduled
 * evaluations run on a second apart as before. A tick that reads the
 * landmarks this way and finds the player at or past `blendEnd` ends the
 * episode there, as a scheduled evaluation would, so a car rolled back short
 * of the line before the next one is no fresh exit for the merge warning; one
 * whose landmarks cannot be used waits for the next scheduled evaluation.
 * Once both are done, nothing between them reads the landmarks.
 *
 * After the first call, again only when a flip settles before the
 * player reaches `blendEnd` and before the merge warning (below) is said. A flip pending at the call point is held like any
 * other: one that began before it and holds at a scheduled evaluation that is
 * the call point's is settled there, so the call says the newer verdict; at a
 * call point between two scheduled evaluations, or one first seen AT the call
 * point, the call says the settled verdict, and the flip follows at the next
 * scheduled evaluation if it holds there. Waiting for it instead could lose
 * the call to the end of a short blend lane, and no single evaluation decides
 * what is heard anywhere else. An evaluation that cannot settle a verdict
 * stays silent and the first one at the call point that can makes the call; a
 * track without both landmarks learned on its current geometry never gets
 * one. The lines speak no number; `seconds` (the nearest timed car's arrival
 * relative to the player's, to a tenth, negative before, from the latest
 * evaluation that reached the verdict spoken) is for logs and the harness.
 *
 * **The merge warning** (amended 2026-11-20: "maybe a 'watch for cars' in the
 * merge lane again, if there's cars truly close"). Past `pitRoadEnd` (the
 * ETA's blend-phase test above, read at each evaluation, not latched) and
 * short of `blendEnd`, each evaluation with a verdict also asks whether the
 * nearest crossing of `blendEnd` by a timed car, of every crossing tested
 * (below), lies within the `trafficPitExitMergeWarnSeconds` threshold of the
 * player's ETA, either side: `|arrival − eta| ≤ threshold`, symmetric, since
 * the spec names no side. The first that does publishes `traffic.pitExitMerge`
 * with that car's relative arrival, to a tenth, whatever the first call said
 * and whether or not a flip is pending; it is said once per episode, never
 * again. It is the last word on the exit: from then on no `traffic.pitExit` is
 * published that episode, so a flip settling after it ("clear" after "Watch
 * for cars.") is logged at debug and not said. In an evaluation that makes
 * both, the call is emitted first. The test reads the unrounded arrival, so under a threshold that is
 * not a whole tenth the published tenth can lie up to 0.05 s past it, as the
 * event catalog states; testing the tenth instead would make a threshold of
 * 0, which is meant to be off, warn for any car within 0.05 s, and would
 * widen a whole-tenth threshold by up to 0.05 s. A car nobody can time never
 * triggers it: "truly close" is a number, and an untimed car has none (it
 * makes the verdict traffic, which the first call has said). The threshold
 * is read live at each such evaluation; 0 leaves only an exact coincidence,
 * so it is off in practice. The crossings
 * tested run up to the larger of the window's `after` and the threshold, so
 * a crossing inside the threshold is never left out. "In the exit lane"
 * needs an exit lane: a track without one gets no merge warning, however the
 * road bit reads. Without one is `pitRoadEnd` at `blendEnd`, within
 * {@link TRAFFIC_PIT_EXIT_LANDMARK_SLACK_M} after it (the same point, above)
 * or within the learner's own agreement tolerance (`PIT_LANE_TOLERANCE_M`,
 * 5 m) before it, closer than the learner can tell two points apart. There
 * `OnPitRoad` can turn false a tick or two short of the learned point, which
 * moves the ETA to its blend phase and is the call point's fallback, as
 * anywhere, but admits the player to no exit lane. Gated, with the pit-exit call, by
 * the `calloutEnabledTrafficPitExit` opt-in on the audio side.
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
export const TRAFFIC_PIT_EXIT_EVENTS = [
  "traffic.pitExit",
  "traffic.pitExitMerge",
] as const satisfies readonly SimEventName[];

/**
 * How long before the player reaches `pitRoadEnd`, the pit exit line, the
 * first call is made (s, at the pit speed limit; the spec's
 * `PIT_EXIT_CALL_LEAD_S`, amended 2026-11-20): "3s before the merge", in the
 * driver's words, so the call is heard before the exit and not right after
 * it. A stall closer than this to `pitRoadEnd` is called on the departure.
 */
export const TRAFFIC_PIT_EXIT_CALL_LEAD_S = 3;

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
 * little of a pit exit, settled from the stall on. The first verdict is never
 * held: it settles at the episode's first evaluation, and is spoken at the
 * call point, {@link TRAFFIC_PIT_EXIT_CALL_LEAD_S} short of `pitRoadEnd`
 * (module header).
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
   * landmark view is built only when read: at an evaluation, and on the ticks
   * between two of them only until the call is made and the merge warning
   * checked past `pitRoadEnd` (module header).
   */
  readonly readLandmarks: () => TrafficPitExitLandmarks | null;
};

/** The windows the episode reads, live at each evaluation; each closure is the plugin's sanitized setting. */
export type TrafficPitExitWindows = {
  /** `trafficPitExitBeforeSeconds`: a car arriving up to this long before the player is traffic. */
  getBeforeSeconds: () => number;
  /** `trafficPitExitAfterSeconds`: a car arriving up to this long after the player is traffic. */
  getAfterSeconds: () => number;
  /**
   * `trafficPitExitMergeWarnSeconds`: in the exit lane, a timed car arriving
   * within this long of the player, either side, gets the merge warning.
   * Read only at an evaluation past `pitRoadEnd`.
   */
  getMergeWarnSeconds: () => number;
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
 * Whether the player is in the stall this tick (module header), read the same
 * way for the episode's end and for the stall baseline the departure edge is
 * read against. The stall flag decides when the sim sent it: `false` with the
 * surface still `InPitStall` is a departure whose surface lags a tick. Unsent,
 * the surface `InPitStall` is the player in the stall; any other surface is
 * no reading (`null`), since the flag is what the departure is read from.
 */
function readInStall(telemetry: TrafficPitExitTelemetry): boolean | null {
  const flag = telemetry.PlayerCarInPitStall;

  if (typeof flag === "boolean") return flag;

  return telemetry.PlayerTrackSurface === TrkLoc.InPitStall ? true : null;
}

/**
 * Why a running episode ends at once on this tick, read before the
 * landmarks; `null` while it runs on, or is held for a position the sim did
 * not send (module header).
 */
function endReason(
  telemetry: TrafficPitExitTelemetry,
  inStall: boolean | null,
  position: PlayerPosition,
): string | null {
  if (telemetry.IsOnTrack !== true) return "left the car";

  if (inStall === true) return "back in the stall";

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
  const inStall = readInStall(telemetry);
  // A container that is not an array is no position at all, as the arrival
  // model reads it (`computeTrafficArrivals`): indexing an array-like object
  // would evaluate on a tick whose per-car read then fails, resetting a held
  // flip instead of holding the episode for the position grace.
  const lapDistPcts: unknown = telemetry.CarIdxLapDistPct;
  const rawPlayerPct: unknown =
    facts.playerCarIdx >= 0 && Array.isArray(lapDistPcts) ? lapDistPcts[facts.playerCarIdx] : undefined;
  const position = readPlayerPosition(telemetry, rawPlayerPct);
  const departed = episode.lastInPitStall === true && inStall === false && telemetry.OnPitRoad === true;

  if (departed) {
    if (episode.active) logger.debug("episode ended (left the stall again)");

    Object.assign(episode, createTrafficPitExitState(), { active: true, lastOnPitRoad: true });

    // Where the episode's forward progress is measured from (module header):
    // the stall the player just left, never past `blendEnd`. Without it the
    // first evaluation that reads the landmarks takes the start.
    if (position.kind === "onLap") episode.startPct = position.pct;

    logger.debug(
      `episode started (left the stall at pct=${isFiniteNumber(rawPlayerPct) ? rawPlayerPct.toFixed(4) : "?"})`,
    );
  }

  if (episode.active) {
    // The road bit the sim sent is recorded before the evaluation that can
    // throw: it is a reading kept to fill a tick that omits it, not a
    // baseline an edge is read against, so the retry after a throw must see
    // it rather than the reading before it.
    if (typeof telemetry.OnPitRoad === "boolean") episode.lastOnPitRoad = telemetry.OnPitRoad;

    const reason = endReason(telemetry, inStall, position);

    if (reason !== null) {
      end(episode, reason, logger);
    } else if (position.kind === "unavailable") {
      holdWithoutPosition(episode, now, logger);
    } else if (position.kind === "onLap" && !positionGapExpired(episode, now, logger)) {
      // A wall clock that stepped back evaluates now: waiting the interval out
      // from a time still ahead would stop every evaluation for as long as the step.
      if (episode.lastEvalAt !== null && episode.lastEvalAt > now) episode.lastEvalAt = null;

      // A tick that does not send `OnPitRoad` keeps the episode's last
      // reading of it, so a missing bit never switches the ETA's phase.
      const onPitRoad = episode.lastOnPitRoad === true;

      if (episode.lastEvalAt === null || elapsed(now, episode.lastEvalAt) >= TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS) {
        evaluate(
          episode,
          curves,
          telemetry,
          position.pct,
          onPitRoad,
          facts.readLandmarks(),
          "scheduled",
          facts,
          windows,
          emit,
          logger,
        );

        // Written once the evaluation has returned, its silent returns
        // included (the package's step rule): one that threw, in the landmark
        // read or the timing, is retried on the next tick rather than a second
        // later. An evaluation that ended the episode leaves it ended.
        if (episode.active) episode.lastEvalAt = now;
      } else if (episode.spokenVerdict === null || (!episode.mergeChecked && !episode.mergeWarned)) {
        // Between two scheduled evaluations, until the call is made and the
        // merge checked: the first tick at the call point, or past
        // `pitRoadEnd` with the merge unchecked, evaluates at once (module
        // header), and so does each tick after it until that is done. It
        // leaves `lastEvalAt` alone, so the schedule runs on as it was. A
        // tick that finds the player at or past `blendEnd` ends the episode.
        const landmarks = facts.readLandmarks();
        const step = offScheduleStep(episode, position.pct, onPitRoad, landmarks, facts);

        if (step === "pastBlendEnd") {
          end(episode, "past blendEnd, between evaluations", logger);
        } else if (step === "evaluate") {
          evaluate(
            episode,
            curves,
            telemetry,
            position.pct,
            onPitRoad,
            landmarks,
            "offSchedule",
            facts,
            windows,
            emit,
            logger,
          );
        }
      }
    }
  }

  // The stall baseline is the departure edge's, so it is written last (the
  // package's step rule): a step that threw re-reads the edge on the next tick.
  episode.lastInPitStall = inStall;
}

/**
 * A tick without a readable player position (module header): holds the
 * episode, with no evaluation, and ends it silently once the gap has lasted
 * {@link TRAFFIC_PIT_EXIT_POSITION_GRACE_MS}. A wall clock that stepped back
 * restarts the gap from now, so the step neither ends it early nor holds it on.
 */
function holdWithoutPosition(episode: TrafficPitExitState, now: number, logger: ILogger): void {
  if (episode.positionUnavailableSince === null || episode.positionUnavailableSince > now) {
    if (episode.positionUnavailableSince === null) logger.debug("player position unavailable, episode held");

    episode.positionUnavailableSince = now;
  }

  const gap = elapsed(now, episode.positionUnavailableSince);

  if (gap >= TRAFFIC_PIT_EXIT_POSITION_GRACE_MS) end(episode, `player position unavailable for ${gap} ms`, logger);
}

/**
 * The first readable tick after a gap in the player's position (module
 * header): a gap shorter than {@link TRAFFIC_PIT_EXIT_POSITION_GRACE_MS} is
 * over and the episode kept (`false`); one that lasted the grace, with no tick
 * in between to end it (the sim sent none), ends the episode here, as an
 * unreadable tick at the grace limit would have (`true`). No gap is `false`.
 */
function positionGapExpired(episode: TrafficPitExitState, now: number, logger: ILogger): boolean {
  if (episode.positionUnavailableSince === null) return false;

  const gap = elapsed(now, episode.positionUnavailableSince);

  if (gap >= TRAFFIC_PIT_EXIT_POSITION_GRACE_MS) {
    end(episode, `player position unavailable for ${gap} ms`, logger);

    return true;
  }

  logger.debug(`player position back after ${gap} ms, episode kept`);
  episode.positionUnavailableSince = null;

  return false;
}

/** Ends the episode silently, keeping the stall baseline (written after). */
function end(episode: TrafficPitExitState, reason: string, logger: ILogger): void {
  logger.debug(`episode ended (${reason})`);
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

/**
 * Whether the episode's own progress has carried the player past `blendEnd`
 * (module header): the forward distance from where it started reaches the
 * forward distance from there to `blendEnd`. Of the lap beyond `blendEnd`,
 * the nearer half is past it and the farther half is behind the start, a car
 * rolled back from where the episode began, which is still short of it.
 */
function progressedPast(startPct: number, playerPct: number, blendEndPct: number): boolean {
  const startToBlendEnd = forwardPct(startPct, blendEndPct);
  const beyond = forwardPct(startPct, playerPct) - startToBlendEnd;

  return beyond >= 0 && beyond < (1 - startToBlendEnd) / 2;
}

/** Where the player is against the landmarks (module header); `null` once at or past `blendEnd`. */
function exitPosition(
  startPct: number,
  playerPct: number,
  pitRoadEnd: PitLaneResolvedLandmark,
  blendEnd: PitLaneResolvedLandmark,
  slackPct: number,
): ExitPosition | null {
  const toBlendEnd = forwardPct(playerPct, blendEnd.pct);

  if (toBlendEnd === 0 || toBlendEnd > 1 - slackPct) return null;

  if (progressedPast(startPct, playerPct, blendEnd.pct)) return null;

  const pitRoadEndToBlendEnd = forwardPct(pitRoadEnd.pct, blendEnd.pct);

  return { toBlendEnd, pitRoadEndToBlendEnd: pitRoadEndToBlendEnd > 1 - slackPct ? 0 : pitRoadEndToBlendEnd };
}

/**
 * Whether the player is past `pitRoadEnd` (module header): `OnPitRoad` false,
 * or the position at or past `pitRoadEnd`. The ETA's blend phase
 * (`playerEta`) and the call point's fallback; the merge warning also needs an
 * exit lane ({@link inExitLane}).
 */
function pastPitRoadEnd(onPitRoad: boolean, position: ExitPosition): boolean {
  return !onPitRoad || position.toBlendEnd <= position.pitRoadEndToBlendEnd;
}

/**
 * Whether the player is in the exit lane, where the merge warning is checked
 * (module header): past `pitRoadEnd` ({@link pastPitRoadEnd}) on a track that
 * has an exit lane, its `pitRoadEnd` more than the learner's agreement
 * tolerance (`PIT_LANE_TOLERANCE_M`) before `blendEnd`. Landmarks closer than
 * that are one point, where the road bit turning false a little short of it
 * is no lane to be in.
 */
function inExitLane(onPitRoad: boolean, position: ExitPosition, trackLengthMeters: number | null): boolean {
  return position.pitRoadEndToBlendEnd > pitLaneTolerancePct(trackLengthMeters) && pastPitRoadEnd(onPitRoad, position);
}

/**
 * The ETA's pit-road term (module header): the forward distance from the
 * player to `pitRoadEnd` at the pit speed limit, in seconds; 0 at or past it
 * by position. `null` with the track length or the pit speed limit unknown,
 * the two things it is measured with.
 */
function secondsToPitRoadEnd(position: ExitPosition, facts: TrafficPitExitFacts): number | null {
  const trackLengthMeters = facts.trackLengthMeters;

  if (trackLengthMeters === null || !(trackLengthMeters > 0) || !(facts.pitSpeedLimitMps > 0)) return null;

  const toPitRoadEnd = Math.max(0, position.toBlendEnd - position.pitRoadEndToBlendEnd);

  return (toPitRoadEnd * trackLengthMeters) / facts.pitSpeedLimitMps;
}

/**
 * Whether the player has reached the call point (module header):
 * {@link TRAFFIC_PIT_EXIT_CALL_LEAD_S} or less short of `pitRoadEnd` at the
 * pit speed limit, or past it already. The one definition of where the call
 * is made, read by every evaluation (to latch `callPointReached`) and between
 * them (to evaluate at once on reaching it).
 */
function reachedCallPoint(onPitRoad: boolean, position: ExitPosition, facts: TrafficPitExitFacts): boolean {
  if (pastPitRoadEnd(onPitRoad, position)) return true;

  const lead = secondsToPitRoadEnd(position, facts);

  return lead !== null && lead <= TRAFFIC_PIT_EXIT_CALL_LEAD_S;
}

/**
 * Whether `pitRoadEnd` lies after `blendEnd` in driving order, beyond the
 * slack that makes the two one point (module header): read forward from
 * `pitRoadEnd`, `blendEnd` is more than half a lap on, which is behind it,
 * and not within `slackPct` of a whole lap, which {@link exitPosition} reads
 * as the same point. The half lap is the rule the episode's own progress
 * reads the lap beyond `blendEnd` by: the nearer half is past it.
 */
function landmarksOutOfOrder(
  pitRoadEnd: PitLaneResolvedLandmark,
  blendEnd: PitLaneResolvedLandmark,
  slackPct: number,
): boolean {
  const pitRoadEndToBlendEnd = forwardPct(pitRoadEnd.pct, blendEnd.pct);

  return pitRoadEndToBlendEnd > 0.5 && pitRoadEndToBlendEnd <= 1 - slackPct;
}

/**
 * Both landmarks, when learned on the track's current geometry and in driving
 * order (module header); `null` otherwise.
 */
function usableLandmarks(
  landmarks: TrafficPitExitLandmarks | null,
  slackPct: number,
): { pitRoadEnd: PitLaneResolvedLandmark; blendEnd: PitLaneResolvedLandmark } | null {
  const pitRoadEnd = landmarks?.pitRoadEnd ?? null;
  const blendEnd = landmarks?.blendEnd ?? null;

  if (pitRoadEnd === null || blendEnd === null) return null;

  if (pitRoadEnd.source === "previous" || blendEnd.source === "previous") return null;

  if (landmarksOutOfOrder(pitRoadEnd, blendEnd, slackPct)) return null;

  return { pitRoadEnd, blendEnd };
}

/**
 * What a tick between two scheduled evaluations does (module header):
 * `"evaluate"` at once, with the call not yet made, at the call point (the
 * latch already set, or {@link reachedCallPoint}); or with the merge warning
 * not yet checked or said, in the exit lane ({@link inExitLane}). Both on
 * landmarks the evaluation can use. `"pastBlendEnd"` with the player at or
 * past `blendEnd` on usable landmarks: a crossing seen here ends the episode
 * as a scheduled evaluation's would, so a car rolled back short of the line
 * before the next one is not a fresh exit to warn about. `"wait"` otherwise,
 * with either landmark unusable among them: no evaluation could do anything
 * there, and the next scheduled one handles it. A start the departure did
 * not take is read as the player's position, as the evaluation would take it.
 */
function offScheduleStep(
  episode: TrafficPitExitState,
  playerPct: number,
  onPitRoad: boolean,
  landmarks: TrafficPitExitLandmarks | null,
  facts: TrafficPitExitFacts,
): "evaluate" | "pastBlendEnd" | "wait" {
  const slackPct = landmarkSlackPct(facts.trackLengthMeters);
  const usable = usableLandmarks(landmarks, slackPct);

  if (usable === null) return "wait";

  const position = exitPosition(episode.startPct ?? playerPct, playerPct, usable.pitRoadEnd, usable.blendEnd, slackPct);

  if (position === null) return "pastBlendEnd";

  const callDue =
    episode.spokenVerdict === null && (episode.callPointReached || reachedCallPoint(onPitRoad, position, facts));
  const mergeDue =
    !episode.mergeChecked && !episode.mergeWarned && inExitLane(onPitRoad, position, facts.trackLengthMeters);

  return callDue || mergeDue ? "evaluate" : "wait";
}

/** The player's arrival at `blendEnd` (module header), or why it cannot be known. */
function playerEta(
  curves: Readonly<TrafficArrivalState>,
  telemetry: TrafficPitExitTelemetry,
  playerPct: number,
  onPitRoad: boolean,
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
  if (!pastPitRoadEnd(onPitRoad, position)) {
    if (facts.trackLengthMeters === null || !(facts.trackLengthMeters > 0)) return { reason: "noTrackLength" };

    if (!(facts.pitSpeedLimitMps > 0)) return { reason: "noPitSpeedLimit" };

    // The track length and the limit are known, so the term is a number.
    const toPitRoadEnd = secondsToPitRoadEnd(position, facts) as number;
    let blend = 0;

    // Two landmarks at one point have no time between them.
    if (position.pitRoadEndToBlendEnd > 0) {
      const tPitRoadEnd = landmarkTime(curves, pitRoadEnd, playerClass);

      if (tPitRoadEnd === null) return { reason: "noReference" };

      const span = referenceSpan(curves, facts.classes, playerClass, pitRoadEnd.pct, blendEnd.pct, tPitRoadEnd, tBlend);

      if (span === null) return { reason: "noClassLap" };

      blend = span;
    }

    return { seconds: toPitRoadEnd + blend, phase: "pitRoad" };
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
 * again; the settled verdict stands, and so does the spoken one. An
 * evaluation off the schedule, between two scheduled ones, is no part of the
 * row, so it leaves it as it was.
 */
function noVerdict(episode: TrafficPitExitState, kind: EvaluationKind): void {
  if (kind !== "scheduled") return;

  episode.flipVerdict = null;
  episode.flipEvaluations = 0;
}

/**
 * Which evaluation this is (module header): one of the once-a-second
 * schedule, or one run off it, between two of them, at the call point or on
 * first reaching the exit lane, which settles a first verdict, speaks the
 * settled one and checks the merge, but neither advances nor breaks a flip's
 * row.
 */
type EvaluationKind = "scheduled" | "offSchedule";

/** One evaluation: the landmarks, the ETA, then the verdict and whether to speak it (module header). */
function evaluate(
  episode: TrafficPitExitState,
  curves: Readonly<TrafficArrivalState>,
  telemetry: TrafficPitExitTelemetry,
  playerPct: number,
  onPitRoad: boolean,
  landmarks: TrafficPitExitLandmarks | null,
  kind: EvaluationKind,
  facts: TrafficPitExitFacts,
  windows: TrafficPitExitWindows,
  emit: EmitFn<(typeof TRAFFIC_PIT_EXIT_EVENTS)[number]>,
  logger: ILogger,
): void {
  const pitRoadEnd = landmarks?.pitRoadEnd ?? null;
  const blendEnd = landmarks?.blendEnd ?? null;

  if (pitRoadEnd === null || blendEnd === null) {
    noVerdict(episode, kind);

    if (!episode.landmarksMissingLogged) {
      episode.landmarksMissingLogged = true;
      logger.debug(
        `silent, landmarks not learned (pitRoadEnd ${pitRoadEnd ? "learned" : "missing"}, blendEnd ${blendEnd ? "learned" : "missing"})`,
      );
    }

    return;
  }

  // A landmark kept from before a track rebuild was learned on the old
  // geometry: neither the slack nor the ETA holds on it (module header).
  if (pitRoadEnd.source === "previous" || blendEnd.source === "previous") {
    noVerdict(episode, kind);

    if (!episode.landmarksRelearningLogged) {
      episode.landmarksRelearningLogged = true;
      logger.debug(
        `silent, landmarks relearning after a track rebuild (pitRoadEnd ${pitRoadEnd.source}, blendEnd ${blendEnd.source})`,
      );
    }

    return;
  }

  const slackPct = landmarkSlackPct(facts.trackLengthMeters);

  // A pair out of driving order was mislearned: read as it stands, every
  // position short of the blend is past `pitRoadEnd` (module header).
  if (landmarksOutOfOrder(pitRoadEnd, blendEnd, slackPct)) {
    noVerdict(episode, kind);

    if (!episode.landmarksOutOfOrderLogged) {
      episode.landmarksOutOfOrderLogged = true;
      logger.debug(
        `silent, landmarks out of driving order (pitRoadEnd ${pitRoadEnd.pct.toFixed(4)} is past blendEnd ${blendEnd.pct.toFixed(4)})`,
      );
    }

    return;
  }

  // The departure tick sent no position, so the start is taken here, where
  // `blendEnd` is known (module header): a position in the half lap after it
  // is the player already past it, never a start a lap short.
  if (episode.startPct === null) {
    if (forwardPct(playerPct, blendEnd.pct) > 0.5) {
      end(episode, "past blendEnd, with no departure position", logger);

      return;
    }

    episode.startPct = playerPct;
  }

  const position = exitPosition(episode.startPct, playerPct, pitRoadEnd, blendEnd, slackPct);

  if (position === null) {
    end(episode, "past blendEnd", logger);

    return;
  }

  // At the call point (module header), latched, so a car rolled back behind
  // it or a position wobbling across it neither silences the call nor speaks
  // twice. A fact the tick read, so it is kept even when no verdict follows.
  if (reachedCallPoint(onPitRoad, position, facts)) episode.callPointReached = true;

  // In the exit lane, where the merge warning is checked: read at each
  // evaluation, not latched, so a car rolled back onto pit road is not in it,
  // and never on a track without one (module header).
  const exitLane = inExitLane(onPitRoad, position, facts.trackLengthMeters);

  const playerClass = resolveCarClassId(telemetry, facts.classes, facts.playerCarIdx);
  const eta = playerEta(curves, telemetry, playerPct, onPitRoad, playerClass, facts, pitRoadEnd, blendEnd, position);

  if ("reason" in eta) {
    noVerdict(episode, kind);

    if (!episode.noEtaLogged) {
      episode.noEtaLogged = true;
      logger.debug(`silent, no ETA to blendEnd (${eta.reason})`);
    }

    return;
  }

  const before = windows.getBeforeSeconds();
  const after = windows.getAfterSeconds();
  // The merge threshold, read live while the warning is still to be said.
  const mergeWarnSeconds = exitLane && !episode.mergeWarned ? windows.getMergeWarnSeconds() : null;
  // Every crossing within the threshold is tested too (module header).
  const crossingsUpTo = mergeWarnSeconds === null ? after : Math.max(after, mergeWarnSeconds);
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
    noVerdict(episode, kind);

    if (!episode.arraysMissingLogged) {
      episode.arraysMissingLogged = true;
      logger.debug("silent, the per-car arrays are missing");
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
      crossingsUpTo,
      resolveClassLapTime(curves, facts.classes, arrival.classId),
    )) {
      if (nearest === null || Math.abs(relative) < Math.abs(nearest.relative)) nearest = { car: arrival, relative };

      if (relative >= -before && relative <= after) inWindow = true;
    }
  }

  const verdict: "clear" | "traffic" = inWindow || untimed.length > 0 ? "traffic" : "clear";
  const seconds = nearest === null ? null : Math.round(nearest.relative * 10) / 10;
  const settled = episode.settledVerdict;
  const scheduled = kind === "scheduled";
  let nextSettled = verdict;
  // An evaluation off the schedule, between two scheduled ones, keeps the
  // flip's row as it was (module header); a scheduled one rewrites it below.
  let flipVerdict: "clear" | "traffic" | null = scheduled ? null : episode.flipVerdict;
  let flipEvaluations = scheduled ? 0 : episode.flipEvaluations;

  // A flip of the settled verdict settles only once it has held (module
  // header); the first verdict never waits. Nothing is committed before the
  // work that can throw, the debug lines and the emit below (the package's
  // step rule): a throw leaves `lastEvalAt` where it was, so the next tick
  // evaluates again at once, and a count already committed would confirm the
  // flip on that tick, a tick rather than an interval later.
  if (settled !== null && verdict !== settled && !scheduled) {
    // Off the schedule, a tick or two after a scheduled evaluation: counting
    // it would confirm a flip that has held for a few milliseconds.
    logger.debug(`${verdict} off the schedule between evaluations, not counted, ${settled} still stands`);
    nextSettled = settled;
  } else if (settled !== null && verdict !== settled) {
    const evaluations = episode.flipVerdict === verdict ? episode.flipEvaluations + 1 : 1;

    if (evaluations < TRAFFIC_PIT_EXIT_FLIP_CONFIRM_EVALUATIONS) {
      logger.debug(
        `${verdict} at ${evaluations} of ${TRAFFIC_PIT_EXIT_FLIP_CONFIRM_EVALUATIONS} evaluations, ${settled} still stands`,
      );
      nextSettled = settled;
      flipVerdict = verdict;
      flipEvaluations = evaluations;
    }
  }

  // The seconds of the latest evaluation that reached the settled verdict:
  // this one's, unless it only began a flip.
  const nextSeconds = nextSettled === verdict ? seconds : episode.settledSeconds;
  const details =
    `eta ${eta.seconds.toFixed(2)} s on ${eta.phase}, window -${before}/+${after} s; ` +
    `${nearest === null ? "no timed car" : `nearest car ${nearest.car.carIdx} at ${nearest.relative.toFixed(2)} s via ${nearest.car.source}`}; ` +
    `untimed: ${untimed.length === 0 ? "none" : untimed.map((car) => `car ${car.carIdx} (${car.reason})`).join(", ")}` +
    `${stationary.length === 0 ? "" : `; standing still: ${stationary.map((carIdx) => `car ${carIdx}`).join(", ")}`}`;

  if (nextSettled !== settled && !episode.callPointReached) {
    logger.debug(
      `${nextSettled} settled short of the call point, not spoken yet (${settled === null ? "first verdict" : "flipped"}; ${details})`,
    );
  }

  // Spoken only from the call point on (module header): there whatever has
  // settled by then, and after it each settled flip, until the merge warning
  // has been said. After it nothing of the verdict is said again that exit.
  const speakCall = episode.callPointReached && !episode.mergeWarned && nextSettled !== episode.spokenVerdict;

  if (episode.mergeWarned && nextSettled !== settled) {
    logger.debug(`${nextSettled} settled after the merge warning, not spoken (${details})`);
  }

  // The merge warning (module header): the nearest crossing of a timed car
  // within the threshold, either side. An untimed car is never one.
  const mergeCar =
    mergeWarnSeconds !== null && nearest !== null && Math.abs(nearest.relative) <= mergeWarnSeconds ? nearest : null;

  // Off the schedule, a check with an untimed car is repeated on the next tick
  // (below), so only a scheduled one says so, once a second.
  if (mergeCar === null && mergeWarnSeconds !== null && (scheduled || untimed.length === 0)) {
    logger.debug(`no merge warning within ${mergeWarnSeconds} s (${details})`);
  }

  // Both are emitted and logged before either latch is written: a throw in
  // any of them drops every event of the step (the tick's `steps.live`
  // truncates them), so both are retried on the next tick rather than lost.
  if (speakCall) {
    emit({
      event: "traffic.pitExit",
      data: nextSeconds === null ? { verdict: nextSettled } : { verdict: nextSettled, seconds: nextSeconds },
    });
    logger.debug(`emit ${nextSettled} (${episode.spokenVerdict === null ? "first call" : "flipped"}; ${details})`);
  }

  if (mergeCar !== null) {
    emit({ event: "traffic.pitExitMerge", data: { seconds: Math.round(mergeCar.relative * 10) / 10 } });
    logger.debug(
      `emit merge warning (car ${mergeCar.car.carIdx} at ${mergeCar.relative.toFixed(2)} s, within ${mergeWarnSeconds} s; ${details})`,
    );
  }

  if (speakCall) episode.spokenVerdict = nextSettled;

  if (mergeCar !== null) episode.mergeWarned = true;

  // Checked only on a picture with every car timed, or an empty track (module
  // header): with a car untimed, each tick off the schedule tries again until
  // the warning is said or a picture is whole. A warning said stays said.
  if (exitLane && untimed.length === 0) episode.mergeChecked = true;

  episode.settledVerdict = nextSettled;
  episode.settledSeconds = nextSeconds;
  episode.flipVerdict = flipVerdict;
  episode.flipEvaluations = flipEvaluations;
}
