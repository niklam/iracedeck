/**
 * The Telemetry Snapshot's plugin-state sections (#1387), named in one place.
 *
 * Take Snapshot writes what the plugin had computed at the press beside the
 * telemetry it computed it from. Each owning package exports a reader for its
 * own state; this module registers the four with `@iracedeck/diagnostics`'
 * registry, which imports none of them. The order here is the key order in the
 * file: `environment`, `settings`, `sim`, `raceEngineer`.
 *
 * Registering stores functions and reads nothing. Every reader answers for a
 * subsystem that has not started (`{ initialized: false }`, or the schema
 * defaults for the settings), so the four are registered together at the end
 * of `initCore`, with no ordering against the phases that start those
 * subsystems later. A snapshot from a plugin whose scenario engine never
 * started says so instead of lacking the section.
 *
 * Decision record: `docs/superpowers/specs/2026-10-10-issue-1387-snapshot-plugin-state.md`.
 */
import { raceEngineerStateHeadline, readRaceEngineerState } from "@iracedeck/audio-scenarios/pit-crew";
import { getPluginPlatform, getPluginVersion } from "@iracedeck/deck-core";
import { hasElevationMismatch, isIRacingActive } from "@iracedeck/deck-iracing";
import { type HeadlineRow, registerStateSection } from "@iracedeck/diagnostics";
import {
  getSettingsStoreSource,
  isSettingsStoreReady,
  readSettingsForSnapshot,
  type SettingsStoreSource,
} from "@iracedeck/settings";
import { readSimState, simStateHeadline } from "@iracedeck/sim-events-iracing";

import type { Core } from "./types.js";

/**
 * The `environment` section: which build is running, on which deck host, and
 * what it could see of the sim and of its own settings at the press.
 *
 * **No file path, ever.** The plugin's directories (`Core.binDir`, the log
 * location, the settings file) all sit under the Windows profile, so a path
 * would put the user's account name in a file they send to someone else, and
 * it would add nothing the version and the host do not already say.
 */
export type EnvironmentState = {
  pluginVersion: string;
  /** The deck host the plugin was built for (`getPluginPlatform()`): "stream-deck", "mirabox", "ulanzi". */
  host: string;
  /** `process.version` of the host's Node runtime. */
  node: string;
  /** Whether the SDK controller is connected to iRacing's telemetry. */
  sdkConnected: boolean;
  /** Whether the app monitor sees iRacing running. */
  iRacingActive: boolean;
  /** The elevation check's verdict (#976). `false` also while no probe has answered. */
  elevationMismatch: boolean;
  /**
   * Whether the settings cache reflects the settings store yet. The `settings`
   * section reads the schema defaults until it does, which is exactly what a
   * user who changed nothing reads as; this is what tells the two apart.
   */
  settingsStoreReady: boolean;
  /** How the cache was filled: "file", "host" (migrated from the deck host) or "fresh"; `null` until it is ready. */
  settingsStoreSource: SettingsStoreSource | null;
};

/**
 * Reads the environment NOW. Called by the collector at the press, never at
 * registration: the SDK connects, iRacing starts and the settings load long
 * after `initCore`, so a value captured there would describe startup.
 */
function readEnvironment(core: Core): EnvironmentState {
  return {
    pluginVersion: getPluginVersion(),
    host: getPluginPlatform(),
    node: process.version,
    sdkConnected: core.controller.getConnectionStatus(),
    iRacingActive: isIRacingActive(),
    elevationMismatch: hasElevationMismatch(),
    settingsStoreReady: isSettingsStoreReady(),
    settingsStoreSource: getSettingsStoreSource(),
  };
}

/** The two rows the snapshot's Markdown report opens its Plugin State section with. */
function environmentHeadline(state: EnvironmentState): HeadlineRow[] {
  return [
    ["Plugin version", state.pluginVersion],
    ["Deck host", state.host],
  ];
}

/**
 * Registers the four plugin-state sections for the Telemetry Snapshot, in the
 * order the file lists them. Call it once per run: the registry refuses a name
 * registered twice, since two owners for one section is a wiring bug.
 *
 * `core` is kept only by the `environment` reader, which asks its controller
 * for the connection status at each press.
 */
export function registerStateSections(core: Core): void {
  registerStateSection<EnvironmentState>("environment", {
    read: () => readEnvironment(core),
    headline: environmentHeadline,
  });

  // The settings reader decides what of the settings may leave the machine: it
  // drops every internal `_` key it does not name (`SNAPSHOT_KEPT_INTERNAL_KEYS`
  // in `@iracedeck/settings`), `_settingsChannel` and its token among them.
  // Never swap it for `getGlobalSettings`. No headline: the report has no
  // one-line summary of 200 settings.
  registerStateSection("settings", { read: () => readSettingsForSnapshot() });

  registerStateSection("sim", { read: readSimState, headline: simStateHeadline });

  // From the `pit-crew` subpath: the package's root barrel stays free of sim imports.
  registerStateSection("raceEngineer", { read: readRaceEngineerState, headline: raceEngineerStateHeadline });
}
