import { describe, expect, it } from "vitest";

import {
  buildTemplateContextFromData,
  findDriverByCamCarIdx,
  findDriverByRacePosition,
  findNearestDriverOnTrack,
  flattenContext,
  formatTimeRemaining,
  prefixKeys,
  resolveRacePositions,
  splitDriverName,
} from "./template-context.js";
import { resolveTemplate } from "./template-resolver.js";
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
    });

    const result = findNearestDriverOnTrack(0, drivers, telemetry, "ahead");

    expect(result?.UserName).toBe("Ahead Car");
  });

  it("should find the car physically behind", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [4, 5, 3],
      CarIdxLapDistPct: [0.5, 0.7, 0.3],
    });

    const result = findNearestDriverOnTrack(0, drivers, telemetry, "behind");

    expect(result?.UserName).toBe("Behind Car");
  });

  it("should wrap around when leading on track", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [10, 5, 3],
      CarIdxLapDistPct: [0.9, 0.7, 0.3],
    });

    // Circular: player at 0.9, ahead wraps to Behind Car at 0.3 (gap=0.4)
    const result = findNearestDriverOnTrack(0, drivers, telemetry, "ahead");

    expect(result?.UserName).toBe("Behind Car");
  });

  it("should wrap around when last on track", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [1, 5, 3],
      CarIdxLapDistPct: [0.1, 0.7, 0.3],
    });

    // Circular: player at 0.1, behind wraps to Ahead Car at 0.7 (gap=0.4)
    const result = findNearestDriverOnTrack(0, drivers, telemetry, "behind");

    expect(result?.UserName).toBe("Ahead Car");
  });

  it("should include cars flagged as on pit road", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [4, 5, 3],
      CarIdxLapDistPct: [0.5, 0.7, 0.3],
      CarIdxOnPitRoad: [false, true, false],
    });

    // CarIdxOnPitRoad is unreliable; Ahead Car at 0.7 is still closest ahead
    const result = findNearestDriverOnTrack(0, drivers, telemetry, "ahead");

    expect(result?.UserName).toBe("Ahead Car");
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
    });

    // Pace car skipped; ahead wraps to Behind Car at 0.3 (gap=0.8)
    const result = findNearestDriverOnTrack(0, driversWithPace, telemetry, "ahead");

    expect(result?.UserName).toBe("Behind Car");
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
    });

    // Spectator skipped; ahead wraps to Behind Car at 0.3 (gap=0.8)
    const result = findNearestDriverOnTrack(0, driversWithSpectator, telemetry, "ahead");

    expect(result?.UserName).toBe("Behind Car");
  });

  it("should return null with no telemetry", () => {
    expect(findNearestDriverOnTrack(0, drivers, null, "ahead")).toBeNull();
  });

  it("should find lapped car directly ahead by physical proximity", () => {
    const driversMany = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Leader" }),
      makeDriver({ CarIdx: 2, UserName: "Lapped Car" }),
    ];

    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [10, 12, 8],
      CarIdxLapDistPct: [0.5, 0.9, 0.51],
    });

    // Lapped Car at 0.51 is physically closest ahead (gap=0.01) vs Leader at 0.9 (gap=0.4)
    const result = findNearestDriverOnTrack(0, driversMany, telemetry, "ahead");

    expect(result?.UserName).toBe("Lapped Car");
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

  it("should use provided positions array instead of CarIdxPosition", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Actually First" }),
      makeDriver({ CarIdx: 2, UserName: "Actually Third" }),
    ];

    const telemetry = makeTelemetry({ CarIdxPosition: [2, 1, 3] });
    const calculatedPositions = [2, 3, 1]; // Car 2 is P1, Car 0 is P2, Car 1 is P3

    const result = findDriverByRacePosition(0, drivers, telemetry, -1, calculatedPositions);

    expect(result?.UserName).toBe("Actually Third"); // Car 2 at P1, ahead of player at P2
  });
});

