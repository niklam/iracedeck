import { describe, expect, it } from "vitest";

import {
  absoluteWindBearingDeg,
  COMPASS_POINTS,
  compassPoint,
  convertWindSpeed,
  formatWindSpeed,
  normalizeDegrees,
  normalizeSignedDegrees,
  relativeWindAngleDeg,
  windSpeedUnitLabel,
} from "./wind-utils.js";

/** Bearings (rad) the in-sim captures confirmed for issue #947. */
const NORTH = 0;
const EAST = Math.PI / 2;
const SOUTH = Math.PI;
const WEST = (3 * Math.PI) / 2;

describe("normalizeDegrees", () => {
  it.each([
    [0, 0],
    [359, 359],
    [360, 0],
    [450, 90],
    [-90, 270],
    [-450, 270],
  ])("maps %s into [0, 360)", (input, expected) => {
    expect(normalizeDegrees(input)).toBeCloseTo(expected, 6);
  });
});

describe("normalizeSignedDegrees", () => {
  it.each([
    [0, 0],
    [90, 90],
    [180, 180],
    [181, -179],
    [270, -90],
    [-270, 90],
  ])("maps %s into (-180, 180]", (input, expected) => {
    expect(normalizeSignedDegrees(input)).toBeCloseTo(expected, 6);
  });
});

describe("relativeWindAngleDeg", () => {
  // The core contract: the returned angle is where the wind PUSHES the car,
  // not where it comes from. Car pointing north (yawNorth = 0) throughout.
  it("returns ±180 for a headwind (wind from dead ahead)", () => {
    expect(Math.abs(relativeWindAngleDeg(NORTH, NORTH)!)).toBeCloseTo(180, 6);
  });

  it("returns 0 for a tailwind (wind from directly behind)", () => {
    expect(relativeWindAngleDeg(SOUTH, NORTH)).toBeCloseTo(0, 6);
  });

  it("returns -90 when the wind comes from the right and pushes the car left", () => {
    expect(relativeWindAngleDeg(EAST, NORTH)).toBeCloseTo(-90, 6);
  });

  it("returns +90 when the wind comes from the left and pushes the car right", () => {
    expect(relativeWindAngleDeg(WEST, NORTH)).toBeCloseTo(90, 6);
  });

  it("rotates with the car: the same wind reads as a tailwind when the car turns to face away", () => {
    // Wind from the north; car also pointing north = headwind.
    expect(Math.abs(relativeWindAngleDeg(NORTH, NORTH)!)).toBeCloseTo(180, 6);
    // Car now points south — the same north wind is a tailwind.
    expect(relativeWindAngleDeg(NORTH, SOUTH)).toBeCloseTo(0, 6);
  });

  it("matches the live capture: car at bearing 51.23°, wind out of the north", () => {
    // local/telemetry-snapshot-20260809-183833-781.json — the wind source sits
    // 51° off the nose to the left, so the wind is mostly head-on while
    // pushing the car right (between +90 and +180).
    const yawNorth = 0.894069;

    expect(relativeWindAngleDeg(NORTH, yawNorth)).toBeCloseTo(128.77, 1);
  });

  it("stays within (-180, 180] across a full sweep of wind bearings", () => {
    for (let deg = 0; deg < 360; deg += 7) {
      const value = relativeWindAngleDeg((deg * Math.PI) / 180, 0.5)!;

      expect(value).toBeGreaterThan(-180.000001);
      expect(value).toBeLessThanOrEqual(180.000001);
    }
  });

  it.each([
    ["windDir missing", undefined, NORTH],
    ["yawNorth missing", NORTH, undefined],
    ["both missing", undefined, undefined],
    ["windDir not finite", Number.NaN, NORTH],
    ["yawNorth not finite", NORTH, Number.POSITIVE_INFINITY],
  ])("returns null when %s", (_label, windDir, yawNorth) => {
    expect(relativeWindAngleDeg(windDir, yawNorth)).toBeNull();
  });
});

