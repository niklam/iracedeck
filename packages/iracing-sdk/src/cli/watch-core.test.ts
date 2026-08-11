import { describe, expect, it } from "vitest";

import type { TelemetryData } from "../types.js";
import {
  buildConnectionRecord,
  buildMetaRecord,
  buildTickRecord,
  findMissingVars,
  formatWatchSummary,
  parseWatchArgs,
  pickWatchValues,
  watchBaseName,
  watchValuesChanged,
} from "./watch-core.js";

describe("parseWatchArgs", () => {
  it("parses vars, mode, output, and flags", () => {
    const { options, error } = parseWatchArgs([
      "--vars=PlayerIncidents,PlayerCarMyIncidentCount",
      "--mode=all",
      "--output=capture.jsonl",
      "--verbose",
    ]);

    expect(error).toBeNull();
    expect(options.vars).toEqual(["PlayerIncidents", "PlayerCarMyIncidentCount"]);
    expect(options.mode).toBe("all");
    expect(options.output).toBe("capture.jsonl");
    expect(options.outputDir).toBeNull();
    expect(options.verbose).toBe(true);
  });

  it("defaults mode to changes and outputs to null", () => {
    const { options, error } = parseWatchArgs(["--vars=Speed"]);

    expect(error).toBeNull();
    expect(options.mode).toBe("changes");
    expect(options.output).toBeNull();
    expect(options.outputDir).toBeNull();
    expect(options.verbose).toBe(false);
  });

  it("trims var names and drops empty entries", () => {
    const { options } = parseWatchArgs(["--vars= Speed , ,Gear "]);

    expect(options.vars).toEqual(["Speed", "Gear"]);
  });

  it("errors when --vars is missing", () => {
    const { error } = parseWatchArgs([]);

    expect(error).toMatch(/--vars/);
  });

  it("errors when --vars is empty", () => {
    const { error } = parseWatchArgs(["--vars=,"]);

    expect(error).toMatch(/--vars/);
  });

  it("errors on an invalid mode", () => {
    const { error } = parseWatchArgs(["--vars=Speed", "--mode=sometimes"]);

    expect(error).toMatch(/mode/i);
  });

  it("errors on an unknown argument", () => {
    const { error } = parseWatchArgs(["--vars=Speed", "--frobnicate"]);

    expect(error).toMatch(/--frobnicate/);
  });

  it("help short-circuits validation", () => {
    const { options, error } = parseWatchArgs(["--help"]);

    expect(error).toBeNull();
    expect(options.help).toBe(true);
  });

  it("accepts -h and -v shorthands", () => {
    const { options } = parseWatchArgs(["--vars=Speed", "-h", "-v"]);

    expect(options.help).toBe(true);
    expect(options.verbose).toBe(true);
  });
});

describe("pickWatchValues", () => {
  it("extracts requested vars in request order", () => {
    const telemetry = { Gear: 3, Speed: 42.5 } as TelemetryData;

    const values = pickWatchValues(telemetry, ["Speed", "Gear"]);

    expect(Object.keys(values)).toEqual(["Speed", "Gear"]);
    expect(values).toEqual({ Speed: 42.5, Gear: 3 });
  });

  it("records missing vars as null so the record shape stays stable", () => {
    const telemetry = { Speed: 42.5 } as TelemetryData;

    expect(pickWatchValues(telemetry, ["Speed", "NoSuchVar"])).toEqual({ Speed: 42.5, NoSuchVar: null });
  });
});

describe("watchValuesChanged", () => {
  it("always reports change when there is no previous record", () => {
    expect(watchValuesChanged(null, { Speed: 0 })).toBe(true);
  });

  it("reports no change for identical primitives", () => {
    expect(watchValuesChanged({ Speed: 42.5, Live: true }, { Speed: 42.5, Live: true })).toBe(false);
  });

  it("detects a primitive change", () => {
    expect(watchValuesChanged({ Speed: 42.5 }, { Speed: 43 })).toBe(true);
  });

  it("compares arrays by content", () => {
    expect(watchValuesChanged({ Flags: [1, 2] }, { Flags: [1, 2] })).toBe(false);
    expect(watchValuesChanged({ Flags: [1, 2] }, { Flags: [1, 3] })).toBe(true);
  });

  it("treats a var flipping to null as a change", () => {
    expect(watchValuesChanged({ Speed: 42.5 }, { Speed: null })).toBe(true);
  });
});

describe("findMissingVars", () => {
  it("lists requested vars absent from the frame", () => {
    const telemetry = { Speed: 1 } as TelemetryData;

    expect(findMissingVars(telemetry, ["Speed", "Bogus", "AlsoBogus"])).toEqual(["Bogus", "AlsoBogus"]);
  });

  it("returns an empty list when everything is present", () => {
    const telemetry = { Speed: 1 } as TelemetryData;

    expect(findMissingVars(telemetry, ["Speed"])).toEqual([]);
  });
});

describe("record builders", () => {
  it("builds the meta record", () => {
    const startedAt = new Date("2026-08-11T18:00:00.000Z");

    expect(buildMetaRecord(startedAt, ["A", "B"], "changes")).toEqual({
      type: "meta",
      startedAt: "2026-08-11T18:00:00.000Z",
      vars: ["A", "B"],
      mode: "changes",
    });
  });

  it("builds a tick record with SessionTick/SessionTime lifted out", () => {
    const telemetry = { SessionTick: 1234, SessionTime: 56.78, PlayerIncidents: 5 } as TelemetryData;

    expect(buildTickRecord(1700000000000, telemetry, ["PlayerIncidents"])).toEqual({
      type: "tick",
      ts: 1700000000000,
      sessionTick: 1234,
      sessionTime: 56.78,
      values: { PlayerIncidents: 5 },
    });
  });

  it("null-fills SessionTick/SessionTime when the frame lacks them", () => {
    const telemetry = { PlayerIncidents: 0 } as TelemetryData;

    const record = buildTickRecord(1, telemetry, ["PlayerIncidents"]);

    expect(record.sessionTick).toBeNull();
    expect(record.sessionTime).toBeNull();
  });

  it("builds a connection record", () => {
    expect(buildConnectionRecord(42, true)).toEqual({ type: "connection", ts: 42, connected: true });
  });
});

describe("watchBaseName", () => {
  it("formats a filesystem-safe, millisecond-unique name", () => {
    const now = new Date(2026, 7, 11, 18, 5, 7, 42);

    expect(watchBaseName(now)).toBe("telemetry-watch-20260811-180507-042");
  });
});

describe("formatWatchSummary", () => {
  it("formats sub-minute durations in seconds", () => {
    expect(formatWatchSummary(12, 42_000)).toBe("Recorded 12 tick records in 42s");
  });

  it("formats longer durations as minutes and seconds", () => {
    expect(formatWatchSummary(345, 272_000)).toBe("Recorded 345 tick records in 4m 32s");
  });
});
