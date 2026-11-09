/**
 * Learned pit-lane landmarks (issue #1112): iRacing's half of the learner —
 * the track identity of the session, the per-car edge detector, and the
 * logging around track-data's learner.
 *
 * iRacing reports which state each car is in but never where those states
 * change. This diff watches every car but the pace car and turns each edge it
 * drives into a {@link PitLaneLandmarkSample}, which it hands to
 * `@iracedeck/track-data`'s sim-neutral learner (`learnPitLaneLandmarks`,
 * folding with `foldSample` — the same fold the landmark store,
 * `@iracedeck/track-store`, runs on what it receives) and publishes as
 * `pitLane.landmarkLearned` when accepted. The four edges, in driving order:
 *
 * - `approachStart` — `CarIdxTrackSurface` `OnTrack → AproachingPits`, on the
 *   way in only: not while the car is coming from pit road, and not within
 *   {@link PIT_LANE_EDGE_SETTLE_S} of its rejoining the track.
 * - `pitRoadStart` — `CarIdxOnPitRoad` false → true, from `OnTrack` or
 *   `AproachingPits` into `AproachingPits`.
 * - `pitRoadEnd` — `CarIdxOnPitRoad` true → false, out of `AproachingPits`
 *   into `AproachingPits` or `OnTrack`. It arms the car's "came from pit
 *   road" flag, whether or not the sample is accepted.
 * - `blendEnd` — `AproachingPits → OnTrack` while that flag is set, including
 *   on the tick that armed it (a pit lane that ends straight onto the track
 *   makes `pitRoadEnd` and `blendEnd` on one tick); it clears the flag, as
 *   does any tick read `OnTrack` off pit road.
 *
 * **Why the pit-road edges read the surface too.** `CarIdxOnPitRoad` alone is
 * not a pit-road signal: the maintainer's local captures (not committed) read
 * it `true` for cars on the racing surface (`OnTrack`). In
 * `telemetry-watch-20261104-204104-531.jsonl` twelve cars (18–29) flip to it
 * at once around the line at 217.85 s, and car 16 about nine seconds
 * earlier. In `…20260917-191825-092.jsonl` one car's flag tracks the pace
 * car's pit-lane visit, from just after the pace car turns into the approach
 * until shortly before it reads `OnTrack` again, starting in the formation
 * lap or a caution. The flag also reads `true` for cars out of the world. A
 * car driving the pit lane reads `AproachingPits` there (the 2026-09-17
 * capture's start from pit road), so the pit side of each pit-road edge must
 * be `AproachingPits`: a car read `OnTrack` on both ticks never makes a
 * pit-road edge here. No capture shows a non-player car's real pit entry, so
 * this is the model those captures support, not a measured one. A pit lane
 * that does not read `AproachingPits` between the cones (possibly a dirt
 * oval's, see `diff/pit-lane.ts`) learns only `approachStart` there: the
 * pit-road and blend landmarks stay unlearned, and their consumers silent.
 *
 * **Acceptance** (spec decision 2): the previous tick is a road state of the
 * edge's own (never `InPitStall` or `NotInWorld`, so a tow, a reset or a
 * teleport to the stall makes none), the car moved a plausible distance since
 * that tick (no faster than {@link PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS}, judged
 * wrap-aware on the track length, so a jump is a teleport, and timed by
 * `SessionTime`, or by `SessionTick` on a tick where `SessionTime` repeated),
 * the two ticks are at most {@link PIT_LANE_MAX_EDGE_SPAN_S} apart (a car
 * not read for longer, as when its unit threw on many ticks in a row, is
 * re-seeded by the tick: its baseline moves on and its pit-visit state
 * follows what the two readings show, but no edge between them is sampled),
 * and it is not the pace car. A car's first tick only seeds it, and a tick with no position or
 * out of the world (`NotInWorld`) updates its baseline and accepts nothing.
 * With no track length, no track identity or no subsession nothing is
 * learned, though the baselines still advance. A sample the fold rejects (a
 * duplicate of one already in the window, by its key, or one too stale for a
 * full window) is not published.
 *
 * **The sample.** `pct` is the wrap-aware midpoint of the edge's two ticks.
 * `estTime` and the lap in the key come from the tick on the same side of the
 * start/finish line as that midpoint, since `CarIdxEstTime` restarts at the
 * line: the later tick when the two do not straddle it, else whichever tick's
 * side the midpoint falls on. The key is
 * `<subSessionId>:<sessionNum>:<carIdx>:<landmark>:<lap>`, and `at` is the
 * wall clock the translator hands in.
 *
 * **A unit per car** (#1559): each car runs through the `runUnit` the
 * translator hands in. The readings and samples come first; then one call to
 * `learnPitLaneLandmarks` folds and summarises all of the car's edges before
 * it replaces the learner's section (all or nothing), the events are emitted,
 * and the car's baseline is written last, so a car whose unit throws learns
 * nothing that tick and is read again on the next.
 *
 * **Diagnostics.** A pit-road flip between two in-world ticks that teaches
 * no pit-road landmark logs one debug line to the logger the translator hands
 * in (silent by default): the car, whether it is the player, the direction,
 * both ticks' surface (as `TrkLoc` names) and position, and the first
 * condition that refused it, in the order the edge is judged — `on-track
 * noise (OnTrack both ticks)` for a car read `OnTrack` on both ticks. A run
 * that learns no pit-road landmark (the Spa test) then explains itself from
 * the plugin log. The line is written after the car's baseline, and a throw
 * in it is swallowed, so it never costs the car its tick.
 *
 * No replay term: a replay tick, a saved replay included, never reaches this
 * diff (the translator's replay guard), so it learns from live, in-car
 * telemetry only (spec amendment 5).
 */
