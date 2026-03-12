import { describe, expect, it } from "vitest";

import {
  buildTemplateContextFromData,
  findDriverByRacePosition,
  findNearestDriverOnTrack,
  flattenForDisplay,
  formatTimeRemaining,
  prefixKeys,
  splitDriverName,
} from "./template-context.js";
import type { SessionInfo } from "./types.js";
import type { TelemetryData } from "./types.js";

function makeDriver(overrides: Record<string, unknown> = {}) {
  return {
    CarIdx: 0,
    UserName: "Test Driver",
    AbbrevName: "T. Driver",
    CarNumber: "1",
    IRating: 3000,
    LicString: "A 4.99",
    IsSpectator: 0,
    CarIsPaceCar: 0,
    ...overrides,
  };
}

function makeSessionInfo(drivers: ReturnType<typeof makeDriver>[], playerCarIdx = 0): SessionInfo {
  return {
    DriverInfo: {
      DriverCarIdx: playerCarIdx,
      Drivers: drivers,
    },
    WeekendInfo: {
      TrackDisplayName: "Spa-Francorchamps",
      TrackDisplayShortName: "Spa",
    },
    SessionInfo: {
      Sessions: [{ SessionType: "Race", SessionName: "RACE" }],
    },
  } as unknown as SessionInfo;
}

function makeTelemetry(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    PlayerCarPosition: 2,
    PlayerCarClassPosition: 2,
    PlayerCarMyIncidentCount: 3,
    Lap: 5,
    LapCompleted: 4,
    SessionNum: 0,
    SessionLapsRemainEx: 10,
    SessionTimeRemain: 3661,
    CarIdxPosition: [2, 1, 3],
    CarIdxClassPosition: [2, 1, 3],
    CarIdxLap: [5, 6, 4],
    CarIdxLapCompleted: [4, 5, 3],
    CarIdxLapDistPct: [0.5, 0.7, 0.3],
    CarIdxOnPitRoad: [false, false, false],
    ...overrides,
  } as TelemetryData;
}

describe("splitDriverName", () => {
  it("should split first and last name", () => {
    expect(splitDriverName("John Smith")).toEqual({ firstName: "John", lastName: "Smith" });
  });

  it("should handle single name", () => {
    expect(splitDriverName("John")).toEqual({ firstName: "John", lastName: "" });
  });

  it("should handle name with suffix", () => {
    expect(splitDriverName("John Smith Jr.")).toEqual({ firstName: "John", lastName: "Smith Jr." });
  });

  it("should handle empty string", () => {
    expect(splitDriverName("")).toEqual({ firstName: "", lastName: "" });
  });

  it("should trim whitespace", () => {
    expect(splitDriverName("  John Smith  ")).toEqual({ firstName: "John", lastName: "Smith" });
  });
});

describe("formatTimeRemaining", () => {
  it("should format seconds to MM:SS", () => {
    expect(formatTimeRemaining(125)).toBe("2:05");
  });

  it("should format zero", () => {
    expect(formatTimeRemaining(0)).toBe("0:00");
  });

  it("should format large values", () => {
    expect(formatTimeRemaining(3661)).toBe("61:01");
  });

  it("should return empty for undefined", () => {
    expect(formatTimeRemaining(undefined)).toBe("");
  });

  it("should return empty for negative values", () => {
    expect(formatTimeRemaining(-1)).toBe("");
  });
});

