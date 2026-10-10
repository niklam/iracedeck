/**
 * The global settings as the Telemetry Snapshot records them (issue #1387).
 *
 * A snapshot is a file the user sends to someone else, so this reader decides
 * what of the settings may leave the machine. Design:
 * docs/superpowers/specs/2026-10-10-issue-1387-snapshot-plugin-state.md.
 */
import { PI_WARNINGS_KEY, VOICE_PACKS_KEY } from "@iracedeck/app-constants";
import { z } from "zod";

import { getGlobalSettings, MIGRATION_ABANDONED_KEY, MIGRATION_PENDING_KEY } from "./global-settings.js";
import { parseStoredWarnings } from "./pi-warnings.js";

/** What marks a settings key as internal: plugin-written, not a user choice. */
const INTERNAL_KEY_PREFIX = "_";

/**
 * The key the changelog version check and the first-run check record the
 * running version under. No package exports a constant for it: its writers
 * (`first-run.ts` here, `plugin-runtime`'s settings phase) spell the literal,
 * so this is one more copy. The reader's test goes through the real first-run
 * writer, which fails if the two drift apart.
 */
const LAST_SEEN_VERSION_KEY = "_lastSeenVersion";

/** The longest string read as a plugin version: `semver`'s own `MAX_LENGTH`. */
const VERSION_MAX_LENGTH = 256;

/**
 * Turns a kept internal key's stored value into what the snapshot records, or
 * returns `undefined` when the value is not in the form the key is documented
 * to hold.
 *
 * An internal key is a passthrough key: the settings schema never validates it,
 * so the stored value can be of any shape, whoever was meant to write it. The
 * reader is what decides which part of it may leave the machine, and it returns
 * data of its own making — validated, and nothing it did not check.
 */
type KeptInternalKeyReader = (stored: unknown) => unknown;

/** A plugin version as a key stores it: any string no longer than a version can be. */
function readStoredVersion(stored: unknown): string | undefined {
  return typeof stored === "string" && stored.length <= VERSION_MAX_LENGTH ? stored : undefined;
}

/** `_migrationPending`: how many starts the deck host left the migration read unanswered. */
function readStoredMigrationPending(stored: unknown): number | undefined {
  return typeof stored === "number" && Number.isFinite(stored) && stored >= 0 ? stored : undefined;
}

/** `_migrationAbandoned`: the plugin version that gave up on the migration, or `true` from a build that could not name its own. */
function readStoredMigrationAbandoned(stored: unknown): string | true | undefined {
  return stored === true ? true : readStoredVersion(stored);
}

/**
 * The fields of the `_voicePacks` scan result the snapshot records, each named.
 *
 * The payload is `plugin-runtime`'s (its voice-pack phase builds it from the
 * scan) and no package this one may depend on exports its type, so the shape is
 * restated here on purpose: an object schema strips every field it does not
 * name, so a field added to the payload later is not written until someone adds
 * it here, having read what it holds.
 *
 * **`packs[].dir` is not named, and must not be.** It is the absolute directory
 * of a development-root pack, so it carries the Windows user name.
 * `provenance: "development"` already says that a development root is in use.
 *
 * `provenance` is a string rather than the scanner's list of values: that list
 * is the voice-pack stack's, and a value it gains should not cost the snapshot
 * the whole scan.
 */
const SnapshotVoicePacksSchema = z.object({
  packs: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      version: z.string(),
      voices: z.array(z.object({ id: z.string(), label: z.string() })),
      provenance: z.string(),
      managed: z.boolean(),
    }),
  ),
  problems: z.array(z.object({ pack: z.string(), reason: z.string() })),
});

/**
 * `_voicePacks`: the last voice-pack scan, stored as a JSON string.
 *
 * All or nothing: the payload has one writer and one shape, so a value that
 * does not match it whole is not that payload, and a part of it would read as a
 * scan that found less than it did.
 */
