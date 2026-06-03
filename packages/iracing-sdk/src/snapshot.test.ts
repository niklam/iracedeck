import { describe, expect, it } from "vitest";

import {
  buildDriverDetailsTable,
  buildDriverList,
  buildMarkdownTable,
  buildPlayerTelemetry,
  buildSnapshotEnvelope,
  generateMarkdown,
  getSessionIdentification,
  snapshotBaseName,
  snapshotTimestamp,
  trkLocToString,
} from "./snapshot.js";
import { TrkLoc } from "./types.js";

const sampleTelemetry: Record<string, unknown> = {
  PlayerCarIdx: 1,
  PlayerCarPosition: 2,
  PlayerCarClassPosition: 1,
  PlayerTrackSurface: TrkLoc.OnTrack,
  OnPitRoad: false,
  Lap: 5,
  Speed: 50, // m/s
  RPM: 6500.4,
  Gear: 4,
  FuelLevel: 32.567,
  CarIdxPosition: [0, 2, 1],
  CarIdxLapDistPct: [0, 0.25, 0.75],
  CarIdxLap: [0, 5, 5],
  CarIdxTrackSurface: [TrkLoc.NotInWorld, TrkLoc.OnTrack, TrkLoc.OnTrack],
};

const sampleSessionInfo: Record<string, unknown> = {
  WeekendInfo: {
    TrackDisplayName: "Silverstone Circuit",
    TrackConfigName: "Grand Prix",
    TrackLength: "5.81 km",
    EventType: "Race",
  },
  SessionInfo: {
    Sessions: [{ SessionType: "Race", SessionLaps: "20", SessionTime: "unlimited" }],
  },
  DriverInfo: {
    DriverCarIdx: 1,
    Drivers: [
      { CarIdx: 1, CarNumber: "42", UserName: "Test Driver", CarScreenName: "Mazda MX-5", IRating: 2500 },
      { CarIdx: 2, CarNumber: "7", UserName: "Other Driver", CarScreenName: "Mazda MX-5", IRating: 1900 },
    ],
  },
};

describe("trkLocToString", () => {
  it("should map known track locations", () => {
    expect(trkLocToString(TrkLoc.OnTrack)).toBe("On Track");
    expect(trkLocToString(TrkLoc.OffTrack)).toBe("Off Track");
    expect(trkLocToString(TrkLoc.InPitStall)).toBe("In Pit Stall");
    expect(trkLocToString(TrkLoc.AproachingPits)).toBe("Pit Lane");
    expect(trkLocToString(TrkLoc.NotInWorld)).toBe("Not in World");
  });

  it("should report unknown values", () => {
    expect(trkLocToString(99)).toBe("Unknown (99)");
  });
});

describe("buildDriverList", () => {
  it("should return empty list when car index arrays are missing", () => {
    expect(buildDriverList({}, sampleSessionInfo)).toEqual([]);
  });

  it("should skip cars that are not in the world with no position", () => {
    const drivers = buildDriverList(sampleTelemetry, sampleSessionInfo);

    expect(drivers.map((d) => d.carIdx)).toEqual([1, 2]);
  });

  it("should map driver names and numbers from session info", () => {
    const drivers = buildDriverList(sampleTelemetry, sampleSessionInfo);

    expect(drivers[0]).toMatchObject({ carIdx: 1, carNumber: "42", driverName: "Test Driver", position: 2 });
  });

  it("should compute laps completed as lap - 1 with a floor of 0", () => {
    const drivers = buildDriverList(sampleTelemetry, sampleSessionInfo);

    expect(drivers[0].lapsCompleted).toBe(4);

    const lapZero = buildDriverList({ ...sampleTelemetry, CarIdxLap: [0, 0, 0] }, sampleSessionInfo);

    expect(lapZero[0].lapsCompleted).toBe(0);
  });
});

describe("buildMarkdownTable", () => {
  it("should build an aligned markdown table", () => {
    const table = buildMarkdownTable(["Name", "Value"], [["Speed", "100"]], [false, true]);
    const lines = table.split("\n");

    expect(lines[0]).toBe("| Name  | Value |");
    expect(lines[1]).toBe("| ----- | ----: |");
    expect(lines[2]).toBe("| Speed |   100 |");
  });
});