describe("findNearestDriverOnTrack", () => {
  const drivers = [
    makeDriver({ CarIdx: 0, UserName: "Player" }),
    makeDriver({ CarIdx: 1, UserName: "Ahead Car" }),
    makeDriver({ CarIdx: 2, UserName: "Behind Car" }),
  ];

  it("should find the car physically ahead", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [4, 5, 3],
      CarIdxLapDistPct: [0.5, 0.7, 0.3],
      CarIdxOnPitRoad: [false, false, false],
    });

    const result = findNearestDriverOnTrack(0, drivers, telemetry, "ahead");

    expect(result?.UserName).toBe("Ahead Car");
  });

  it("should find the car physically behind", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [4, 5, 3],
      CarIdxLapDistPct: [0.5, 0.7, 0.3],
      CarIdxOnPitRoad: [false, false, false],
    });

    const result = findNearestDriverOnTrack(0, drivers, telemetry, "behind");

    expect(result?.UserName).toBe("Behind Car");
  });

  it("should return null when leading on track", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [10, 5, 3],
      CarIdxLapDistPct: [0.9, 0.7, 0.3],
      CarIdxOnPitRoad: [false, false, false],
    });

    const result = findNearestDriverOnTrack(0, drivers, telemetry, "ahead");

    expect(result).toBeNull();
  });

  it("should return null when last on track", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [1, 5, 3],
      CarIdxLapDistPct: [0.1, 0.7, 0.3],
      CarIdxOnPitRoad: [false, false, false],
    });

    const result = findNearestDriverOnTrack(0, drivers, telemetry, "behind");

    expect(result).toBeNull();
  });

  it("should skip cars on pit road", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [4, 5, 3],
      CarIdxLapDistPct: [0.5, 0.7, 0.3],
      CarIdxOnPitRoad: [false, true, false],
    });

    const result = findNearestDriverOnTrack(0, drivers, telemetry, "ahead");

    expect(result).toBeNull();
  });

  it("should skip pace car", () => {
    const driversWithPace = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Pace Car", CarIsPaceCar: 1 }),
      makeDriver({ CarIdx: 2, UserName: "Behind Car" }),
    ];

    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [4, 5, 3],
      CarIdxLapDistPct: [0.5, 0.7, 0.3],
      CarIdxOnPitRoad: [false, false, false],
    });

    const result = findNearestDriverOnTrack(0, driversWithPace, telemetry, "ahead");

    expect(result).toBeNull();
  });

  it("should skip spectators", () => {
    const driversWithSpectator = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Spectator", IsSpectator: 1 }),
      makeDriver({ CarIdx: 2, UserName: "Behind Car" }),
    ];

    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [4, 5, 3],
      CarIdxLapDistPct: [0.5, 0.7, 0.3],
      CarIdxOnPitRoad: [false, false, false],
    });

    const result = findNearestDriverOnTrack(0, driversWithSpectator, telemetry, "ahead");

    expect(result).toBeNull();
  });

  it("should return null with no telemetry", () => {
    expect(findNearestDriverOnTrack(0, drivers, null, "ahead")).toBeNull();
  });

  it("should find lapped car directly ahead", () => {
    const driversMany = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Leader" }),
      makeDriver({ CarIdx: 2, UserName: "Lapped Car" }),
    ];

    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [10, 12, 8],
      CarIdxLapDistPct: [0.5, 0.9, 0.51],
      CarIdxOnPitRoad: [false, false, false],
    });

    const result = findNearestDriverOnTrack(0, driversMany, telemetry, "ahead");

    expect(result?.UserName).toBe("Leader");
  });
});

describe("findDriverByRacePosition", () => {
  const drivers = [
    makeDriver({ CarIdx: 0, UserName: "Player" }),
    makeDriver({ CarIdx: 1, UserName: "First Place" }),
    makeDriver({ CarIdx: 2, UserName: "Third Place" }),
  ];

  it("should find driver at position ahead", () => {
    const telemetry = makeTelemetry({ CarIdxPosition: [2, 1, 3] });

    expect(findDriverByRacePosition(0, drivers, telemetry, -1)?.UserName).toBe("First Place");
  });

  it("should find driver at position behind", () => {
    const telemetry = makeTelemetry({ CarIdxPosition: [2, 1, 3] });

    expect(findDriverByRacePosition(0, drivers, telemetry, +1)?.UserName).toBe("Third Place");
  });

  it("should return null when in first position and looking ahead", () => {
    const telemetry = makeTelemetry({ CarIdxPosition: [1, 2, 3] });

    expect(findDriverByRacePosition(0, drivers, telemetry, -1)).toBeNull();
  });

  it("should return null when in last position and looking behind", () => {
    const telemetry = makeTelemetry({ CarIdxPosition: [3, 1, 2] });

    expect(findDriverByRacePosition(0, drivers, telemetry, +1)).toBeNull();
  });

  it("should return null with no telemetry", () => {
    expect(findDriverByRacePosition(0, drivers, null, -1)).toBeNull();
  });

  it("should return null when player position is 0", () => {
    const telemetry = makeTelemetry({ CarIdxPosition: [0, 1, 2] });

    expect(findDriverByRacePosition(0, drivers, telemetry, -1)).toBeNull();
  });
});

