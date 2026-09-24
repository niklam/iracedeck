import { Flags, SessionState, type TelemetryData } from "@iracedeck/iracing-native";
import { describe, expect, it } from "vitest";

import {
  getTireChangeGranularity,
  hasPitLimiter,
  hasVisor,
  hasWipers,
  isPenaltyFlagActive,
  isPostRace,
  isPreGreen,
  resolveReplayFrame,
} from "./telemetry-features.js";

/** Build a minimal TelemetryData mock from a partial set of fields. */
function telemetry(fields: Partial<TelemetryData>): TelemetryData {
  return fields as TelemetryData;
}

describe("telemetry-features", () => {
  describe("hasPitLimiter", () => {
    it("returns true when dcPitSpeedLimiterToggle is present", () => {
      expect(hasPitLimiter(telemetry({ dcPitSpeedLimiterToggle: false }))).toBe(true);
      expect(hasPitLimiter(telemetry({ dcPitSpeedLimiterToggle: true }))).toBe(true);
    });

    it("returns false when the field is absent", () => {
      expect(hasPitLimiter(telemetry({}))).toBe(false);
    });

    it("returns false for null telemetry", () => {
      expect(hasPitLimiter(null)).toBe(false);
    });
  });

  describe("hasVisor", () => {
    it("returns true when dcTearOffVisor is present", () => {
      expect(hasVisor(telemetry({ dcTearOffVisor: false }))).toBe(true);
    });

    it("returns false when the field is absent", () => {
      expect(hasVisor(telemetry({}))).toBe(false);
    });

    it("returns false for null telemetry", () => {
      expect(hasVisor(null)).toBe(false);
    });
  });

  describe("hasWipers", () => {
    it("returns true when dcToggleWindshieldWipers is present", () => {
      expect(hasWipers(telemetry({ dcToggleWindshieldWipers: false }))).toBe(true);
    });

    it("returns true when dcTriggerWindshieldWipers is present", () => {
      expect(hasWipers(telemetry({ dcTriggerWindshieldWipers: false }))).toBe(true);
    });

    it("returns true when both wiper fields are present", () => {
      expect(hasWipers(telemetry({ dcToggleWindshieldWipers: false, dcTriggerWindshieldWipers: false }))).toBe(true);
    });

    it("returns false when neither wiper field is present", () => {
      expect(hasWipers(telemetry({}))).toBe(false);
    });

    it("returns false for null telemetry", () => {
      expect(hasWipers(null)).toBe(false);
    });
  });

  describe("getTireChangeGranularity", () => {
    it("returns corner when all four corner fields are present", () => {
      expect(
        getTireChangeGranularity(
          telemetry({ dpLFTireChange: 0, dpRFTireChange: 0, dpLRTireChange: 0, dpRRTireChange: 0 }),
        ),
      ).toBe("corner");
    });

    it("returns corner when any single corner field is present", () => {
      expect(getTireChangeGranularity(telemetry({ dpRRTireChange: 0 }))).toBe("corner");
    });

    it("returns side when only the side fields are present", () => {
      expect(getTireChangeGranularity(telemetry({ dpLTireChange: 0, dpRTireChange: 0 }))).toBe("side");
    });

    it("returns side when only one side field is present", () => {
      expect(getTireChangeGranularity(telemetry({ dpRTireChange: 0 }))).toBe("side");
    });

    it("returns all when only dpTireChange is present", () => {
      expect(getTireChangeGranularity(telemetry({ dpTireChange: 0 }))).toBe("all");
    });

    it("resolves an unexpected corner + all combination to the finer level", () => {
      expect(getTireChangeGranularity(telemetry({ dpLFTireChange: 0, dpTireChange: 0 }))).toBe("corner");
    });

    it("resolves an unexpected side + all combination to the finer level", () => {
      expect(getTireChangeGranularity(telemetry({ dpLTireChange: 0, dpTireChange: 0 }))).toBe("side");
    });

    it("reads presence, not value", () => {
      expect(getTireChangeGranularity(telemetry({ dpTireChange: 1 }))).toBe("all");
    });

    it("returns null when no field is present", () => {
      expect(getTireChangeGranularity(telemetry({}))).toBeNull();
    });

    it("returns null for null or undefined telemetry", () => {
      expect(getTireChangeGranularity(null)).toBeNull();
      expect(getTireChangeGranularity(undefined)).toBeNull();
    });
  });

  describe("isPreGreen", () => {
    it("returns true for the pre-racing states (Invalid / GetInCar / Warmup / ParadeLaps)", () => {
      expect(isPreGreen(telemetry({ SessionState: SessionState.Invalid }))).toBe(true);
      expect(isPreGreen(telemetry({ SessionState: SessionState.GetInCar }))).toBe(true);
      expect(isPreGreen(telemetry({ SessionState: SessionState.Warmup }))).toBe(true);
      expect(isPreGreen(telemetry({ SessionState: SessionState.ParadeLaps }))).toBe(true);
    });

    it("returns false once racing and for the post-racing states", () => {
      expect(isPreGreen(telemetry({ SessionState: SessionState.Racing }))).toBe(false);
      expect(isPreGreen(telemetry({ SessionState: SessionState.Checkered }))).toBe(false);
      expect(isPreGreen(telemetry({ SessionState: SessionState.CoolDown }))).toBe(false);
    });

    it("returns false when SessionState is absent (back-compat default)", () => {
      expect(isPreGreen(telemetry({}))).toBe(false);
    });

    it("returns false for null/undefined telemetry", () => {
      expect(isPreGreen(null)).toBe(false);
      expect(isPreGreen(undefined)).toBe(false);
    });
  });

  describe("isPenaltyFlagActive", () => {
    it("returns true when the Black bit is set", () => {
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: Flags.Black }))).toBe(true);
    });

    it("returns true when the Disqualify bit is set (alone or with Black)", () => {
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: Flags.Disqualify }))).toBe(true);
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: Flags.Black | Flags.Disqualify }))).toBe(true);
    });

    it("returns true when a penalty bit rides alongside unrelated bits (the captured #846 escalation)", () => {
      // SessionFlags 0x10050000 — StartHidden | Servicible | Black.
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: 268763136 }))).toBe(true);
    });

    it("returns false for non-penalty flags (Furled is a warning, not a penalty)", () => {
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: Flags.Furled }))).toBe(false);
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: Flags.Green | Flags.Yellow }))).toBe(false);
      expect(isPenaltyFlagActive(telemetry({ SessionFlags: 0 }))).toBe(false);
    });

    it("returns false when SessionFlags is absent (don't punish missing data)", () => {
      expect(isPenaltyFlagActive(telemetry({}))).toBe(false);
    });

    it("returns false for null/undefined telemetry", () => {
      expect(isPenaltyFlagActive(null)).toBe(false);
      expect(isPenaltyFlagActive(undefined)).toBe(false);
    });
  });

  describe("isPostRace", () => {
    it("returns true for the post-racing states (Checkered / CoolDown)", () => {
      expect(isPostRace(telemetry({ SessionState: SessionState.Checkered }))).toBe(true);
      expect(isPostRace(telemetry({ SessionState: SessionState.CoolDown }))).toBe(true);
    });

    it("returns false for the pre-racing and racing states", () => {
      expect(isPostRace(telemetry({ SessionState: SessionState.Invalid }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.GetInCar }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.Warmup }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.ParadeLaps }))).toBe(false);
      expect(isPostRace(telemetry({ SessionState: SessionState.Racing }))).toBe(false);
    });

    it("returns false when SessionState is absent (back-compat default)", () => {
      expect(isPostRace(telemetry({}))).toBe(false);
    });

    it("returns false for null/undefined telemetry", () => {
      expect(isPostRace(null)).toBe(false);
      expect(isPostRace(undefined)).toBe(false);
    });
  });

  describe("resolveReplayFrame (#1162)", () => {
    it("reads ReplayFrameNumEnd on a live tick — ReplayFrameNum is a constant 0 while driving", () => {
      expect(
        resolveReplayFrame(
          telemetry({ IsReplayPlaying: false, IsOnTrack: true, ReplayFrameNum: 0, ReplayFrameNumEnd: 30821 }),
        ),
      ).toBe(30821);
    });

    it("reads ReplayFrameNum in a replay — the absolute position over the recording", () => {
      expect(
        resolveReplayFrame(telemetry({ IsReplayPlaying: true, ReplayFrameNum: 55657, ReplayFrameNumEnd: 26000 })),
      ).toBe(55657);
    });

    it("still reads ReplayFrameNum in a paused replay (speed 0, IsReplayPlaying true)", () => {
      expect(
        resolveReplayFrame(
          telemetry({ IsReplayPlaying: true, ReplayPlaySpeed: 0, ReplayFrameNum: 44373, ReplayFrameNumEnd: 100 }),
        ),
      ).toBe(44373);
    });

    it("treats a missing IsReplayPlaying as live", () => {
      expect(resolveReplayFrame(telemetry({ ReplayFrameNum: 7, ReplayFrameNumEnd: 900 }))).toBe(900);
    });

    it("returns null when the field the mode needs is missing", () => {
      expect(resolveReplayFrame(telemetry({ IsReplayPlaying: false, ReplayFrameNum: 0 }))).toBeNull();
      expect(resolveReplayFrame(telemetry({ IsReplayPlaying: true, ReplayFrameNumEnd: 100 }))).toBeNull();
    });

    it("returns null when the field is not a finite number", () => {
      expect(resolveReplayFrame(telemetry({ IsReplayPlaying: true, ReplayFrameNum: Number.NaN }))).toBeNull();
      expect(resolveReplayFrame(telemetry({ ReplayFrameNumEnd: "30821" as unknown as number }))).toBeNull();
    });

    it("returns null for null/undefined telemetry", () => {
      expect(resolveReplayFrame(null)).toBeNull();
      expect(resolveReplayFrame(undefined)).toBeNull();
    });
  });
});
