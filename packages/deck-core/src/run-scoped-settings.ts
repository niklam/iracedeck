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
 * Enrolling a key here settles that for good. It is stripped at every boundary
 * an older value could cross back in through:
 *
 * - out of everything entering the cache in `global-settings.ts` (file load,
 *   the one-time deck-host migration, a fresh start), so a record written by
 *   an earlier run — or an earlier VERSION — can never be read back in;
 * - out of everything handed to `SettingsStore.save()`, so it stops being
 *   written in the first place and a file that already carries one is cleaned
 *   on the next save; and
 * - out of every `setGlobalSettings` a UI sends the settings server
 *   (`settings-window-server.ts`). No page is ever the producer of an
 *   observation about this run, and sdpi saves its WHOLE snapshot on any
 *   change — a snapshot that can predate the cache, since a Property
 *   Inspector bootstraps off the once-per-start deck-host mirror before its
 *   first loopback push arrives.
 *
 * Nothing else changes: the key still lives in the cache for the whole run,
 * still fans out to `onGlobalSettingsChange`, and still rides the once-per-start
 * deck-host mirror. Note what that last one does and does not buy on the
 * fallback path (a UI with no loopback channel, which reads the host copy and
 * nothing else): it carries whatever was raised BEFORE the mirror went out —
 * the settings-window failure banners, which is the case it exists for — but
 * an enrolled key written later in the run has no route there at all, and no
 * longer arrives one run late the way a persisted copy used to. The elevation
 * banner (raised on an iRacing connection, always after startup) is the one
 * that loses by it.
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
import { VOICE_PACK_STATUS_KEY, VOICE_PACKS_KEY } from "./voice-pack-constants.js";

/**
 * The enrolled keys. Each is an observation about THIS run rather than a user
 * choice: the PI warning banners, and the list of voice packs currently on disk
 * (issue #1034 — persisting it would let a deleted pack reappear after a
 * restart, with nothing in any UI able to clear it).
 */
export const RUN_SCOPED_SETTING_KEYS: readonly string[] = [PI_WARNINGS_KEY, VOICE_PACKS_KEY, VOICE_PACK_STATUS_KEY];

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

/**
 * True when `keys` is non-empty and every one of them is enrolled — i.e. the
 * write it describes cannot change a single byte of the settings file.
 *
 * Used to skip the store save on such a write. Without it every
 * `setWarning`/`clearWarning` costs a debounced atomic rewrite of an
 * unchanged file, plus the write-retry schedule and its error logging on a
 * machine where the file is momentarily locked — all for a key the file never
 * contains. Safe with the "save the LIVE cache, never a snapshot" rule (#441):
 * a listener that layers a durable partial on top during the fan-out issues
 * its own write, which persists the live cache including everything above it.
 *
 * Empty means false: a caller with nothing to write should not be told its
 * write was run-scoped.
 */
export function hasOnlyRunScopedKeys(keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((key) => RUN_SCOPED_SETTING_KEYS.includes(key));
}
