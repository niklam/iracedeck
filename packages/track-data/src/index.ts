/**
 * @iracedeck/track-data
 *
 * Bundled track datasets. Ships a pruned snapshot of Lovely Sim Racing's
 * lovely-track-data corner markers (CC BY-NC-SA 4.0, used with permission —
 * attribution is a grant condition, see `attribution.ts`), keyed by
 * iRacing's `WeekendInfo.TrackName`.
 */
export { CORNER_DATA_ATTRIBUTION } from "./attribution.js";
export { type CornerMarker, listCornerNames, resolveCornerMarkers } from "./corner-data.js";
export { normalizeCornerName, normalizeTrackKey, slugifyCornerName } from "./normalize.js";
