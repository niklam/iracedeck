import { Flags } from "@iracedeck/iracing-native";
import { describe, expect, it } from "vitest";

import { decodePenaltyFlags, PENALTY_FLAG_MASK } from "./penalty-flag-utils.js";

describe("PENALTY_FLAG_MASK", () => {
  it("covers exactly the four penalty bits", () => {
    expect(PENALTY_FLAG_MASK).toBe(Flags.Furled | Flags.Black | Flags.Repair | Flags.Disqualify);
  });
});

describe("decodePenaltyFlags", () => {
  it("decodes each bit independently", () => {
    expect(decodePenaltyFlags(Flags.Black)).toEqual({ furled: false, black: true, repair: false, disqualify: false });
    expect(decodePenaltyFlags(Flags.Furled | Flags.Repair)).toEqual({
      furled: true,
      black: false,
      repair: true,
      disqualify: false,
    });
  });

  it("ignores non-penalty bits (the Step 0 capture: 0x50000 = Black + Servicible)", () => {
    expect(decodePenaltyFlags(0x50000)).toEqual({ furled: false, black: true, repair: false, disqualify: false });
    expect(decodePenaltyFlags(0x40000)).toEqual({ furled: false, black: false, repair: false, disqualify: false });
  });

  it("treats undefined as no flags", () => {
    expect(decodePenaltyFlags(undefined)).toEqual({ furled: false, black: false, repair: false, disqualify: false });
  });
});
