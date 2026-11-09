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
  type PitLaneLandmarks,
  type PitLaneLandmarkSample,
  type PitLaneLandmarkSummary,
  type PitLaneResolvedLandmark,
  type PitLaneSection,
  type PitLaneTrackIdentity,
  resolvePublishedLandmark,
  summarizeLandmark,
} from "./pit-lane-landmarks.js";

/**
 * What a loader answers when the track's stored data exists but cannot be
 * read right now (a lock, a permission, a scanner holding the file): not
 * "none", which is final for the identity, but "ask again later". The learner
 * learns on the section it has meanwhile and asks again after a back-off
 * ({@link PIT_LANE_LOAD_RETRY_MS}).
 */
export const PIT_LANE_SECTION_UNAVAILABLE = "unavailable";

/**
 * Where the plugin's landmark store hands the learner a track's section:
 * `null` when it has none, {@link PIT_LANE_SECTION_UNAVAILABLE} when it cannot
 * read it yet. Called once per track identity per load
 * ({@link loadPitLaneLandmarkLearner}), and again after a back-off for as long
 * as it answers {@link PIT_LANE_SECTION_UNAVAILABLE}.
 */
export type PitLaneLandmarksLoader = (
  track: PitLaneTrackIdentity,
) => PitLaneSection | null | typeof PIT_LANE_SECTION_UNAVAILABLE;

/**
 * The first wait before a loader that answered
 * {@link PIT_LANE_SECTION_UNAVAILABLE} is asked again, in milliseconds. Each
 * further unavailable answer in a row doubles it, up to
 * {@link PIT_LANE_LOAD_RETRY_MAX_MS}. A reasoned default: a scanner or a
 * backup holds a file for a moment, so the first retry comes soon, while a
 * file that stays locked is asked about at most once a minute.
 */
export const PIT_LANE_LOAD_RETRY_MS = 5_000;

/** The longest wait between two asks of a loader that keeps answering {@link PIT_LANE_SECTION_UNAVAILABLE}. */
export const PIT_LANE_LOAD_RETRY_MAX_MS = 60_000;

/** A pending retry of a load the loader answered {@link PIT_LANE_SECTION_UNAVAILABLE} to. */
export type PitLaneLoadRetry = {
  /** How many asks in a row answered unavailable. */
  attempts: number;
  /** The `now` of the last ask, epoch ms. */
  since: number;
  /** How long after {@link since} the loader is asked again. */
  delayMs: number;
};

/**
 * The learned landmarks of the track in session. A translator holds one for
 * its session and empties it ({@link createPitLaneLandmarkLearner}) when the
 * session changes or the sim disconnects, so the next load reads the store's
 * current section again.
 */
export type PitLaneLandmarkLearner = {
  /** {@link pitLaneTrackKey} of {@link track} once loaded; `null` = not loaded. */
  key: string | null;
  /**
   * The identity the section was loaded for, carried on every event: the
   * object last handed in with this {@link key} (`loadPitLaneLandmarkLearner`
   * adopts an equal one); `null` = not loaded.
   */
  track: PitLaneTrackIdentity | null;
  /** The track's section, as loaded and then folded into; `null` = not loaded. */
  section: PitLaneSection | null;
  /**
   * Set while the loader's last answer for {@link key} was
   * {@link PIT_LANE_SECTION_UNAVAILABLE}: the learner learns on the section it
   * has and asks again once the retry is due. `null` otherwise.
   */
  retry: PitLaneLoadRetry | null;
};

/** A learner with nothing loaded. */
export function createPitLaneLandmarkLearner(): PitLaneLandmarkLearner {
  return { key: null, track: null, section: null, retry: null };
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
 * - `kept` — nothing: no identity yet, the learner already holds this one,
 *   or the retry of an unavailable load is not due yet.
 * - `loaded` — the loader's section, read and brought to the track length;
 *   `records` counts the known landmarks it holds.
 * - `none` — no loader, or it had nothing: an empty section.
 * - `unreadable` — the loader answered something that is not a section this
 *   build reads (malformed, or a newer version): an empty section.
 * - `threw` — the loader threw: an empty section.
 * - `unavailable` — the loader answered {@link PIT_LANE_SECTION_UNAVAILABLE}:
 *   the learner learns on the section it has (empty on the first such
 *   answer) and asks again in `retryInMs`. `attempt` counts the unavailable
 *   answers in a row for this identity, so a caller can warn on the first and
 *   stay quiet on the rest.
 *
 * Every outcome but `kept` loads the learner. After any but `unavailable` the
 * loader is not asked again until the identity changes or the learner is
 * emptied. A load that follows unavailable answers keeps what the learner
 * accepted meanwhile: those samples are folded into the loaded section, each
 * through `foldSample`, so one the loader's section already holds is a
 * duplicate and changes nothing.
 */
export type PitLaneLearnerLoad =
  | { kind: "kept" }
  | { kind: "loaded"; records: number }
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "threw"; error: unknown }
  | { kind: "unavailable"; attempt: number; retryInMs: number };

const KEPT: PitLaneLearnerLoad = { kind: "kept" };

/**
 * Whether a pending retry may ask the loader now: its delay has passed since
 * the last ask, or the clock went back before that ask (a wall-clock
 * adjustment, which would otherwise postpone the retry by as much). Never on
 * a `now` that is not a finite number.
 */
