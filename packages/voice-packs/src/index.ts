// @iracedeck/voice-packs: the downloadable Race Engineer voice-pack stack (issue #1034),
// moved out of deck-core (issue #1366). The pack format's shared rules
// (`parseVoicePackManifest`, `CalloutScript`, ...) are `@iracedeck/callout-script`'s;
// import them from there.
export { resolveVoicePacksPath, type ResolveVoicePacksPathOptions } from "./voice-packs-path.js";
export {
  readVoiceScript,
  scanVoicePacks,
  type InstalledVoice,
  type InstalledVoicePack,
  type ScanVoicePacksOptions,
  type ScanVoicePacksResult,
  type VoicePackFileSystem,
  type VoicePackProblem,
  type VoiceScriptRead,
} from "./voice-pack-scanner.js";
export { VOICE_PACK_PROVENANCE_FILE } from "./voice-pack-constants.js";
export { resolveVoicePackCatalogUrl } from "./voice-pack-catalog-base.js";
export {
  isVoicePackOfferable,
  parseVoicePackCatalog,
  VOICE_PACK_CATALOG_MAX_BYTES,
  VOICE_PACK_CATALOG_MAX_PACKS,
  type VoicePackCatalogEntry,
  VoicePackCatalogEntrySchema,
  VoicePackCatalogSchema,
} from "./voice-pack-catalog.js";
export {
  parseVoicePackProvenance,
  serializeVoicePackProvenance,
  VOICE_PACK_SOURCES,
  type VoicePackProvenance,
  VoicePackProvenanceSchema,
  type VoicePackSource,
} from "./voice-pack-provenance.js";
export {
  FIRST_PARTY_VOICE_LABEL_PREFIX,
  isFirstPartyVoicePack,
  orderRaceEngineerVoices,
  voiceDisplayLabels,
} from "./voice-labels.js";
export { createVoicePackArchiveFileSystem, createVoicePackFileSystem, VOICE_PACK_MAX_DEPTH } from "./voice-pack-fs.js";
export {
  type BundledVoicePack,
  createVoicePackInstaller,
  createVoicePackInstallerFileSystem,
  readInstalledVoicePackSha,
  VOICE_PACK_INSTALL_FAILURE_CODES,
  VOICE_PACK_PROGRESS_INTERVAL_MS,
  type VoicePackInstallFailureCode,
  type VoicePackInstaller,
  type VoicePackInstallerCatalog,
  type VoicePackInstallerDeps,
  type VoicePackInstallerFileSystem,
  type VoicePackInstallOptions,
  type VoicePackInstallOutcome,
  type VoicePackInstallResult,
  type VoicePackRemoveResult,
  type VoicePackSeedResult,
} from "./voice-pack-installer.js";
export {
  createVoicePackLaunchStep,
  isManagedVoicePack,
  VOICE_PACK_RETRY_DELAYS_MS,
  VOICE_PACK_RETRY_STEADY_MS,
  type VoicePackLaunchOutcome,
  type VoicePackLaunchStep,
  type VoicePackLaunchStepDeps,
} from "./voice-pack-launch.js";
export { createVoicePackService, type VoicePackService, type VoicePackServiceDeps } from "./voice-pack-service.js";
export {
  type ExtractVoicePackArchiveOptions,
  type ExtractVoicePackArchiveResult,
  extractVoicePackArchive,
  VOICE_PACK_ARCHIVE_FAILURE_CODES,
  VOICE_PACK_ARCHIVE_LIMITS,
  type VoicePackArchiveFailureCode,
  type VoicePackArchiveFileSystem,
  type VoicePackArchiveLimits,
  type VoicePackArchiveWrite,
} from "./voice-pack-archive.js";
export {
  type DownloadVoicePackOptions,
  downloadVoicePack,
  VOICE_PACK_DOWNLOAD_CEILING_BYTES,
  VOICE_PACK_DOWNLOAD_FAILURES,
  VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS,
  type VoicePackDownloadFailure,
  type VoicePackDownloadProgress,
  type VoicePackDownloadResult,
  type VoicePackDownloadSink,
} from "./voice-pack-download.js";
export {
  type CreateVoicePackStagingResult,
  createVoicePackStorage,
  createVoicePackStorageFileSystem,
  type OpenVoicePackDownloadResult,
  type PromoteVoicePackResult,
  type RetireVoicePackResult,
  type SweepVoicePacksResult,
  VOICE_PACK_TMP_DIR,
  VOICE_PACK_TRASH_DIR,
  type VoicePackFsResult,
  type VoicePackLock,
  type VoicePackStorage,
  type VoicePackStorageDeps,
  type VoicePackStorageFileSystem,
  type VoicePackWriteHandle,
} from "./voice-pack-storage.js";
export {
  fetchVoicePackCatalog,
  VOICE_PACK_CATALOG_FETCH_TIMEOUT_MS,
  VOICE_PACK_CATALOG_URL,
  type VoicePackCatalogFetchResult,
} from "./voice-pack-catalog-client.js";
export {
  createVoicePackCatalogService,
  VOICE_PACK_CATALOG_FAILURE_TTL_MS,
  VOICE_PACK_CATALOG_SUCCESS_TTL_MS,
  type VoicePackCatalogGetOptions,
  type VoicePackCatalogService,
  type VoicePackCatalogServiceDeps,
} from "./voice-pack-catalog-service.js";

// Missing-callout-script banner: the active Race Engineer voice has no script,
// so every callout that comes from the script is skipped in it — surfaced in
// the PI rather than only in the log (issue #1064)
export {
  evaluateVoiceScriptWarning,
  VOICE_SCRIPT_WARNING_ID,
  type VoiceScriptWarningInput,
} from "./voice-script-warning.js";
export {
  createVoiceScriptWarningReporter,
  type VoiceScriptWarningReporterDeps,
} from "./voice-script-warning-reporter.js";