describe("prefixKeys", () => {
  it("should prefix all keys", () => {
    const result = prefixKeys("self", { name: "John", position: "3" });

    expect(result).toEqual({ "self.name": "John", "self.position": "3" });
  });

  it("should handle empty record", () => {
    expect(prefixKeys("self", {})).toEqual({});
  });

  it("should handle keys that already contain dots", () => {
    const result = prefixKeys("sessionInfo", { "WeekendInfo.TrackName": "Spa" });

    expect(result).toEqual({ "sessionInfo.WeekendInfo.TrackName": "Spa" });
  });
});

describe("buildTemplateContextFromData", () => {
  it("should build flat context with valid data", () => {
    const drivers = [
      makeDriver({
        CarIdx: 0,
        UserName: "John Smith",
        AbbrevName: "J. Smith",
        CarNumber: "1",
        IRating: 3500,
        LicString: "A 4.99",
      }),
      makeDriver({
        CarIdx: 1,
        UserName: "Jane Doe",
        AbbrevName: "J. Doe",
        CarNumber: "42",
        IRating: 2800,
        LicString: "B 3.50",
      }),
      makeDriver({
        CarIdx: 2,
        UserName: "Bob Wilson",
        AbbrevName: "B. Wilson",
        CarNumber: "77",
        IRating: 2200,
        LicString: "C 2.50",
      }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry();
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx["self.name"]).toBe("John Smith");
    expect(ctx["self.first_name"]).toBe("John");
    expect(ctx["self.last_name"]).toBe("Smith");
    expect(ctx["self.position"]).toBe("2");
    expect(ctx["self.incidents"]).toBe("3");
    expect(ctx["session.type"]).toBe("Race");
    expect(ctx["session.laps_remaining"]).toBe("10");
    expect(ctx["session.time_remaining"]).toBe("61:01");
    expect(ctx["track.name"]).toBe("Spa-Francorchamps");
    expect(ctx["track.short_name"]).toBe("Spa");
  });

  it("should return empty fields with null telemetry", () => {
    const drivers = [makeDriver({ CarIdx: 0 })];
    const sessionInfo = makeSessionInfo(drivers, 0);
    const ctx = buildTemplateContextFromData(null, sessionInfo);

    expect(ctx["self.position"]).toBe("");
    expect(ctx["self.incidents"]).toBe("");
    expect(ctx["track_ahead.name"]).toBe("");
    expect(ctx["track_behind.name"]).toBe("");
  });

  it("should return empty fields with null session info", () => {
    const ctx = buildTemplateContextFromData(null, null);

    expect(ctx["self.name"]).toBe("");
    expect(ctx["track_ahead.name"]).toBe("");
    expect(ctx["session.type"]).toBe("");
    expect(ctx["track.name"]).toBe("");
  });

  it("should populate race_ahead and race_behind from race position", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "P1 Driver" }),
      makeDriver({ CarIdx: 2, UserName: "P3 Driver" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({ CarIdxPosition: [2, 1, 3] });
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx["race_ahead.name"]).toBe("P1 Driver");
    expect(ctx["race_behind.name"]).toBe("P3 Driver");
  });

  it("should use player-specific telemetry for self fields", () => {
    const drivers = [makeDriver({ CarIdx: 0, UserName: "Player" })];
    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({
      PlayerCarPosition: 5,
      PlayerCarClassPosition: 3,
      Lap: 12,
      LapCompleted: 11,
      PlayerCarMyIncidentCount: 7,
      CarIdxPosition: [99],
    });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx["self.position"]).toBe("5");
    expect(ctx["self.class_position"]).toBe("3");
    expect(ctx["self.lap"]).toBe("12");
    expect(ctx["self.laps_completed"]).toBe("11");
    expect(ctx["self.incidents"]).toBe("7");
  });

  it("should include telemetry with prefix and formatted values", () => {
    const telemetry = makeTelemetry({
      Speed: 156.789,
      OilTemp: 95,
      IsOnTrack: true,
      CarIdxLap: [5, 6],
      CarIdxPosition: [1, 2],
    } as Partial<TelemetryData>);

    const drivers = [makeDriver({ CarIdx: 0 })];
    const sessionInfo = makeSessionInfo(drivers, 0);
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx["telemetry.Speed"]).toBe("156.79");
    expect(ctx["telemetry.OilTemp"]).toBe("95");
    expect(ctx["telemetry.IsOnTrack"]).toBe("Yes");
    expect(ctx["telemetry.CarIdxLap"]).toBeUndefined();
    expect(ctx["telemetry.CarIdxPosition"]).toBeUndefined();
  });

  it("should include sessionInfo with prefix and nested dot-notation", () => {
    const drivers = [makeDriver({ CarIdx: 0 })];
    const sessionInfo = makeSessionInfo(drivers, 0);
    const ctx = buildTemplateContextFromData(null, sessionInfo);

    expect(ctx["sessionInfo.WeekendInfo.TrackDisplayName"]).toBe("Spa-Francorchamps");
    expect(ctx["sessionInfo.WeekendInfo.TrackDisplayShortName"]).toBe("Spa");
  });

  it("should return empty telemetry and sessionInfo with null data", () => {
    const ctx = buildTemplateContextFromData(null, null);

    expect(ctx["telemetry.Speed"]).toBeUndefined();
    expect(ctx["sessionInfo.WeekendInfo.TrackDisplayName"]).toBeUndefined();
  });
});

