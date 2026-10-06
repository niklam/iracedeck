import { describe, expect, expectTypeOf, it } from "vitest";

import { calloutIdForKey, type CalloutIdOf, calloutKey, defineCalloutFamily } from "./define.js";

const DEMO = defineCalloutFamily({
  id: "demo",
  callouts: {
    a: { key: "calloutEnabledDemoA", label: "A" },
    b: { key: "calloutEnabledDemoB", label: "B", default: false },
  },
});

describe("defineCalloutFamily", () => {
  it("returns the family unchanged and keeps literal ids and keys", () => {
    expectTypeOf<CalloutIdOf<typeof DEMO>>().toEqualTypeOf<"a" | "b">();
    expect(calloutKey(DEMO, "b")).toBe("calloutEnabledDemoB");
    expectTypeOf(calloutKey(DEMO, "a")).toEqualTypeOf<"calloutEnabledDemoA" | "calloutEnabledDemoB">();
  });

  it("maps a key back to its id, and an unknown key to undefined", () => {
    expect(calloutIdForKey(DEMO, "calloutEnabledDemoA")).toBe("a");
    expect(calloutIdForKey(DEMO, "calloutEnabledOther")).toBeUndefined();
  });
});
