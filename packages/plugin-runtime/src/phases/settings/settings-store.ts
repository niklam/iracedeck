/**
 * The settings phase's store step (#1377): the plugin-owned global-settings
 * store (issue #993) and its exit flush, adjacent. The phase builds it before
 * the settings window and hands it over as a parameter: the window's
 * command-handler deps read `store.path` eagerly, at construction.
 */
import { getPluginPlatform } from "@iracedeck/deck-core";
import {
  createFileSettingsStore,
  createSettingsFileRejectionReporter,
  resolveSettingsStorePath,
  type SettingsStore,
} from "@iracedeck/settings";

import type { Core } from "../../types.js";

export function initSettingsStore(core: Core): SettingsStore {
  const settingsStore = createFileSettingsStore({
    path: resolveSettingsStorePath({ platform: getPluginPlatform(), env: process.env }),
    logger: core.adapter.createLogger("SettingsStore"),
    // A file rejected as invalid JSON is moved aside and the settings restored
    // from the deck host's copy; this banner is how the user learns that (#1036).
    onRejected: createSettingsFileRejectionReporter(),
  });

  // Land the last debounced save on the way out. Node runs "exit" handlers
  // synchronously, which is exactly why the store has a SYNCHRONOUS flush — the
  // async flush() would never get an event-loop turn here. This covers every
  // orderly exit, including the Mirabox/Ulanzi clients' outright process.exit(0)
  // when their host socket closes. A hard kill by the host can't be caught by
  // anything, so a <=250 ms window remains there by construction.
  process.on("exit", () => settingsStore.flushSync());

  return settingsStore;
}