import type { SimEventName } from "@iracedeck/event-bus";
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import {
  learnPitLaneLandmarks,
  loadPitLaneLandmarkLearner,
  normalizePitLanePct,
  type PitLaneLandmarkLearner,
  type PitLaneLandmarkName,
  type PitLaneLandmarkSample,
  type PitLaneLandmarksLoader,
  type PitLaneLearnerEdge,
  type PitLaneLearnerResult,
  pitLaneMidpointPct,
  pitLaneSignedDeltaPct,
  type PitLaneTrackIdentity,
} from "@iracedeck/track-data";

import { IRACING_SIM_ID } from "../sim-id.js";
import type { PitLaneLandmarkCarTick, PitLaneLandmarksState } from "../state.js";
import { runUnitsDirectly, type UnitRunner } from "../tick-steps.js";
import { parseTrackLengthMeters } from "../track-type.js";
import type { EmitFn } from "./types.js";

/** The events {@link diffPitLaneLandmarks} emits (issue #1112): its emitter's type, and its row in `TICK_ORDER`. */
export const PIT_LANE_LANDMARKS_EVENTS = ["pitLane.landmarkLearned"] as const satisfies readonly SimEventName[];

/**
 * The fastest a car may have moved between an edge's two ticks, in metres per
 * second, for the edge to count as driven (spec decision 2). A reasoned
 * default, to be tuned on captures: 540 km/h is beyond any car iRacing runs,
 * while a tow or a reset moves a car hundreds of metres in one tick, so this
 * rejects only teleports.
 */
export const PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS = 150;

/**
 * The longest span between an edge's two ticks, in seconds, for the edge to
 * be learned. A reasoned default, to be tuned on captures: consecutive live
 * ticks are 1/60 s apart, and even a stalled `SessionTime` or a slow tick
 * leaves them far under a second, while a car whose unit threw on many ticks
 * in a row keeps its baseline from before the run. Across such a gap the
 * speed check stops meaning anything (at {@link PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS}
 * a gap of trackLength / 150 s admits any move), and the midpoint of two
 * distant ticks is not where the edge was. So a car not read for longer is
 * re-seeded by the tick (its baseline moves to it) and not learned from.
 */
export const PIT_LANE_MAX_EDGE_SPAN_S = 1;

/**
 * How long after one edge its reverse is not taken as a landmark, in seconds
 * of `SessionTime`: a pit-road edge within this of the opposite pit-road
 * edge, and an `approachStart` within this of the car rejoining the track. A
 * reasoned default, to be tuned on captures: no pit lane is driven, nor a lap
 * from pit exit back to pit entry, in three seconds, while a signal that
 * flickers across a boundary would otherwise plant the reverse landmark at the
 * wrong end of the pit lane. Flicker has not been seen in a capture; this
 * guards the median against it rather than recording that it happens.
 */
export const PIT_LANE_EDGE_SETTLE_S = 3;

