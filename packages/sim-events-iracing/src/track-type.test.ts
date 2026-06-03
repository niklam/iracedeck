import { describe, expect, it } from "vitest";

import { resolveTrackType, TrackType } from "./track-type.js";

describe("resolveTrackType", () => {
  it("maps 'road course' to RoadCourse", () => {
    expect(resolveTrackType({ WeekendInfo: { TrackType: "road course" } })).toBe(TrackType.RoadCourse);
  });

  it("maps 'dirt oval' to DirtOval", () => {
    expect(resolveTrackType({ WeekendInfo: { TrackType: "dirt oval" } })).toBe(TrackType.DirtOval);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveTrackType({ WeekendInfo: { TrackType: "  Dirt Oval  " } })).toBe(TrackType.DirtOval);
    expect(resolveTrackType({ WeekendInfo: { TrackType: "ROAD COURSE" } })).toBe(TrackType.RoadCourse);
  });

  it("maps unrecognized track types to Unknown", () => {
    expect(resolveTrackType({ WeekendInfo: { TrackType: "asphalt oval" } })).toBe(TrackType.Unknown);
    expect(resolveTrackType({ WeekendInfo: { TrackType: "" } })).toBe(TrackType.Unknown);
  });

  it("returns Unknown for null session info", () => {
    expect(resolveTrackType(null)).toBe(TrackType.Unknown);
  });

  it("returns Unknown when WeekendInfo or TrackType is missing", () => {
    expect(resolveTrackType({})).toBe(TrackType.Unknown);
    expect(resolveTrackType({ WeekendInfo: {} })).toBe(TrackType.Unknown);
  });

  it("returns Unknown when TrackType is not a string", () => {
    expect(resolveTrackType({ WeekendInfo: { TrackType: 3 } })).toBe(TrackType.Unknown);
  });
});
