import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import * as testing from "./testing.js";

describe("replay-store's testing entry (#1375)", () => {
  it("re-exports the very marker functions the barrel ships, for tests that mock the barrel", () => {
    expect(Object.keys(testing).sort()).toEqual(["addMarker", "deleteNearestMarker"]);

    for (const name of Object.keys(testing) as Array<keyof typeof testing>) {
      expect(testing[name], name).toBe(barrel[name]);
    }
  });
});