/**
 * iRacing's telemetry rate: `SessionTick` advances this many times per second.
 * The plausibility check's fallback clock (`tickDelta / IRACING_SESSION_TICKS_PER_S`
 * seconds) on a tick whose `SessionTime` did not move: the capture review
 * found `SessionTime` repeating for one tick every 15–40 s while
 * `SessionTick` advances, which would otherwise lose an edge on that tick.
 */
export const IRACING_SESSION_TICKS_PER_S = 60;

/**
 * The track in session, as the landmark store keys it (issue #1112): `sim` is
 * {@link IRACING_SIM_ID}, the rest is from `WeekendInfo`: `TrackID` (a
 * non-negative integer), `TrackName` and
 * `TrackLength` (strings) are required, else `null` — session info not loaded
 * yet. A missing `TrackConfigName` reads `""`; `TrackVersion` is kept as a
 * string (a number is stringified) and is `null` when absent.
 * `trackLengthM` is `parseTrackLengthMeters`' reading of the same length.
 */
export function resolvePitLaneTrackIdentity(sessionInfo: Record<string, unknown> | null): PitLaneTrackIdentity | null {
  const weekend = sessionInfo?.WeekendInfo as Record<string, unknown> | undefined;

  if (!weekend) return null;

  const { TrackID: trackId, TrackName: trackName, TrackLength: trackLength } = weekend;

  if (typeof trackId !== "number" || !Number.isInteger(trackId) || trackId < 0) return null;

  if (typeof trackName !== "string" || trackName === "" || typeof trackLength !== "string") return null;

  const config = weekend.TrackConfigName;
  const version = weekend.TrackVersion;

  return {
    sim: IRACING_SIM_ID,
    trackId,
    trackName,
    trackConfigName: typeof config === "string" ? config : "",
    trackLength,
    trackLengthM: parseTrackLengthMeters(sessionInfo),
    trackVersion:
      typeof version === "string"
        ? version
        : typeof version === "number" && Number.isFinite(version)
          ? String(version)
          : null,
  };
}

/**
 * Load the translator's learner for the track in session (issue #1112) with
 * track-data's `loadPitLaneLandmarkLearner` — once per identity, and again on
 * its back-off while the store cannot read the track's file; a no-op
 * otherwise — and log what it did: a loader that threw or answered something
 * unreadable is a warn (the track learns afresh), the first "cannot read it
 * yet" for an identity a warn and every retry after it a debug line (the
 * track learns meanwhile and keeps it), any load a debug line.
 *
 * @param now - The wall clock, epoch ms: when an unavailable load is retried.
 */
export function seedPitLaneLandmarkLearner(
  learner: PitLaneLandmarkLearner,
  track: PitLaneTrackIdentity | null,
  loader: PitLaneLandmarksLoader | null,
  now: number,
  logger: ILogger,
): void {
  const outcome = loadPitLaneLandmarkLearner(learner, track, loader, now);

  if (outcome.kind === "kept" || track === null) return;

  if (outcome.kind === "unavailable") {
    const message = `Pit-lane landmarks: the stored landmarks for track ${track.trackId} cannot be read yet (attempt ${outcome.attempt}); learning meanwhile, retrying in ${Math.round(outcome.retryInMs / 1000)} s`;

    if (outcome.attempt === 1) logger.warn(message);
    else logger.debug(message);

    return;
  }

  if (outcome.kind === "threw") {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);

    logger.warn(`Pit-lane landmarks: loading track ${track.trackId} failed (${message}); learning afresh`);
  } else if (outcome.kind === "unreadable") {
    logger.warn(`Pit-lane landmarks: the stored section for track ${track.trackId} is unreadable; learning afresh`);
  }

  logger.debug(
    `Pit-lane landmarks: track ${track.trackId} "${track.trackName}" "${track.trackConfigName}" loaded with ${
      outcome.kind === "loaded" ? outcome.records : 0
    } landmark records`,
  );
}

function isInWorld(surface: number, pct: number): boolean {
  return surface !== TrkLoc.NotInWorld && pct >= 0;
}

function isSettling(since: number | null, sessionTime: number): boolean {
  if (since === null) return false;

  const elapsed = sessionTime - since;

  return elapsed >= 0 && elapsed < PIT_LANE_EDGE_SETTLE_S;
}

