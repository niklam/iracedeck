/**
 * @iracedeck/track-data
 *
 * Bundled track datasets. Ships a pruned snapshot of Lovely Sim Racing's
 * lovely-track-data corner markers (CC BY-NC-SA 4.0, used with permission —
 * attribution is a grant condition, see `attribution.ts`), keyed by
 * iRacing's `WeekendInfo.TrackName`.
 *
 * Also the pure model of learned pit-lane landmarks (`pit-lane-landmarks.ts`,
 * #1112) and the sim-neutral learner over it (`pit-lane-learner.ts`):
 * positions measured from live telemetry, not Lovely Sim Racing data.
 */
export { CORNER_DATA_ATTRIBUTION } from "./attribution.js";
export { type CornerMarker, listCornerNames, resolveCornerMarkers } from "./corner-data.js";
export { normalizeCornerName, normalizeTrackKey, slugifyCornerName } from "./normalize.js";
export {
  applyTrackLength,
  foldSample,
  isDuplicatePitLaneSample,
  isNewerPitLaneSection,
  isPitLaneLandmarkSample,
  normalizePitLaneLandmarkRecord,
  normalizePitLanePct,
  normalizePitLaneSection,
  PIT_LANE_DUPLICATE_WINDOW_MS,
  PIT_LANE_LANDMARK_NAMES,
  PIT_LANE_MIN_AGREEING_SAMPLES,
  PIT_LANE_SECTION_VERSION,
  PIT_LANE_TOLERANCE_M,
  PIT_LANE_TOLERANCE_PCT,
  PIT_LANE_WINDOW_CAP,
  type PitLaneFoldResult,
  type PitLaneLandmarkName,
  type PitLaneLandmarkOrigin,
  type PitLaneLandmarkPrevious,
  type PitLaneLandmarkRecord,
  type PitLaneLandmarks,
  type PitLaneLandmarkSample,
  type PitLaneLandmarkSummary,
  type PitLaneResolvedLandmark,
  type PitLaneSection,
  type PitLaneTrackIdentity,
  pitLaneCircularMedianPct,
  pitLaneMidpointPct,
  pitLaneSignedDeltaPct,
  pitLaneTolerancePct,
  resolvePublishedLandmark,
  summarizeLandmark,
} from "./pit-lane-landmarks.js";
export {
  createPitLaneLandmarkLearner,
  learnPitLaneLandmarks,
  loadPitLaneLandmarkLearner,
  type PitLaneLandmarkLearner,
  type PitLaneLandmarksLoader,
  type PitLaneLearnerEdge,
  type PitLaneLearnerLoad,
  type PitLaneLearnerResult,
  pitLaneTrackKey,
  resolvePitLaneLandmarks,
} from "./pit-lane-learner.js";
