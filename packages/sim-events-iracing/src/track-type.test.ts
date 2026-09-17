import { describe, expect, it } from "vitest";

import {
  isDirtTrack,
  isOvalTrack,
  resolveTrackDirection,
  resolveTrackType,
  TrackDirection,
  TrackType,
} from "./track-type.js";

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

describe("isOvalTrack", () => {
  it("reads the captured oval", () => {
    // Measured 2026-09-17 at Homestead-Miami — see the #1127 spec.
    expect(isOvalTrack({ WeekendInfo: { Category: "Oval", TrackType: "medium oval" } })).toBe(true);
  });

  it.each([
    ["Oval", true],
    ["DirtOval", true],
    ["Dirt Oval", true],
    ["oval", true],
    ["Road", false],
    ["DirtRoad", false],
  ])("lets an enumerated Category %s settle it as oval=%s, whatever the track type says", (category, expected) => {
    // The Category is checked against a list, so it answers in BOTH directions
    // and the substring fallback never runs — here against a TrackType that
    // would have said the opposite on its own.
    const trackType = expected ? "road course" : "superspeedway";

    expect(isOvalTrack({ WeekendInfo: { Category: category, TrackType: trackType } })).toBe(expected);
  });

  it.each([
    ["medium oval", true],
    ["short oval", true],
    ["dirt oval", true],
    ["superspeedway", true],
    ["road course", false],
    ["dirt road", false],
  ])("falls back to TrackType %s when there is no Category, giving oval=%s", (trackType, expected) => {
    expect(isOvalTrack({ WeekendInfo: { TrackType: trackType } })).toBe(expected);
  });

  it("falls back to TrackType for a Category it does not recognize", () => {
    // A value iRacing adds later must degrade to the substring rather than
    // silently turn every oval into a road course.
    expect(isOvalTrack({ WeekendInfo: { Category: "SportsCar", TrackType: "short oval" } })).toBe(true);
  });

  it("is not fooled by a roval, whose Category says road while its name contains oval", () => {
    // The one direction a substring gets wrong on its own, and the reason the
    // enumerated Category is the primary test rather than a second opinion.
    expect(isOvalTrack({ WeekendInfo: { Category: "Road", TrackType: "roval" } })).toBe(false);
  });

  it("does not guess without session info", () => {
    expect(isOvalTrack(null)).toBe(false);
    expect(isOvalTrack({})).toBe(false);
    expect(isOvalTrack({ WeekendInfo: {} })).toBe(false);
    expect(isOvalTrack({ WeekendInfo: { TrackType: 3, Category: 7 } })).toBe(false);
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