describe("findDriverByCamCarIdx", () => {
  const drivers = [
    makeDriver({ CarIdx: 0, UserName: "Player" }),
    makeDriver({ CarIdx: 1, UserName: "Other Driver" }),
    makeDriver({ CarIdx: 2, UserName: "Third Driver" }),
  ];

  it("should find the camera-focused driver", () => {
    const telemetry = makeTelemetry({ CamCarIdx: 1 });

    expect(findDriverByCamCarIdx(drivers, telemetry)?.UserName).toBe("Other Driver");
  });

  it("should resolve to the player when the camera is on the player's own car", () => {
    const telemetry = makeTelemetry({ CamCarIdx: 0 });

    expect(findDriverByCamCarIdx(drivers, telemetry)?.UserName).toBe("Player");
  });

  it("should return null when CamCarIdx is undefined", () => {
    const telemetry = makeTelemetry({ CamCarIdx: undefined });

    expect(findDriverByCamCarIdx(drivers, telemetry)).toBeNull();
  });

  it("should return null for a negative sentinel (scenic/track cam)", () => {
    const telemetry = makeTelemetry({ CamCarIdx: -1 });

    expect(findDriverByCamCarIdx(drivers, telemetry)).toBeNull();
  });

  it("should return null when CamCarIdx matches no driver", () => {
    const telemetry = makeTelemetry({ CamCarIdx: 99 });

    expect(findDriverByCamCarIdx(drivers, telemetry)).toBeNull();
  });

  it("should return null with no telemetry", () => {
    expect(findDriverByCamCarIdx(drivers, null)).toBeNull();
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

    expect(ctx.display["self.name"]).toBe("John Smith");
    expect(ctx.display["self.first_name"]).toBe("John");
    expect(ctx.display["self.last_name"]).toBe("Smith");
    expect(ctx.display["self.position"]).toBe("2");
    expect(ctx.display["self.incidents"]).toBe("3");
    expect(ctx.display["session.type"]).toBe("Race");
    expect(ctx.display["session.laps_remaining"]).toBe("10");
    expect(ctx.display["session.time_remaining"]).toBe("61:01");
    expect(ctx.display["track.name"]).toBe("Spa-Francorchamps");
    expect(ctx.display["track.short_name"]).toBe("Spa");
  });

  it("should return empty fields with null telemetry", () => {
    const drivers = [makeDriver({ CarIdx: 0 })];
    const sessionInfo = makeSessionInfo(drivers, 0);
    const ctx = buildTemplateContextFromData(null, sessionInfo);

    expect(ctx.display["self.position"]).toBe("");
    expect(ctx.display["self.incidents"]).toBe("");
    expect(ctx.display["track_ahead.name"]).toBe("");
    expect(ctx.display["track_behind.name"]).toBe("");
  });

  it("should return empty fields with null session info", () => {
    const ctx = buildTemplateContextFromData(null, null);

    expect(ctx.display["self.name"]).toBe("");
    expect(ctx.display["track_ahead.name"]).toBe("");
    expect(ctx.display["session.type"]).toBe("");
    expect(ctx.display["track.name"]).toBe("");
  });

  it("should omit track_ahead fields from raw when there is no track-ahead driver", () => {
    const drivers = [makeDriver({ CarIdx: 0, UserName: "Player" })];
    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({
      CarIdxPosition: [1],
      CarIdxClassPosition: [1],
      CarIdxLap: [5],
      CarIdxLapCompleted: [4],
      CarIdxLapDistPct: [0.5],
      CarIdxOnPitRoad: [false],
    });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect("track_ahead.position" in ctx.raw).toBe(false);
    expect(ctx.display["track_ahead.position"]).toBe("");
  });

  it("should omit session.laps_remaining from raw when SessionLapsRemainEx is negative", () => {
    const drivers = [makeDriver({ CarIdx: 0 })];
    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({ SessionLapsRemainEx: -1 });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect("session.laps_remaining" in ctx.raw).toBe(false);
    expect(ctx.display["session.laps_remaining"]).toBe("");
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

    expect(ctx.display["race_ahead.name"]).toBe("P1 Driver");
    expect(ctx.display["race_behind.name"]).toBe("P3 Driver");
  });

  it("should populate focused fields from the camera-focused car (CamCarIdx)", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Focused Driver", AbbrevName: "F. Driver", CarNumber: "42", IRating: 4200 }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({ CamCarIdx: 1, CarIdxPosition: [2, 1] });
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.display["focused.name"]).toBe("Focused Driver");
    expect(ctx.display["focused.abbrev_name"]).toBe("F. Driver");
    expect(ctx.display["focused.car_number"]).toBe("42");
    expect(ctx.display["focused.position"]).toBe("1");
    expect(ctx.display["focused.irating"]).toBe("4200");
  });

  it("should resolve focused fields to the player's data when the camera is on the player's car", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player", CarNumber: "7" }),
      makeDriver({ CarIdx: 1, UserName: "Other Driver" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({ CamCarIdx: 0, CarIdxPosition: [2, 1] });
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.display["focused.name"]).toBe("Player");
    expect(ctx.display["focused.car_number"]).toBe("7");
    // incidents is self-only even when focused resolves to the player's own car
    expect(ctx.display["focused.incidents"]).toBeUndefined();
    expect("focused.incidents" in ctx.raw).toBe(false);
  });

  it("should make every focused field match self when the camera is on the player's car", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player", CarNumber: "7" }),
      makeDriver({ CarIdx: 1, UserName: "Other" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    // The player-authoritative fields deliberately disagree with the per-car
    // arrays at the player's index. Without the player-aware path, focused would
    // read the array values (e.g. lap 99) while self reads Lap (9) — so this
    // proves both prefixes resolve the player's car through the same code.
    const telemetry = makeTelemetry({
      CamCarIdx: 0,
      PlayerCarPosition: 2,
      PlayerCarClassPosition: 2,
      Lap: 9,
      LapCompleted: 8,
      CarIdxPosition: [7, 1],
      CarIdxClassPosition: [7, 1],
      CarIdxLap: [99, 6],
      CarIdxLapCompleted: [99, 5],
      CarIdxOnPitRoad: [false, false],
    });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    for (const field of ["position", "class_position", "lap", "laps_completed", "name", "car_number", "irating"]) {
      expect(ctx.display[`focused.${field}`]).toBe(ctx.display[`self.${field}`]);
    }

    // Sanity: the player-authoritative lap won, not the stale per-car array value.
    expect(ctx.display["focused.lap"]).toBe("9");
    expect(ctx.display["focused.laps_completed"]).toBe("8");
  });

  it("should leave focused fields empty when no car is focused (negative sentinel)", () => {
    const drivers = [makeDriver({ CarIdx: 0, UserName: "Player" })];
    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({ CamCarIdx: -1 });
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.display["focused.name"]).toBe("");
    expect(ctx.display["focused.position"]).toBe("");
    expect("focused.position" in ctx.raw).toBe(false);
  });

  it("should leave focused fields empty when CamCarIdx is absent from live telemetry", () => {
    const drivers = [makeDriver({ CarIdx: 0, UserName: "Player" })];
    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry(); // CamCarIdx not set
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.display["focused.name"]).toBe("");
    expect(ctx.display["focused.position"]).toBe("");
    // Numeric fields are omitted from raw when unavailable (string fields stay "" — same as the other no-driver prefixes)
    expect("focused.position" in ctx.raw).toBe(false);
  });

  it("should show the pace car's identity but blank position/class when focused on it", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Pace Car", CarNumber: "0", CarIsPaceCar: 1 }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    // The pace car is physically ahead, so the live lap-order would rank it P1 —
    // a bogus race position. It must render blank, not "1" or "0".
    const telemetry = makeTelemetry({ CamCarIdx: 1, CarIdxPosition: [1, 0], CarIdxClassPosition: [1, 0] });
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    // Camera focus is a deliberate user selection, so the pace car is NOT filtered
    // out — its identity still shows — but it has no meaningful race position.
    expect(ctx.display["focused.name"]).toBe("Pace Car");
    expect(ctx.display["focused.car_number"]).toBe("0");
    expect(ctx.display["focused.position"]).toBe("");
    expect(ctx.display["focused.class_position"]).toBe("");
    expect("focused.position" in ctx.raw).toBe(false);
    expect("focused.class_position" in ctx.raw).toBe(false);
  });

  it("should blank an unclassified (position 0) car's position rather than show 0", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Garaged" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    // Car 1 is a real competitor but not classified (in the garage): position 0.
    const telemetry = makeTelemetry({
      CamCarIdx: 1,
      CarIdxPosition: [1, 0],
      CarIdxClassPosition: [1, 0],
      CarIdxLapCompleted: [4, -1],
      CarIdxLapDistPct: [0.5, -1],
    });
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.display["focused.name"]).toBe("Garaged");
    expect(ctx.display["focused.position"]).toBe("");
    expect(ctx.display["focused.class_position"]).toBe("");
  });

  it("should resolve a focused template end to end with a real built context", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Focused Driver", CarNumber: "42" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({ CamCarIdx: 1, CarIdxPosition: [2, 1] });
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(resolveTemplate("#{{focused.car_number}} {{focused.name}}", ctx)).toBe("#42 Focused Driver");
  });

  it("should use the injected live race order for overall position over the calculated/official order", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Other" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    // Lap data would calculate car1 ahead; official CarIdxPosition is stale. The
    // injected live order ([car0 P1, car1 P2]) must win for both self and focused.
    const telemetry = makeTelemetry({
      CamCarIdx: 1,
      CarIdxPosition: [5, 6],
      CarIdxLapCompleted: [4, 5],
      CarIdxLapDistPct: [0.5, 0.7],
      CarIdxOnPitRoad: [false, false],
    });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo, [1, 2]);

    expect(ctx.display["self.position"]).toBe("1");
    expect(ctx.display["focused.position"]).toBe("2");
  });

  it("should derive class position from the live order, not the frozen CarIdxClassPosition", () => {
    // Classes: car0 & car2 = class 10; car1 & car3 = class 20.
    // Live order: car1 P1, car0 P2, car3 P3, car2 P4 → in class 10, car0 is ahead of car2.
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "P0" }),
      makeDriver({ CarIdx: 1, UserName: "P1" }),
      makeDriver({ CarIdx: 2, UserName: "P2" }),
      makeDriver({ CarIdx: 3, UserName: "P3" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({
      CamCarIdx: 2,
      CarIdxClass: [10, 20, 10, 20],
      CarIdxClassPosition: [9, 9, 9, 9], // deliberately stale to prove the derived value wins
      CarIdxOnPitRoad: [false, false, false, false],
    });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo, [2, 1, 4, 3]);

    expect(ctx.display["self.class_position"]).toBe("1"); // car0, class 10, leads its class
    expect(ctx.display["focused.class_position"]).toBe("2"); // car2, class 10, behind car0
  });

  it("should use the official class position for a car on pit road", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Pit Car" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({
      CamCarIdx: 1,
      CarIdxClass: [10, 10],
      CarIdxClassPosition: [1, 7], // car1 officially class P7
      CarIdxOnPitRoad: [false, true],
    });

    // Live order would derive car1 as class P2, but it's on pit road → official P7.
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo, [1, 2]);

    expect(ctx.display["focused.class_position"]).toBe("7");
  });

  it("should fall back to the official class position when CarIdxClass is unavailable", () => {
    const drivers = [makeDriver({ CarIdx: 0 }), makeDriver({ CarIdx: 1, UserName: "Focused" })];
    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({ CamCarIdx: 1, CarIdxClassPosition: [2, 5] }); // no CarIdxClass

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.display["focused.class_position"]).toBe("5");
  });

  it("should not expose a focused.incidents field (self-only)", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Focused Driver" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({ CamCarIdx: 1 });
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.display["focused.incidents"]).toBeUndefined();
    expect("focused.incidents" in ctx.raw).toBe(false);
  });

  it("should use player-specific telemetry for self fields in non-race sessions", () => {
    const drivers = [makeDriver({ CarIdx: 0, UserName: "Player" })];
    const sessionInfo = {
      DriverInfo: { DriverCarIdx: 0, Drivers: drivers },
      WeekendInfo: { TrackDisplayName: "Spa", TrackDisplayShortName: "Spa" },
      SessionInfo: { Sessions: [{ SessionType: "Practice", SessionName: "PRACTICE" }] },
    } as unknown as SessionInfo;
    const telemetry = makeTelemetry({
      PlayerCarPosition: 5,
      PlayerCarClassPosition: 3,
      Lap: 12,
      LapCompleted: 11,
      PlayerCarMyIncidentCount: 7,
      CarIdxPosition: [99],
    });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.display["self.position"]).toBe("5");
    expect(ctx.display["self.class_position"]).toBe("3");
    expect(ctx.display["self.lap"]).toBe("12");
    expect(ctx.display["self.laps_completed"]).toBe("11");
    expect(ctx.display["self.incidents"]).toBe("7");
  });

  it("should use calculated positions for race sessions", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Leader" }),
      makeDriver({ CarIdx: 2, UserName: "Behind" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({
      PlayerCarPosition: 2,
      CarIdxPosition: [2, 1, 3],
      CarIdxLapCompleted: [10, 5, 3],
      CarIdxLapDistPct: [0.9, 0.1, 0.3],
      // Calculated: Car 0 = 10.9 → P1, Car 1 = 5.1 → P2, Car 2 = 3.3 → P3
    });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    // self.position should reflect calculated P1, not PlayerCarPosition (2)
    expect(ctx.display["self.position"]).toBe("1");
    expect(ctx.display["race_behind.name"]).toBe("Leader"); // Car 1 at P2 is behind player at P1
  });

  it("should use native CarIdxPosition for non-race sessions", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Other" }),
    ];

    const sessionInfo = {
      DriverInfo: { DriverCarIdx: 0, Drivers: drivers },
      WeekendInfo: { TrackDisplayName: "Spa", TrackDisplayShortName: "Spa" },
      SessionInfo: { Sessions: [{ SessionType: "Practice", SessionName: "PRACTICE" }] },
    } as unknown as SessionInfo;

    const telemetry = makeTelemetry({
      PlayerCarPosition: 2,
      CarIdxPosition: [2, 1],
      CarIdxLapCompleted: [10, 5],
      CarIdxLapDistPct: [0.9, 0.1],
    });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    // Non-race: should use PlayerCarPosition (2), not calculated (1)
    expect(ctx.display["self.position"]).toBe("2");
  });

  it("should use official position for player on pit road in race session", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Leader" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({
      PlayerCarPosition: 2,
      OnPitRoad: true,
      CarIdxPosition: [2, 1],
      CarIdxLapCompleted: [10, 5],
      CarIdxLapDistPct: [0.9, 0.1],
      CarIdxOnPitRoad: [true, false],
    });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    // Player on pit road: self.position should use PlayerCarPosition=2, not calculated P1
    expect(ctx.display["self.position"]).toBe("2");
  });

  it("should use official position for other car on pit road in race session", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Pit Car" }),
      makeDriver({ CarIdx: 2, UserName: "Third" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({
      PlayerCarPosition: 1,
      CarIdxPosition: [1, 2, 3],
      CarIdxClassPosition: [1, 2, 3],
      CarIdxLap: [5, 10, 3],
      CarIdxLapCompleted: [5, 10, 3],
      CarIdxLapDistPct: [0.5, 0.9, 0.3],
      CarIdxOnPitRoad: [false, true, false],
    });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    // Car 1 on pit road: calculated would be P1 (10.9), but official is P2
    // Player (car 0) calculated is P2 (5.5), race_ahead should be car 1 at resolved P2? No...
    // Resolved: car 0=P2 (calculated), car 1=P2 (official, on pit road), car 2=P3 (calculated)
    // Player position is P2, so race_ahead is position 1 → no driver has position 1 in resolved
    // Let's check: player is at resolved[0]=P2, race_behind is position 3 = car 2
    expect(ctx.display["race_behind.name"]).toBe("Third");
    expect(ctx.display["race_behind.position"]).toBe("3");
  });

  it("should fall back to official position when calculated is unavailable in race session", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Other" }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({
      PlayerCarPosition: 2,
      OnPitRoad: false,
      CarIdxPosition: [2, 1],
      CarIdxLapCompleted: [-1, 5],
      CarIdxLapDistPct: [-1, 0.7],
      CarIdxOnPitRoad: [false, false],
    });

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    // Car 0 is inactive (calculated=0), falls back to official CarIdxPosition=2
    // PlayerCarPosition is also used for self.position fallback
    expect(ctx.display["self.position"]).toBe("2");
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

    expect(ctx.display["telemetry.Speed"]).toBe("156.79");
    expect(ctx.display["telemetry.OilTemp"]).toBe("95");
    expect(ctx.display["telemetry.IsOnTrack"]).toBe("Yes");
    expect(ctx.display["telemetry.CarIdxLap"]).toBeUndefined();
    expect(ctx.display["telemetry.CarIdxPosition"]).toBeUndefined();
  });

  it("should include sessionInfo with prefix and nested dot-notation", () => {
    const drivers = [makeDriver({ CarIdx: 0 })];
    const sessionInfo = makeSessionInfo(drivers, 0);
    const ctx = buildTemplateContextFromData(null, sessionInfo);

    expect(ctx.display["sessionInfo.WeekendInfo.TrackDisplayName"]).toBe("Spa-Francorchamps");
    expect(ctx.display["sessionInfo.WeekendInfo.TrackDisplayShortName"]).toBe("Spa");
  });

  it("should return empty telemetry and sessionInfo with null data", () => {
    const ctx = buildTemplateContextFromData(null, null);

    expect(ctx.display["telemetry.Speed"]).toBeUndefined();
    expect(ctx.display["sessionInfo.WeekendInfo.TrackDisplayName"]).toBeUndefined();
  });
});

