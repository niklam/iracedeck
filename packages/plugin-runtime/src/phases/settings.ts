/**
 * Phase 7 (#1349): the plugin-owned settings store, the settings window, the
 * startup notices (first run, changelog), the global-settings listener with
 * its one-shot store-ready block and its every-arrival banner re-assertions,
 * and the PI-appear re-pushes.
 *
 * Since #1377 the body only sequences named steps from `./settings/`, each
 * handed what it needs as a parameter:
 *
 * 1. `createAudioDeviceSync` — the device-list push (deduped) and the saved-device apply.
 * 2. `createStartupNotices` — the serialised first-run + changelog run and its sim-exit handler,
 *    which the body registers first.
 * 3. `initSettingsStore` — the file store and its exit flush, adjacent.
 * 4. `initSettingsWindow` — the channel publisher, the CPU profile capture, the update check,
 *    the controller and `openSettingsWindow`; it reads the store's path eagerly.
 * 5. `createStoreReadyStep` — the one-shot block, which arms the notices with the window's opener
 *    and starts the window's server.
 * 6. `createSettingsListener` / `createPropertyInspectorAppearHandler` — the two listeners,
 *    composed from the steps above.
 *
 * Each step's constructor is either free of side effects or makes exactly the
 * recorded calls `start-plugin.test.ts` pins for it, so the phase's call order
 * is the order of the lines below.
 */
import { onIRacingTerminated } from "@iracedeck/deck-iracing";
import { onGlobalSettingsChange } from "@iracedeck/settings";

import { evaluateNativeAddonWarnings } from "../native-addons.js";
import type { Audio, Core, Settings, VoicePacks } from "../types.js";
import { createAudioDeviceSync } from "./settings/audio-devices.js";
import { createPropertyInspectorAppearHandler, createSettingsListener } from "./settings/listeners.js";
import { initSettingsStore } from "./settings/settings-store.js";
import { initSettingsWindow } from "./settings/settings-window.js";
import { createStartupNotices } from "./settings/startup-notices.js";
import { createStoreReadyStep } from "./settings/store-ready.js";

export function initSettings(core: Core, audio: Audio, voicePacks: VoicePacks): Settings {
  // A native addon that failed to load gets an error banner (#1373). The statuses
  // are fixed for the run, so the records are computed once; the listener sets
  // them again on every settings arrival, because `_warnings` is run-scoped.
  const nativeAddonWarnings = evaluateNativeAddonWarnings(core.nativeAddons);
  const audioDevices = createAudioDeviceSync();
  const notices = createStartupNotices({ core, logger: core.adapter.createLogger("VersionCheck") });

  // Re-run the startup notices when iRacing exits (issue #870) — see
  // `onSimExited` for when that is pending.
  onIRacingTerminated(notices.onSimExited);

  const store = initSettingsStore(core);
  const settingsWindow = initSettingsWindow({ core, store, voicePacks });
  const storeReady = createStoreReadyStep({ audio, voicePacks, store, settingsWindow, notices });

  onGlobalSettingsChange(createSettingsListener({ audioDevices, storeReady, voicePacks, nativeAddonWarnings }));
  core.adapter.onPropertyInspectorDidAppear(createPropertyInspectorAppearHandler({ audioDevices, voicePacks }));

  return { store, openSettingsWindow: settingsWindow.openSettingsWindow };
}
