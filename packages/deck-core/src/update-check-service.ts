/**
 * The plugin's upstream update check (issue #1016).
 *
 * Composes the pure pieces around the one network call: read the user's
 * preference, fetch the published changelog at most once per TTL, and report
 * which releases are newer than the running build. The settings window asks
 * this through `GET /updates/status`; nothing else consumes it.
 *
 * Three properties it must keep:
 *
 * - **Nothing happens unless someone asks.** There is no timer and no startup
 *   fetch: the only caller is the window's What's New tab, so a user who never
 *   opens the window never generates a request.
 * - **The preference is authoritative, and read live.** `isEnabled()` is
 *   consulted on every call, so switching the setting off stops the plugin
 *   talking to iracedeck.com without a restart, and the page never gets to
 *   decide whether a request happens.
 * - **It cannot fail loudly.** Every path returns a status; nothing throws,
 *   nothing rejects. A tab that cannot reach the site is the tab as it was
 *   before this feature existed.
 *
 * The cache holds the fetched RELEASES, not the derived status, so the running
 * version is re-applied on every call — an update installed while the window
 * is open stops being "available" without waiting for the TTL.
 */
import type { ILogger } from "@iracedeck/logger";

import { fetchPublishedChangelog } from "./changelog-feed-client.js";
import type { PublishedRelease } from "./published-changelog.js";
import { selectAvailableUpdates } from "./update-check.js";

/** How long a successful check is reused. One window session, comfortably. */
export const UPDATE_CHECK_SUCCESS_TTL_MS = 60 * 60 * 1000;

/**
 * How long a FAILED check is reused. Much shorter than the success TTL: the
 * usual cause is a machine that was offline, and "I reconnected and reopened
 * the window" should not mean waiting an hour to find out.
 */
export const UPDATE_CHECK_FAILURE_TTL_MS = 5 * 60 * 1000;

/** What the window is told. `ok` is the only state that renders anything. */
export type UpdateStatus =
  | { state: "disabled"; installedVersion: string }
  | { state: "unavailable"; installedVersion: string }
  | {
      state: "ok";
      installedVersion: string;
      latestVersion: string;
      releases: PublishedRelease[];
      checkedAt: number;
    };

export interface UpdateCheckServiceDeps {
  /** The `updateCheck` global setting, read live on every call. */
  isEnabled: () => boolean;
  /** The running plugin version (`getPluginVersion()`). */
  getInstalledVersion: () => string;
  /** Override the artifact URL. Tests only; never taken from a request. */
  url?: string;
  /** Injected `fetch`, so tests never touch the network. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
  logger: ILogger;
}

export interface UpdateCheckService {
  /** The current update status. Never rejects. */
  get(): Promise<UpdateStatus>;
}

export function createUpdateCheckService(deps: UpdateCheckServiceDeps): UpdateCheckService {
  const {
    isEnabled,
    getInstalledVersion,
    url,
    fetchImpl,
    now = () => Date.now(),
    successTtlMs = UPDATE_CHECK_SUCCESS_TTL_MS,
    failureTtlMs = UPDATE_CHECK_FAILURE_TTL_MS,
    logger,
  } = deps;

  let cached: { releases: PublishedRelease[] | undefined; at: number } | undefined;
  // One request at a time: two panes asking at once (or a reopened window
  // racing itself) must not become two outbound requests.
  let inFlight: Promise<PublishedRelease[] | undefined> | undefined;

  function isFresh(entry: { releases: PublishedRelease[] | undefined; at: number }): boolean {
    const ttl = entry.releases === undefined ? failureTtlMs : successTtlMs;

    return now() - entry.at < ttl;
  }

  async function releases(): Promise<PublishedRelease[] | undefined> {
    if (cached !== undefined && isFresh(cached)) return cached.releases;

    inFlight ??= fetchPublishedChangelog({ url, fetchImpl }).then((result) => {
      cached = { releases: result, at: now() };
      inFlight = undefined;

      if (result === undefined) {
        logger.info("Update check could not reach the changelog");
      } else {
        logger.debug(`Update check fetched ${result.length} published releases`);
      }

      return result;
    });

    return inFlight;
  }

  return {
    async get(): Promise<UpdateStatus> {
      let installedVersion = "";

      try {
        installedVersion = getInstalledVersion();

        if (!isEnabled()) return { state: "disabled", installedVersion };

        const published = await releases();

        if (published === undefined) return { state: "unavailable", installedVersion };

        const available = selectAvailableUpdates({ installedVersion, releases: published });

        if (available.length === 0) return { state: "unavailable", installedVersion };

        logger.info("Update check found a newer version");
        logger.debug(`Installed ${installedVersion}, latest ${available[0].version}`);

        return {
          state: "ok",
          installedVersion,
          latestVersion: available[0].version,
          releases: available,
          checkedAt: now(),
        };
      } catch (error: unknown) {
        // A throwing delegate (a settings read, a version lookup) must not
        // turn into a rejected request the server would have to handle.
        logger.warn("Update check failed");
        logger.debug(String(error));

        return { state: "unavailable", installedVersion };
      }
    },
  };
}
