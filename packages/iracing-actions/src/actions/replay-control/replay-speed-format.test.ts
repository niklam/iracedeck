import { describe, expect, it } from "vitest";

import { formatPlayCaption, formatSpeedDisplay, parseSpeedSetting } from "./replay-speed-format.js";

// `parseSpeedSetting` and `formatSpeedDisplay` keep their full suites in
// `replay-control.test.ts`, which reads them through the action's re-export.
describe("replay-speed-format", () => {
  describe("formatPlayCaption", () => {
    it.each<[number, boolean, string]>([
      [1, false, "► 1x"],
      [4, false, "► 4x"],
      [16, false, "► 16x"],
      [-2, false, "◄ 2x"],
      [4, true, "► 1/4x"],
      [-4, true, "◄ 1/4x"],
      [-16, true, "◄ 1/16x"],
    ])("should format speed %d (slow motion %s) as %s", (speed, slowMotion, expected) => {
      expect(formatPlayCaption(speed, slowMotion)).toBe(expected);
    });

    it("should use the two pointers the bundled Arimo carries", () => {
      expect(formatPlayCaption(1, false).codePointAt(0)).toBe(0x25ba);
      expect(formatPlayCaption(-1, false).codePointAt(0)).toBe(0x25c4);
    });

    it("should carry the direction in the mark alone, never as a sign", () => {
      expect(formatPlayCaption(-8, false)).not.toContain("-");
      expect(formatPlayCaption(-8, true)).not.toContain("-");
    });
  });

  it("should read a keypad speed setting back as its display text", () => {
    const slow = parseSpeedSetting("s4");
    const fast = parseSpeedSetting("8");

    expect(formatSpeedDisplay(slow.speed, slow.slowMotion)).toBe("1/4x");
    expect(formatSpeedDisplay(fast.speed, fast.slowMotion)).toBe("8x");
  });
});
