// @iracedeck/track-store: the per-track store (issue #1112). Pit-lane landmarks
// learned from live telemetry, one file per TrackID under
// %LOCALAPPDATA%\iRaceDeck\Track Data, shared by every deck host and merged on
// every write. The landmark model is @iracedeck/track-data's.
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
  trackFileMismatch,
  trackFileName,
  type TrackFileRead,
} from "./track-file.js";
export {
  _resetTrackStore,
  createTrackStore,
  getTrackStore,
  initializeTrackStore,
  isTrackStoreInitialized,
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
