/**
 * The pit-lane landmark learner (issue #1112): the sim-neutral half of
 * learning, beside the model it folds with.
 *
 * A sim's translator owns the half that reads telemetry — which edge a car
 * drove, the sample it makes, and the track identity of the session. This
 * module owns the rest: the section of the track in session, loaded once per
 * identity from whatever the plugin's store hands in, the fold of each
 * accepted sample into it, and the per-landmark view a consumer reads. So a
 * second sim's translator learns with exactly the same rules, and none of it
 * is reimplemented per sim.
 *
 * Like the model, it does no IO and reads no clock: the loader is a callback,
 * every timestamp an argument, and an outcome is returned for the caller to
 * log rather than a logger taken.
 */
import {
  applyTrackLength,
  foldSample,
  normalizePitLaneSection,
  PIT_LANE_LANDMARK_NAMES,
  type PitLaneLandmarkName,
  type PitLaneLandmarkSample,
  type PitLaneLandmarkSummary,
  type PitLaneResolvedLandmark,
  type PitLaneSection,
  type PitLaneTrackIdentity,
  resolvePublishedLandmark,
  summarizeLandmark,
} from "./pit-lane-landmarks.js";

/**
 * Where the plugin's landmark store hands the learner a track's section:
 * `null` when it has none. Called at most once per track identity per load
 * ({@link loadPitLaneLandmarkLearner}).
 */
export type PitLaneLandmarksLoader = (track: PitLaneTrackIdentity) => PitLaneSection | null;

/**
 * The learned landmarks of the track in session. A translator holds one for
 * its session and empties it ({@link createPitLaneLandmarkLearner}) when the
 * session changes or the sim disconnects, so the next load reads the store's
 * current section again.
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
 * Every field of the identity in one opaque string: a learner is loaded again
 * when it changes. Compare it, never parse it.
 */
export function pitLaneTrackKey(track: PitLaneTrackIdentity): string {
  return JSON.stringify([
    track.sim,
    track.trackId,
    track.trackName,
    track.trackConfigName,
    track.trackLength,
    track.trackLengthM,
    track.trackVersion,
  ]);
}

/**
 * What {@link loadPitLaneLandmarkLearner} did, for the caller to log.
 *
 * - `kept` — nothing: no identity yet, or the learner already holds this one.
 * - `loaded` — the loader's section, read and brought to the track length;
 *   `records` counts the known landmarks it holds.
 * - `none` — no loader, or it had nothing: an empty section.
 * - `unreadable` — the loader answered something that is not a section this
 *   build reads (malformed, or a newer version): an empty section.
 * - `threw` — the loader threw: an empty section.
 *
 * Every outcome but `kept` loads the learner, so the loader is not asked
 * again until the identity changes or the learner is emptied.
 */
export type PitLaneLearnerLoad =
  | { kind: "kept" }
  | { kind: "loaded"; records: number }
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "threw"; error: unknown };

/**
 * Load the learner for `track`, once per identity: `kept` while the learner
 * already holds this identity, or with no identity yet. Otherwise the loader
 * gets a copy of the identity, and its section, read leniently
 * ({@link normalizePitLaneSection}, so a malformed or newer one counts as
 * none), is brought in line with the session's track length
 * ({@link applyTrackLength}: a changed length is a rebuild, whose published
 * values become `previous`). Never throws for the loader's sake.
 */
export function loadPitLaneLandmarkLearner(
  learner: PitLaneLandmarkLearner,
  track: PitLaneTrackIdentity | null,
  loader: PitLaneLandmarksLoader | null,
): PitLaneLearnerLoad {
  if (track === null) return { kind: "kept" };

  const key = pitLaneTrackKey(track);

  if (key === learner.key) return { kind: "kept" };

  let readable: PitLaneSection | null = null;
  let failure: PitLaneLearnerLoad | null = null;

  try {
    const loaded = loader === null ? null : loader({ ...track });

    if (loaded === null) failure = { kind: "none" };
    else {
      readable = normalizePitLaneSection(loaded);

      if (readable === null) failure = { kind: "unreadable" };
    }
  } catch (error: unknown) {
    readable = null;
    failure = { kind: "threw", error };
  }

  const section = applyTrackLength(readable ?? undefined, track.trackLength, track.trackLengthM);

  learner.key = key;
  learner.track = track;
  learner.section = section;

  return (
    failure ?? {
      kind: "loaded",
      records: PIT_LANE_LANDMARK_NAMES.filter((name) => section.landmarks[name] !== undefined).length,
    }
  );
}

/**
 * What a consumer may use for each landmark of the loaded track
 * ({@link resolvePublishedLandmark}: the current values when published, else
 * the pre-rebuild ones, else `null`), or `null` when nothing is loaded.
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

/** One sample a translator offers the learner: the landmark whose edge a car drove, and the sample it made. */
export type PitLaneLearnerEdge = {
  landmark: PitLaneLandmarkName;
  sample: PitLaneLandmarkSample;
};

/**
 * What became of one offered edge. An accepted one carries the landmark's
 * summary after the fold, which is what the translator publishes; a rejected
 * one says why (`unloaded`: the learner holds no track).
 */
export type PitLaneLearnerResult = PitLaneLearnerEdge &
  (
    | { accepted: true; summary: PitLaneLandmarkSummary }
    | { accepted: false; reason: "duplicate" | "stale" | "invalid" | "unloaded" }
  );

/**
 * Fold the edges one car drove on one tick into the learner, and say what
 * became of each, in the order given. Each is folded with {@link foldSample}
 * into the record the edges before it left, and summarised under the loaded
 * track's length.
 *
 * All or nothing: every fold and summary runs before the learner is touched,
 * and the learner's section is then replaced (never mutated) in one
 * assignment, so a throw part-way leaves the learner as it was and the same
 * edges can be offered again on the next tick. That is what lets a
 * translator run each car as a unit (#1559): it calls this, publishes the
 * accepted results, and writes the car's baseline last.
 *
 * @param now ISO timestamp, the folded records' `updatedAt`.
 */
export function learnPitLaneLandmarks(
  learner: PitLaneLandmarkLearner,
  edges: readonly PitLaneLearnerEdge[],
  now: string,
): PitLaneLearnerResult[] {
  const { track, section } = learner;

  if (track === null || section === null) {
    return edges.map(({ landmark, sample }) => ({ landmark, sample, accepted: false, reason: "unloaded" }));
  }

  const landmarks = { ...section.landmarks };
  const results: PitLaneLearnerResult[] = [];
  let changed = false;

  for (const { landmark, sample } of edges) {
    const result = foldSample(landmarks[landmark], sample, now, track.trackLengthM);

    if (!result.accepted) {
      results.push({ landmark, sample, accepted: false, reason: result.reason });
      continue;
    }

    landmarks[landmark] = result.record;
    changed = true;
    results.push({ landmark, sample, accepted: true, summary: summarizeLandmark(result.record, track.trackLengthM) });
  }

  if (changed) learner.section = { ...section, landmarks };

  return results;
}