describe("buildTemplateContextFromData raw map", () => {
  it("should keep full-precision numbers in raw while display is formatted", () => {
    const telemetry = makeTelemetry({ Speed: 156.789 } as Partial<TelemetryData>);
    const sessionInfo = makeSessionInfo([makeDriver({ CarIdx: 0 })], 0);

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.raw["telemetry.Speed"]).toBe(156.789);
    expect(ctx.display["telemetry.Speed"]).toBe("156.79");
  });

  it("should keep booleans as booleans in raw while display is Yes/No", () => {
    const telemetry = makeTelemetry({ IsOnTrack: true } as Partial<TelemetryData>);
    const sessionInfo = makeSessionInfo([makeDriver({ CarIdx: 0 })], 0);

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.raw["telemetry.IsOnTrack"]).toBe(true);
    expect(ctx.display["telemetry.IsOnTrack"]).toBe("Yes");
  });

  it("should keep boolean-semantic integer fields as 0/1 numbers in raw while display is Yes/No", () => {
    const telemetry = makeTelemetry({ PushToPass: 1 } as unknown as Partial<TelemetryData>);
    const sessionInfo = makeSessionInfo([makeDriver({ CarIdx: 0 })], 0);

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.raw["telemetry.PushToPass"]).toBe(1);
    expect(ctx.display["telemetry.PushToPass"]).toBe("Yes");
  });

  it("should keep driver position as a number in raw while display is a string", () => {
    const sessionInfo = makeSessionInfo([makeDriver({ CarIdx: 0 })], 0);
    const telemetry = makeTelemetry();

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.raw["self.position"]).toBe(Number(ctx.display["self.position"]));
    expect(typeof ctx.raw["self.position"]).toBe("number");
    expect(typeof ctx.display["self.position"]).toBe("string");
  });

  it("should omit missing numeric driver fields from raw but keep empty string in display", () => {
    const sessionInfo = makeSessionInfo([makeDriver({ CarIdx: 0 })], 0);

    const ctx = buildTemplateContextFromData(null, sessionInfo);

    expect("self.position" in ctx.raw).toBe(false);
    expect(ctx.display["self.position"]).toBe("");
  });

  it("should produce essentially empty maps with null telemetry and session info", () => {
    const ctx = buildTemplateContextFromData(null, null);

    expect(ctx.raw["telemetry.Speed"]).toBeUndefined();
    expect("self.position" in ctx.raw).toBe(false);
    expect(ctx.raw["self.name"]).toBe("");
    expect(ctx.display["self.name"]).toBe("");
  });

  it("should keep sessionInfo numbers full-precision in raw", () => {
    const sessionInfo = {
      DriverInfo: {
        DriverCarIdx: 0,
        DriverCarFuelKgPerLtr: 0.75,
        Drivers: [makeDriver({ CarIdx: 0 })],
      },
      WeekendInfo: { TrackDisplayName: "Spa", TrackDisplayShortName: "Spa" },
      SessionInfo: { Sessions: [{ SessionType: "Race", SessionName: "RACE" }] },
    } as unknown as SessionInfo;

    const ctx = buildTemplateContextFromData(null, sessionInfo);

    expect(ctx.raw["sessionInfo.DriverInfo.DriverCarFuelKgPerLtr"]).toBe(0.75);
    expect(ctx.display["sessionInfo.DriverInfo.DriverCarFuelKgPerLtr"]).toBe("0.75");
  });

  it("should resolve the fuel-add expression end to end with a real built context", () => {
    const sessionInfo = {
      DriverInfo: {
        DriverCarIdx: 0,
        DriverCarFuelKgPerLtr: 0.75,
        Drivers: [makeDriver({ CarIdx: 0 })],
      },
      WeekendInfo: { TrackDisplayName: "Spa", TrackDisplayShortName: "Spa" },
      SessionInfo: { Sessions: [{ SessionType: "Race", SessionName: "RACE" }] },
    } as unknown as SessionInfo;
    const telemetry = makeTelemetry({ dpFuelAddKg: 20 } as Partial<TelemetryData>);

    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    const result = resolveTemplate(
      "{{= round(telemetry.dpFuelAddKg / (sessionInfo.DriverInfo.DriverCarFuelKgPerLtr * 3.78541), 1) }}",
      ctx,
    );

    expect(result).toBe("7.0");
  });

  it("should expose focused numeric fields in the raw map for expressions", () => {
    const drivers = [
      makeDriver({ CarIdx: 0, UserName: "Player" }),
      makeDriver({ CarIdx: 1, UserName: "Focused Driver", IRating: 4200 }),
    ];

    const sessionInfo = makeSessionInfo(drivers, 0);
    const telemetry = makeTelemetry({ CamCarIdx: 1, CarIdxPosition: [2, 1] });
    const ctx = buildTemplateContextFromData(telemetry, sessionInfo);

    expect(ctx.raw["focused.irating"]).toBe(4200);
    expect(resolveTemplate("{{= focused.irating + 100 }}", ctx)).toBe("4300");
  });
});

