import { Flags } from "@iracedeck/iracing-native";
import { describe, expect, it } from "vitest";

import { FLAG_DEFINITIONS, resolveActiveFlag, resolveAllActiveFlags } from "./flag-utils.js";

describe("flag-utils", () => {
  describe("FLAG_DEFINITIONS", () => {
    it("should have entries for all major flag types", () => {
      expect(FLAG_DEFINITIONS.length).toBeGreaterThanOrEqual(8);
    });

    it("should have red as highest priority", () => {
      const result = FLAG_DEFINITIONS[0];
      expect(result.info.label).toBe("RED");
    });
  });

  describe("resolveActiveFlag", () => {
    it("should return null for undefined", () => {
      expect(resolveActiveFlag(undefined)).toBeNull();
    });

    it("should return null for no flags", () => {
      expect(resolveActiveFlag(0)).toBeNull();
    });

    it("should return yellow for yellow flag", () => {
      const result = resolveActiveFlag(Flags.Yellow);
      expect(result).not.toBeNull();
      expect(result!.label).toBe("YELLOW");
      expect(result!.color).toBe("#f1c40f");
    });

    it("should return blue for blue flag", () => {
      const result = resolveActiveFlag(Flags.Blue);
      expect(result).not.toBeNull();
      expect(result!.label).toBe("BLUE");
    });

    it("should return red over yellow when both active (priority)", () => {
      const result = resolveActiveFlag(Flags.Red | Flags.Yellow);
      expect(result!.label).toBe("RED");
    });

    it("should return yellow for caution flag", () => {
      const result = resolveActiveFlag(Flags.Caution);
      expect(result!.label).toBe("YELLOW");
    });

    it("should return yellow for caution waving flag", () => {
      const result = resolveActiveFlag(Flags.CautionWaving);
      expect(result!.label).toBe("YELLOW");
    });

    it("should return yellow for yellow waving flag", () => {
      const result = resolveActiveFlag(Flags.YellowWaving);
      expect(result!.label).toBe("YELLOW");
    });

    it("should return black for disqualify flag", () => {
      const result = resolveActiveFlag(Flags.Disqualify);
      expect(result!.label).toBe("BLACK");
      expect(result!.pulse).toBe(true);
    });
  });

  describe("resolveAllActiveFlags", () => {
    it("should return empty array for undefined", () => {
      expect(resolveAllActiveFlags(undefined)).toEqual([]);
    });

    it("should return empty array for no flags", () => {
      expect(resolveAllActiveFlags(0)).toEqual([]);
    });

    it("should return single flag", () => {
      const result = resolveAllActiveFlags(Flags.Yellow);
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("YELLOW");
    });

    it("should return multiple flags when active", () => {
      const result = resolveAllActiveFlags(Flags.Yellow | Flags.Blue);
      expect(result).toHaveLength(2);
      const labels = result.map((f) => f.label);
      expect(labels).toContain("YELLOW");
      expect(labels).toContain("BLUE");
    });

    it("should exclude green flag", () => {
      const result = resolveAllActiveFlags(Flags.Green | Flags.Blue);
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("BLUE");
    });

    it("should return empty array for green-only", () => {
      expect(resolveAllActiveFlags(Flags.Green)).toEqual([]);
    });

    it("should exclude white flag (informational)", () => {
      const result = resolveAllActiveFlags(Flags.White | Flags.Blue);
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("BLUE");
    });

    it("should exclude checkered flag (informational)", () => {
      const result = resolveAllActiveFlags(Flags.Checkered | Flags.Yellow);
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("YELLOW");
    });

    it("should return empty for only informational flags", () => {
      expect(resolveAllActiveFlags(Flags.Green | Flags.White | Flags.Checkered)).toEqual([]);
    });

    it("should detect yellow waving flag", () => {
      const result = resolveAllActiveFlags(Flags.YellowWaving);
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("YELLOW");
    });

    it("should maintain priority order", () => {
      const result = resolveAllActiveFlags(Flags.Blue | Flags.Yellow | Flags.Red);
      expect(result[0].label).toBe("RED");
      expect(result[1].label).toBe("YELLOW");
      expect(result[2].label).toBe("BLUE");
    });
  });
});
