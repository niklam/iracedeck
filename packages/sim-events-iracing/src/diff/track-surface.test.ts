import { TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { isRacingSurface } from "./track-surface.js";

describe("isRacingSurface", () => {
  it("is true on the racing surface and beside it", () => {
    expect(isRacingSurface(TrkLoc.OnTrack)).toBe(true);
    expect(isRacingSurface(TrkLoc.OffTrack)).toBe(true);
  });

  it("is false in the pits and out of the world", () => {
    expect(isRacingSurface(TrkLoc.InPitStall)).toBe(false);
    expect(isRacingSurface(TrkLoc.AproachingPits)).toBe(false);
    expect(isRacingSurface(TrkLoc.NotInWorld)).toBe(false);
  });

  it("is false for a surface that could not be read", () => {
    expect(isRacingSurface(undefined)).toBe(false);
    expect(isRacingSurface(null)).toBe(false);
    expect(isRacingSurface("3")).toBe(false);
  });
});