/**
 * Learn the pit-lane landmarks from every car's edges this tick, and publish
 * each accepted sample (module comment).
 *
 * @param slice - The per-car baselines, written in place.
 * @param learner - The loaded track; track-data's `learnPitLaneLandmarks` replaces (never mutates) its section on an accepted sample.
 * @param paceCarIdx - The pace car, which never teaches a landmark; `null` when unknown.
 * @param subSessionId - `WeekendInfo.SubSessionID` for the sample keys (`readSubSessionId`); `null`, unreadable, learns nothing.
 * @param now - The wall clock, epoch ms: each sample's `at`, and the folded records' `updatedAt`.
 * @param runUnit - Runs each car as a unit (#1559): the translator's step runner, so one car's throw costs that car only. Defaults to {@link runUnitsDirectly}, which catches nothing
 * @param logger - Where the edge diagnostics go, at debug (module comment); silent by default.
 */
export function diffPitLaneLandmarks(
  slice: PitLaneLandmarksState,
  learner: PitLaneLandmarkLearner,
  telemetry: TelemetryData,
  paceCarIdx: number | null,
  subSessionId: number | null,
  now: number,
  emit: EmitFn<(typeof PIT_LANE_LANDMARKS_EVENTS)[number]>,
  runUnit: UnitRunner = runUnitsDirectly,
  logger: ILogger = silentLogger,
): void {
  const surfaces = telemetry.CarIdxTrackSurface as number[] | undefined;
  const onPitRoads = telemetry.CarIdxOnPitRoad as boolean[] | undefined;
  const pcts = telemetry.CarIdxLapDistPct as number[] | undefined;

  if (!Array.isArray(surfaces) || !Array.isArray(onPitRoads) || !Array.isArray(pcts)) return;

  const estTimes = telemetry.CarIdxEstTime as number[] | undefined;
  const laps = telemetry.CarIdxLap as number[] | undefined;
  const classes = telemetry.CarIdxClass as number[] | undefined;
  const sessionTime = typeof telemetry.SessionTime === "number" ? telemetry.SessionTime : Number.NaN;
  const sessionTick = typeof telemetry.SessionTick === "number" ? telemetry.SessionTick : Number.NaN;
  const sessionNum = telemetry.SessionNum;
  const playerCarIdx = typeof telemetry.PlayerCarIdx === "number" ? telemetry.PlayerCarIdx : null;
  const track = learner.track;
  const trackLengthM = track?.trackLengthM ?? null;
  const notLearning = notLearningReason(learner, subSessionId, sessionNum, sessionTime);
  const learning = notLearning === null;
  let nowIso: string | null = null;

  // The car the unit below reads, set by the loop: one closure per tick.
  let i = 0;
  const unit = (unitEmit: EmitFn<(typeof PIT_LANE_LANDMARKS_EVENTS)[number]>): void => {
    if (i === paceCarIdx) return;

    const surface = surfaces[i] ?? TrkLoc.NotInWorld;
    const onPitRoad = onPitRoads[i] === true;
    const pct = typeof pcts[i] === "number" ? pcts[i]! : -1;
    const estTime = typeof estTimes?.[i] === "number" ? estTimes[i]! : -1;
    const lap = typeof laps?.[i] === "number" ? laps[i]! : -1;
    const prev = slice.cars[i];

    // A car's first tick only seeds it.
    if (prev === undefined) {
      slice.cars[i] = {
        surface,
        onPitRoad,
        pct,
        estTime,
        sessionTime,
        sessionTick,
        lap,
        fromPitRoad: false,
        pitRoadStartAt: null,
        pitRoadEndAt: null,
        rejoinedAt: null,
      };

      return;
    }

    let fromPitRoad = prev.fromPitRoad;
    let pitRoadStartAt = prev.pitRoadStartAt;
    let pitRoadEndAt = prev.pitRoadEndAt;
    let rejoinedAt = prev.rejoinedAt;
    let edges: PitLaneLandmarkName[] | null = null;
    // What the edge diagnostics read, set only on the rare tick they log.
    let flip: PitRoadFlip | null = null;
    let sampleRefusal: string | null = null;
    let results: PitLaneLearnerResult[] | null = null;

    // An edge needs both ticks in the world; a tick out of it only moves the baseline.
    if (isInWorld(surface, pct) && isInWorld(prev.surface, prev.pct)) {
      const pitRoadOn = !prev.onPitRoad && onPitRoad;
      const pitRoadOff = prev.onPitRoad && !onPitRoad;

      if (pitRoadOn) flip = "on";
      else if (pitRoadOff) flip = "off";

      const moved =
        learning && isDrivenEdge(prev.pct, pct, elapsedSeconds(prev, sessionTime, sessionTick), trackLengthM as number);

      if (
        moved &&
        prev.surface === TrkLoc.OnTrack &&
        surface === TrkLoc.AproachingPits &&
        !prev.fromPitRoad &&
        !isSettling(prev.rejoinedAt, sessionTime)
      ) {
        (edges ??= []).push("approachStart");
      }

      if (pitRoadOn) {
        if (
          moved &&
          (prev.surface === TrkLoc.OnTrack || prev.surface === TrkLoc.AproachingPits) &&
          surface === TrkLoc.AproachingPits &&
          !isSettling(prev.pitRoadEndAt, sessionTime)
        ) {
          (edges ??= []).push("pitRoadStart");
        }

        pitRoadStartAt = sessionTime;
      }

      if (pitRoadOff) {
        const leftThePitLane =
          prev.surface === TrkLoc.AproachingPits && (surface === TrkLoc.AproachingPits || surface === TrkLoc.OnTrack);

        if (moved && leftThePitLane && !isSettling(prev.pitRoadStartAt, sessionTime)) {
          (edges ??= []).push("pitRoadEnd");
        }

        if (leftThePitLane) fromPitRoad = true;

        pitRoadEndAt = sessionTime;
      }

      // `fromPitRoad`, not `prev.fromPitRoad`: a pit lane that ends straight
      // onto the track arms the flag and crosses the blend line on one tick.
      if (prev.surface === TrkLoc.AproachingPits && surface === TrkLoc.OnTrack && fromPitRoad) {
        if (moved) (edges ??= []).push("blendEnd");

        fromPitRoad = false;
        rejoinedAt = sessionTime;
      }
    }

    // Back on the racing surface, off pit road: the pit visit is over.
    if (fromPitRoad && surface === TrkLoc.OnTrack && !onPitRoad) {
      fromPitRoad = false;
      rejoinedAt = sessionTime;
    }

    // The samples, then track-data's learner: it folds every edge of this
    // car before it touches the section (all or nothing), so a throw here
    // leaves the learner as it was and the edges are read again next tick.
    if (edges !== null && learning) {
      const reading = readSampleSide(prev, pct, estTime, lap);
      const carClassId = classes?.[i];

      if (reading === null) sampleRefusal = "unreadable estTime";
      else if (typeof carClassId !== "number") sampleRefusal = "no class";
      else {
        const offered: PitLaneLearnerEdge[] = edges.map((landmark) => ({
          landmark,
          sample: {
            pct: reading.pct,
            estTime: reading.estTime,
            carClassId,
            key: `${subSessionId}:${sessionNum as number}:${i}:${landmark}:${reading.lap}`,
            at: now,
          } satisfies PitLaneLandmarkSample,
        }));

        results = learnPitLaneLandmarks(learner, offered, (nowIso ??= new Date(now).toISOString()));

        // Then the events, and the baseline is written last.
        for (const result of results) {
          if (!result.accepted) continue;

          unitEmit({
            event: "pitLane.landmarkLearned",
            data: {
              track: { ...(track as PitLaneTrackIdentity) },
              landmark: result.landmark,
              sample: result.sample,
              summary: result.summary,
            },
          });
        }
      }
    }

    // The previous tick as the diagnostics read it, before the baseline moves on.
    const before = flip !== null ? { ...prev } : null;

    writeBaseline(prev, surface, onPitRoad, pct, estTime, sessionTime, sessionTick, lap);
    prev.fromPitRoad = fromPitRoad;
    prev.pitRoadStartAt = pitRoadStartAt;
    prev.pitRoadEndAt = pitRoadEndAt;
    prev.rejoinedAt = rejoinedAt;

    // Diagnostics last, after everything the car's unit owes: a throw here
    // must never cost the car its tick, nor re-offer its edges.
    if (before !== null && flip !== null) {
      try {
        const reason = pitRoadEdgeRefusal(flip, before, surface, pct, sessionTime, sessionTick, {
          notLearning,
          trackLengthM,
          sampleRefusal,
          results,
        });

        if (reason !== null) {
          logger.debug(
            describePitRoadEdge({ carIdx: i, isPlayer: i === playerCarIdx, flip, before, surface, pct, reason }),
          );
        }
      } catch {
        // Diagnostics only: nothing to recover.
      }
    }
  };

  for (i = 0; i < surfaces.length; i++) runUnit(emit, unit);
}

