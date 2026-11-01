import { CALLOUT_FAMILIES, CALLOUT_SETTING_KEYS, calloutIdForKey } from "@iracedeck/callout-settings";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { GlobalSettingsSchema } from "./global-settings.js";

/**
 * Append-only record of every `calloutEnabled*` key: its default, how it
 * coerces a stored value, and the callout it silences. Stored keys are a
 * published contract (`.claude/rules/global-settings.md`), and this record is
 * what holds them to it now that their declaration lives in
 * `@iracedeck/callout-settings` (#1350).
 *
 * Rows are appended when a key is added, and never removed or regenerated.
 * Dropping, renaming or re-defaulting a stored key fails here, which is the
 * moment a migration (or a deliberate, reviewed default change) is owed —
 * never the moment to rewrite the row. Every registry key must have a live
 * row and every live row's key must still be in the registry, so a key added
 * without a row fails as surely as a key removed under one (#1376).
 *
 * Retiring a key on purpose keeps its row too. The change that takes the key
 * out of the registry adds the settings migration
 * (`global-settings-migrations.ts`) for the value users stored under it, and
 * marks the row `"retiredBy": "#<issue>"` — the one field a written row ever
 * gains — and appends the key to `RETIRED_KEYS` below. A retired row's key must then be gone from the registry and from the
 * schema's defaults; its other columns stay as the record of what the key
 * was, and are no longer checked against the schema. A retired key is never
 * reused: a callout that comes back takes a new key and a new row. A rename
 * is both at once — the old key's row retired, the new key's row appended.
 *
 * Adding a callout: append one row at the end of
 * `__fixtures__/callout-settings-baseline.json`, then write the new pin
 * (`RECORD_ROWS`, `RECORD_SHA256` below) that the failing test prints. The row is keyed by the new
 * `calloutEnabled*` key, in the shape of the rows above it —
 * `owner` is `<family id>/<callout id>` from the registry entry, `default` is
 * `true` unless the entry declares `default: false`, and the coercion columns
 * are what every key's shared field does today (`true`/`"true"` → true,
 * `false`/`"false"`/`"x"` → false, a number rejected). Write the row by hand
 * from the entry you just declared; never generate it from the schema, or it
 * would record whatever the schema happens to do.
 *
 * The first 100 rows are the keys as they stood before #1350, captured from
 * master before the registry merged; the `owner` column was added once at
 * that time — for the 95 keys that had an id map on master, from master's
 * `*_CALLOUT_SETTING_KEYS` maps; for the 5 that had none, from the registry's
 * five small families. Rows from 101 on were appended by #1376 for the three
 * keys added in between (`calloutEnabledRollingStartLineupChanged`,
 * `calloutEnabledCautionCatchUp`, `calloutEnabledCautionCatchUpReminder`).
 *
 * `owner` is the one column a live row may change: when an entry moves to
 * another family, its key, default and coercion stay as they were, no stored
 * value moves and no migration is owed, so the owner is updated to the new
 * `<family id>/<callout id>` and nothing else in the row is touched. #1167 did
 * this once, taking `calloutEnabledFlagOnePaceLapToGo` from
 * `flag/one-pace-lap-to-go` to `rolling-start/one-pace-lap-to-go` when the
 * call became a formation call and its checkbox moved under Rolling Start.
 */
interface BaselineRow {
  readonly owner: string;
  readonly default: boolean;
  readonly true: boolean;
  readonly '"true"': boolean;
  readonly false: boolean;
  readonly '"false"': boolean;
  readonly '"x"': boolean;
  readonly numberRejected: boolean;
  /** The issue whose settings migration retired the key, as `#<n>`; absent while the key is live. */
  readonly retiredBy?: string;
}

/** The columns every row carries; `retiredBy` is the one optional column beside them. */
const COLUMNS: readonly string[] = ["owner", "default", "true", '"true"', "false", '"false"', '"x"', "numberRejected"];

