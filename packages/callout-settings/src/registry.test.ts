import { describe, expect, expectTypeOf, it } from "vitest";

import * as registry from "./index.js";
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
  TRAFFIC_CALLOUTS,
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

describe("Lap Time group (#1163, #1571)", () => {
  it("renders New best lap, Every lap, Fastest lap of the race, in that order", () => {
    const group = CALLOUT_PI_GROUPS.find((g) => g.id === "lap-time");
    const rows = group?.families.flatMap((f: CalloutFamily) => Object.values(f.callouts));

    expect(rows?.map((e) => [e.key, e.label])).toEqual([
      ["calloutEnabledLapTimeBestLap", "New best lap"],
      ["calloutEnabledLapTimeEveryLap", "Every lap"],
      ["calloutEnabledFastestLap", "Fastest lap of the race"],
    ]);
  });

  it("ships both new opt-ins on", () => {
    expect(calloutDefault("calloutEnabledLapTimeEveryLap")).toBe(true);
    expect(calloutDefault("calloutEnabledFastestLap")).toBe(true);
  });
});

describe("Traffic group (#1113)", () => {
  it("renders the rejoin and pit-exit opt-ins under its own heading, right after Spotter", () => {
    const ids = CALLOUT_PI_GROUPS.map((g) => g.id);
    const group = CALLOUT_PI_GROUPS.find((g) => g.id === "traffic");
    const rows = group?.families.flatMap((f: CalloutFamily) => Object.values(f.callouts));

    expect(ids.indexOf("traffic")).toBe(ids.indexOf("spotter") + 1);
    expect(group?.title).toBe("Traffic");
    expect(rows?.map((e) => [e.key, e.label])).toEqual([
      ["calloutEnabledTrafficRejoin", "Traffic when rejoining (experimental)"],
      ["calloutEnabledTrafficPitExit", "Traffic at pit exit"],
    ]);
  });

  it("keeps the pit-exit traffic opt-in out of the Pit Speeding group, where the pit exit beep lives", () => {
    const pitSpeeding = CALLOUT_PI_GROUPS.find((g) => g.id === "pit-speeding");
    const keys = pitSpeeding?.families.flatMap((f: CalloutFamily) => Object.values(f.callouts).map((e) => e.key));

    expect(keys).not.toContain("calloutEnabledTrafficPitExit");
  });

  it("ships the rejoin opt-in off, as experimental, and the pit-exit one on (amended 2026-11-20)", () => {
    expect(calloutDefault("calloutEnabledTrafficRejoin")).toBe(false);
    expect(calloutDefault("calloutEnabledTrafficPitExit")).toBe(true);
  });

  it("maps the traffic family's ids to their keys", () => {
    expect(calloutKey(TRAFFIC_CALLOUTS, "rejoin")).toBe("calloutEnabledTrafficRejoin");
    expect(calloutKey(TRAFFIC_CALLOUTS, "pit-exit")).toBe("calloutEnabledTrafficPitExit");
  });
});
