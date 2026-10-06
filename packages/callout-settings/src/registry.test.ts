import { describe, expect, it } from "vitest";

import {
  CALLOUT_FAMILIES,
  CALLOUT_PI_GROUPS,
  CALLOUT_SETTING_KEYS,
  calloutDefault,
  type CalloutFamily,
} from "./index.js";

const entries = CALLOUT_FAMILIES.flatMap((f) => Object.values(f.callouts));

describe("callout settings registry", () => {
  it("has 35 families and 100 keys", () => {
    expect(CALLOUT_FAMILIES).toHaveLength(35);
    expect(CALLOUT_SETTING_KEYS).toHaveLength(100);
  });

  it("has unique family ids", () => {
    const ids = CALLOUT_FAMILIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique keys, each a calloutEnabled* key", () => {
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);

    for (const key of keys) expect(key).toMatch(/^calloutEnabled[A-Z]\w*$/);
  });

  it("has non-empty labels and titles", () => {
    for (const e of entries) expect(e.label.trim()).not.toBe("");

    for (const g of CALLOUT_PI_GROUPS) expect(g.title.trim()).not.toBe("");
  });

  it("puts every family in exactly one PI group, and no group is empty", () => {
    const placed = CALLOUT_PI_GROUPS.flatMap((g): readonly CalloutFamily[] => g.families);
    expect(placed).toHaveLength(CALLOUT_FAMILIES.length);
    expect(new Set(placed)).toEqual(new Set(CALLOUT_FAMILIES));

    for (const g of CALLOUT_PI_GROUPS) expect(g.families.length).toBeGreaterThan(0);
  });

  it("ships exactly the six fuel countdown counts off", () => {
    expect(CALLOUT_SETTING_KEYS.filter((k) => !calloutDefault(k)).sort()).toEqual(
      [10, 9, 8, 7, 6, 4].map((n) => `calloutEnabledFuelLapsLeft${n}`).sort(),
    );
  });
});
