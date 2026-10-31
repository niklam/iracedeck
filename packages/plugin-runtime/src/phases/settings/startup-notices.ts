/**
 * The settings phase's startup notices (#1377): the Getting Started page on a
 * first run (#1061) and the changelog version check (issues #680, #742, #870),
 * serialised into one run.
 *
 * Each run builds its inputs from the LIVE settings cache, because it runs at
 * two different moments: once ~15 s after the first global-settings arrival
 * (the #870 startup grace that lets the sim-running signals settle — the
 * store-ready block arms the notices and starts that timer), and again
 * whenever iRacing exits — a due changelog is never opened over a live
 * session, it defers (nothing persisted) and stays pending until the sim is
 * gone. `runVersionCheck` is naturally idempotent across these calls: once a
 * version is persisted, later calls decide `skip`.
 *
 * Building the notices has no side effects. The phase registers `onSimExited`
 * with `onIRacingTerminated` itself, as its first call; the store-ready block
 * calls `arm` with the settings-window opener, which does not exist yet when
 * the notices are built, so nothing runs before the store has settled.
 */
import { runVersionCheck, shouldOpenChangelog } from "@iracedeck/app-updates";
import { getPluginPlatform, getPluginVersion } from "@iracedeck/deck-core";
import { isIRacingActive } from "@iracedeck/deck-iracing";
import type { ILogger } from "@iracedeck/logger";
import {
  FIRST_RUN_VERSION_KEY,
  getGlobalSettings,
  GETTING_STARTED_PANE,
  MIGRATION_PENDING_KEY,
  runFirstRunCheck,
  updateGlobalSettings,
} from "@iracedeck/settings";
import type { SettingsWindowOpenOptions } from "@iracedeck/settings-window";

import type { Core } from "../../types.js";

/** Opens the settings window; the store-ready block hands the phase's own (which asks the catalog first). */
export type OpenSettingsWindow = (options?: SettingsWindowOpenOptions) => Promise<unknown>;

export interface StartupNoticesDeps {
  /** The changelog check reads the connected deck type and opens its URL through the adapter. */
  readonly core: Pick<Core, "host" | "adapter">;
  /** The `VersionCheck` logger both checks write to. */
  readonly logger: ILogger;
}

export interface StartupNotices {
  /** Run the first-run check, then the changelog check — serialised, and a no-op until armed. */
  run(): Promise<void>;
  /**
   * Allow runs from now on, opening Getting Started through `openSettingsWindow`.
   * Called once by the store-ready block: nothing meaningful can be compared
   * before the store has settled, and the window is built after the notices.
   */
  arm(openSettingsWindow: OpenSettingsWindow): void;
  /** `onIRacingTerminated`'s handler: re-run when an open is still pending. */
  onSimExited(): void;
}

export function createStartupNotices({ core, logger }: StartupNoticesDeps): StartupNotices {
  let openSettingsWindow: OpenSettingsWindow | undefined;
  let startupNoticesInFlight: Promise<void> | undefined;

  /**
   * Serialises the two entry points (the grace timer and `onSimExited`).
   * `runFirstRunCheck` persists only once the window has opened, so its own
   * "already resolved" guard is blind for the whole browser-spawn duration —
   * long enough for the startup-grace timer and an iRacing exit to both decide
   * "open" and spawn two windows.
   */
  function runStartupNotices(): Promise<void> {
    startupNoticesInFlight ??= startupNotices().finally(() => {
      startupNoticesInFlight = undefined;
    });

    return startupNoticesInFlight;
  }

  async function startupNotices(): Promise<void> {
    // Nothing meaningful to compare before the first settings arrival.
    const open = openSettingsWindow;

    if (!open) return;

    const settings = getGlobalSettings();
    const s = settings as Record<string, unknown>;

    // Reads the last-seen version from the passthrough `_lastSeenVersion` key
    // and persists the running version. No-op for pre-release builds and
    // same/older versions. `type` is the connected deck's type id where the
    // host extension reports one (Stream Deck), omitted otherwise (Mirabox,
    // Ulanzi expose none); the browser opens through the adapter's `openUrl`.
    // On Mirabox that is best-effort: harmless if the Stream Dock host ignores it.
    // The `changelogNotification` preference (issue #742)
    // decides whether a due changelog opens, is recorded silently, or stays
    // pending (monthly window, anchored on the passthrough
    // `_lastChangelogOpenedAt` key).
    // The first-run check runs FIRST and may consume the start (#1061). That
    // ordering is load-bearing rather than tidy: its evidence for "some build has
    // already started against this store" is the absence of `_lastSeenVersion`,
    // and the changelog check below is precisely what writes that key. It also
    // consumes the start while the settings migration is still pending, so the
    // key stays pristine until the store has settled.
    if (
      await runFirstRunCheck({
        currentVersion: getPluginVersion(),
        firstRunVersion: s[FIRST_RUN_VERSION_KEY],
        lastSeenVersion: s._lastSeenVersion,
        migrationPending: s[MIGRATION_PENDING_KEY],
        isSimRunning: isIRacingActive,
        persist: (partial) => updateGlobalSettings(partial),
        openGettingStarted: () => open({ pane: GETTING_STARTED_PANE }),
        logger,
      })
    ) {
      return;
    }

    await runVersionCheck({
      currentVersion: getPluginVersion(),
      lastSeenVersion: typeof s._lastSeenVersion === "string" ? s._lastSeenVersion : undefined,
      policy: settings.changelogNotification,
      lastOpenedAt: typeof s._lastChangelogOpenedAt === "number" ? s._lastChangelogOpenedAt : undefined,
      ecosystem: getPluginPlatform(),
      deviceType: core.host.extension?.getConnectedDeviceType(),
      isSimRunning: isIRacingActive,
      persist: (version) => updateGlobalSettings({ _lastSeenVersion: version }),
      persistOpenedAt: (timestamp) => updateGlobalSettings({ _lastChangelogOpenedAt: timestamp }),
      openUrl: (url) => core.adapter.openUrl(url),
      logger,
    });
  }

  return {
    run: runStartupNotices,
    arm(open) {
      openSettingsWindow = open;
    },
    // Re-run the check when iRacing exits so a changelog deferred mid-session
    // opens right after the session ends (issue #870) — on hosts without
    // app-monitoring events, via the app monitor's SDK-disconnect fallback. The
    // app monitor notifies after the running flag and the SDK connection are
    // already down, so the isSimRunning gate reads false here. Gated on an open
    // actually being pending: once the version is persisted (or on a pre-release
    // build) every later sim exit would otherwise re-run a dead check and log
    // "Version up to date" for the whole process lifetime.
    onSimExited() {
      const s = getGlobalSettings() as Record<string, unknown>;
      const lastSeen = typeof s._lastSeenVersion === "string" ? s._lastSeenVersion : undefined;

      // Also re-run while the Getting Started page is still unresolved (#1061):
      // on a pre-release build `shouldOpenChangelog` is always false, so without
      // this a first-run open deferred by the sim gate would never be retried.
      if (!s[FIRST_RUN_VERSION_KEY]) {
        void runStartupNotices();

        return;
      }

      if (!shouldOpenChangelog(getPluginVersion(), lastSeen)) return;

      void runStartupNotices();
    },
  };
}
