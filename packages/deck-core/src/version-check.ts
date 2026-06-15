/**
 * Version-check / "what's new" changelog opener (issue #680).
 *
 * On startup the plugin compares its current version against the last version
 * the user has seen. When a strictly newer *stable* release is detected it opens
 * the iRaceDeck changelog page (scoped to the active ecosystem and device type)
 * exactly once, recording the current version so the page never re-opens for the
 * same release. Pre-release builds (rc/dev) are intentionally skipped so testers
 * are not nagged on every dev bump.
 *
 * The logic is pure and side-effect-free except `runVersionCheck`, which is the
 * orchestrator: it takes injected `persist`/`openUrl` delegates so the module
 * stays platform-agnostic (no Stream Deck / Mirabox dependency).
 */
import type { ILogger } from "@iracedeck/logger";
import { gt, prerelease, valid } from "semver";

/** Base URL of the iRaceDeck changelog page. */
export const CHANGELOG_BASE_URL = "https://iracedeck.com/changelog/";

/**
 * Decide whether the changelog should open for the current run.
 *
 * Returns `false` when `current` is not a valid semver or is a pre-release
 * (rc/dev builds never trigger the changelog). Returns `true` on first run —
 * when `lastSeen` is missing or unparseable — otherwise only when `current` is
 * strictly newer than `lastSeen`.
 */
export function shouldOpenChangelog(current: string, lastSeen: string | null | undefined): boolean {
  if (!valid(current) || prerelease(current) !== null) {
    return false;
  }

  if (!lastSeen || !valid(lastSeen)) {
    return true;
  }

  return gt(current, lastSeen);
}

/**
 * Build the changelog URL, always carrying the `ecosystem` query parameter and
 * adding a `type` parameter only when `deviceType` is provided and non-empty.
 */
export function buildChangelogUrl(p: { ecosystem: string; deviceType?: string | number }): string {
  const q = new URLSearchParams();
  q.append("ecosystem", p.ecosystem);

  if (p.deviceType !== undefined && p.deviceType !== "") {
    q.append("type", String(p.deviceType));
  }

  return `${CHANGELOG_BASE_URL}?${q.toString()}`;
}

/**
 * Orchestrate the version check: when a newer stable release is due, persist the
 * current version FIRST (so a flaky `openUrl` can never re-trigger on the next
 * run) and then open the changelog URL. Opening failures are swallowed and
 * logged — they must not crash startup.
 */
export async function runVersionCheck(opts: {
  currentVersion: string;
  lastSeenVersion: string | null | undefined;
  ecosystem: string;
  deviceType?: string | number;
  persist: (version: string) => void;
  openUrl: (url: string) => void | Promise<void>;
  logger: ILogger;
}): Promise<void> {
  const { currentVersion, lastSeenVersion, ecosystem, deviceType, persist, openUrl, logger } = opts;

  if (!shouldOpenChangelog(currentVersion, lastSeenVersion)) {
    if (prerelease(currentVersion) !== null) {
      logger.info("Pre-release version, skipping changelog check");
    } else {
      logger.info("Version up to date");
    }

    logger.debug(`Current version: ${currentVersion}, last seen: ${lastSeenVersion ?? "(none)"}`);

    return;
  }

  // Persist FIRST so a failed openUrl never re-triggers the changelog next run.
  persist(currentVersion);

  const url = buildChangelogUrl({ ecosystem, deviceType });
  logger.info("New version detected, opening changelog");
  logger.debug(`Current version: ${currentVersion}, last seen: ${lastSeenVersion ?? "(none)"}, url: ${url}`);

  try {
    await openUrl(url);
  } catch (error) {
    logger.warn("Failed to open changelog");
    logger.debug(`Open changelog error: ${String(error)}`);
  }
}
