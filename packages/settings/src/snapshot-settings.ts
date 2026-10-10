/**
 * The global settings as the Telemetry Snapshot records them (issue #1387).
 *
 * A snapshot is a file the user sends to someone else, so this reader decides
 * what of the settings may leave the machine. Design:
 * docs/superpowers/specs/2026-10-10-issue-1387-snapshot-plugin-state.md.
 */
import { PI_WARNINGS_KEY } from "@iracedeck/app-constants";

import { getGlobalSettings } from "./global-settings.js";
import { parseStoredWarnings } from "./pi-warnings.js";

/** What marks a settings key as internal: plugin-written, not a user choice. */
const INTERNAL_KEY_PREFIX = "_";

/**
 * Turns a kept internal key's stored value into what the snapshot records.
 *
 * An internal key is a passthrough key: the settings schema never validates it,
 * so the stored value can be of any shape, whoever was meant to write it. The
 * reader is what decides which part of it may leave the machine, and it returns
 * data of its own making — validated, and nothing it did not check.
 */
type KeptInternalKeyReader = (stored: unknown) => unknown;

/**
 * The internal keys the snapshot keeps, each with the reader its value goes
 * through. There is deliberately no generic reader and no default: a key cannot
 * be kept without naming how it is validated, so a new one cannot arrive in the
 * file as whatever happened to be stored.
 *
 * `_warnings` is here because the banners a user was shown are exactly what
 * support asks about. It goes through the banners' own validated read, so the
 * snapshot holds the well-formed `{ id, level, message }` records and nothing
 * else the value carried.
 *
 * Adding a key is a decision about what leaves the user's machine: read what
 * its producers put in it first, and give it a reader that admits only that.
 *
 * A `Map`, not an object: the lookup is by a key read from stored settings, and
 * an object would answer `__proto__` or `constructor` with something inherited.
 */
const KEPT_INTERNAL_KEY_READERS: ReadonlyMap<string, KeptInternalKeyReader> = new Map<string, KeptInternalKeyReader>([
  [PI_WARNINGS_KEY, parseStoredWarnings],
]);

/** Internal keys the snapshot keeps. Everything else starting with `_` is dropped. */
export const SNAPSHOT_KEPT_INTERNAL_KEYS: readonly string[] = [...KEPT_INTERNAL_KEY_READERS.keys()];

/**
 * The settings for the snapshot's `settings` section: every top-level key that
 * does not start with `_`, plus the internal keys named in
 * {@link SNAPSHOT_KEPT_INTERNAL_KEYS}.
 *
 * **The rule is an allow-list, and must stay one.** One internal key,
 * `_settingsChannel`, holds the loopback settings server's port and the token
 * that authorises requests to it, and a snapshot is sent to other people.
 * Dropping every `_` key that is not named means an internal key added later is
 * excluded without anyone remembering this file. A list of the keys known to be
 * secret would let the next one through — do not invert it.
 *
 * A kept internal key is not copied either: its value goes through that key's
 * own reader, which validates it. `_warnings` yields the well-formed warning
 * records, as data rather than the JSON string the settings hold; a malformed
 * record is left out, and a value that is not a list of records yields none.
 * The snapshot does not say that something was left out.
 *
 * The rule reads top-level keys only. A value under an ordinary key is returned
 * whole, whatever its own keys are called, and is never parsed: a key binding
 * is a JSON string too, and the snapshot shows it as the settings hold it.
 *
 * Synchronous and side-effect-free, as every snapshot reader is: it returns a
 * new top-level object and never mutates what it reads. The values under
 * ordinary keys are the settings' own, not copies, so a caller must not write
 * to them.
 *
 * It never throws for settings that are not up yet. Before `initGlobalSettings`
 * has run, and until the store has loaded, the cache is the schema defaults, so
 * that is what comes back — with no internal keys, since nothing has written
 * one. It is the state the plugin was acting on at that moment.
 *
 * @param settings - The settings to filter; the live cache when omitted.
 */
export function readSettingsForSnapshot(
  settings: Record<string, unknown> = getGlobalSettings(),
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(INTERNAL_KEY_PREFIX)) {
      kept[key] = value;
      continue;
    }

    const read = KEPT_INTERNAL_KEY_READERS.get(key);

    if (read !== undefined) kept[key] = read(value);
  }

  return kept;
}
