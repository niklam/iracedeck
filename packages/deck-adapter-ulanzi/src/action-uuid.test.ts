import { describe, expect, it } from "vitest";

import { toUlanziActionUuid, ULANZI_PLUGIN_UUID } from "./action-uuid.js";

describe("toUlanziActionUuid", () => {
  it("maps the bare canonical plugin UUID to the Ulanzi plugin UUID", () => {
    expect(toUlanziActionUuid("com.iracedeck.sd.core")).toBe(ULANZI_PLUGIN_UUID);
  });

  it("rewrites a canonical action UUID into the Ulanzi namespace", () => {
    expect(toUlanziActionUuid("com.iracedeck.sd.core.black-box-selector")).toBe(
      "com.ulanzi.ulanzistudio.iracedeck.black-box-selector",
    );
  });

  it("rewrites the legacy camera-cycle UUID", () => {
    expect(toUlanziActionUuid("com.iracedeck.sd.core.camera-cycle")).toBe(
      "com.ulanzi.ulanzistudio.iracedeck.camera-cycle",
    );
  });

  it("returns an unrelated UUID unchanged (idempotent passthrough)", () => {
    expect(toUlanziActionUuid("com.ulanzi.ulanzistudio.iracedeck.black-box-selector")).toBe(
      "com.ulanzi.ulanzistudio.iracedeck.black-box-selector",
    );
    expect(toUlanziActionUuid("com.example.other.action")).toBe("com.example.other.action");
  });

  it("exposes the 4-segment Ulanzi plugin UUID", () => {
    expect(ULANZI_PLUGIN_UUID).toBe("com.ulanzi.ulanzistudio.iracedeck");
    expect(ULANZI_PLUGIN_UUID.split(".")).toHaveLength(4);
  });
});
