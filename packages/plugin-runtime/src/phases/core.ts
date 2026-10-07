/**
 * Phase 1 (#1349): the plugin config, the log level, the two run-long
 * monitors, the setup-warning check, the SDK and the event bus — everything
 * later phases read through `Core`.
 */
import {
  getGlobalSettings,
  initPluginConfig,
  onGlobalSettingsChange,
  type PluginConfig,
  startMainThreadWatchdog,
  startResourceMonitor,
  validateSetupWarningPatterns,
} from "@iracedeck/deck-core";
import {
  getController,
  initializeSDK,
  isIRacingActive,
  onIRacingStarted,
  onIRacingTerminated,
} from "@iracedeck/deck-iracing";
import { initializeEventBus } from "@iracedeck/event-bus";
import { LogLevel } from "@iracedeck/logger";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { requireLogLocation } from "../log-location.js";
import type { Core, PluginHost } from "../types.js";

export function initCore(host: PluginHost): Core {
  const { adapter } = host;

  // Load build-time config (version, platform)
  const pluginConfig: PluginConfig = JSON.parse(readFileSync(join(host.binDir, "config.json"), "utf-8"));
  initPluginConfig(pluginConfig);

  // Default to info-level logging in production; the user opts into verbose
  // debug logging from the PI "Enable debug logging" toggle without a rebuild
  // (issue #609). Every adapter's `setLogLevel` is runtime-mutable (Elgato
  // forwards to the SDK logger; Mirabox and Ulanzi flip a level their loggers
  // read live), so re-apply on every settings change. The initial call reads
  // the schema-default cache (debugLogging=false → info); the host echo
  // re-fires the listener with the persisted value once global settings load.
  const applyDebugLogging = (settings: ReturnType<typeof getGlobalSettings>): void => {
    adapter.setLogLevel(settings.debugLogging ? LogLevel.Debug : LogLevel.Info);
  };
  onGlobalSettingsChange(applyDebugLogging);
  applyDebugLogging(getGlobalSettings());

  // Watch the main thread for the rest of the run (#1330). A freeze blocks every
  // logger on this thread, so the watchdog's worker appends its report straight
  // to the file the host's logger writes — Elgato's `<cwd>/logs/<plugin UUID>.0.log`,
  // Mirabox's and Ulanzi's per-day file under their `log` directory — as the
  // adapter reports it (`logLocation`).
  const logLocation = requireLogLocation(adapter);
  startMainThreadWatchdog({
    logger: adapter.createLogger("MainThreadWatchdog"),
    target: logLocation,
  });

  // Report the plugin's own CPU, event-loop and memory use into its log (#1338):
  // one WARN with the numbers after three high minutes, an INFO on recovery, and
  // a summary at each iRacing exit. It samples at both session edges too, so
  // every interval lies wholly inside or outside a session. The app-monitor
  // hooks are injected, as the window service's are (#1176).
  startResourceMonitor({
    logger: adapter.createLogger("ResourceMonitor"),
    onSessionStart: onIRacingStarted,
    onSessionEnd: onIRacingTerminated,
    isSessionActive: isIRacingActive,
  });

  // Banner a broken setup-warning regex pattern (issue #625). Validating on every
  // settings change gives immediate PI feedback when a user types an invalid
  // pattern; the live match closure independently skips the warning, so the
  // callout never crashes. The initial call reads the schema-default cache (both
  // patterns default → valid → no banner); the host echo re-fires the listener
  // with persisted values once global settings load.
  const applySetupWarningValidation = (): void => {
    validateSetupWarningPatterns(getGlobalSettings() as Record<string, unknown>);
  };
  onGlobalSettingsChange(applySetupWarningValidation);
  applySetupWarningValidation();

  // Initialize the SDK singleton
  initializeSDK(adapter.createLogger("iRacingSDK"));

  // Initialize the event bus BEFORE any publisher (sim-events-iracing) or
  // subscriber (actions) exist. Must land before sdk translator + actions so
  // both sides can see the bus.
  const bus = initializeEventBus(adapter.createLogger("EventBus"));

  return { host, adapter, binDir: host.binDir, logLocation, bus, controller: getController() };
}
