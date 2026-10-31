/**
 * The settings phase's one-shot store-ready block (#1377): arming the startup
 * notices, the startup migrations and the per-feature startup policies (issue
 * #1007, replacing the "On startup" defaults of #482 — a policy of
 * `remember-last` now leaves the previous session's gate alone instead of
 * overriding it), then the notices' grace timer, publishing the store path,
 * starting the settings server and the catalog-override warning. The Pit Crew action's own
 * onGlobalSettingsChange listener picks up the echoed runtime keys and
 * re-applies them to the audio buses / radar engine, so no further wiring is
 * needed here.
 *
 * The global-settings listener calls `runIfReady` on every arrival; the block
 * runs on the first one that finds the settings store ready, and never again.
 */
import { VERSION_CHECK_STARTUP_GRACE_MS } from "@iracedeck/app-updates";
import {
  applyStartupFeatureGates,
  deleteGlobalSettings,
  isSettingsStoreReady,
  migrateStartupPolicies,
  type SettingsStore,
  updateGlobalSettings,
} from "@iracedeck/settings";

import { migrateLfeIntensityBindingKeys } from "../../actions.js";
import type { Audio, VoicePacks } from "../../types.js";
import { warnIfCatalogOverride } from "./catalog-override-warning.js";
import type { SettingsWindowStep } from "./settings-window.js";
import type { StartupNotices } from "./startup-notices.js";

export interface StoreReadyDeps {
  readonly audio: Audio;
  readonly voicePacks: VoicePacks;
  /** Only its path is read: the Diagnostics card shows it. */
  readonly store: Pick<SettingsStore, "path">;
  readonly settingsWindow: SettingsWindowStep;
  readonly notices: StartupNotices;
}

export interface StoreReadyStep {
  /** Run the block if it has not run and the settings store is ready. */
  runIfReady(): void;
}

export function createStoreReadyStep({
  audio,
  voicePacks,
  store,
  settingsWindow,
  notices,
}: StoreReadyDeps): StoreReadyStep {
  let startupDefaultsApplied = false;

  return {
    runIfReady() {
      // Gated on the settings store: a write made before it has loaded still
      // notifies listeners (read-your-writes), and running the startup defaults
      // against schema defaults would layer those computed values over the
      // loaded/migrated settings (#993). The flag is set before anything else,
      // so a listener re-entered by one of the writes below skips the block.
      if (startupDefaultsApplied || !isSettingsStoreReady()) return;

      startupDefaultsApplied = true;

      // The startup notices may run from now on (#1061, #680), opening the window
      // through the phase's own opener. Armed together with the flag, as the
      // single flag they once shared was, so a migration below that throws
      // leaves them runnable on the next iRacing exit exactly as before.
      notices.arm(settingsWindow.openSettingsWindow);

      // First step is the issue #515 migration: drop the four pre-rename Pit
      // Crew enable keys from persisted storage. Idempotent — once they're
      // gone, subsequent startups skip the write. Runs BEFORE the on-startup
      // defaults below so the renamed `pitCrew*Enabled` keys take their
      // schema defaults (`false`) for everyone, regardless of what the
      // pre-rename keys held.
      deleteGlobalSettings([
        "raceEngineerEnabled",
        "radarEnabled",
        "raceEngineerEnabledOnStartup",
        "radarEnabledOnStartup",
      ]);

      // Issue #657 rename cleanup: the per-callout opt-in
      // `calloutEnabledFlagOneLapToGreen` was renamed to
      // `calloutEnabledFlagOnePaceLapToGo`. Drop the orphaned old key so the new
      // key takes its schema default (on) for everyone — the same "reset to
      // schema default on rename" convention as the #515 keys above. The cue was
      // also re-triggered and re-recorded (effectively new behaviour), so it
      // should default on per the Race Engineer "new functionality defaults on"
      // principle rather than inherit a disable of the old, broken cue.
      deleteGlobalSettings(["calloutEnabledFlagOneLapToGreen"]);

      // Issue #848: the Force Feedback LFE "intensity" modes were retired as
      // duplicates of Wheel/BassShaker LFE (iRacing has one control pair per
      // LFE device, labeled differently across its settings pages). Carry any
      // bindings stored under the retired keys over to the canonical
      // louder/quieter keys (never overwriting a configured one), then drop
      // the retired keys. Idempotent.
      migrateLfeIntensityBindingKeys();

      // Issue #1007: the retired `…EnabledOnStartup` booleans became startup
      // policies. Migrate first so the policies below are the user's real
      // choice, apply them to the live gates, then arm the gate sync — in that
      // order, because arming records the post-write values as already applied
      // and a startup write must never sound like a user toggle.
      migrateStartupPolicies(audio.featureGateLogger);
      applyStartupFeatureGates(audio.featureGateLogger);
      audio.armFeatureGateSync();

      // Open Getting Started on a first run (#1061) or the website changelog
      // once when a newer stable version is detected (issue #680) — via the
      // notices armed above, delayed by the #870 startup grace so a
      // mid-session plugin restart (the deck-host auto-update case) can't run
      // the check before the sim-running signals are up and open the page over
      // a live session.
      setTimeout(() => void notices.run(), VERSION_CHECK_STARTUP_GRACE_MS);

      // #993: the Diagnostics "Storage" card's path is known synchronously (no
      // I/O at construction) — publish it unconditionally here, NOT inside the
      // ensureStarted().then() below, so a bind/firewall failure that rejects
      // the settings server still leaves the path visible for the rest of the
      // process life. That's exactly when a diagnostic aid matters most.
      updateGlobalSettings({ _settingsStorePath: store.path });

      // #993: the settings server is the channel every UI uses; publish where it
      // is (the ONE host mirror per start — full store + `_settingsChannel` —
      // that the PI bridge bootstraps from; the channel itself is never persisted
      // in the store — see createSettingsChannelPublisher). The
      // controller's onStarted hook publishes a server that starts LATER too (a
      // failed startup bind followed by a successful "Open Settings"), and the
      // publisher is idempotent, so calling it here as well only ensures a
      // server that came up before the store was ready still gets mirrored.
      // Two-arg then: a bind/firewall failure must not crash the plugin process
      // (Node throws on an unobserved rejection). The controller logs it and
      // raises the PI warning banner itself (#1005), so there is nothing left
      // to do here but observe it; publish() logs its own faults and never throws.
      void settingsWindow.controller.ensureStarted().then(
        (channel) => settingsWindow.channel.publish(channel),
        // Mirror the store to the host WITHOUT a channel (#1005). With no server
        // there is nothing for a Property Inspector to connect to, so every PI
        // falls back to reading the deck host's copy — and this is the only write
        // the plugin makes to it. Without this the warning banner the controller
        // just raised would never leave the plugin's own settings file.
        () => settingsWindow.channel.publishUnavailable(),
      );

      warnIfCatalogOverride(voicePacks.logger);
    },
  };
}
