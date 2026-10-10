/**
 * The global settings as the Telemetry Snapshot records them (issue #1387).
 *
 * A snapshot is a file the user sends to someone else, so this reader decides
 * what of the settings may leave the machine. Design:
 * docs/superpowers/specs/2026-10-10-issue-1387-snapshot-plugin-state.md.
 */
import { PI_WARNINGS_KEY } from "@iracedeck/app-constants";

import { getGlobalSettings } from "./global-settings.js";

/** What marks a settings key as internal: plugin-written, not a user choice. */
const INTERNAL_KEY_PREFIX = "_";

/**
 * Internal keys the snapshot keeps. Everything else starting with `_` is
 * dropped.
 *
 * `_warnings` is here because the banners a user was shown are exactly what
 * support asks about. Adding a key is a decision about what leaves the user's
 * machine, so read what its producers put in it first.
 */
export const SNAPSHOT_KEPT_INTERNAL_KEYS: readonly string[] = [PI_WARNINGS_KEY];

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
 * The rule reads top-level keys only. A value under a kept key or under an
 * ordinary key is returned whole, whatever its own keys are called.
 *
 * A kept internal value stored as a JSON string (`_warnings` is one) is parsed,
 * so it reads as data in the file; a string that does not parse is kept as the
 * string. Ordinary keys are never parsed: a key binding is a JSON string too,
 * and the snapshot shows it as the settings hold it.
 *
 * Synchronous and side-effect-free, as every snapshot reader is: it returns a
 * new top-level object and never mutates what it reads. The values under it are
 * the settings' own, not copies, so a caller must not write to them.
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
    } else if (SNAPSHOT_KEPT_INTERNAL_KEYS.includes(key)) {
      kept[key] = parsedIfJson(value);
    }
  }

  return kept;
}

/** A JSON string as the data it holds; anything else, and a string that does not parse, as it is. */
function parsedIfJson(value: unknown): unknown {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