/**
 * The seconds between the car's previous tick and this one: the `SessionTime`
 * delta when it is positive, else, when `SessionTime` stalled (or went
 * backwards) but `SessionTick` advanced, that many ticks at
 * {@link IRACING_SESSION_TICKS_PER_S}. `NaN` when neither clock moved forward,
 * which no move is plausible in.
 */
function elapsedSeconds(prev: PitLaneLandmarkCarTick, sessionTime: number, sessionTick: number): number {
  const elapsed = sessionTime - prev.sessionTime;

  if (Number.isFinite(elapsed) && elapsed > 0) return elapsed;

  const ticks = sessionTick - prev.sessionTick;

  return Number.isFinite(ticks) && ticks > 0 ? ticks / IRACING_SESSION_TICKS_PER_S : Number.NaN;
}

/**
 * Whether a car got from `fromPct` to `toPct` by driving, on two ticks close
 * enough to sample an edge between: time moved forward
 * ({@link elapsedSeconds}) by no more than {@link PIT_LANE_MAX_EDGE_SPAN_S},
 * and the shorter way round the lap is no longer than
 * {@link PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS} allows in that time.
 */
function isDrivenEdge(fromPct: number, toPct: number, elapsed: number, trackLengthM: number): boolean {
  if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > PIT_LANE_MAX_EDGE_SPAN_S) return false;

  return Math.abs(pitLaneSignedDeltaPct(fromPct, toPct)) * trackLengthM <= PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS * elapsed;
}

