import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CALLOUT_FAMILIES,
  CALLOUT_PI_GROUPS,
  CALLOUT_SETTING_KEYS,
  calloutDefault,
  type CalloutFamily,
  type CalloutIdOf,
  calloutKey,
  type CalloutSettingKey,
  FLAG_CALLOUTS,
  type RegisteredCalloutFamily,
} from "./index.js";

const entries = CALLOUT_FAMILIES.flatMap((f) => Object.values(f.callouts));

/**
 * The shape a consumer's generic gate takes. The return annotation is the assertion: constrained on `CalloutFamily`
 * instead, `calloutKey` yields only `calloutEnabled${string}` and this does not compile.
 */
function keyOf<F extends RegisteredCalloutFamily>(family: F, id: CalloutIdOf<F>): CalloutSettingKey {
  return calloutKey(family, id);
}

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

  it("lists the families in PI group order", () => {
    expect(CALLOUT_FAMILIES).toEqual(CALLOUT_PI_GROUPS.flatMap((g): readonly CalloutFamily[] => g.families));
  });

  it("gives every entry only the known fields, so a misspelt one fails", () => {
    for (const e of entries) {
      for (const field of Object.keys(e)) expect(["key", "label", "default"]).toContain(field);
    }
  });

  it("lets a generic helper over any registered family yield a CalloutSettingKey", () => {
    expect(keyOf(FLAG_CALLOUTS, "green")).toBe("calloutEnabledFlagGreen");
    expectTypeOf(keyOf(FLAG_CALLOUTS, "green")).toEqualTypeOf<CalloutSettingKey>();
    expectTypeOf(calloutKey(FLAG_CALLOUTS, "green")).toExtend<CalloutSettingKey>();
  });

  it("still rejects an id the family does not have", () => {
    // Never called: the assertion is that the call does not compile.
    const misspelt = () =>
      // @ts-expect-error -- "nope" is not a FLAG_CALLOUTS id
      keyOf(FLAG_CALLOUTS, "nope");

    expect(misspelt).toBeTypeOf("function");
  });

  it("ships exactly the six fuel countdown counts off", () => {
    expect(CALLOUT_SETTING_KEYS.filter((k) => !calloutDefault(k)).sort()).toEqual(
      [10, 9, 8, 7, 6, 4].map((n) => `calloutEnabledFuelLapsLeft${n}`).sort(),
    );
  });
});
