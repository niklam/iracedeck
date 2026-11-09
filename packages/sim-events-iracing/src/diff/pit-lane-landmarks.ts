/**
 * Learned pit-lane landmarks (issue #1112): the translator's half of the
 * learner.
 *
 * iRacing reports which state each car is in but never where those states
 * change. This diff watches every car but the pace car and turns each edge it
 * drives into a {@link PitLaneLandmarkSample}, which it folds into the
 * learner's section with track-data's `foldSample` — the same fold the
 * landmark store (`@iracedeck/track-store`) runs on what it receives — and
 * publishes as `pitLane.landmarkLearned`. The four edges, in driving order:
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
 * wrap-aware on the track length, so a jump is a teleport), and it is not the
 * pace car. A car's first tick only seeds it, and a tick with no position or
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
 * translator hands in. The work that can throw (the readings, the samples,
 * the folds and summaries) runs first; then the learner takes the folded
 * records, the events are emitted, and the car's baseline is written last, so
 * a car whose unit throws learns nothing that tick and is read again on the
 * next.
 *
 * No replay term: a replay tick, a saved replay included, never reaches this
 * diff (the translator's replay guard), so it learns from live, in-car
 * telemetry only (spec amendment 5).
 */
import type { SimEventName } from "@iracedeck/event-bus";
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import {
  applyTrackLength,
  foldSample,
  normalizePitLanePct,
  normalizePitLaneSection,
  PIT_LANE_LANDMARK_NAMES,
  type PitLaneLandmarkName,
  type PitLaneLandmarkRecord,
  type PitLaneLandmarkSample,
  type PitLaneLandmarkSummary,
  pitLaneMidpointPct,
  type PitLaneResolvedLandmark,
  type PitLaneSection,
  pitLaneSignedDeltaPct,
  type PitLaneTrackIdentity,
  resolvePublishedLandmark,
  summarizeLandmark,
} from "@iracedeck/track-data";

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
 * Where the plugin's landmark store hands the translator a track's learned
 * section (issue #1112): `null` when it has none. Called at most once per
 * track per session (`loadPitLaneLandmarkLearner`), from a live tick.
 */
export type PitLaneLandmarksLoader = (track: PitLaneTrackIdentity) => PitLaneSection | null;

/**
 * The learned landmarks of the track in session (issue #1112). Held on the
 * translator instance, not in `TranslatorState`: it must survive the replay
 * wipe, which every garage visit makes. Emptied at a session change and a
 * disconnect, so the next live tick loads it again from the store: the
 * store's current section, including its unwritten samples. Another plugin
 * process's samples reach it only through the store's own merge when it
 * writes the file.
 */
export type PitLaneLandmarkLearner = {
  /** {@link pitLaneTrackKey} of {@link track} once loaded; `null` = not loaded. */
  key: string | null;
  /** The identity the section was loaded for, carried on every event; `null` = not loaded. */
  track: PitLaneTrackIdentity | null;
  /** The track's section, as loaded and then folded into; `null` = not loaded. */
  section: PitLaneSection | null;
};

/** A learner with nothing loaded. */
export function createPitLaneLandmarkLearner(): PitLaneLandmarkLearner {
  return { key: null, track: null, section: null };
}

/**
 * The track in session, as the landmark store keys it (issue #1112), from
 * `WeekendInfo`: `TrackID` (a non-negative integer), `TrackName` and
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

/** Every field of the identity in one string: a learner is loaded again when it changes. */
export function pitLaneTrackKey(track: PitLaneTrackIdentity): string {
  return JSON.stringify([
    track.trackId,
    track.trackName,
    track.trackConfigName,
    track.trackLength,
    track.trackLengthM,
    track.trackVersion,
  ]);
}

/**
 * Load the learner for `track`, once per identity (issue #1112): a no-op
 * while the learner already holds this identity, or with no identity yet.
 * Otherwise the loader's section, read leniently (`normalizePitLaneSection`,
 * so a malformed or newer one counts as none), is brought in line with the
 * session's track length (`applyTrackLength`: a changed length is a rebuild,
 * whose published values become `previous`). A loader that throws, returns
 * `null` or returns something unreadable, or no loader at all, leaves an empty
 * section for this track, and is not asked again until the identity changes
 * or the learner is emptied.
 */
export function loadPitLaneLandmarkLearner(
  learner: PitLaneLandmarkLearner,
  track: PitLaneTrackIdentity | null,
  loader: PitLaneLandmarksLoader | null,
  logger: ILogger,
): void {
  if (track === null) return;

  const key = pitLaneTrackKey(track);

  if (key === learner.key) return;

  let section: PitLaneSection;

  try {
    const loaded = loader === null ? null : loader({ ...track });
    const readable = loaded === null ? null : normalizePitLaneSection(loaded);

    if (loaded !== null && readable === null) {
      logger.warn(`Pit-lane landmarks: the stored section for track ${track.trackId} is unreadable; learning afresh`);
    }

    section = applyTrackLength(readable ?? undefined, track.trackLength, track.trackLengthM);
  } catch (error) {
    logger.warn(
      `Pit-lane landmarks: loading track ${track.trackId} failed (${error instanceof Error ? error.message : String(error)}); learning afresh`,
    );
    section = applyTrackLength(undefined, track.trackLength, track.trackLengthM);
  }

  learner.key = key;
  learner.track = track;
  learner.section = section;
  logger.debug(
    `Pit-lane landmarks: track ${track.trackId} "${track.trackName}" "${track.trackConfigName}" loaded with ${
      PIT_LANE_LANDMARK_NAMES.filter((name) => section.landmarks[name] !== undefined).length
    } landmark records`,
  );
}

/**
 * What a consumer may use for each landmark of the loaded track
 * (`resolvePublishedLandmark`), or `null` when nothing is loaded.
 */
export function resolvePitLaneLandmarks(
  learner: PitLaneLandmarkLearner,
): Record<PitLaneLandmarkName, PitLaneResolvedLandmark | null> | null {
  const { track, section } = learner;

  if (track === null || section === null) return null;

  return {
    approachStart: resolvePublishedLandmark(section.landmarks.approachStart, track.trackLengthM),
    pitRoadStart: resolvePublishedLandmark(section.landmarks.pitRoadStart, track.trackLengthM),
    pitRoadEnd: resolvePublishedLandmark(section.landmarks.pitRoadEnd, track.trackLengthM),
    blendEnd: resolvePublishedLandmark(section.landmarks.blendEnd, track.trackLengthM),
  };
}

/** One landmark a car's tick accepted, folded and summarised, waiting for the commit. */
type Accepted = {
  landmark: PitLaneLandmarkName;
  sample: PitLaneLandmarkSample;
  record: PitLaneLandmarkRecord;
  summary: PitLaneLandmarkSummary;
};

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
 * @param learner - The loaded track's section; replaced (never mutated) by the folded one on an accepted sample.
 * @param paceCarIdx - The pace car, which never teaches a landmark; `null` when unknown.
 * @param subSessionId - `WeekendInfo.SubSessionID` for the sample keys (`readSubSessionId`); `null`, unreadable, learns nothing.
 * @param now - The wall clock, epoch ms: each sample's `at`, and the folded records' `updatedAt`.
 * @param runUnit - Runs each car as a unit (#1559): the translator's step runner, so one car's throw costs that car only. Defaults to {@link runUnitsDirectly}, which catches nothing
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
): void {
  const surfaces = telemetry.CarIdxTrackSurface as number[] | undefined;
  const onPitRoads = telemetry.CarIdxOnPitRoad as boolean[] | undefined;
  const pcts = telemetry.CarIdxLapDistPct as number[] | undefined;

  if (!Array.isArray(surfaces) || !Array.isArray(onPitRoads) || !Array.isArray(pcts)) return;

  const estTimes = telemetry.CarIdxEstTime as number[] | undefined;
  const laps = telemetry.CarIdxLap as number[] | undefined;
  const classes = telemetry.CarIdxClass as number[] | undefined;
  const sessionTime = typeof telemetry.SessionTime === "number" ? telemetry.SessionTime : Number.NaN;
  const sessionNum = telemetry.SessionNum;
  const track = learner.track;
  const trackLengthM = track?.trackLengthM ?? null;
  const learning =
    track !== null &&
    learner.section !== null &&
    trackLengthM !== null &&
    Number.isFinite(trackLengthM) &&
    trackLengthM > 0 &&
    subSessionId !== null &&
    typeof sessionNum === "number" &&
    Number.isFinite(sessionTime);
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

    // An edge needs both ticks in the world; a tick out of it only moves the baseline.
    if (isInWorld(surface, pct) && isInWorld(prev.surface, prev.pct)) {
      const pitRoadOn = !prev.onPitRoad && onPitRoad;
      const pitRoadOff = prev.onPitRoad && !onPitRoad;
      const moved = learning && isPlausibleMove(prev.pct, prev.sessionTime, pct, sessionTime, trackLengthM as number);

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

    // The work that can throw: the samples, the folds, the summaries.
    let accepted: Accepted[] | null = null;

    if (edges !== null && learning) {
      const section = learner.section as PitLaneSection;
      const reading = readSampleSide(prev, pct, estTime, lap);
      const carClassId = classes?.[i];

      for (const landmark of edges) {
        if (reading === null || typeof carClassId !== "number") break;

        const sample: PitLaneLandmarkSample = {
          pct: reading.pct,
          estTime: reading.estTime,
          carClassId,
          key: `${subSessionId}:${sessionNum as number}:${i}:${landmark}:${reading.lap}`,
          at: now,
        };
        const result = foldSample(
          section.landmarks[landmark],
          sample,
          (nowIso ??= new Date(now).toISOString()),
          trackLengthM,
        );

        if (!result.accepted) continue;

        (accepted ??= []).push({
          landmark,
          sample,
          record: result.record,
          summary: summarizeLandmark(result.record, trackLengthM),
        });
      }
    }

    // The commit: nothing below throws. The learner takes the folded records,
    // the events go out, and the baseline is written last.
    if (accepted !== null) {
      const section = learner.section as PitLaneSection;
      const landmarks = { ...section.landmarks };

      for (const entry of accepted) landmarks[entry.landmark] = entry.record;

      learner.section = { ...section, landmarks };

      for (const entry of accepted) {
        unitEmit({
          event: "pitLane.landmarkLearned",
          data: {
            track: { ...(track as PitLaneTrackIdentity) },
            landmark: entry.landmark,
            sample: entry.sample,
            summary: entry.summary,
          },
        });
      }
    }

    writeBaseline(prev, surface, onPitRoad, pct, estTime, sessionTime, lap);
    prev.fromPitRoad = fromPitRoad;
    prev.pitRoadStartAt = pitRoadStartAt;
    prev.pitRoadEndAt = pitRoadEndAt;
    prev.rejoinedAt = rejoinedAt;
  };

  for (i = 0; i < surfaces.length; i++) runUnit(emit, unit);
}

/**
 * Whether a car got from `fromPct` to `toPct` by driving: time moved forward,
 * and the shorter way round the lap is no longer than
 * {@link PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS} allows in that time.
 */
function isPlausibleMove(
  fromPct: number,
  fromTime: number,
  toPct: number,
  toTime: number,
  trackLengthM: number,
): boolean {
  const elapsed = toTime - fromTime;

  if (!Number.isFinite(elapsed) || elapsed <= 0) return false;

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
  lap: number,
): void {
  baseline.surface = surface;
  baseline.onPitRoad = onPitRoad;
  baseline.pct = pct;
  baseline.estTime = estTime;
  baseline.sessionTime = sessionTime;
  baseline.lap = lap;
}
