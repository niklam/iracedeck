/**
 * Phase 5, step 4 (#1377): the launch step, built over the installer and the
 * scan's service, dev root and logger. Built here, started by `startServices`.
 */
import { getGlobalSettings, onGlobalSettingsChange, whenSettingsStoreSettled } from "@iracedeck/settings";
import {
  createVoicePackLaunchStep,
  type VoicePackInstaller,
  type VoicePackLaunchStep,
  type VoicePackService,
} from "@iracedeck/voice-packs";

import type { VoicePackScan } from "./scan.js";

/** What the launch step reads from the scan: the dev root, the logger, and two service calls. */
export type LaunchScanView = Pick<VoicePackScan, "logger" | "devVoicePacksRoot"> & {
  readonly service: Pick<VoicePackService, "installed" | "isProvidedByDevRoot">;
};

export function buildVoicePackLaunch(scan: LaunchScanView, installer: VoicePackInstaller): VoicePackLaunchStep {
  const { service, devVoicePacksRoot, logger: voicePacksLogger } = scan;

  // The launch step (#1034 stage 3): sweep, seed, then — once the settings load
  // has settled, so the catalog dev override is readable — ensure `default` and
  // update every catalog-installed pack, retrying on its own schedule. Started
  // by `startServices`, after `initGlobalSettings`: nothing in it depends on the
  // settings store being READY (ruling 2 — the fail-closed settings path must
  // not cost the voice), and it opens no window (the structural test holds it
  // to that).
  return createVoicePackLaunchStep({
    installer,
    // A thunk: `initGlobalSettings` (in `startServices`) re-arms the settle
    // signal, so the promise must be taken inside `start()`, which runs after it.
    settled: () => whenSettingsStoreSettled(),
    // What is on disk now, as against the record's digest: the scanner's last
    // result listing the pack with a voice. A managed pack whose record
    // survived but whose clips did not is reinstalled by force off this.
    isPackUsable: (id) => service.installed().some((pack) => pack.id === id && pack.voices.length > 0),
    // The development root provides `id` right now, so the launch step must
    // never install or update it over that root's own copy (#1143).
    isProvidedByDevRoot: (id) => service.isProvidedByDevRoot(id),
    ...(devVoicePacksRoot === undefined ? {} : { devRoot: devVoicePacksRoot }),
    isRaceEngineerEnabled: () => (getGlobalSettings() as Record<string, unknown>).pitCrewRaceEngineerEnabled === true,
    // The step watches the Race Engineer gate itself and re-runs the ensure on
    // the false→true edge — the moment a missing or stale voice starts to matter.
    onSettingsChange: onGlobalSettingsChange,
    logger: voicePacksLogger,
  });
}
