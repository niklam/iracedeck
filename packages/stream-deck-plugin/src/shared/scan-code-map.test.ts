import { getModifierScanCode, getScanCode } from "@iracedeck/deck-core";
import { describe, expect, it } from "vitest";

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
