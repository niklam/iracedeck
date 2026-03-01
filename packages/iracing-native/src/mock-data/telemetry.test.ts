import { describe, expect, it } from "vitest";

import { VarType, VarTypeBytes } from "../defines.js";
import { buildTelemetryBuffer, getBufferSize, MOCK_VAR_HEADERS, MOCK_VAR_INDEX_MAP } from "./telemetry.js";

describe("MOCK_VAR_HEADERS", () => {
  it("should have non-empty headers array", () => {
    expect(MOCK_VAR_HEADERS.length).toBeGreaterThan(0);
  });

  it("should have unique variable names", () => {
    const names = MOCK_VAR_HEADERS.map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("should have non-overlapping offsets", () => {
    const ranges = MOCK_VAR_HEADERS.map((h) => ({
      name: h.name,
      start: h.offset,
      end: h.offset + VarTypeBytes[h.type] * h.count,
    }));

    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const overlap = ranges[i].start < ranges[j].end && ranges[j].start < ranges[i].end;
        expect(overlap, `${ranges[i].name} overlaps with ${ranges[j].name}`).toBe(false);
      }
    }
  });

  it("should have proper alignment for each type", () => {
    for (const header of MOCK_VAR_HEADERS) {
      const alignment = Math.min(VarTypeBytes[header.type], 8);
      expect(
        header.offset % alignment,
        `${header.name} at offset ${header.offset} is not aligned to ${alignment}`,
      ).toBe(0);
    }
  });
});

describe("MOCK_VAR_INDEX_MAP", () => {
  it("should map all header names", () => {
    expect(MOCK_VAR_INDEX_MAP.size).toBe(MOCK_VAR_HEADERS.length);
  });

  it("should return correct indices", () => {
    for (let i = 0; i < MOCK_VAR_HEADERS.length; i++) {
      expect(MOCK_VAR_INDEX_MAP.get(MOCK_VAR_HEADERS[i].name)).toBe(i);
    }
  });

  it("should contain common telemetry variables", () => {
    const expected = ["Speed", "RPM", "Gear", "FuelLevel", "Lap", "SessionTime"];

    for (const name of expected) {
      expect(MOCK_VAR_INDEX_MAP.has(name), `Missing variable: ${name}`).toBe(true);
    }
  });
});

describe("getBufferSize", () => {
  it("should return a positive number", () => {
    expect(getBufferSize()).toBeGreaterThan(0);
  });

  it("should cover all variable data", () => {
    const size = getBufferSize();

    for (const h of MOCK_VAR_HEADERS) {
      const end = h.offset + VarTypeBytes[h.type] * h.count;
      expect(size, `Buffer too small for ${h.name}`).toBeGreaterThanOrEqual(end);
    }
  });
});

describe("buildTelemetryBuffer", () => {
  it("should create a buffer of the correct size", () => {
    const buf = buildTelemetryBuffer({});
    expect(buf.length).toBe(getBufferSize());
  });

  it("should write float values correctly", () => {
    const speed = 75.5;
    const buf = buildTelemetryBuffer({ Speed: speed });
    const header = MOCK_VAR_HEADERS.find((h) => h.name === "Speed")!;
    expect(buf.readFloatLE(header.offset)).toBeCloseTo(speed, 5);
  });

  it("should write int values correctly", () => {
    const gear = 4;
    const buf = buildTelemetryBuffer({ Gear: gear });
    const header = MOCK_VAR_HEADERS.find((h) => h.name === "Gear")!;
    expect(buf.readInt32LE(header.offset)).toBe(gear);
  });

  it("should write double values correctly", () => {
    const sessionTime = 245.123;
    const buf = buildTelemetryBuffer({ SessionTime: sessionTime });
    const header = MOCK_VAR_HEADERS.find((h) => h.name === "SessionTime")!;
    expect(buf.readDoubleLE(header.offset)).toBeCloseTo(sessionTime, 10);
  });

  it("should write boolean values correctly", () => {
    const buf = buildTelemetryBuffer({ IsOnTrack: true });
    const header = MOCK_VAR_HEADERS.find((h) => h.name === "IsOnTrack")!;
    expect(buf.readInt8(header.offset)).toBe(1);

    const buf2 = buildTelemetryBuffer({ IsOnTrack: false });
    expect(buf2.readInt8(header.offset)).toBe(0);
  });

  it("should write array values correctly", () => {
    const laps = new Array<number>(64).fill(-1);
    laps[0] = 5;
    laps[1] = 3;
    laps[2] = 2;

    const buf = buildTelemetryBuffer({ CarIdxLap: laps });
    const header = MOCK_VAR_HEADERS.find((h) => h.name === "CarIdxLap")!;

    expect(header.type).toBe(VarType.Int);
    expect(buf.readInt32LE(header.offset)).toBe(5);
    expect(buf.readInt32LE(header.offset + 4)).toBe(3);
    expect(buf.readInt32LE(header.offset + 8)).toBe(2);
    expect(buf.readInt32LE(header.offset + 12)).toBe(-1);
  });

  it("should handle missing values as zero-filled", () => {
    const buf = buildTelemetryBuffer({});
    const header = MOCK_VAR_HEADERS.find((h) => h.name === "Speed")!;
    expect(buf.readFloatLE(header.offset)).toBe(0);
  });
});
