import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { COMMS_CATALOG } from "./comms-catalog.js";

const JSON_PATH = new URL("./data/action-comms.json", import.meta.url);

describe("action-comms catalog", () => {
  it("committed action-comms.json matches the TS catalog (run `pnpm generate:action-comms`)", () => {
    const committed = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
    // Round-trip the catalog so the comparison is over plain JSON values.
    const generated = JSON.parse(JSON.stringify(COMMS_CATALOG));
    expect(committed).toEqual(generated);
  });

  it("every entry has a string modeSetting in _meta", () => {
    for (const [action, map] of Object.entries(COMMS_CATALOG)) {
      expect(typeof map._meta?.modeSetting, `${action}._meta.modeSetting`).toBe("string");
    }
  });

  it("every mode descriptor is well-formed", () => {
    for (const [action, map] of Object.entries(COMMS_CATALOG)) {
      for (const [mode, descriptor] of Object.entries(map)) {
        if (mode === "_meta") continue;

        expect(["api", "keybind", "chat"], `${action}.${mode}.method`).toContain(descriptor.method);

        // Only keybind modes may carry a binding; api/chat must not.
        if (descriptor.method !== "keybind") {
          expect(descriptor.binding, `${action}.${mode} should have no binding`).toBeUndefined();
        }

        const ref = descriptor.binding;

        if (!ref) continue;

        const hasConstant = "key" in ref;
        const hasMulti = "keys" in ref;
        const hasKeyBy = "keyBy" in ref;
        // Exactly one binding-key form.
        expect([hasConstant, hasMulti, hasKeyBy].filter(Boolean).length, `${action}.${mode} binding form`).toBe(1);

        if (hasMulti) expect((ref as { keys: string[] }).keys.length).toBeGreaterThan(0);
      }
    }
  });
});