/**
 * The pin: how many rows the record held when it was last pinned, live and
 * retired (100 captured before #1350, three appended by #1376), and the
 * SHA-256 of those rows in file order — each row's key and its
 * {@link PINNED_COLUMNS}. The checks further down compare the record with
 * today's registry and schema, so a key dropped together with its row would
 * pass them all, and so would one row swapped for another (the count stays the
 * same) or a default changed in the registry and its row together (no
 * migration seen). The pinned prefix refuses all three: the first
 * `RECORD_ROWS` rows must still hash to the pin. An append leaves that prefix
 * alone, and its test then prints the new pin to write in the same change;
 * nothing else ever moves it.
 */
const RECORD_ROWS = 105;
const RECORD_SHA256 = "e6efa1f3f796a1e9966f0b0773ba32068854c30e80b34e2297ebdfcb153e3ec4";

/**
 * The columns a written row never changes, so the pin covers them: the default
 * and every coercion result. `owner` moves when an entry changes family and
 * `retiredBy` is added on retirement, so neither is pinned.
 */
const PINNED_COLUMNS = COLUMNS.filter((column) => column !== "owner");

const BASELINE_FILE = "packages/settings/src/__fixtures__/callout-settings-baseline.json";

const baseline = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__", "callout-settings-baseline.json"), "utf8"),
) as Record<string, BaselineRow>;

const isRetired = (key: string): boolean => Object.hasOwn(baseline[key], "retiredBy");

/** Rows whose key is still stored and read: every check of the schema and the registry applies to these. */
const liveKeys = Object.keys(baseline).filter((key) => !isRetired(key));

/** Rows a settings migration retired: their key must be gone, and nothing else of them is checked. */
const retiredKeys = Object.keys(baseline).filter(isRetired);

/**
 * Every key ever retired, append-only and kept apart from the rows' markers,
 * since the pin leaves `retiredBy` out (it is added on retirement). Without it,
 * dropping a row's marker and re-adding the key to the registry would make a
 * retired key live again. Retiring a key appends it here as well as marking
 * its row; an entry is never removed, because a retired key is never reused.
 */
const RETIRED_KEYS: readonly string[] = [];

const registryKeys: readonly string[] = CALLOUT_SETTING_KEYS;

const parseKey = (key: string, value: unknown): unknown =>
  (GlobalSettingsSchema.parse({ [key]: value }) as Record<string, unknown>)[key];

/** The SHA-256 `RECORD_SHA256` pins: one line per row, its key then its pinned columns as JSON. */
const recordDigest = (keys: readonly string[]): string =>
  createHash("sha256")
    .update(
      keys
        .map((key) =>
          [key, ...PINNED_COLUMNS.map((c) => JSON.stringify(baseline[key][c as keyof BaselineRow]))].join(" "),
        )
        .join("\n"),
    )
    .digest("hex");

const recordKeys = Object.keys(baseline);

/** Whether the record still opens with exactly the pinned rows, in order. */
const pinnedPrefixIntact =
  recordKeys.length >= RECORD_ROWS && recordDigest(recordKeys.slice(0, RECORD_ROWS)) === RECORD_SHA256;