/**
 * The edge's position (the wrap-aware midpoint of its two ticks), with the
 * `estTime` and lap of the tick on the midpoint's side of the start/finish
 * line: the current tick when the two do not straddle the line, else the
 * tick whose side the midpoint falls on (a midpoint exactly on the line is
 * the new lap's, as `normalizePitLanePct` makes it `0`). `null` when that
 * tick's `estTime` is not a finite non-negative number.
 */
function readSampleSide(
  prev: PitLaneLandmarkCarTick,
  pct: number,
  estTime: number,
  lap: number,
): { pct: number; estTime: number; lap: number } | null {
  const delta = pitLaneSignedDeltaPct(prev.pct, pct);
  const unwrappedCurrent = prev.pct + delta;
  const straddles = unwrappedCurrent >= 1 || unwrappedCurrent < 0;
  const unwrappedMidpoint = prev.pct + delta / 2;
  const midpointOnCurrentSide = !straddles || normalizePitLanePct(unwrappedMidpoint) !== unwrappedMidpoint;
  const side = midpointOnCurrentSide ? { estTime, lap } : { estTime: prev.estTime, lap: prev.lap };

  if (!Number.isFinite(side.estTime) || side.estTime < 0) return null;

  return { pct: pitLaneMidpointPct(prev.pct, pct), estTime: side.estTime, lap: side.lap };
}

function writeBaseline(
  baseline: PitLaneLandmarkCarTick,
  surface: number,
  onPitRoad: boolean,
  pct: number,
  estTime: number,
  sessionTime: number,
  sessionTick: number,
  lap: number,
): void {
  baseline.surface = surface;
  baseline.onPitRoad = onPitRoad;
  baseline.pct = pct;
  baseline.estTime = estTime;
  baseline.sessionTime = sessionTime;
  baseline.sessionTick = sessionTick;
  baseline.lap = lap;
}

/** The direction of a pit-road flip: `on` (false → true) or `off` (true → false). */
type PitRoadFlip = "on" | "off";

/**
 * Why nothing is learned this tick from any car, in the order the learning
 * condition reads it; `null` when the tick can learn.
 */
function notLearningReason(
  learner: PitLaneLandmarkLearner,
  subSessionId: number | null,
  sessionNum: unknown,
  sessionTime: number,
): string | null {
  const trackLengthM = learner.track?.trackLengthM ?? null;

  if (learner.track === null || learner.section === null) return "no track loaded";

  if (trackLengthM === null || !Number.isFinite(trackLengthM) || trackLengthM <= 0) return "no track length";

  if (subSessionId === null) return "no subsession";

  if (typeof sessionNum !== "number") return "no session number";

  if (!Number.isFinite(sessionTime)) return "no session time";

  return null;
}

