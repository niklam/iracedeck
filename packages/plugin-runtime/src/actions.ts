/**
 * The plugin-level hooks `@iracedeck/iracing-actions` exposes to the bootstrap.
 * The only importer of that package in plugin-runtime, so tests mock one file.
 */
export {
  applyRaceEngineerAudio,
  applyRadarEnabled,
  applyRadarVolume,
  armFeatureGateSync,
  CAR_CYCLE_BINDING_DEFAULTS,
  isAudioPreviewKind,
  migrateLfeIntensityBindingKeys,
  runAudioPreview,
  SETUP_CHASSIS_BINDING_KEY_RENAMES,
  stopRaceEngineerPlayback,
  syncFeatureGates,
} from "@iracedeck/iracing-actions";