describe("flattenForDisplay", () => {
  it("should flatten a flat object", () => {
    const result = flattenForDisplay({ Speed: 100, Gear: 4 });

    expect(result.Speed).toBe("100");
    expect(result.Gear).toBe("4");
  });

  it("should flatten nested objects with dot notation", () => {
    const result = flattenForDisplay({
      WeekendInfo: { TrackDisplayName: "Spa", TrackLength: "7.004 km" },
    });

    expect(result["WeekendInfo.TrackDisplayName"]).toBe("Spa");
    expect(result["WeekendInfo.TrackLength"]).toBe("7.004 km");
  });

  it("should round floating point numbers to 2 decimals", () => {
    const result = flattenForDisplay({ Speed: 156.789, Throttle: 0.5 });

    expect(result.Speed).toBe("156.79");
    expect(result.Throttle).toBe("0.50");
  });

  it("should keep integers as integers", () => {
    const result = flattenForDisplay({ Gear: 4, Lap: 12 });

    expect(result.Gear).toBe("4");
    expect(result.Lap).toBe("12");
  });

  it("should convert booleans to Yes/No", () => {
    const result = flattenForDisplay({ IsOnTrack: true, IsReplayPlaying: false });

    expect(result.IsOnTrack).toBe("Yes");
    expect(result.IsReplayPlaying).toBe("No");
  });

  it("should skip arrays", () => {
    const result = flattenForDisplay({ CarIdxLap: [1, 2, 3], Speed: 100 });

    expect(result.CarIdxLap).toBeUndefined();
    expect(result.Speed).toBe("100");
  });

  it("should skip arrays at nested levels", () => {
    const result = flattenForDisplay({
      DriverInfo: { Drivers: [{ Name: "test" }], DriverCarIdx: 0 },
    });

    expect(result["DriverInfo.Drivers"]).toBeUndefined();
    expect(result["DriverInfo.DriverCarIdx"]).toBe("0");
  });

  it("should filter keys by excludePrefix", () => {
    const result = flattenForDisplay(
      { Speed: 100, CarIdxLap: [1], CarIdxPosition: [1], Gear: 3 },
      { excludePrefix: "CarIdx" },
    );

    expect(result.Speed).toBe("100");
    expect(result.Gear).toBe("3");
    expect(result.CarIdxLap).toBeUndefined();
    expect(result.CarIdxPosition).toBeUndefined();
  });

  it("should handle deeply nested objects", () => {
    const result = flattenForDisplay({
      CarSetup: { Tires: { LeftFront: { TreadRemaining: 85.5 } } },
    });

    expect(result["CarSetup.Tires.LeftFront.TreadRemaining"]).toBe("85.50");
  });

  it("should convert known boolean-semantic integer fields to Yes/No", () => {
    const result = flattenForDisplay({ IsOnTrack: 1, IsReplayPlaying: 0, Speed: 100 });

    expect(result.IsOnTrack).toBe("Yes");
    expect(result.IsReplayPlaying).toBe("No");
    expect(result.Speed).toBe("100");
  });

  it("should not convert unknown integer fields to Yes/No", () => {
    const result = flattenForDisplay({ Gear: 1, Lap: 0 });

    expect(result.Gear).toBe("1");
    expect(result.Lap).toBe("0");
  });

  it("should skip null and undefined values", () => {
    const result = flattenForDisplay({ a: null, b: undefined, c: "valid" } as Record<string, unknown>);

    expect(result.a).toBeUndefined();
    expect(result.b).toBeUndefined();
    expect(result.c).toBe("valid");
  });
});
