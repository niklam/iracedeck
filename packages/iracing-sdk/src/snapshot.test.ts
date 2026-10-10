import { describe, expect, it } from "vitest";

import {
  buildDriverDetailsTable,
  buildDriverList,
  buildMarkdownTable,
  buildPlayerTelemetry,
  buildSnapshotEnvelope,
  formatSnapshotJson,
  formatTime,
  generateMarkdown,
  getSessionIdentification,
  SNAPSHOT_INLINE_OBJECT_MAX_KEYS,
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

describe("formatTime", () => {
  it("should format sub-minute times in seconds", () => {
    expect(formatTime(23.181)).toBe("23.181s");
    expect(formatTime(5.2)).toBe("5.200s");
  });

  it("should pad seconds to two digits past the minute", () => {
    expect(formatTime(68.985)).toBe("1:08.985");
    expect(formatTime(120)).toBe("2:00.000");
  });

  it("should not pad ten or more seconds past the minute", () => {
    expect(formatTime(72.345)).toBe("1:12.345");
    expect(formatTime(659.5)).toBe("10:59.500");
  });

  it("should carry a value that rounds up to the next minute", () => {
    expect(formatTime(119.9996)).toBe("2:00.000");
    expect(formatTime(59.9996)).toBe("1:00.000");
  });

  it("should switch to hours from an hour up", () => {
    expect(formatTime(3700)).toBe("1:01:40.000");
    expect(formatTime(3599.9996)).toBe("1:00:00.000");
    expect(formatTime(7265.5)).toBe("2:01:05.500");
  });

  it("should print a dash for a negative (unset) time", () => {
    expect(formatTime(-1)).toBe("-");
  });

  it("should print a dash for a non-finite time", () => {
    expect(formatTime(Number.NaN)).toBe("-");
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe("-");
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

  it("should print lap times of a minute or more as m:ss.sss (#1287)", () => {
    const table = buildPlayerTelemetry(
      { ...sampleTelemetry, LapLastLapTime: 68.985, LapBestLapTime: 72.345 },
      sampleSessionInfo,
    );

    expect(table).toMatch(/Last Lap Time\s*\|\s*1:08\.985/);
    expect(table).toMatch(/Best Lap Time\s*\|\s*1:12\.345/);
  });

  it("should render blank instead of 'null' for a blank UserName/CarNumber (#869)", () => {
    const sessionInfo = {
      DriverInfo: {
        Drivers: [{ CarIdx: 1, UserName: null, CarNumber: null, CarScreenName: "Mazda MX-5" }],
      },
    } as Record<string, unknown>;

    const table = buildPlayerTelemetry({ PlayerCarIdx: 1 }, sessionInfo);

    expect(table).not.toContain("null");
    expect(table).toContain("Mazda MX-5 (#)");
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

  describe("extra sections", () => {
    const now = new Date("2026-06-02T15:04:05.000Z");
    const base = generateMarkdown(sampleTelemetry, sampleSessionInfo, now);

    it("should append an extra section as a two-column table after the built-in ones", () => {
      const markdown = generateMarkdown(sampleTelemetry, sampleSessionInfo, now, [
        { title: "Plugin State", rows: [["Plugin version", "3.6.0"]] },
      ]);
      // The report ends on a line break; the leading "" is the blank line that sets the heading off.
      const section = [
        "",
        "## Plugin State",
        "",
        "|                |       |",
        "| -------------- | ----- |",
        "| Plugin version | 3.6.0 |",
        "",
      ].join("\n");

      expect(base).toContain("## Player Telemetry");
      expect(markdown).toBe(base + section);
    });

    it("should append several sections in the order given", () => {
      const markdown = generateMarkdown(sampleTelemetry, sampleSessionInfo, now, [
        { title: "Plugin State", rows: [["Host", "elgato"]] },
        { title: "Second", rows: [["A", "B"]] },
      ]);

      expect(markdown.startsWith(base)).toBe(true);
      expect(markdown.indexOf("## Plugin State")).toBeGreaterThan(markdown.indexOf("## Player Telemetry"));
      expect(markdown.indexOf("## Second")).toBeGreaterThan(markdown.indexOf("## Plugin State"));
    });

    it("should leave the report byte-identical when no extra section is passed", () => {
      expect(generateMarkdown(sampleTelemetry, sampleSessionInfo, now, undefined)).toBe(base);
      expect(generateMarkdown(sampleTelemetry, sampleSessionInfo, now, [])).toBe(base);
    });

    it("should omit a section with zero rows", () => {
      const markdown = generateMarkdown(sampleTelemetry, sampleSessionInfo, now, [
        { title: "Empty", rows: [] },
        { title: "Plugin State", rows: [["Host", "elgato"]] },
      ]);

      expect(markdown).not.toContain("## Empty");
      expect(markdown).toContain("## Plugin State");
      expect(generateMarkdown(sampleTelemetry, sampleSessionInfo, now, [{ title: "Empty", rows: [] }])).toBe(base);
    });

    it("should keep a caller's cell on its own row: line breaks become spaces and pipes are escaped", () => {
      const markdown = generateMarkdown(sampleTelemetry, sampleSessionInfo, now, [
        {
          title: "Plugin State",
          rows: [
            ["a|b", "first\nsecond\r\nthird\rfourth"],
            ["Host", "elgato"],
          ],
        },
      ]);
      const table = markdown.slice(markdown.indexOf("## Plugin State")).split("\n").slice(2, 6);

      expect(table).toEqual([
        "|      |                           |",
        "| ---- | ------------------------- |",
        "| a\\|b | first second third fourth |",
        "| Host | elgato                    |",
      ]);
    });

    it("should escape a backslash too, so one standing before a pipe cannot cancel the pipe's escape", () => {
      const markdown = generateMarkdown(sampleTelemetry, sampleSessionInfo, now, [
        { title: "Plugin State", rows: [["Path", "a\\|b"]] },
      ]);
      const row = markdown.slice(markdown.indexOf("## Plugin State")).split("\n")[4];

      // The text `a\|b` is written `a\\\|b`: an escaped backslash, then an escaped pipe.
      expect(row).toBe("| Path | a\\\\\\|b |");
    });

    it("should append a section to a report that has no telemetry tables", () => {
      const markdown = generateMarkdown({}, null, now, [{ title: "Plugin State", rows: [["Host", "elgato"]] }]);

      expect(markdown).toContain("No position data available.");
      expect(markdown.endsWith("\n## Plugin State\n\n|      |        |\n| ---- | ------ |\n| Host | elgato |\n")).toBe(
        true,
      );
    });
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
  it("should prefix the timestamp with telemetry-snapshot- and include milliseconds", () => {
    const now = new Date(2026, 5, 2, 15, 4, 5, 0);

    expect(snapshotBaseName(now)).toBe("telemetry-snapshot-20260602-150405-000");
  });

  it("should zero-pad the millisecond component", () => {
    const now = new Date(2026, 5, 2, 15, 4, 5, 7);

    expect(snapshotBaseName(now)).toBe("telemetry-snapshot-20260602-150405-007");
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

  it("should carry no pluginState key when none is passed", () => {
    expect("pluginState" in buildSnapshotEnvelope(sampleTelemetry, sampleSessionInfo, true, now)).toBe(false);
    expect("pluginState" in buildSnapshotEnvelope(sampleTelemetry, sampleSessionInfo, true, now, undefined)).toBe(
      false,
    );
  });

  it("should carry the plugin state it is given, after the session info", () => {
    const pluginState = { schema: 1 };
    const envelope = buildSnapshotEnvelope(sampleTelemetry, sampleSessionInfo, true, now, pluginState);

    expect(envelope.pluginState).toBe(pluginState);
    expect(Object.keys(envelope)).toEqual(["timestamp", "telemetry", "sessionInfo", "pluginState"]);
  });

  it("should carry the plugin state without session info", () => {
    const envelope = buildSnapshotEnvelope(sampleTelemetry, sampleSessionInfo, false, now, { schema: 1 });

    expect(Object.keys(envelope)).toEqual(["timestamp", "telemetry", "pluginState"]);
  });
});

describe("formatSnapshotJson", () => {
  /** A primitive-only object of `count` members: `{ k0: 0, k1: 1, … }`. */
  const flatObject = (count: number): Record<string, number> =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, i]));

  // An own `__proto__` key, which no object literal can create.
  const withProtoKey: unknown = JSON.parse('{ "__proto__": { "a": 1 }, "b": 2 }');

  const sparse: unknown[] = [1, 2, 3];
  sparse[6] = 7;

  const envelope = buildSnapshotEnvelope(
    { ...sampleTelemetry, CarIdxLap: Array.from({ length: 64 }, (_, i) => i) },
    sampleSessionInfo,
    true,
    new Date("2026-06-02T15:04:05.000Z"),
    { schema: 1, collectedAt: 1791727391482, sim: { gaps: [{ progress: 1.5, time: 2 }], order: [] } },
  );

  describe("round trip", () => {
    const cases: Array<[string, unknown]> = [
      ["the snapshot envelope", envelope],
      ["a string with quotes, backslashes and line breaks", { s: 'say "hi" \\ C:\\path\\\r\n\tnext' }],
      ["a string with U+2028, U+2029 and control characters", ["a\u2028b\u2029c", "nul\u0000bell\u0007del\u007f"]],
      ["a string with a lone surrogate and an astral character", ["\ud800", "\udc00x", "\u{1F3C1}"]],
      ["keys that need escaping, inline", { 'a"b': 1, "back\\slash": 2, "new\nline": 3, "": 4 }],
      ["keys that need escaping, one per line", { 'a"b': 1, "back\\slash": 2, "new\nline": 3, "": 4, "\u2028": 5 }],
      ["a __proto__ key", withProtoKey],
      ["integer-like keys, which serialise first", { b: 1, 10: 2, 2: 3, a: { z: 1, 1: 2 } }],
      ["an empty object", {}],
      ["an empty array", []],
      ["nested empty containers", { a: {}, b: [], c: [[], {}], d: [{}], e: { f: {}, g: [[]] } }],
      ["null members", { a: null, b: [null, null], c: { d: null }, e: [null, { f: null }] }],
      ["awkward numbers", [-0, 1e21, 1e-7, 5e-324, 1.7976931348623157e308, Number.MAX_SAFE_INTEGER, 0.1 + 0.2]],
      ["awkward numbers as members", { negZero: -0, big: 1e21, small: 1e-7, nested: { negZero: -0 } }],
      ["non-finite numbers", { a: Number.NaN, b: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN] }],
      ["undefined members", { a: undefined, b: 1, c: [undefined, 2], d: { e: undefined } }],
      ["an object left empty once its members are dropped", { a: { b: undefined, c: () => 1 }, d: 1 }],
      ["functions and symbols", { f: () => 1, s: Symbol("s"), [Symbol("key")]: 1, list: [() => 1, Symbol("s"), 3] }],
      ["a sparse array", { sparse }],
      ["a Date and a toJSON method", { at: new Date("2026-06-02T15:04:05.000Z"), custom: { toJSON: () => [1, 2] } }],
      ["class instances", { set: new Set([1]), map: new Map([[1, 2]]), typed: new Uint8Array([1, 2]) }],
      ["an array of 64 numbers", { CarIdxLap: Array.from({ length: 64 }, (_, i) => i * 1.5) }],
      ["a primitive-only object of 4 members", flatObject(4)],
      ["a primitive-only object of 5 members", flatObject(5)],
      ["an object with one nested object", { a: 1, b: { c: 2 } }],
      ["mixed arrays, nested", [1, [2, [3, { a: [4, { b: 5 }] }]], "x", null, true]],
      ["a top-level string", 'a "quoted"\nline'],
      ["a top-level number", -12.5],
      ["a top-level boolean", false],
      ["a top-level null", null],
    ];

    it.each(cases)("should parse to what JSON.stringify gives for %s", (_name, value) => {
      const expected = JSON.stringify(value);
      const parsed: unknown = JSON.parse(formatSnapshotJson(value));

      expect(parsed).toStrictEqual(JSON.parse(expected));
      // Serialising it again pins what deep equality is lax about, key order above all.
      expect(JSON.stringify(parsed)).toBe(expected);
    });

    it("should write null for a top-level value JSON.stringify has no text for", () => {
      expect(formatSnapshotJson(undefined)).toBe("null");
      expect(formatSnapshotJson(() => 1)).toBe("null");
    });

    it("should throw where JSON.stringify throws", () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      expect(() => formatSnapshotJson(cyclic)).toThrow(TypeError);
      expect(() => formatSnapshotJson({ big: 1n })).toThrow(TypeError);
    });
  });

  describe("layout", () => {
    it("should write an array of primitives on one line, whatever its length", () => {
      const line = formatSnapshotJson(envelope)
        .split("\n")
        .find((l) => l.includes('"CarIdxLap"'));

      expect(line).toBe(`    "CarIdxLap": [${Array.from({ length: 64 }, (_, i) => i).join(", ")}],`);
      expect(formatSnapshotJson(["a", 1, null, true])).toBe('["a", 1, null, true]');
    });

    it("should write a small primitive-only object on one line", () => {
      expect(formatSnapshotJson([{ progress: 1.5, time: 2 }])).toBe('[\n  { "progress": 1.5, "time": 2 }\n]');
      expect(formatSnapshotJson({ a: 1, b: "x", c: null, d: true })).toBe('{ "a": 1, "b": "x", "c": null, "d": true }');
    });

    it("should keep a primitive-only object inline up to the limit and no further", () => {
      expect(SNAPSHOT_INLINE_OBJECT_MAX_KEYS).toBe(4);
      expect(formatSnapshotJson(flatObject(4))).toBe('{ "k0": 0, "k1": 1, "k2": 2, "k3": 3 }');
      expect(formatSnapshotJson(flatObject(5))).toBe('{\n  "k0": 0,\n  "k1": 1,\n  "k2": 2,\n  "k3": 3,\n  "k4": 4\n}');
    });

    it("should count the members that are written, not the ones that are dropped", () => {
      expect(formatSnapshotJson({ ...flatObject(4), gone: undefined, fn: () => 1 })).toBe(
        '{ "k0": 0, "k1": 1, "k2": 2, "k3": 3 }',
      );
    });

    it("should write an object holding a nested container one member per line", () => {
      expect(formatSnapshotJson({ a: 1, b: { c: 2 } })).toBe('{\n  "a": 1,\n  "b": { "c": 2 }\n}');
      expect(formatSnapshotJson({ a: [1, 2] })).toBe('{\n  "a": [1, 2]\n}');
      expect(formatSnapshotJson({ a: [] })).toBe('{\n  "a": []\n}');
    });

    it("should write an array holding an object one member per line", () => {
      expect(formatSnapshotJson([{ a: 1 }, 2])).toBe('[\n  { "a": 1 },\n  2\n]');
    });

    it("should write empty containers closed", () => {
      expect(formatSnapshotJson([])).toBe("[]");
      expect(formatSnapshotJson({})).toBe("{}");
      expect(formatSnapshotJson([[], {}])).toBe("[\n  [],\n  {}\n]");
    });

    it("should indent each nesting level by two spaces", () => {
      const value = {
        traces: [
          [
            { progress: 1.5, time: 2 },
            { progress: 2, time: 3 },
          ],
          [],
        ],
      };

      expect(formatSnapshotJson(value)).toBe(
        [
          "{",
          '  "traces": [',
          "    [",
          '      { "progress": 1.5, "time": 2 },',
          '      { "progress": 2, "time": 3 }',
          "    ],",
          "    []",
          "  ]",
          "}",
        ].join("\n"),
      );
    });

    it("should write what a two-space JSON.stringify writes where no leaf is compact", () => {
      const wide = { driver: { ...flatObject(5), car: { ...flatObject(6), name: 'a "b"' } }, other: flatObject(7) };

      expect(formatSnapshotJson(wide)).toBe(JSON.stringify(wide, null, 2));
    });

    it("should keep 64 full gap traces under the 5 MB budget", () => {
      const gapTraces = Array.from({ length: 64 }, (_, car) =>
        Array.from({ length: 575 }, (_, i) => ({
          progress: 11 + (car + i / 575) / 3,
          time: 1800 + car * 1.37 + i / 7,
        })),
      );
      const text = formatSnapshotJson({ pluginState: { sim: { raw: { gapTraces } } } });

      expect(text.split("\n").length).toBeGreaterThan(64 * 575);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThan(5 * 1024 * 1024);
    });
  });
});
