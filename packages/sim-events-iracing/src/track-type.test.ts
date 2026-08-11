import { describe, expect, it } from "vitest";

import { isDirtTrack, resolveTrackDirection, resolveTrackType, TrackDirection, TrackType } from "./track-type.js";

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

describe("isDirtTrack", () => {
  it.each([
    ["dirt oval", true],
    ["Dirt Road", true],
    ["road course", false],
    ["short oval", false],
  ])("classifies TrackType %s as dirt=%s", (trackType, expected) => {
    expect(isDirtTrack({ WeekendInfo: { TrackType: trackType } })).toBe(expected);
  });

  it("treats null / missing session info as pavement", () => {
    expect(isDirtTrack(null)).toBe(false);
    expect(isDirtTrack({})).toBe(false);
    expect(isDirtTrack({ WeekendInfo: { TrackType: 7 } })).toBe(false);
  });
});

describe("resolveTrackDirection", () => {
  it("maps 'left' to Left", () => {
    expect(resolveTrackDirection({ WeekendInfo: { TrackDirection: "left" } })).toBe(TrackDirection.Left);
  });

  it("maps 'right' to Right", () => {
    expect(resolveTrackDirection({ WeekendInfo: { TrackDirection: "right" } })).toBe(TrackDirection.Right);
  });

  it("maps 'neutral' to Neutral", () => {
    expect(resolveTrackDirection({ WeekendInfo: { TrackDirection: "neutral" } })).toBe(TrackDirection.Neutral);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveTrackDirection({ WeekendInfo: { TrackDirection: " Left " } })).toBe(TrackDirection.Left);
    expect(resolveTrackDirection({ WeekendInfo: { TrackDirection: "RIGHT" } })).toBe(TrackDirection.Right);
  });

  it("maps unrecognized directions to Neutral", () => {
    expect(resolveTrackDirection({ WeekendInfo: { TrackDirection: "sideways" } })).toBe(TrackDirection.Neutral);
    expect(resolveTrackDirection({ WeekendInfo: { TrackDirection: "" } })).toBe(TrackDirection.Neutral);
  });

  it("returns Neutral for null session info", () => {
    expect(resolveTrackDirection(null)).toBe(TrackDirection.Neutral);
  });

  it("returns Neutral when WeekendInfo or TrackDirection is missing", () => {
    expect(resolveTrackDirection({})).toBe(TrackDirection.Neutral);
    expect(resolveTrackDirection({ WeekendInfo: {} })).toBe(TrackDirection.Neutral);
  });

  it("returns Neutral when TrackDirection is not a string", () => {
    expect(resolveTrackDirection({ WeekendInfo: { TrackDirection: 1 } })).toBe(TrackDirection.Neutral);
  });
});
