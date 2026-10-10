// @iracedeck/diagnostics: the plugin's self-diagnostics, moved out of deck-core (issue #1367).

// Main-thread watchdog: a worker that reports a blocked main thread into the host's log (issue #1330)
export {
  type MainThreadWatchdog,
  type MainThreadWatchdogOptions,
  startMainThreadWatchdog,
  WATCHDOG_DEFAULTS,
  watchdogDailyLogFileName,
  type WatchdogLogTarget,
} from "./main-thread-watchdog.js";

// Capture CPU profile: an in-process profiler session behind the settings window's Diagnostics button (issue #1338)
export {
  CPU_PROFILE_DEFAULTS,
  type CpuProfileCapture,
  type CpuProfileCaptureOptions,
  type CpuProfileCaptureResult,
  _resetCpuProfileCapture,
  createCpuProfileCapture,
  getCpuProfileCapture,
  initializeCpuProfileCapture,
  isCpuProfileCaptureInitialized,
  type ProfileCaptureStatus,
} from "./cpu-profile-capture.js";

// Resource monitor: the plugin's own CPU, event-loop and memory use in its log (issue #1338)
export {
  RESOURCE_MONITOR_DEFAULTS,
  type ResourceMonitor,
  type ResourceMonitorConfig,
  type ResourceMonitorOptions,
  type ResourceSample,
  startResourceMonitor,
} from "./resource-monitor.js";

// Plugin state for the Telemetry Snapshot: section registry and JSON-safe encoder (issue #1387)
export { JSON_SAFE_MAX_DEPTH, type JsonValue, toJsonSafe } from "./json-safe.js";
export {
  _resetStateSections,
  type CollectedState,
  collectStateSections,
  type HeadlineRow,
  PLUGIN_STATE_SCHEMA,
  registerStateSection,
  type StateSection,
} from "./state-sections.js";
