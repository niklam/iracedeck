import { BINDING_KEY_CODE_MAP, defaultBindingStoredValue, parseDefaultKeyBinding } from "@iracedeck/deck-core";
import { describe, expect, it, vi } from "vitest";

import { parseSimpleDefault } from "./key-binding-utils.js";
import { KEY_CODE_MAP } from "./key-maps.js";

/**
 * The plugin writes a binding default itself when it seeds one at startup
 * (#1277, deck-core `seedBindingDefaultsIfAbsent`), and that value must be
 * exactly what `ird-key-binding` saves when it mounts over an unset setting
 * — `JSON.stringify(parseSimpleDefault(default))`. deck-core cannot import
 * this package and the PI bundle must not pull deck-core in, so the parser
 * and its key map exist twice (deck-core `key-binding-defaults.ts`). Nothing
 * else connects the copies; a key added to one map only would seed a value
 * the field never writes, or none at all, without a failing test. So they are
 * pinned here: the maps are equal, and both sides store the same string for
 * every key, bare and under every modifier form.
 */
describe("binding default parity: PI field ↔ deck-core seed (#1277)", () => {
  it("deck-core's key map is the PI's key map", () => {
    expect(BINDING_KEY_CODE_MAP).toEqual(KEY_CODE_MAP);
  });

  const forms = (key: string): string[] => [
    key,
    key.toUpperCase(),
    `Shift+${key}`,
    `Ctrl+Shift+Alt+${key}`,
    `Alt+Control+${key}`,
    ` ctrl + ${key} `,
  ];

  it("stores the same value as the field for every key and modifier form", () => {
    for (const key of Object.values(KEY_CODE_MAP)) {
      for (const text of forms(key)) {
        const field = parseSimpleDefault(text);

        expect(field, text).not.toBeNull();
        expect(defaultBindingStoredValue(text), text).toBe(JSON.stringify(field));
      }
    }
  });

  it("the defaults Cycle by Track Order seeds are stored exactly as the field stores them", () => {
    for (const text of ["V", "Shift+V"]) {
      expect(defaultBindingStoredValue(text), text).toBe(JSON.stringify(parseSimpleDefault(text)));
    }
  });

  it("agrees on what is NOT a key", () => {
    // The field warns on each; that is its business, not this test's output.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const text of ["", "Shift", "Ctrl+Shift", "Hyper+Q1", "numpad10"]) {
      expect(parseSimpleDefault(text), text).toBeNull();
      expect(parseDefaultKeyBinding(text), text).toBeUndefined();
    }

    vi.restoreAllMocks();
  });
});