describe("getSessionIdentification", () => {
  it("should return null when session info is null", () => {
    expect(getSessionIdentification(null)).toBeNull();
  });

  it("should return null when no identifying fields exist", () => {
    expect(getSessionIdentification({})).toBeNull();
  });

  it("should include track and session details", () => {
    const table = getSessionIdentification(sampleSessionInfo);

    expect(table).toContain("Silverstone Circuit — Grand Prix");
    expect(table).toContain("Session Type");
    expect(table).toContain("Race");
  });
});

describe("buildDriverDetailsTable", () => {
  it("should return null when session info is null", () => {
    expect(buildDriverDetailsTable(null)).toBeNull();
  });

  it("should return null when there are no drivers", () => {
    expect(buildDriverDetailsTable({ DriverInfo: { Drivers: [] } })).toBeNull();
  });

  it("should list drivers and skip the pace car", () => {
    const withPaceCar = {
      DriverInfo: {
        Drivers: [
          { CarIdx: 0, CarNumber: "0", UserName: "Pace Car", CarIsPaceCar: 1 },
          { CarIdx: 1, CarNumber: "42", UserName: "Test Driver" },
        ],
      },
    };
    const table = buildDriverDetailsTable(withPaceCar);

    expect(table).toContain("Test Driver");
    expect(table).not.toContain("Pace Car");
  });
});

describe("buildPlayerTelemetry", () => {
  it("should return null when player car index is missing", () => {
    expect(buildPlayerTelemetry({}, sampleSessionInfo)).toBeNull();
  });

  it("should include player identity and vehicle state", () => {
    const table = buildPlayerTelemetry(sampleTelemetry, sampleSessionInfo);

    expect(table).toContain("Test Driver");
    expect(table).toContain("Mazda MX-5 (#42)");
    expect(table).toContain("180.0 km/h"); // 50 m/s * 3.6
    expect(table).toContain("32.6 L");
  });
});

describe("generateMarkdown", () => {
  it("should include all report sections for full data", () => {
    const markdown = generateMarkdown(sampleTelemetry, sampleSessionInfo);

    expect(markdown).toContain("# Telemetry Snapshot");
    expect(markdown).toContain("## Session Info");
    expect(markdown).toContain("## Race Position Order");
    expect(markdown).toContain("## Track Position Order (Car Ahead / Behind)");
    expect(markdown).toContain("## Driver Details");
    expect(markdown).toContain("## Player Telemetry");
  });

  it("should note missing position data when telemetry has no car arrays", () => {
    const markdown = generateMarkdown({}, null);

    expect(markdown).toContain("No position data available.");
  });

  it("should stamp the report with the provided time", () => {
    const now = new Date("2026-06-02T15:04:05.000Z");
    const markdown = generateMarkdown(sampleTelemetry, sampleSessionInfo, now);

    expect(markdown).toContain("*2026-06-02T15:04:05.000Z*");
  });
});

describe("snapshotTimestamp", () => {
  it("should format the timestamp as YYYYMMDD-HHMMSS in local time", () => {
    const now = new Date(2026, 5, 2, 15, 4, 5);

    expect(snapshotTimestamp(now)).toBe("20260602-150405");
  });

  it("should zero-pad single digit components", () => {
    const now = new Date(2026, 0, 1, 1, 2, 3);

    expect(snapshotTimestamp(now)).toBe("20260101-010203");
  });
});

describe("snapshotBaseName", () => {
  it("should prefix the timestamp with telemetry-snapshot-", () => {
    const now = new Date(2026, 5, 2, 15, 4, 5);

    expect(snapshotBaseName(now)).toBe("telemetry-snapshot-20260602-150405");
  });
});

describe("buildSnapshotEnvelope", () => {
  const now = new Date("2026-06-02T15:04:05.000Z");

  it("should include telemetry and an ISO timestamp", () => {
    const envelope = buildSnapshotEnvelope(sampleTelemetry, sampleSessionInfo, false, now);

    expect(envelope.timestamp).toBe("2026-06-02T15:04:05.000Z");
    expect(envelope.telemetry).toBe(sampleTelemetry);
    expect(envelope.sessionInfo).toBeUndefined();
  });

  it("should include session info when requested", () => {
    const envelope = buildSnapshotEnvelope(sampleTelemetry, sampleSessionInfo, true, now);

    expect(envelope.sessionInfo).toBe(sampleSessionInfo);
  });

  it("should omit session info when requested but unavailable", () => {
    const envelope = buildSnapshotEnvelope(sampleTelemetry, null, true, now);

    expect(envelope.sessionInfo).toBeUndefined();
  });
});