describe("resolveRacePositions", () => {
  it("should use calculated positions for cars not on pit road", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [10, 5, 3],
      CarIdxLapDistPct: [0.9, 0.1, 0.3],
      CarIdxPosition: [1, 2, 3],
      CarIdxOnPitRoad: [false, false, false],
    });

    const result = resolveRacePositions(telemetry);

    // Calculated: Car 0=10.9→P1, Car 1=5.1→P2, Car 2=3.3→P3
    expect(result).toEqual([1, 2, 3]);
  });

  it("should use official position for cars on pit road", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [10, 5, 3],
      CarIdxLapDistPct: [0.9, 0.1, 0.3],
      CarIdxPosition: [2, 1, 3],
      CarIdxOnPitRoad: [true, false, false],
    });

    const result = resolveRacePositions(telemetry);

    // Car 0 on pit road → uses official P2; Car 1 calculated P2; Car 2 calculated P3
    expect(result![0]).toBe(2);
    expect(result![1]).toBe(2);
    expect(result![2]).toBe(3);
  });

  it("should fall back to official for inactive cars (calculated=0)", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [-1, 5, 3],
      CarIdxLapDistPct: [-1, 0.7, 0.3],
      CarIdxPosition: [4, 1, 2],
      CarIdxOnPitRoad: [false, false, false],
    });

    const result = resolveRacePositions(telemetry);

    // Car 0 inactive (calculated=0) → falls back to official P4
    expect(result![0]).toBe(4);
    expect(result![1]).toBe(1);
    expect(result![2]).toBe(2);
  });

  it("should return undefined for null telemetry", () => {
    expect(resolveRacePositions(null)).toBeUndefined();
  });

  it("should return undefined when lap data is missing", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: undefined,
      CarIdxLapDistPct: undefined,
    });

    expect(resolveRacePositions(telemetry)).toBeUndefined();
  });
});

