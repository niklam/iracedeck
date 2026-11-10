// @iracedeck/track-store: the per-track store (issue #1112). Pit-lane landmarks
// learned from live telemetry, one file per track under
// %LOCALAPPDATA%\iRaceDeck\Track Data\<sim>, shared by every deck host and
// merged on every write. The landmark model is @iracedeck/track-data's. There
// is no global getter: the plugin threads the handle initializeTrackStore
// returns, and consumers read the translator, never the store.
export {
  buildTrackFile,
  type ParsedTrackFile,
  parseTrackFile,
  readTrackFile,
  resolveTrackDataDirectory,
  type ResolveTrackDataDirectoryOptions,
  TRACK_DATA_DIR_ENV,
  TRACK_FILE_VERSION,
  type TrackFile,
  type TrackFileEnvelope,
  type TrackFileMismatch,
  trackFileMismatch,
  trackFileName,
  type TrackFileRead,
} from "./track-file.js";
export {
  _resetTrackStore,
  createTrackStore,
  initializeTrackStore,
  nodeTrackStoreIo,
  TRACK_STORE_OWN_SAMPLES_CAP,
  TRACK_STORE_STALE_TEMP_MS,
  TRACK_STORE_WRITE_DEBOUNCE_MS,
  TRACK_STORE_WRITE_MAX_WAIT_MS,
  type TrackStore,
  type TrackStoreIo,
  type TrackStoreOptions,
  type TrackStoreSampleInput,
} from "./track-store.js";
