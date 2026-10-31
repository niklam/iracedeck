import { CALLOUT_FAMILIES, CALLOUT_SETTING_KEYS, calloutIdForKey } from "@iracedeck/callout-settings";
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
 * Rows are appended when a key is added, and never edited, removed or
 * regenerated. Dropping, renaming or re-defaulting a stored key fails here,
 * which is the moment a migration (or a deliberate, reviewed default change)
 * is owed — never the moment to rewrite the row. Every registry key must have
 * a row and every row's key must still be in the registry, so a key added
 * without a row fails as surely as a key removed under one (#1376).
 *
 * Adding a callout: append one row at the end of
 * `__fixtures__/callout-settings-baseline.json`, keyed by the new
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
 * One row's owner has moved since, deliberately: #1167 took
 * `calloutEnabledFlagOnePaceLapToGo` from `flag/one-pace-lap-to-go` to
 * `rolling-start/one-pace-lap-to-go` when the call became a formation call
 * and its checkbox moved under Rolling Start, with the key and its default
 * untouched, so no stored value moved and no migration was owed.
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
}

/** The record held this many rows before it became append-only (#1376); it never shrinks below it. */
const PRE_REGISTRY_ROWS = 100;

const BASELINE_FILE = "packages/settings/src/__fixtures__/callout-settings-baseline.json";

const baseline = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__", "callout-settings-baseline.json"), "utf8"),
) as Record<string, BaselineRow>;

const registryKeys: readonly string[] = CALLOUT_SETTING_KEYS;

const parseKey = (key: string, value: unknown): unknown =>
  (GlobalSettingsSchema.parse({ [key]: value }) as Record<string, unknown>)[key];

describe("callout settings baseline (#1350, #1376)", () => {
  it(`never shrinks below the ${PRE_REGISTRY_ROWS} keys captured before the registry`, () => {
    expect(Object.keys(baseline).length).toBeGreaterThanOrEqual(PRE_REGISTRY_ROWS);
  });

  it.each(registryKeys)("%s has a row in the record", (key) => {
    expect(
      Object.hasOwn(baseline, key),
      `${key} is in the callout registry but has no row in ${BASELINE_FILE}. ` +
        `A new callout key appends one row at the end of that file, by hand, in the shape of the rows above it: ` +
        `"owner": "<family id>/<callout id>", "default": true unless the entry declares default: false, ` +
        `and the coercion columns every key shares (true/"true" -> true, false/"false"/"x" -> false, numberRejected: true). ` +
        `Never regenerate or edit the existing rows — see the header of callout-settings-baseline.test.ts.`,
    ).toBe(true);
  });

  it.each(Object.keys(baseline))("%s is still in the registry", (key) => {
    expect(
      registryKeys.includes(key),
      `${key} has a row in ${BASELINE_FILE} but is no longer in the callout registry. ` +
        `A stored key is a published contract: dropping or renaming it needs a settings migration, ` +
        `and its row stays in the record.`,
    ).toBe(true);
  });

  it.each(Object.keys(baseline))("%s keeps its default and coercion", (key) => {
    const row = baseline[key];
    expect((GlobalSettingsSchema.parse({}) as Record<string, unknown>)[key]).toBe(row.default);
    expect(parseKey(key, true)).toBe(row.true);
    expect(parseKey(key, "true")).toBe(row['"true"']);
    expect(parseKey(key, false)).toBe(row.false);
    expect(parseKey(key, "false")).toBe(row['"false"']);
    expect(parseKey(key, "x")).toBe(row['"x"']);
    expect(!GlobalSettingsSchema.safeParse({ [key]: 1 }).success).toBe(row.numberRejected);
  });

  it.each(Object.keys(baseline))("%s still silences the callout it always did", (key) => {
    const [familyId, calloutId] = baseline[key].owner.split("/");
    const family = CALLOUT_FAMILIES.find((f) => f.id === familyId);

    expect(family, `no registry family "${familyId}"`).toBeDefined();
    expect(family && calloutIdForKey(family, key)).toBe(calloutId);
  });
});
