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
 * The `changelogNotification` global setting (issue #742) controls *when* a due
 * changelog actually opens: `always` (every stable update — the pre-#742
 * behavior, and the default until #901), `features` (only major/minor bumps;
 * patch releases record the version silently — the default since #901),
 * `monthly` (at most once per 30 days — a suppressed update stays pending and
 * opens at the first startup after the window passes), or `never` (still
 * records the version silently so re-enabling later doesn't pop an old
 * changelog).
 *
 * The changelog must never open while iRacing is running (issue #870): a due
 * `open` is deferred — nothing persisted, the version stays pending — when the
 * injected `isSimRunning` delegate reports the sim active. Plugins re-run the
 * check when iRacing exits (the app monitor's `onIRacingTerminated` hook) and
 * delay the startup check by {@link VERSION_CHECK_STARTUP_GRACE_MS} so the
 * sim-detection signals (app-monitor launch event, SDK connection) have
 * settled before the first decision — a plugin restarted mid-session by a
 * deck-host auto-update would otherwise check before either signal is up.
 *
 * The logic is pure and side-effect-free except `runVersionCheck`, which is the
 * orchestrator: it takes injected `persist`/`openUrl` delegates so the module
 * stays platform-agnostic (no Stream Deck / Mirabox dependency).
 */
import type { ILogger } from "@iracedeck/logger";
import { gt, major, minor, prerelease, valid } from "semver";

/** Base URL of the iRaceDeck changelog page. */
export const CHANGELOG_BASE_URL = "https://iracedeck.com/changelog/";

/**
 * The `changelogNotification` global-setting values (issue #742). Defined here
 * (not in `global-settings.ts`) so the Zod schema and the decision logic share
 * one source of truth without a dependency cycle.
 */
export const CHANGELOG_NOTIFICATION_POLICIES = ["always", "features", "monthly", "never"] as const;

/** User preference for when the changelog opens after an update. */
export type ChangelogNotificationPolicy = (typeof CHANGELOG_NOTIFICATION_POLICIES)[number];

/**
 * Default `changelogNotification` policy: `never` — nothing opens itself unless
 * the user asks for it (issue #1061). Shared by the `GlobalSettingsSchema` field
 * and `runVersionCheck` so the two can never disagree.
 *
 * This REVERSES #901, which set `features` on Ulanzi's RCA recommendation, and
 * the reversal is deliberate rather than a drift. Two things to know before
 * moving it back:
 *
 * What #901 inherited was a DIRECTION, not a value — the RCA's heading said
 * `features` while the code beneath it said `monthly`, so "not `always`" is all
 * it actually recommended, and `features` was a judgement made on top of that.
 * And the judgement rested on the default being the only lever there was:
 * nobody was ever asked, so the question was purely which setting annoys the
 * fewest people who never chose. The Getting Started page (#1061) asks directly
 * at first run and offers one-press opt-in, so the default's job stops being
 * "guess what most people want" and becomes "do nothing surprising until
 * asked" — the same principle that keeps the Race Engineer off by default.
 *
 * `never` is quiet, not lossy or hiding: it still persists `_lastSeenVersion`
 * via `track-silently`, so switching to another policy later never replays an
 * old release; the notes are compiled into the build and always on the What's
 * New tab; and the #1016 update banner rides the separate `updateCheck`
 * setting. Changing this reaches NEW INSTALLS ONLY — every write persists the
 * whole parsed cache, so existing users keep whatever they already have, and
 * there is deliberately no migration (a persisted value cannot be told apart
 * from a deliberate choice).
 */
export const DEFAULT_CHANGELOG_NOTIFICATION_POLICY: ChangelogNotificationPolicy = "never";

/** Suppression window for the `monthly` policy: 30 days in milliseconds. */
export const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Delay between the first global-settings arrival and the startup version
 * check (issue #870). The sim-running signals the `isSimRunning` delegate
 * reads — the app monitor's `applicationDidLaunch` for an already-running
 * iRacing, and the SDK controller's shared-memory connection — race the
 * settings arrival on a mid-session plugin restart (exactly the deck-host
 * auto-update case), so an immediate check could open the changelog over a
 * live session. By this long after startup both signals are reliably settled;
 * a changelog opening this much later on a sim-free startup is harmless.
 */
export const VERSION_CHECK_STARTUP_GRACE_MS = 15_000;

/**
 * Outcome of a version check under a notification policy:
 *
 * - `open` — persist the version (and the opened-at timestamp), open the changelog.
 * - `track-silently` — persist the version but don't open. Keeps `_lastSeenVersion`
 *   current so switching to a chattier policy later never replays an old release.
 * - `defer` — do nothing at all. The version stays pending, so a later startup
 *   (once the monthly window has passed) opens it.
 * - `skip` — nothing is due (pre-release, invalid, same or older version).
 */
export type ChangelogDecision = "open" | "track-silently" | "defer" | "skip";

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
 * Resolve what to do for the current run under the user's notification policy
 * (issue #742). Pure: the caller supplies `now` and the persisted timestamps.
 *
 * A due update is first established via `shouldOpenChangelog`; anything not due
 * is `skip` regardless of policy. The policy then decides between opening,
 * recording the version silently (`never`, and `features` on a patch-only bump),
 * or deferring untouched (`monthly` inside its window — the version stays
 * pending so the first startup after the window opens it).
 *
 * `features` compares the major/minor components only, so a stored pre-release
 * of the same triple (which can't occur through normal persistence — pre-release
 * runs never persist) counts as a patch-level change. A missing or invalid
 * `lastSeenVersion` is first-run and opens, matching `shouldOpenChangelog`. A
 * missing or non-finite `lastOpenedAt` under `monthly` counts as "long ago".
 */
export function resolveChangelogDecision(p: {
  currentVersion: string;
  lastSeenVersion: string | null | undefined;
  policy: ChangelogNotificationPolicy;
  lastOpenedAt?: number | null;
  now: number;
}): ChangelogDecision {
  const { currentVersion, lastSeenVersion, policy, lastOpenedAt, now } = p;

  if (!shouldOpenChangelog(currentVersion, lastSeenVersion)) {
    return "skip";
  }

  switch (policy) {
    case "never":
      return "track-silently";
    case "features": {
      if (!lastSeenVersion || !valid(lastSeenVersion)) {
        return "open";
      }

      const featureBump =
        major(currentVersion) !== major(lastSeenVersion) || minor(currentVersion) !== minor(lastSeenVersion);

      return featureBump ? "open" : "track-silently";
    }
    case "monthly": {
      if (typeof lastOpenedAt !== "number" || !Number.isFinite(lastOpenedAt)) {
        return "open";
      }

      return now - lastOpenedAt >= MONTHLY_WINDOW_MS ? "open" : "defer";
    }
    default:
      return "open";
  }
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
 * Orchestrate the version check: when a newer stable release is due and the
 * `changelogNotification` policy allows opening, persist the current version
 * FIRST (so a flaky `openUrl` can never re-trigger on the next run), stamp the
 * opened-at timestamp, and then open the changelog URL. Opening failures are
 * swallowed and logged — they must not crash startup.
 *
 * `policy` defaults to {@link DEFAULT_CHANGELOG_NOTIFICATION_POLICY};
 * `lastOpenedAt` / `persistOpenedAt` back the `monthly` window via the passthrough
 * `_lastChangelogOpenedAt` key. The timestamp is stamped on every open under any
 * policy so a later switch to `monthly` has a meaningful anchor.
 *
 * `isSimRunning` (issue #870) gates the `open` outcome only: when it reports
 * true, the open is deferred exactly like the monthly window — nothing
 * persisted, so the version stays pending for a later run (the plugins re-run
 * the check when iRacing exits). It is consulted at decision time, as late as
 * possible, and only when an open is actually due; `track-silently` still
 * persists (nothing would open anyway, and recording the version keeps a later
 * policy switch from replaying an old release).
 */
export async function runVersionCheck(opts: {
  currentVersion: string;
  lastSeenVersion: string | null | undefined;
  policy?: ChangelogNotificationPolicy;
  lastOpenedAt?: number | null;
  now?: number;
  ecosystem: string;
  deviceType?: string | number;
  isSimRunning?: () => boolean;
  persist: (version: string) => void;
  persistOpenedAt?: (timestamp: number) => void;
  openUrl: (url: string) => void | Promise<void>;
  logger: ILogger;
}): Promise<void> {
  const {
    currentVersion,
    lastSeenVersion,
    policy = DEFAULT_CHANGELOG_NOTIFICATION_POLICY,
    lastOpenedAt,
    now = Date.now(),
    ecosystem,
    deviceType,
    isSimRunning,
    persist,
    persistOpenedAt,
    openUrl,
    logger,
  } = opts;

  const decision = resolveChangelogDecision({ currentVersion, lastSeenVersion, policy, lastOpenedAt, now });

  if (decision === "skip") {
    if (prerelease(currentVersion) !== null) {
      logger.info("Pre-release version, skipping changelog check");
    } else {
      logger.info("Version up to date");
    }

    logger.debug(`Current version: ${currentVersion}, last seen: ${lastSeenVersion ?? "(none)"}`);

    return;
  }

  if (decision === "track-silently") {
    persist(currentVersion);
    logger.info("New version detected, changelog suppressed by preference");
    logger.debug(`Current version: ${currentVersion}, last seen: ${lastSeenVersion ?? "(none)"}, policy: ${policy}`);

    return;
  }

  if (decision === "defer") {
    logger.info("New version detected, changelog deferred by the monthly window");
    logger.debug(
      `Current version: ${currentVersion}, last seen: ${lastSeenVersion ?? "(none)"}, last opened: ${lastOpenedAt ?? "(none)"}`,
    );

    return;
  }

  // Never open over a live session (issue #870): defer — persisting nothing —
  // so the version stays pending. Checked before the persist-first write, since
  // a persisted version would mark the release as seen without it ever opening.
  if (isSimRunning?.()) {
    logger.info("New version detected, changelog deferred while iRacing is running");
    logger.debug(`Current version: ${currentVersion}, last seen: ${lastSeenVersion ?? "(none)"}`);

    return;
  }

  // Persist FIRST so a failed openUrl never re-triggers the changelog next run.
  persist(currentVersion);
  persistOpenedAt?.(now);

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
