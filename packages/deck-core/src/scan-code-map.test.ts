import { KEY_CODE_MAP, MODIFIERS } from "@iracedeck/app-constants";
import { describe, expect, it } from "vitest";

import {
  canSendByScanCode,
  getModifierScanCode,
  getScanCode,
  MAPPED_CODES,
  MAPPED_MODIFIERS,
} from "./scan-code-map.js";

describe("scan-code-map", () => {
  describe("getScanCode", () => {
    it("should map letter keys to correct PS/2 scan codes", () => {
      expect(getScanCode("KeyA")).toBe(0x1e);
      expect(getScanCode("KeyZ")).toBe(0x2c);
      expect(getScanCode("KeyQ")).toBe(0x10);
    });

    it("should map digit keys to correct scan codes", () => {
      expect(getScanCode("Digit1")).toBe(0x02);
      expect(getScanCode("Digit0")).toBe(0x0b);
    });

    it("should map function keys to correct scan codes", () => {
      expect(getScanCode("F1")).toBe(0x3b);
      expect(getScanCode("F12")).toBe(0x58);
      expect(getScanCode("F11")).toBe(0x57);
    });

    it("should map OEM/symbol keys to correct scan codes", () => {
      expect(getScanCode("Minus")).toBe(0x0c);
      expect(getScanCode("Equal")).toBe(0x0d);
      expect(getScanCode("BracketLeft")).toBe(0x1a);
      expect(getScanCode("BracketRight")).toBe(0x1b);
      expect(getScanCode("Backslash")).toBe(0x2b);
      expect(getScanCode("Semicolon")).toBe(0x27);
      expect(getScanCode("Quote")).toBe(0x28);
      expect(getScanCode("Backquote")).toBe(0x29);
      expect(getScanCode("Comma")).toBe(0x33);
      expect(getScanCode("Period")).toBe(0x34);
      expect(getScanCode("Slash")).toBe(0x35);
    });

    it("should map special keys to correct scan codes", () => {
      expect(getScanCode("Tab")).toBe(0x0f);
      expect(getScanCode("Space")).toBe(0x39);
      expect(getScanCode("Enter")).toBe(0x1c);
      expect(getScanCode("Escape")).toBe(0x01);
      expect(getScanCode("Backspace")).toBe(0x0e);
    });

    it("should map extended keys with 0x100 flag", () => {
      expect(getScanCode("Delete")).toBe(0x153);
      expect(getScanCode("Insert")).toBe(0x152);
      expect(getScanCode("ArrowUp")).toBe(0x148);
      expect(getScanCode("ArrowDown")).toBe(0x150);
      expect(getScanCode("ArrowLeft")).toBe(0x14b);
      expect(getScanCode("ArrowRight")).toBe(0x14d);
      expect(getScanCode("Home")).toBe(0x147);
      expect(getScanCode("End")).toBe(0x14f);
      expect(getScanCode("PageUp")).toBe(0x149);
      expect(getScanCode("PageDown")).toBe(0x151);
    });

    it("should map numpad keys to correct scan codes", () => {
      expect(getScanCode("Numpad0")).toBe(0x52);
      expect(getScanCode("Numpad9")).toBe(0x49);
      expect(getScanCode("NumpadAdd")).toBe(0x4e);
      expect(getScanCode("NumpadSubtract")).toBe(0x4a);
      expect(getScanCode("NumpadMultiply")).toBe(0x37);
      expect(getScanCode("NumpadDivide")).toBe(0x135);
      expect(getScanCode("NumpadDecimal")).toBe(0x53);
      expect(getScanCode("NumpadEnter")).toBe(0x11c);
    });

    it("should return undefined for unknown codes", () => {
      expect(getScanCode("SomeUnknown")).toBeUndefined();
      expect(getScanCode("")).toBeUndefined();
    });
  });

  describe("getModifierScanCode", () => {
    it("should map ctrl to Left Ctrl scan code", () => {
      expect(getModifierScanCode("ctrl")).toBe(0x1d);
    });

    it("should map shift to Left Shift scan code", () => {
      expect(getModifierScanCode("shift")).toBe(0x2a);
    });

    it("should map alt to Left Alt scan code", () => {
      expect(getModifierScanCode("alt")).toBe(0x38);
    });

    it("should return undefined for unknown modifiers", () => {
      expect(getModifierScanCode("meta")).toBeUndefined();
      expect(getModifierScanCode("")).toBeUndefined();
    });
  });
});

describe("scan-code-map (#1495)", () => {
  describe("agrees with the key map the Property Inspector checks against", () => {
    // The PI cannot import deck-core, so it reads a binding as sendable when
    // its code is in KEY_CODE_MAP and every modifier is in MODIFIERS. These
    // pin that both sides hold the same sets, so a binding the PI shows as set
    // is one the runtime can send, and the other way round.
    it("holds exactly KEY_CODE_MAP's codes", () => {
      expect([...MAPPED_CODES].sort()).toEqual(Object.keys(KEY_CODE_MAP).sort());
    });

    it("holds exactly the MODIFIERS", () => {
      expect([...MAPPED_MODIFIERS].sort()).toEqual([...MODIFIERS].sort());
    });

    it("gives every recordable code and modifier a scan code", () => {
      for (const code of Object.keys(KEY_CODE_MAP)) {
        expect(getScanCode(code), code).toBeTypeOf("number");
      }

      for (const modifier of MODIFIERS) {
        expect(getModifierScanCode(modifier), modifier).toBeTypeOf("number");
      }
    });
  });

  describe("names inherited from Object.prototype are not codes", () => {
    // A stored code is outside input; an object index would answer these with a
    // function, which the keyboard service would then push as a scan code.
    const INHERITED = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"];

    it.each(INHERITED)("%s has no scan code and is no modifier", (name) => {
      expect(getScanCode(name)).toBeUndefined();
      expect(getModifierScanCode(name)).toBeUndefined();
      expect(canSendByScanCode({ code: name, modifiers: [] })).toBe(false);
      expect(canSendByScanCode({ code: "F1", modifiers: [name] })).toBe(false);
    });
  });

  describe("canSendByScanCode", () => {
    it.each([
      ["a code alone", { code: "F1" }],
      ["a code with no modifiers", { code: "KeyA", modifiers: [] }],
      ["a code with every supported modifier", { code: "F1", modifiers: ["ctrl", "shift", "alt"] }],
      ["an extended key", { code: "ArrowUp", modifiers: ["shift"] }],
    ])("is true for %s", (_label, combination) => {
      expect(canSendByScanCode(combination)).toBe(true);
    });

    it.each([
      ["no code", { modifiers: [] }],
      ["an empty code", { code: "", modifiers: [] }],
      ["a code the map does not hold (F13)", { code: "F13", modifiers: [] }],
      ["a code the map does not hold (CapsLock)", { code: "CapsLock", modifiers: [] }],
      ["a key name where the code belongs", { code: "f1", modifiers: [] }],
      ["a capitalised modifier", { code: "F1", modifiers: ["Ctrl"] }],
      ["an unsupported modifier", { code: "F1", modifiers: ["meta"] }],
      ["an unsupported modifier beside a supported one", { code: "F1", modifiers: ["shift", "meta"] }],
      ["an empty modifier", { code: "F1", modifiers: [""] }],
    ])("is false for %s", (_label, combination) => {
      expect(canSendByScanCode(combination)).toBe(false);
    });
  });
});