function readStoredVoicePacks(stored: unknown): z.infer<typeof SnapshotVoicePacksSchema> | undefined {
  if (typeof stored !== "string") return undefined;

  try {
    const result = SnapshotVoicePacksSchema.safeParse(JSON.parse(stored));

    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The internal keys the snapshot keeps, each with the reader its value goes
 * through. There is deliberately no generic reader and no default: a key cannot
 * be kept without naming how it is validated, so a new one cannot arrive in the
 * file as whatever happened to be stored.
 *
 * Each is here because support asks about it:
 *
 * - `_warnings` — the banners the user was shown. Read through the banners' own
 *   validated read, so the snapshot holds the well-formed
 *   `{ id, level, message }` records and nothing else the value carried. A
 *   message is written as it was posted, and two banners name the settings
 *   file's path, Windows user name included; that is accepted in a snapshot, so
 *   do not redact it here.
 * - `_lastSeenVersion` — the version last recorded at a start. Its absence is
 *   the first-run signal.
 * - `_migrationPending` and `_migrationAbandoned` — whether the settings were
 *   ever read from the deck host, which is the question behind "my settings
 *   reverted".
 * - `_voicePacks` — what the voice-pack scan found and what it refused, which
 *   is the question behind "the engineer is silent".
 *
 * **Not here, and not to be added by reflex:**
 *
 * - `_settingsChannel` — the loopback settings server's port and the token
 *   that authorises requests to it. Never.
 * - `_voicePackStatus` — the whole downloadable catalog and the transient
 *   install phases: bulky, and stale by design.
 * - Every other `_` key, by the allow-list rule on
 *   {@link readSettingsForSnapshot}. Several hold a path with the user name in
 *   it (`_settingsStorePath`) or a list of the machine's devices.
 *
 * Adding a key is a decision about what leaves the user's machine: read what
 * its producers put in it first, and give it a reader that admits only that.
 *
 * A `Map`, not an object: the lookup is by a key read from stored settings, and
 * an object would answer `__proto__` or `constructor` with something inherited.
 */
const KEPT_INTERNAL_KEY_READERS: ReadonlyMap<string, KeptInternalKeyReader> = new Map<string, KeptInternalKeyReader>([
  [PI_WARNINGS_KEY, parseStoredWarnings],
  [LAST_SEEN_VERSION_KEY, readStoredVersion],
  [MIGRATION_PENDING_KEY, readStoredMigrationPending],
  [MIGRATION_ABANDONED_KEY, readStoredMigrationAbandoned],
  [VOICE_PACKS_KEY, readStoredVoicePacks],
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
 * own reader, which validates it and returns data rather than the JSON string
 * the settings may hold. Three outcomes, and they read differently on purpose:
 *
 * - **The settings do not hold the key** (or hold `undefined`): the snapshot
 *   does not either. Absence stays absence — a missing `_lastSeenVersion` is
 *   the first-run signal, and a `null` in its place would blur it.
 * - **The value is in the key's documented form**: the snapshot holds what the
 *   reader admitted.
 * - **The key is there but its value is not in that form**: the snapshot holds
 *   `{ "rejected": true }` under the key, and nothing of the value. Leaving the
 *   key out would read as the first case, and the plugin does not treat the two
 *   alike: a `_migrationAbandoned` of `1` still counts as set.
 *
 * `_warnings` has no third outcome. Its reader is the banners' own, which
 * reads a value that is not a list of records as no banners, so that is what
 * the snapshot shows; a malformed record in a list is left out on its own, and
 * the snapshot does not say so.
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

    // A key holding `undefined` is a key the settings do not hold.
    if (read === undefined || value === undefined) continue;

    const admitted = read(value);

    kept[key] = admitted === undefined ? rejectedValue() : admitted;
  }

  return kept;
}

/** What the snapshot holds for a kept key whose value its reader refused: the fact, and none of the value. */
function rejectedValue(): { rejected: true } {
  return { rejected: true };
}
