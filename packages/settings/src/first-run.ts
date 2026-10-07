/**
 * First-run detection and the Getting Started open (issue #1061).
 *
 * Pure decision plus a thin orchestrator, the same split as `version-check.ts`
 * — which this deliberately mirrors, because the two answer the same shaped
 * question on the same startup tick and must not become two mechanisms racing
 * to open a window.
 *
 * WHAT IDENTIFIES A FRESH INSTALL, and why it is not the obvious thing:
 *
 * `getSettingsStoreSource()` cannot answer it, in either direction. `"host"`
 * has no emptiness check on the normal migration path, so a deck host replying
 * `{}` to a brand-new install is indistinguishable from a pre-3.0 upgrade;
 * `"fresh"` means only that the host did not answer within the timeout, which
 * is where a corrupt file lands and — while #1056 stands — where a normal
 * Mirabox upgrade lands; and from the second start onward EVERY install reads
 * `"file"`, because the `"host"` path deletes its markers before persisting.
 *
 * The usable signal is the absence of `_lastSeenVersion`. It has been written
 * on essentially every startup since #680 under every policy except a
 * pre-release build, so its presence means "some iRaceDeck build has completed
 * a startup against this store"; and being a passthrough key, a host migration
 * carries it across verbatim, so an upgrading user whose host answers is
 * correctly identified as not new whichever source value they landed on.
 *
 * It is pristine ONLY until the changelog check writes it. So the first-run
 * check has to run BEFORE `runVersionCheck` on the same tick — that ordering is
 * a requirement of this design, not an incidental detail, and it is why
 * `runFirstRunCheck` reports whether it consumed the start.
 *
 * The unreadable-file path needs no handling here: it never becomes ready, so
 * the `isSettingsStoreReady()` gate every caller already has excludes it.
 *
 * Two cases stay ambiguous BY CONSTRUCTION — a corrupt file moved aside, and a
 * host that never answers — because a defaults-born store is genuinely
 * indistinguishable from a new install. Each costs one Getting Started page,
 * once. That is accepted and documented rather than guessed at with a
 * heuristic over settings content, which cannot work: `.default(...)` fills
 * every schema-backed field on every parse, so a stored value is no evidence
 * that a user chose anything.
 */
import type { ILogger } from "@iracedeck/logger";

/** Passthrough global-settings key: the plugin version that resolved the first-run decision. */
export const FIRST_RUN_VERSION_KEY = "_firstRunVersion";

/** The settings-window pane the first-run open lands on. */
export const GETTING_STARTED_PANE = "getting-started";

/**
 * What to do about the Getting Started page on this start.
 *
 * - `open` — a genuinely fresh install: show the page, then record it.
 * - `record-silently` — an existing install: record the decision, show nothing.
 * - `defer` — undecidable right now; record nothing and re-ask on a later start.
 * - `skip` — already decided by an earlier start.
 */
export type FirstRunDecision = "open" | "record-silently" | "defer" | "skip";

/** Whether a stored marker counts as set. Any non-empty value was written by us. */
function isSet(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";

  return value !== undefined && value !== null && value !== false && value !== 0;
}

/**
 * Decide what the Getting Started page should do on this start.
 *
 * `lastSeenVersion` counts as evidence of prior use whenever it is a non-empty
 * string, which is deliberately WEAKER than `shouldOpenChangelog`'s test: a
 * malformed value is useless for comparing versions but still proves some build
 * wrote it here, and proving that is this function's whole job.
 */
export function resolveFirstRunDecision(params: {
  firstRunVersion?: unknown;
  lastSeenVersion?: unknown;
  /** The `_migrationPending` countdown, when the store still carries one. */
  migrationPending?: unknown;
}): FirstRunDecision {
  if (isSet(params.firstRunVersion)) return "skip";

  // While the countdown is set the store is explicitly provisional: a host
  // answer may still arrive on a later start and prove this an upgrade. Decide
  // nothing — and note the caller must hold the changelog check too, since that
  // is what would write `_lastSeenVersion` and destroy the evidence.
  if (isSet(params.migrationPending)) return "defer";

  if (typeof params.lastSeenVersion === "string" && params.lastSeenVersion.trim() !== "") return "record-silently";

  return "open";
}

/**
 * Run the first-run check, opening the Getting Started page when it is due.
 *
 * @returns whether this start was CONSUMED — when true the caller must skip its
 *   changelog check, because either the page opened (release notes for a
 *   product never run are noise, and two windows at once are worse than either)
 *   or the decision was deferred and `_lastSeenVersion` must stay untouched.
 */
export async function runFirstRunCheck(opts: {
  currentVersion: string;
  firstRunVersion?: unknown;
  lastSeenVersion?: unknown;
  migrationPending?: unknown;
  /** #870: never open over a live race. Same delegate `runVersionCheck` takes. */
  isSimRunning?: () => boolean;
  /**
   * Writes the decision's keys — ONE call, so they cannot half-land.
   *
   * An open records both `_firstRunVersion` and `_lastSeenVersion`; splitting
   * that across two `updateGlobalSettings` calls would be two merges, two Zod
   * re-parses and two listener fan-outs for one decision, and a crash between
   * them would leave the page consumed with the changelog still pending. Same
   * reasoning as `reconcileWarnings`.
   */
  persist: (settings: Record<string, unknown>) => void;
  /** Opens the settings window on the Getting Started pane. */
  openGettingStarted: () => void | Promise<unknown>;
  logger: ILogger;
}): Promise<boolean> {
  const { logger } = opts;
  const decision = resolveFirstRunDecision(opts);

  if (decision === "skip") {
    logger.debug("Getting Started already resolved; nothing to do");

    return false;
  }

  if (decision === "defer") {
    logger.info("Getting Started deferred: the settings migration has not settled");

    return true;
  }

  if (decision === "record-silently") {
    logger.debug("Existing installation; Getting Started not shown");
    opts.persist({ [FIRST_RUN_VERSION_KEY]: opts.currentVersion });

    return false;
  }

  if (opts.isSimRunning?.()) {
    logger.info("Getting Started deferred while iRacing is running");

    return true;
  }

  try {
    await opts.openGettingStarted();
  } catch (error: unknown) {
    // Persist NOTHING. This flag means "the user was shown this", and a
    // rejected open means they were not — the opposite trade-off to
    // `runVersionCheck`'s persist-first, which exists to avoid re-interrupting
    // somebody. Nothing loops: the retry is one attempt per start and it
    // produces no window by definition.
    logger.warn("Getting Started could not be opened; it will be tried again on the next start");
    logger.debug(String(error));

    return true;
  }

  logger.info("Getting Started opened for a new installation");
  // Both keys in ONE write. The changelog is suppressed on this start rather
  // than opened alongside, so the version must be marked seen or the next start
  // would open it as a pending release. `_lastChangelogOpenedAt` is deliberately
  // NOT stamped: nothing opened, and leaving that anchor unset is what makes a
  // later switch to `monthly` open at the next upgrade rather than waiting 30
  // days from a page nobody saw.
  opts.persist({ [FIRST_RUN_VERSION_KEY]: opts.currentVersion, _lastSeenVersion: opts.currentVersion });

  return true;
}
