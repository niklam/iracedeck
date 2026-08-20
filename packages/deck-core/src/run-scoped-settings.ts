/**
 * Settings keys that describe THIS RUN and must never reach the settings file
 * (issue #1014).
 *
 * Global settings are one durable document, and almost everything in it is a
 * user choice that must outlive the process. A few keys are not: they are
 * *observations* the plugin makes about the run it is currently in, published
 * through the same cache only because that is how anything reaches a Property
 * Inspector. `_warnings` is the case that forced the distinction — a banner
 * raised by a condition that has since gone (or by a build that no longer
 * exists) came back on every start, and nothing in the UI could dismiss it,
 * because a state-driven banner is only ever retired by its own producer
 * saying "not any more".
 *
 * Enrolling a key here settles that for good. It is stripped at BOTH ends of
 * the persistence boundary in `global-settings.ts`:
 *
 * - out of everything entering the cache (file load, the one-time deck-host
 *   migration, a salvaged parse), so a record written by an earlier run — or
 *   an earlier VERSION — can never be read back in; and
 * - out of everything handed to `SettingsStore.save()`, so it stops being
 *   written in the first place and a file that already carries one is cleaned
 *   on the next save.
 *
 * Nothing else changes: the key still lives in the cache for the whole run,
 * still fans out to `onGlobalSettingsChange`, and still rides the once-per-start
 * deck-host mirror — which is what keeps warnings visible on the fallback path
 * where there is no settings server to read them from.
 *
 * The rule this buys, and the one an enrolled key's producer owes in return:
 * **every producer must re-assert its state within the run.** A producer that
 * only speaks when something changes would go silent about a condition that is
 * still true. Today's three all comply — the settings-window reporter reports
 * at `ensureStarted()` on every start, the setup-warning validator runs on the
 * first settings arrival and on every change after it, and the elevation probe
 * runs on each iRacing connection (so its banner is absent, correctly, until
 * there is a live sim to compare integrity levels with).
 *
 * Membership is deliberately explicit rather than a naming convention: plenty
 * of underscore-prefixed keys ARE durable (`_lastSeenVersion`,
 * `_lastChangelogOpenedAt`), and getting that wrong silently loses user state.
 */
import { PI_WARNINGS_KEY } from "./pi-warnings-constants.js";

/**
 * The enrolled keys. One member today; the mechanism is the point — a future
 * observation-of-this-run key joins the list and inherits the whole guarantee.
 */
export const RUN_SCOPED_SETTING_KEYS: readonly string[] = [PI_WARNINGS_KEY];

/**
 * A copy of `settings` with every enrolled key removed.
 *
 * Always a copy, never the input: callers on the write path hand the result
 * straight to the store, and the live cache must not escape there (a store is
 * free to hold onto what it is given). The input is never mutated — the cache
 * keeps its run-scoped keys, which is the entire point of stripping only at
 * the boundary.
 */
export function stripRunScopedKeys(settings: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...settings };

  for (const key of RUN_SCOPED_SETTING_KEYS) delete copy[key];

  return copy;
}