function isRetryDue(retry: PitLaneLoadRetry, now: number): boolean {
  if (!Number.isFinite(now)) return false;

  return !Number.isFinite(retry.since) || now < retry.since || now - retry.since >= retry.delayMs;
}

/** The wait after the `attempt`th unavailable answer in a row (1-based): doubling, capped. */
function retryDelayMs(attempt: number): number {
  return Math.min(PIT_LANE_LOAD_RETRY_MAX_MS, PIT_LANE_LOAD_RETRY_MS * 2 ** Math.min(attempt - 1, 16));
}

/**
 * Fold the samples the learner accepted while its load was unavailable
 * (`waiting`'s windows) into the section the loader finally answered, oldest
 * first per landmark, each through {@link foldSample}: one the loaded section
 * already holds (the store merges this process's unwritten samples itself) is
 * a duplicate and changes nothing.
 */
function foldWaitingSamples(
  section: PitLaneSection,
  waiting: PitLaneSection,
  now: string,
  trackLengthM: number | null,
): PitLaneSection {
  const landmarks: PitLaneLandmarks = { ...section.landmarks };
  let changed = false;

  for (const name of PIT_LANE_LANDMARK_NAMES) {
    for (const sample of waiting.landmarks[name]?.window ?? []) {
      const result = foldSample(landmarks[name], sample, now, trackLengthM);

      if (result.accepted) {
        landmarks[name] = result.record;
        changed = true;
      }
    }
  }

  return changed ? { ...section, landmarks } : section;
}

/**
 * Load the learner for `track`, once per identity: `kept` while the learner
 * already holds this identity, or with no identity yet. A loader that answers
 * {@link PIT_LANE_SECTION_UNAVAILABLE} is asked again once the back-off has
 * passed (by `now`, the caller's clock: the learner reads none), and the load
 * that finally answers keeps the samples learned meanwhile. Otherwise the loader
 * gets a copy of the identity, and its section, read leniently
 * ({@link normalizePitLaneSection}, so a malformed or newer one counts as
 * none), is brought in line with the session's track length
 * ({@link applyTrackLength}: a changed length is a rebuild, whose published
 * values become `previous`). Never throws for the loader's sake.
 *
 * A translator calls this every tick, so the common answer is cheap: the very
 * object the learner holds is `kept` without building its key. An equal
 * identity in a new object (the session info was re-read) is `kept` too, and
 * the learner adopts that object, so the calls after it take the cheap path.
 * The learner keeps the identity it is handed, not a copy: never mutate one
 * after handing it in.
 *
 * @param now The caller's clock, epoch ms: when an unavailable load is asked
 *   again, and the `updatedAt` of the samples kept across it.
 */
export function loadPitLaneLandmarkLearner(
  learner: PitLaneLandmarkLearner,
  track: PitLaneTrackIdentity | null,
  loader: PitLaneLandmarksLoader | null,
  now: number,
): PitLaneLearnerLoad {
  if (track === null) return KEPT;

  const pending = learner.retry;

  if (track === learner.track && (pending === null || !isRetryDue(pending, now))) return KEPT;

  const key = pitLaneTrackKey(track);
  const sameIdentity = key === learner.key;

  if (sameIdentity) {
    learner.track = track;

    if (pending === null || !isRetryDue(pending, now)) return KEPT;
  }

  // What the learner accepted while the store could not be read, kept across the retry.
  const retrying = sameIdentity && pending !== null;
  const waiting = retrying ? learner.section : null;
  let readable: PitLaneSection | null = null;
  let failure: PitLaneLearnerLoad | null = null;

  try {
    const loaded = loader === null ? null : loader({ ...track });

    if (loaded === PIT_LANE_SECTION_UNAVAILABLE) {
      const attempt = (retrying ? pending.attempts : 0) + 1;
      const delayMs = retryDelayMs(attempt);

      learner.key = key;
      learner.track = track;
      learner.section = waiting ?? applyTrackLength(undefined, track.trackLength, track.trackLengthM);
      learner.retry = { attempts: attempt, since: now, delayMs };

      return { kind: "unavailable", attempt, retryInMs: delayMs };
    }

    if (loaded === null) failure = { kind: "none" };
    else {
      readable = normalizePitLaneSection(loaded);

      if (readable === null) failure = { kind: "unreadable" };
    }
  } catch (error: unknown) {
    readable = null;
    failure = { kind: "threw", error };
  }

  const fresh = applyTrackLength(readable ?? undefined, track.trackLength, track.trackLengthM);
  const section =
    waiting === null ? fresh : foldWaitingSamples(fresh, waiting, new Date(now).toISOString(), track.trackLengthM);

  learner.key = key;
  learner.track = track;
  learner.section = section;
  learner.retry = null;

  return (
    failure ?? {
      kind: "loaded",
      records: PIT_LANE_LANDMARK_NAMES.filter((name) => section.landmarks[name] !== undefined).length,
    }
  );
}

/**
 * One value per landmark, in {@link PIT_LANE_LANDMARK_NAMES} order. The cast
 * is exact: `PitLaneLandmarkName` is derived from that list, so the entries
 * name every landmark and nothing else.
 */
function byLandmark<T>(value: (name: PitLaneLandmarkName) => T): Record<PitLaneLandmarkName, T> {
  return Object.fromEntries(PIT_LANE_LANDMARK_NAMES.map((name) => [name, value(name)])) as Record<
    PitLaneLandmarkName,
    T
  >;
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

  return byLandmark((name) => resolvePublishedLandmark(section.landmarks[name], track.trackLengthM));
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
