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
 */
const baseline = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__", "callout-settings-baseline.json"), "utf8"),
) as Record<string, Record<string, boolean>>;

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
});
