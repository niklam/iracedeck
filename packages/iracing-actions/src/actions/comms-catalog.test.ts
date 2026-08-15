import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DIAL_CATEGORIES,
  DIAL_MUTE_BINDINGS,
  isInternalAudioCategory,
  rotationBindingKeys,
} from "./audio-controls/audio-controls-settings.js";
import { COMMS_CATALOG } from "./comms-catalog.js";

const JSON_PATH = new URL("./data/action-comms.json", import.meta.url);
const KEY_BINDINGS_PATH = new URL("./data/key-bindings.json", import.meta.url);

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

  describe("audio-controls-dial mirrors the dial settings tables (#782, #809)", () => {
    // The dial surface (rotation pair + mute key per category) and the PI
    // status line (this catalog entry) must agree, or the strip warns about a
    // key the PI says is fine — or vice versa. Both sides are hand-authored.
    const dial = COMMS_CATALOG["audio-controls-dial"] as Record<string, { binding?: Record<string, unknown> }>;

    it("lists every rotation category with exactly the settings module's binding pair", () => {
      for (const category of DIAL_CATEGORIES) {
        const keys = (dial[category]?.binding as { keys?: string[] } | undefined)?.keys;

        if (isInternalAudioCategory(category)) expect(keys, category).toBeUndefined();
        else expect(keys, category).toEqual(rotationBindingKeys(category));
      }
    });

    it("keys mute-unmute by exactly the settings module's mute bindings", () => {
      const keyBy = dial["mute-unmute"].binding?.keyBy as { setting: string; map: Record<string, string> };
      expect(keyBy.setting).toBe("dial.category");
      expect(keyBy.map).toEqual(DIAL_MUTE_BINDINGS);
    });
  });
});
