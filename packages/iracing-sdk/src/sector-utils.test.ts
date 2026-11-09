import { describe, expect, it } from "vitest";

import { extractSectorStarts } from "./sector-utils.js";
import { parseSessionInfoYaml } from "./session-yaml.js";

/** A session info holding only these `SplitTimeInfo.Sectors` entries. */
function withSectors(sectors: unknown): Record<string, unknown> {
  return { SplitTimeInfo: { Sectors: sectors } };
}

describe("extractSectorStarts", () => {
  it("reads the mock session's three sectors from the YAML iRacing publishes", () => {
    // The `SplitTimeInfo` block of `@iracedeck/iracing-native`'s
    // `MOCK_SESSION_INFO_YAML`, verbatim, through the same parser the SDK uses.
    const yaml = [
      "---",
      "SplitTimeInfo:",
      " Sectors:",
      " - SectorNum: 0",
      "   SectorStartPct: 0.000000",
      " - SectorNum: 1",
      "   SectorStartPct: 0.333333",
      " - SectorNum: 2",
      "   SectorStartPct: 0.666667",
      "...",
      "",
    ].join("\n");

    expect(extractSectorStarts(parseSessionInfoYaml(yaml).info)).toEqual([0, 0.333333, 0.666667]);
  });

  it("sorts entries listed out of SectorNum order", () => {
    const info = withSectors([
      { SectorNum: 2, SectorStartPct: 0.7 },
      { SectorNum: 0, SectorStartPct: 0 },
      { SectorNum: 1, SectorStartPct: 0.4 },
    ]);

    expect(extractSectorStarts(info)).toEqual([0, 0.4, 0.7]);
  });

  it("returns null when the first sector does not start at the line", () => {
    const info = withSectors([
      { SectorNum: 0, SectorStartPct: 0.05 },
      { SectorNum: 1, SectorStartPct: 0.5 },
    ]);

    expect(extractSectorStarts(info)).toBeNull();
  });

  it("takes a first start within 1e-6 of 0 as the line, and returns it as exactly 0", () => {
    const info = withSectors([
      { SectorNum: 0, SectorStartPct: 0.0000005 },
      { SectorNum: 1, SectorStartPct: 0.5 },
    ]);

    expect(extractSectorStarts(info)).toEqual([0, 0.5]);
    // Positive control: just past the tolerance is not the line.
    expect(
      extractSectorStarts(
        withSectors([
          { SectorNum: 0, SectorStartPct: 0.000002 },
          { SectorNum: 1, SectorStartPct: 0.5 },
        ]),
      ),
    ).toBeNull();
  });

  it("returns null for a repeated start", () => {
    const info = withSectors([
      { SectorNum: 0, SectorStartPct: 0 },
      { SectorNum: 1, SectorStartPct: 0.5 },
      { SectorNum: 2, SectorStartPct: 0.5 },
    ]);

    expect(extractSectorStarts(info)).toBeNull();
  });

  it("returns null for a start lower than the one before it", () => {
    const info = withSectors([
      { SectorNum: 0, SectorStartPct: 0 },
      { SectorNum: 1, SectorStartPct: 0.6 },
      { SectorNum: 2, SectorStartPct: 0.3 },
    ]);

    expect(extractSectorStarts(info)).toBeNull();
  });

  it.each([1, 1.2])("returns null for a start of %s, at or above 1", (start) => {
    const info = withSectors([
      { SectorNum: 0, SectorStartPct: 0 },
      { SectorNum: 1, SectorStartPct: start },
    ]);

    expect(extractSectorStarts(info)).toBeNull();
  });

  it("returns null for a negative start, even one inside the line tolerance", () => {
    // -0.0000005 is within 1e-6 of 0, so only the `start < 0` check refuses it.
    const info = withSectors([
      { SectorNum: 0, SectorStartPct: -0.0000005 },
      { SectorNum: 1, SectorStartPct: 0.5 },
    ]);

    expect(extractSectorStarts(info)).toBeNull();
  });

  it("accepts a first start of exactly 1e-6 as the line, and refuses one just above", () => {
    expect(
      extractSectorStarts(
        withSectors([
          { SectorNum: 0, SectorStartPct: 1e-6 },
          { SectorNum: 1, SectorStartPct: 0.5 },
        ]),
      ),
    ).toEqual([0, 0.5]);
    expect(
      extractSectorStarts(
        withSectors([
          { SectorNum: 0, SectorStartPct: 1.1e-6 },
          { SectorNum: 1, SectorStartPct: 0.5 },
        ]),
      ),
    ).toBeNull();
  });

  it("returns null for a repeated SectorNum", () => {
    const info = withSectors([
      { SectorNum: 0, SectorStartPct: 0 },
      { SectorNum: 1, SectorStartPct: 0.3 },
      { SectorNum: 1, SectorStartPct: 0.6 },
    ]);

    expect(extractSectorStarts(info)).toBeNull();
    // Positive control: the same starts under distinct numbers are three sectors.
    expect(
      extractSectorStarts(
        withSectors([
          { SectorNum: 0, SectorStartPct: 0 },
          { SectorNum: 1, SectorStartPct: 0.3 },
          { SectorNum: 2, SectorStartPct: 0.6 },
        ]),
      ),
    ).toEqual([0, 0.3, 0.6]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, "0.5", null, undefined])(
    "returns null for a start that is not a finite number (%s)",
    (start) => {
      const info = withSectors([
        { SectorNum: 0, SectorStartPct: 0 },
        { SectorNum: 1, SectorStartPct: start },
      ]);

      expect(extractSectorStarts(info)).toBeNull();
    },
  );

  it("returns null for an entry without a numeric SectorNum, or a null list item", () => {
    expect(
      extractSectorStarts(
        withSectors([
          { SectorNum: 0, SectorStartPct: 0 },
          { SectorStartPct: 0.5 },
        ]),
      ),
    ).toBeNull();
    expect(extractSectorStarts(withSectors([{ SectorNum: 0, SectorStartPct: 0 }, null]))).toBeNull();
  });

  it("returns null when SplitTimeInfo is missing", () => {
    expect(extractSectorStarts({ WeekendInfo: {} })).toBeNull();
    expect(extractSectorStarts({ SplitTimeInfo: null })).toBeNull();
    expect(extractSectorStarts(null)).toBeNull();
    expect(extractSectorStarts(undefined)).toBeNull();
  });

  it("returns null when Sectors is missing or not a list", () => {
    expect(extractSectorStarts({ SplitTimeInfo: {} })).toBeNull();
    expect(extractSectorStarts(withSectors("nope"))).toBeNull();
  });

  it("returns null when Sectors is empty", () => {
    expect(extractSectorStarts(withSectors([]))).toBeNull();
  });

  it("returns [0] for a one-sector track", () => {
    expect(extractSectorStarts(withSectors([{ SectorNum: 0, SectorStartPct: 0 }]))).toEqual([0]);
  });
});
