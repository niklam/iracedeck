/**
 * Unit tests for the tread zone mapping the tire families share (issues
 * #1108, #254).
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import {
  readTireZoneValues,
  TIRE_CORNERS,
  type TireZoneFamily,
  tireZoneValuesAre,
  zonesFromCarSides,
} from "./tire-zones.js";

const FAMILIES: TireZoneFamily[] = ["wear", "tempC"];

/** Twelve distinct readings of a family: LF 1/2/3, RF 4/5/6, LR 7/8/9, RR 10/11/12. */
function twelve(family: TireZoneFamily, overrides: Record<string, unknown> = {}): TelemetryData {
  const fields = ["LF", "RF", "LR", "RR"].flatMap((corner) => ["L", "M", "R"].map((z) => `${corner}${family}${z}`));

  return { ...Object.fromEntries(fields.map((field, i) => [field, i + 1])), ...overrides } as unknown as TelemetryData;
}

describe("TIRE_CORNERS", () => {
  it("walks the corners lf, rf, lr, rr, the left-side tires on the left", () => {
    expect(TIRE_CORNERS.map(({ corner, side }) => [corner, side])).toEqual([
      ["lf", "left"],
      ["rf", "right"],
      ["lr", "left"],
      ["rr", "right"],
    ]);
  });
});

describe.each(FAMILIES)("readTireZoneValues — %s", (family) => {
  it("reads the twelve values in corner order, each corner as the car's left / middle / right", () => {
    expect(readTireZoneValues(twelve(family), family)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("reads only its own family", () => {
    const other: TireZoneFamily = family === "wear" ? "tempC" : "wear";

    expect(readTireZoneValues(twelve(other), family)).toBeNull();
  });

  it("returns null when a value is missing or not a finite number", () => {
    for (const bad of [undefined, NaN, Infinity, "5", null]) {
      expect(readTireZoneValues(twelve(family, { [`RR${family}M`]: bad }), family), String(bad)).toBeNull();
    }
  });

  it("returns null when all twelve are zero, and reads when only some are", () => {
    const zeros = Object.fromEntries(Object.keys(twelve(family)).map((field) => [field, 0]));

    expect(readTireZoneValues(zeros as unknown as TelemetryData, family)).toBeNull();
    expect(readTireZoneValues({ ...zeros, [`LF${family}L`]: 4 } as unknown as TelemetryData, family)).toEqual([
      4,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
  });
});

describe.each(FAMILIES)("tireZoneValuesAre — %s", (family) => {
  const held = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  it("is true for exactly the held values", () => {
    expect(tireZoneValuesAre(twelve(family), family, held)).toBe(true);
  });

  it("is false when any one value differs, however little", () => {
    for (const field of Object.keys(twelve(family))) {
      const moved = twelve(family, { [field]: (twelve(family) as unknown as Record<string, number>)[field]! + 1e-9 });

      expect(tireZoneValuesAre(moved, family, held), field).toBe(false);
    }
  });

  it("is false when a value is missing", () => {
    expect(tireZoneValuesAre(twelve(family, { [`LR${family}R`]: undefined }), family, held)).toBe(false);
  });
});

describe("zonesFromCarSides", () => {
  it("names the sim's L the outside and R the inside on a left-side tire", () => {
    expect(zonesFromCarSides("left", 1, 2, 3)).toEqual({ outside: 1, middle: 2, inside: 3 });
  });

  it("names the sim's L the inside and R the outside on a right-side tire", () => {
    expect(zonesFromCarSides("right", 1, 2, 3)).toEqual({ inside: 1, middle: 2, outside: 3 });
  });
});
