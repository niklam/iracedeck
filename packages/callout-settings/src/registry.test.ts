import { describe, expect, expectTypeOf, it } from "vitest";

import * as registry from "./index.js";
import {
  CALLOUT_FAMILIES,
  CALLOUT_PI_GROUPS,
  CALLOUT_SETTING_KEYS,
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
  it("has unique family ids", () => {
    const ids = CALLOUT_FAMILIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique keys, each a calloutEnabled* key, and lists every one in CALLOUT_SETTING_KEYS", () => {
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(CALLOUT_SETTING_KEYS).toEqual(keys);

    for (const key of keys) expect(key).toMatch(/^calloutEnabled[A-Z]\w*$/);
  });

  it("has non-empty labels and titles", () => {
    for (const e of entries) expect(e.label.trim()).not.toBe("");

    for (const g of CALLOUT_PI_GROUPS) expect(g.title.trim()).not.toBe("");
  });

  it("places every family in only one PI group, and no group is empty", () => {
    const placed = CALLOUT_PI_GROUPS.flatMap((g): readonly CalloutFamily[] => g.families);
    expect(new Set(placed).size).toBe(placed.length);

    for (const g of CALLOUT_PI_GROUPS) expect(g.families.length).toBeGreaterThan(0);
  });

  it("exports every registered family by name", () => {
    const exported = new Set<unknown>(Object.values(registry));

    for (const family of CALLOUT_FAMILIES) expect(exported.has(family), family.id).toBe(true);
  });

  it("gives every entry only the known fields, so a misspelt one fails", () => {
    for (const e of entries) {
      for (const field of Object.keys(e)) expect(["key", "label", "default"]).toContain(field);
    }
  });

  it("keeps CalloutSettingKey the union of literal keys", () => {
    expectTypeOf<"calloutEnabledFlagGreen">().toExtend<CalloutSettingKey>();
    expectTypeOf<"calloutEnabledNoSuchCallout">().not.toExtend<CalloutSettingKey>();
  });

  it("lets a generic helper over any registered family yield a CalloutSettingKey", () => {
    expect(keyOf(FLAG_CALLOUTS, "green")).toBe("calloutEnabledFlagGreen");
    expectTypeOf(keyOf(FLAG_CALLOUTS, "green")).toEqualTypeOf<CalloutSettingKey>();
    expectTypeOf(calloutKey(FLAG_CALLOUTS, "green")).toEqualTypeOf<"calloutEnabledFlagGreen">();
  });

  it("still rejects an id the family does not have", () => {
    // Never called: the assertion is that the call does not compile.
    const misspelt = () =>
      // @ts-expect-error -- "nope" is not a FLAG_CALLOUTS id
      keyOf(FLAG_CALLOUTS, "nope");

    expect(misspelt).toBeTypeOf("function");
  });
});