describe("flattenContext display map", () => {
  it("should flatten a flat object", () => {
    const result = flattenContext({ Speed: 100, Gear: 4 }).display;

    expect(result.Speed).toBe("100");
    expect(result.Gear).toBe("4");
  });

  it("should flatten nested objects with dot notation", () => {
    const result = flattenContext({
      WeekendInfo: { TrackDisplayName: "Spa", TrackLength: "7.004 km" },
    }).display;

    expect(result["WeekendInfo.TrackDisplayName"]).toBe("Spa");
    expect(result["WeekendInfo.TrackLength"]).toBe("7.004 km");
  });

  it("should round floating point numbers to 2 decimals", () => {
    const result = flattenContext({ Speed: 156.789, Throttle: 0.5 }).display;

    expect(result.Speed).toBe("156.79");
    expect(result.Throttle).toBe("0.50");
  });

  it("should keep integers as integers", () => {
    const result = flattenContext({ Gear: 4, Lap: 12 }).display;

    expect(result.Gear).toBe("4");
    expect(result.Lap).toBe("12");
  });

  it("should convert booleans to Yes/No", () => {
    const result = flattenContext({ IsOnTrack: true, IsReplayPlaying: false }).display;

    expect(result.IsOnTrack).toBe("Yes");
    expect(result.IsReplayPlaying).toBe("No");
  });

  it("should skip arrays", () => {
    const result = flattenContext({ CarIdxLap: [1, 2, 3], Speed: 100 }).display;

    expect(result.CarIdxLap).toBeUndefined();
    expect(result.Speed).toBe("100");
  });

  it("should skip arrays at nested levels", () => {
    const result = flattenContext({
      DriverInfo: { Drivers: [{ Name: "test" }], DriverCarIdx: 0 },
    }).display;

    expect(result["DriverInfo.Drivers"]).toBeUndefined();
    expect(result["DriverInfo.DriverCarIdx"]).toBe("0");
  });

  it("should filter keys by excludePrefix", () => {
    const result = flattenContext(
      { Speed: 100, CarIdxLap: [1], CarIdxPosition: [1], Gear: 3 },
      { excludePrefix: "CarIdx" },
    ).display;

    expect(result.Speed).toBe("100");
    expect(result.Gear).toBe("3");
    expect(result.CarIdxLap).toBeUndefined();
    expect(result.CarIdxPosition).toBeUndefined();
  });

  it("should handle deeply nested objects", () => {
    const result = flattenContext({
      CarSetup: { Tires: { LeftFront: { TreadRemaining: 85.5 } } },
    }).display;

    expect(result["CarSetup.Tires.LeftFront.TreadRemaining"]).toBe("85.50");
  });

  it("should convert known boolean-semantic integer fields to Yes/No", () => {
    const result = flattenContext({ IsOnTrack: 1, IsReplayPlaying: 0, Speed: 100 }).display;

    expect(result.IsOnTrack).toBe("Yes");
    expect(result.IsReplayPlaying).toBe("No");
    expect(result.Speed).toBe("100");
  });

  it("should not convert unknown integer fields to Yes/No", () => {
    const result = flattenContext({ Gear: 1, Lap: 0 }).display;

    expect(result.Gear).toBe("1");
    expect(result.Lap).toBe("0");
  });

  it("should skip null and undefined values", () => {
    const result = flattenContext({ a: null, b: undefined, c: "valid" } as Record<string, unknown>).display;

    expect(result.a).toBeUndefined();
    expect(result.b).toBeUndefined();
    expect(result.c).toBe("valid");
  });
});
