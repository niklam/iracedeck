import { CALLOUT_FAMILIES, calloutIdForKey } from "@iracedeck/callout-settings";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { GlobalSettingsSchema } from "./global-settings.js";

/**
 * Frozen record of every `calloutEnabled*` key as it stood before #1350 moved
 * their declaration into `@iracedeck/callout-settings`. Never regenerate it:
 * adding a callout needs no edit here, while dropping, renaming or re-defaulting
 * a stored key fails — which is the moment a migration (or a deliberate,
 * reviewed default change) is owed. Stored keys are a published contract
 * (`.claude/rules/global-settings.md`).
 *
 * The `owner` column (`<family id>/<callout id>`) pins which callout each key
 * silences, so swapping two entries' keys inside a family fails too. It was
 * added once, before #1350 merged: for the 95 keys that had an id map on
 * master, from master's `*_CALLOUT_SETTING_KEYS` maps; for the 5 that had none,
 * from the registry's five small families. It is frozen like the rest.
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

const baseline = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__", "callout-settings-baseline.json"), "utf8"),
) as Record<string, BaselineRow>;

const parseKey = (key: string, value: unknown): unknown =>
  (GlobalSettingsSchema.parse({ [key]: value }) as Record<string, unknown>)[key];

describe("callout settings baseline (#1350)", () => {
  it("holds the 100 keys captured before the registry", () => {
    expect(Object.keys(baseline)).toHaveLength(100);
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