/**
 * The first condition that kept a pit-road flip between two in-world ticks
 * from teaching its landmark, in the order the edge is judged; `null` when it
 * was learned. Reads only what the unit already decided (the learning
 * condition, the sample's refusal, the learner's results), so it cannot
 * disagree with what was learned.
 */
function pitRoadEdgeRefusal(
  flip: PitRoadFlip,
  prev: PitLaneLandmarkCarTick,
  surface: number,
  pct: number,
  sessionTime: number,
  sessionTick: number,
  outcome: {
    notLearning: string | null;
    trackLengthM: number | null;
    sampleRefusal: string | null;
    results: PitLaneLearnerResult[] | null;
  },
): string | null {
  if (prev.surface === TrkLoc.OnTrack && surface === TrkLoc.OnTrack) return "on-track noise (OnTrack both ticks)";

  if (flip === "on") {
    if (prev.surface !== TrkLoc.OnTrack && prev.surface !== TrkLoc.AproachingPits) {
      return `came from ${trkLocName(prev.surface)}, not OnTrack or AproachingPits`;
    }

    if (surface !== TrkLoc.AproachingPits) return `went to ${trkLocName(surface)}, not AproachingPits`;
  } else {
    if (prev.surface !== TrkLoc.AproachingPits) return `came from ${trkLocName(prev.surface)}, not AproachingPits`;

    if (surface !== TrkLoc.AproachingPits && surface !== TrkLoc.OnTrack) {
      return `went to ${trkLocName(surface)}, not AproachingPits or OnTrack`;
    }
  }

  if (outcome.notLearning !== null) return `not learning: ${outcome.notLearning}`;

  const elapsed = elapsedSeconds(prev, sessionTime, sessionTick);

  if (!Number.isFinite(elapsed)) return "neither SessionTime nor SessionTick moved forward";

  if (elapsed > PIT_LANE_MAX_EDGE_SPAN_S) {
    return `ticks ${elapsed.toFixed(2)} s apart, over ${PIT_LANE_MAX_EDGE_SPAN_S} s`;
  }

  const trackLengthM = outcome.trackLengthM as number;

  if (!isDrivenEdge(prev.pct, pct, elapsed, trackLengthM)) {
    const metres = Math.abs(pitLaneSignedDeltaPct(prev.pct, pct)) * trackLengthM;

    return `moved ${metres.toFixed(0)} m in ${elapsed.toFixed(3)} s, faster than ${PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS} m/s`;
  }

  if (flip === "on" && isSettling(prev.pitRoadEndAt, sessionTime)) {
    return `within ${PIT_LANE_EDGE_SETTLE_S} s of the car's last pit-road off edge`;
  }

  if (flip === "off" && isSettling(prev.pitRoadStartAt, sessionTime)) {
    return `within ${PIT_LANE_EDGE_SETTLE_S} s of the car's last pit-road on edge`;
  }

  if (outcome.sampleRefusal !== null) return outcome.sampleRefusal;

  const landmark: PitLaneLandmarkName = flip === "on" ? "pitRoadStart" : "pitRoadEnd";
  const result = outcome.results?.find((r) => r.landmark === landmark);

  if (result === undefined) return "not offered to the learner";

  return result.accepted ? null : `the learner rejected it (${result.reason})`;
}

/** The debug line for a pit-road flip that taught nothing (module comment). */
function describePitRoadEdge(edge: {
  carIdx: number;
  isPlayer: boolean;
  flip: PitRoadFlip;
  before: PitLaneLandmarkCarTick;
  surface: number;
  pct: number;
  reason: string;
}): string {
  const { carIdx, isPlayer, flip, before, surface, pct, reason } = edge;
  const who = `car ${carIdx}${isPlayer ? " (player)" : ""}`;

  return `Pit-lane landmarks: ${who} pit road ${flip} ${trkLocName(before.surface)} -> ${trkLocName(surface)} at pct ${before.pct.toFixed(5)} -> ${pct.toFixed(5)} taught no landmark: ${reason}`;
}

/** A `TrkLoc`'s name, or the raw number when it is none. */
function trkLocName(surface: number): string {
  return (TrkLoc as unknown as Record<number, string | undefined>)[surface] ?? String(surface);
}
