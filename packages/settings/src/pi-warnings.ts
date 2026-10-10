/**
 * Reusable Property Inspector warning store (issue #610).
 *
 * Warning records live in the `_warnings` global setting as a JSON array. Each
 * record is keyed by `id` so independent producers (e.g. the elevation-mismatch
 * detector) can post and clear their own banner without clobbering others. The
 * `ird-warnings` PI component renders the array at the top of every Property
 * Inspector.
 *
 * The key is RUN-SCOPED (issue #1014): it is enrolled in
 * `RUN_SCOPED_SETTING_KEYS`, so it lives in the settings cache and reaches
 * every UI exactly as before, but never reaches the settings file. A banner is
 * a statement about the run making it — persisting one let it outlive both its
 * condition and, across a version change, the producer that could retire it,
 * and nothing in the UI can dismiss a state-driven banner. In exchange, every
 * producer must re-assert its state within the run; see `run-scoped-settings.ts`.
 */
import { PI_WARNING_LEVELS, PI_WARNINGS_KEY, type PiWarning, type PiWarningLevel } from "@iracedeck/app-constants";
import { z } from "zod";

import { getGlobalSettings, updateGlobalSettings } from "./global-settings.js";

/**
 * Schema for one warning record. `_warnings` is plugin-written, but it
 * round-trips through global settings (mirrored to the deck host, echoed back,
 * and written by a Property Inspector saving its whole page), so every entry is
 * validated before `setWarning`/`clearWarning` dereference `w.id`. Validating
 * settings shapes with Zod follows the convention of `global-settings.ts` here
 * and deck-core's `common-settings.ts`.
 */
const PiWarningSchema = z.object({
  id: z.string(),
  level: z.enum(PI_WARNING_LEVELS),
  message: z.string(),
});

/**
 * The well-formed warning records a stored `_warnings` value holds: the one
 * validated read of the key, whoever asks.
 *
 * The value is a JSON array of records. Anything else — a value that is not a
 * string, text that is not JSON, JSON that is not an array — holds no records,
 * and a list entry that is not a `{ id, level, message }` record is left out on
 * its own, so one bad entry does not cost the rest. A record comes back as a
 * new object with those three fields and nothing else: a field the schema does
 * not name is stripped.
 *
 * It bounds SHAPE, not size: a well-formed record is returned whatever the
 * length of its message, and however many there are.
 *
 * Pure, so the Telemetry Snapshot's settings reader (`snapshot-settings.ts`,
 * #1387) validates a value it was handed through the same step the banners'
 * own read of the cache goes through.
 */
export function parseStoredWarnings(stored: unknown): PiWarning[] {
  if (typeof stored !== "string" || stored === "") return [];

  try {
    const parsed: unknown = JSON.parse(stored);

    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((item) => {
      const result = PiWarningSchema.safeParse(item);

      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

function readWarnings(): PiWarning[] {
  return parseStoredWarnings((getGlobalSettings() as Record<string, unknown>)[PI_WARNINGS_KEY]);
}

/**
 * Upsert a warning by id. Replaces an existing record with the same id;
 * appends otherwise. Skips the write when an identical record already exists
 * so it never churns global settings on repeated calls.
 */
export function setWarning(id: string, level: PiWarningLevel, message: string): void {
  const list = readWarnings();
  const existing = list.find((w) => w.id === id);

  if (existing && existing.level === level && existing.message === message) return;

  const next = list.filter((w) => w.id !== id);
  next.push({ id, level, message });
  updateGlobalSettings({ [PI_WARNINGS_KEY]: JSON.stringify(next) });
}

/**
 * Remove the warning with the given id. No-op (no write) when absent.
 */
export function clearWarning(id: string): void {
  const list = readWarnings();
  const next = list.filter((w) => w.id !== id);

  if (next.length === list.length) return;

  updateGlobalSettings({ [PI_WARNINGS_KEY]: JSON.stringify(next) });
}

/**
 * Reconcile one producer's whole family of ids in a SINGLE write: every id in
 * `scope` is dropped, then everything in `warnings` is appended. Records
 * outside `scope` are untouched, so producers still coexist.
 *
 * A producer whose condition raises several banners at once (the settings
 * window's page-wide error plus its button note, #1005) would otherwise call
 * `setWarning` once per record, and every one of those is a full
 * `updateGlobalSettings` — a store persist plus a synchronous fan-out to every
 * `onGlobalSettingsChange` listener in the plugin. Reconciling first and
 * writing once keeps that to one. Like its single-record siblings it skips the
 * write entirely when the outcome is what is already stored.
 */
export function reconcileWarnings(scope: readonly string[], warnings: readonly PiWarning[]): void {
  const list = readWarnings();
  const next = [...list.filter((w) => !scope.includes(w.id)), ...warnings.map((w) => ({ ...w }))];

  // Compared by CONTENT, not by array order: the reconciled list moves this
  // producer's records to the end, so an order-sensitive check would rewrite
  // the setting every time another producer happened to post after us, for a
  // set of banners that had not changed at all.
  if (sameRecords(list, next)) return;

  updateGlobalSettings({ [PI_WARNINGS_KEY]: JSON.stringify(next) });
}

function sameRecords(a: PiWarning[], b: PiWarning[]): boolean {
  if (a.length !== b.length) return false;

  const key = (list: PiWarning[]): string =>
    JSON.stringify([...list].sort((x, y) => x.id.localeCompare(y.id)).map((w) => [w.id, w.level, w.message]));

  return key(a) === key(b);
}
