import type { CommDescriptor } from "@iracedeck/deck-core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DIAL_CATEGORIES } from "./audio-controls/audio-controls-settings.js";
import { type ActionCommMeta, COMMS_CATALOG } from "./comms-catalog.js";

const JSON_PATH = new URL("./data/action-comms.json", import.meta.url);
const KEY_BINDINGS_PATH = new URL("./data/key-bindings.json", import.meta.url);

/**
 * `_meta` is a real key of an entry rather than a sibling of it (see
 * `ActionCommEntry`), so every value read out of one is
 * `CommDescriptor | ActionCommMeta` and needs narrowing before its descriptor
 * fields are readable.
 */
function isDescriptor(value: CommDescriptor | ActionCommMeta): value is CommDescriptor {
  return "method" in value;
}

/** Every global binding key referenced anywhere in the catalog. */
function catalogBindingKeys(): Set<string> {
  const keys = new Set<string>();

  for (const map of Object.values(COMMS_CATALOG)) {
    for (const [mode, descriptor] of Object.entries(map)) {
      if (mode === "_meta") continue;

      const ref = (descriptor as { binding?: Record<string, unknown> }).binding;

      if (!ref) continue;

      if (typeof ref.key === "string") keys.add(ref.key);

      if (Array.isArray(ref.keys)) for (const k of ref.keys as string[]) keys.add(k);

      if (ref.keyBy) for (const k of Object.values((ref.keyBy as { map: Record<string, string> }).map)) keys.add(k);
    }
  }

  return keys;
}

/** Every `setting` declared in the key-bindings accordions. */
function keyBindingSettings(): Set<string> {
  const data = JSON.parse(readFileSync(KEY_BINDINGS_PATH, "utf-8")) as Record<string, Array<{ setting: string }>>;
  const settings = new Set<string>();

  for (const list of Object.values(data)) for (const b of list) settings.add(b.setting);

  return settings;
}

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

        if (!isDescriptor(descriptor)) {
          throw new Error(`${action}.${mode} is not a comm descriptor`);
        }

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

  it("every catalog binding key exists in key-bindings.json (the accordion source)", () => {
    const declared = keyBindingSettings();
    const missing = [...catalogBindingKeys()].filter((k) => !declared.has(k)).sort();
    // A catalog key absent from key-bindings.json means the status line can't
    // find an ird-key-binding for it → wrong/empty state. Catches typos too.
    expect(missing, `binding keys missing from key-bindings.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("describes every Audio Controls dial category (#782, #809)", () => {
    // The descriptors themselves are derived from the settings tables, but a
    // category could still be added to DIAL_CATEGORIES (and to the PI) without
    // an entry here — which renders no status line at all for that mode.
    const dial = COMMS_CATALOG["audio-controls-dial"];

    for (const category of DIAL_CATEGORIES) expect(dial[category], category).toBeDefined();
  });
});