describe("absoluteWindBearingDeg", () => {
  it.each([
    ["north", NORTH, 0],
    ["east", EAST, 90],
    ["south", SOUTH, 180],
    ["west", WEST, 270],
  ])("converts %s to degrees", (_label, rad, expected) => {
    expect(absoluteWindBearingDeg(rad)).toBeCloseTo(expected, 6);
  });

  it("normalizes a bearing past a full turn", () => {
    expect(absoluteWindBearingDeg(2 * Math.PI + EAST)).toBeCloseTo(90, 6);
  });

  it.each([
    ["missing", undefined],
    ["not finite", Number.NaN],
  ])("returns null when the bearing is %s", (_label, input) => {
    expect(absoluteWindBearingDeg(input)).toBeNull();
  });
});

describe("compassPoint", () => {
  it.each([
    [0, "N"],
    [22.5, "NNE"],
    [45, "NE"],
    [90, "E"],
    [135, "SE"],
    [180, "S"],
    [225, "SW"],
    [270, "W"],
    [315, "NW"],
    [359, "N"],
  ])("names %s° as %s", (bearing, expected) => {
    expect(compassPoint(bearing)).toBe(expected);
  });

  it("rounds to the nearest of the 16 points", () => {
    expect(compassPoint(11)).toBe("N");
    expect(compassPoint(12)).toBe("NNE");
  });

  it("covers every compass point across a full turn", () => {
    const seen = new Set<string>();

    for (let deg = 0; deg < 360; deg += 1) seen.add(compassPoint(deg)!);

    expect(seen.size).toBe(COMPASS_POINTS.length);
  });

  it.each([
    ["null", null],
    ["not finite", Number.NaN],
  ])("returns null for a %s bearing", (_label, input) => {
    expect(compassPoint(input)).toBeNull();
  });
});

describe("convertWindSpeed", () => {
  it("passes m/s through unchanged", () => {
    expect(convertWindSpeed(0.89408, "ms")).toBeCloseTo(0.89408, 6);
  });

  it("converts the captured 3 km/h wind", () => {
    // local/telemetry-snapshot-20260809-183545-140.json: WeekendOptions reported 3.22 km/h.
    expect(convertWindSpeed(0.89408, "kmh")).toBeCloseTo(3.22, 2);
  });

  it("converts the captured 6 km/h wind", () => {
    // local/telemetry-snapshot-20260809-184416-196.json: WeekendOptions reported 6.44 km/h.
    expect(convertWindSpeed(1.78816, "kmh")).toBeCloseTo(6.44, 2);
  });

  it("converts to mph", () => {
    expect(convertWindSpeed(10, "mph")).toBeCloseTo(22.3694, 4);
  });

  it.each([
    ["missing", undefined],
    ["not finite", Number.NaN],
  ])("returns null when the speed is %s", (_label, input) => {
    expect(convertWindSpeed(input, "kmh")).toBeNull();
  });
});

describe("windSpeedUnitLabel", () => {
  it.each([
    ["ms", "m/s"],
    ["kmh", "km/h"],
    ["mph", "mph"],
  ] as const)("labels %s as %s", (unit, expected) => {
    expect(windSpeedUnitLabel(unit)).toBe(expected);
  });
});

describe("formatWindSpeed", () => {
  it("rounds km/h to whole units", () => {
    expect(formatWindSpeed(3.0, "kmh")).toBe("11 km/h");
  });

  it("rounds mph to whole units", () => {
    expect(formatWindSpeed(10, "mph")).toBe("22 mph");
  });

  it("keeps one decimal in m/s so a light breeze doesn't collapse to zero", () => {
    expect(formatWindSpeed(0.89408, "ms")).toBe("0.9 m/s");
  });

  it("keeps the m/s decimal at higher speeds too", () => {
    expect(formatWindSpeed(12.44, "ms")).toBe("12.4 m/s");
  });

  it.each([
    ["missing", undefined],
    ["not finite", Number.NaN],
  ])("returns null when the speed is %s", (_label, input) => {
    expect(formatWindSpeed(input, "kmh")).toBeNull();
  });
});