describe("callout settings baseline (#1350, #1376)", () => {
  it(`still opens with the ${RECORD_ROWS} pinned rows, in order`, () => {
    expect(
      pinnedPrefixIntact,
      `one of the first ${RECORD_ROWS} rows of ${BASELINE_FILE} was deleted, replaced, renamed, reordered, or had ` +
        `its default or a coercion column changed. A row is never removed, even when its key is retired (mark it ` +
        `"retiredBy" instead), a stored key's default changes only with a settings migration and a new key, and a ` +
        `new key is appended at the end. The pin in callout-settings-baseline.test.ts moves only for an append.`,
    ).toBe(true);
  });

  it("pins every row in the record", () => {
    // The new pin is printed only over an intact prefix, so a swapped row cannot be pinned by copying it.
    const repin = pinnedPrefixIntact
      ? `In the same change, set RECORD_ROWS to ${recordKeys.length} and RECORD_SHA256 to "${recordDigest(recordKeys)}".`
      : "Restore the pinned rows first (see the failure above).";

    expect(
      recordKeys.length,
      `${BASELINE_FILE} has ${recordKeys.length - RECORD_ROWS} row(s) appended after the pin. ${repin}`,
    ).toBe(RECORD_ROWS);
  });

  it.each(Object.keys(baseline))("%s has exactly the record's columns", (key) => {
    const row = baseline[key];

    expect(
      Object.keys(row)
        .filter((column) => column !== "retiredBy")
        .sort(),
      `${key}'s row in ${BASELINE_FILE} carries exactly the record's columns, plus "retiredBy" once retired`,
    ).toEqual([...COLUMNS].sort());

    if (isRetired(key)) {
      expect(row.retiredBy, `${key}'s "retiredBy" names the issue whose migration retired it, as "#<n>"`).toMatch(
        /^#[1-9]\d*$/,
      );
    }
  });

  it.each(registryKeys)("%s has a live row in the record", (key) => {
    expect(
      Object.hasOwn(baseline, key),
      `${key} is in the callout registry but has no row in ${BASELINE_FILE}. ` +
        `A new callout key appends one row at the end of that file, by hand, in the shape of the rows above it: ` +
        `"owner": "<family id>/<callout id>", "default": true unless the entry declares default: false, ` +
        `and the coercion columns every key shares (true/"true" -> true, false/"false"/"x" -> false, numberRejected: true). ` +
        `Then write the new pin the "pins every row" test prints, and never regenerate ` +
        `or edit the existing rows — see the header of callout-settings-baseline.test.ts.`,
    ).toBe(true);
    expect(
      isRetired(key),
      `${key} is in the callout registry, but its row in ${BASELINE_FILE} is marked "retiredBy": "${baseline[key].retiredBy}". ` +
        `A retired key is never reused, since what users stored under it was migrated: ` +
        `give the callout a new key and append a row for that one.`,
    ).toBe(false);
  });

  it.each(liveKeys)("%s is still in the registry", (key) => {
    expect(
      registryKeys.includes(key),
      `${key} has a live row in ${BASELINE_FILE} but is no longer in the callout registry. ` +
        `A stored key is a published contract: retiring or renaming it needs a settings migration ` +
        `(global-settings-migrations.ts) for the value users stored under it, and then its row is marked ` +
        `"retiredBy": "#<issue>" — never deleted or rewritten. See the header of callout-settings-baseline.test.ts.`,
    ).toBe(true);
  });

  it.each(liveKeys)("%s keeps its default and coercion", (key) => {
    const row = baseline[key];
    expect((GlobalSettingsSchema.parse({}) as Record<string, unknown>)[key]).toBe(row.default);
    expect(parseKey(key, true)).toBe(row.true);
    expect(parseKey(key, "true")).toBe(row['"true"']);
    expect(parseKey(key, false)).toBe(row.false);
    expect(parseKey(key, "false")).toBe(row['"false"']);
    expect(parseKey(key, "x")).toBe(row['"x"']);
    expect(!GlobalSettingsSchema.safeParse({ [key]: 1 }).success).toBe(row.numberRejected);
  });

  it.each(liveKeys)("%s still silences the callout it always did", (key) => {
    const [familyId, calloutId] = baseline[key].owner.split("/");
    const family = CALLOUT_FAMILIES.find((f) => f.id === familyId);

    expect(family, `no registry family "${familyId}"`).toBeDefined();
    expect(family && calloutIdForKey(family, key)).toBe(calloutId);
  });

  // One test over every retired row rather than one per row, so the rule is
  // in the run while no key has been retired yet.
  it("every retired key is gone from the registry and from the schema's defaults", () => {
    const defaults = GlobalSettingsSchema.parse({});

    for (const key of retiredKeys) {
      const { retiredBy } = baseline[key];

      expect(
        registryKeys.includes(key),
        `${key} is marked "retiredBy": "${retiredBy}" in ${BASELINE_FILE} but is still in the callout registry`,
      ).toBe(false);
      expect(
        Object.hasOwn(defaults, key),
        `${key} is marked "retiredBy": "${retiredBy}" in ${BASELINE_FILE} but GlobalSettingsSchema still defaults it`,
      ).toBe(false);
    }
  });

  it("marks exactly the keys RETIRED_KEYS lists as retired", () => {
    expect(
      [...retiredKeys].sort(),
      `the rows marked "retiredBy" in ${BASELINE_FILE} and RETIRED_KEYS in callout-settings-baseline.test.ts ` +
        `must name the same keys: retiring a key marks its row and appends it to RETIRED_KEYS, and neither is ever undone.`,
    ).toEqual([...RETIRED_KEYS].sort());
  });
});
