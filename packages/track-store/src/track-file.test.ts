import { PIT_LANE_SECTION_VERSION, type PitLaneTrackIdentity } from "@iracedeck/track-data";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildTrackFile,
  isTrackDataSim,
  type ParsedTrackFile,
  parseTrackFile,
  readTrackFile,
  resolveTrackDataDirectory,
  TRACK_FILE_VERSION,
  trackFileMismatch,
  trackFileName,
  trackFilePath,
  trackSimDirectory,
} from "./track-file.js";

const TRACK: PitLaneTrackIdentity = {
  sim: "iracing",
  trackId: 101,
  trackName: "spa 2024 gp",
  trackConfigName: "Grand Prix",
  trackLength: "6.93 km",
  trackLengthM: 6930,
  trackVersion: "2025.03.01.02",
};

function fileText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: TRACK_FILE_VERSION,
    sim: "iracing",
    trackId: 101,
    trackName: "spa 2024 gp",
    trackConfigName: "Grand Prix",
    trackLength: "6.93 km",
    trackVersion: "2025.03.01.02",
    pitLane: { version: PIT_LANE_SECTION_VERSION, trackLength: "6.93 km", landmarks: {} },
    ...overrides,
  });
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe("resolveTrackDataDirectory", () => {
  it("is one folder under %LOCALAPPDATA%, with no ecosystem folder", () => {
    expect(resolveTrackDataDirectory({ env: { LOCALAPPDATA: "C:\\Users\\X\\AppData\\Local" } })).toBe(
      join("C:\\Users\\X\\AppData\\Local", "iRaceDeck", "Track Data"),
    );
  });

  it("lets IRACEDECK_TRACK_DATA_DIR replace the whole directory", () => {
    expect(
      resolveTrackDataDirectory({ env: { LOCALAPPDATA: "C:\\Local", IRACEDECK_TRACK_DATA_DIR: "D:\\tracks" } }),
    ).toBe("D:\\tracks");
  });

  it("ignores a blank override and falls back past a blank LOCALAPPDATA", () => {
    expect(resolveTrackDataDirectory({ env: { LOCALAPPDATA: "  ", IRACEDECK_TRACK_DATA_DIR: " " } })).toBe(
      join(homedir(), "AppData", "Local", "iRaceDeck", "Track Data"),
    );
  });
});

describe("trackFileName", () => {
  it("is track_<TrackID>.json", () => {
    expect(trackFileName(101)).toBe("track_101.json");
  });
});

describe("parseTrackFile", () => {
  it("reads a file, keeping every key it does not know", () => {
    const result = parseTrackFile(
      fileText({
        futureEnvelopeKey: { a: 1 },
        pitLane: {
          version: 1,
          trackLength: "6.93 km",
          futureSectionKey: true,
          landmarks: { someFutureLandmark: { x: 1 } },
        },
      }),
    );

    expect(result.kind).toBe("ok");

    if (result.kind !== "ok") return;

    expect(result.file.futureEnvelopeKey).toEqual({ a: 1 });
    expect(result.file.pitLane?.futureSectionKey).toBe(true);
    expect(result.file.pitLane?.landmarks.someFutureLandmark).toEqual({ x: 1 });
    expect(result.file.trackVersion).toBe("2025.03.01.02");
  });

  it("tolerates a BOM", () => {
    expect(parseTrackFile("\ufeff" + fileText()).kind).toBe("ok");
  });

  it("reads a file with no pitLane section as one with no section", () => {
    const result = parseTrackFile(fileText({ pitLane: undefined }));

    expect(result).toMatchObject({ kind: "ok", file: { pitLane: undefined } });
  });

  it("is lenient on the informational envelope fields", () => {
    const result = parseTrackFile(fileText({ sim: 3, trackLength: null, trackVersion: 7 }));

    expect(result).toMatchObject({ kind: "ok", file: { sim: "", trackLength: "", trackVersion: null } });
  });

  it.each([
    ["not JSON", "{not json"],
    ["an array", "[]"],
    ["no version", fileText({ version: undefined })],
    ["a fractional version", fileText({ version: 1.5 })],
    ["no trackId", fileText({ trackId: "101" })],
    ["no trackName", fileText({ trackName: undefined })],
    ["no trackConfigName", fileText({ trackConfigName: 4 })],
    ["a malformed pitLane section", fileText({ pitLane: { version: 1, landmarks: {} } })],
  ])("calls %s corrupt", (_label, text) => {
    expect(parseTrackFile(text).kind).toBe("corrupt");
  });

  it("recognises a newer envelope before anything else", () => {
    expect(parseTrackFile(JSON.stringify({ version: TRACK_FILE_VERSION + 1 }))).toEqual({
      kind: "newerVersion",
      version: TRACK_FILE_VERSION + 1,
    });
  });

  it("recognises a newer pit-lane section and does not call it corrupt", () => {
    expect(parseTrackFile(fileText({ pitLane: { version: PIT_LANE_SECTION_VERSION + 1, shape: "unknown" } }))).toEqual({
      kind: "newerSection",
      version: PIT_LANE_SECTION_VERSION + 1,
    });
  });
});

describe("readTrackFile", () => {
  it("is absent on ENOENT", () => {
    expect(
      readTrackFile("x", () => {
        throw errno("ENOENT");
      }),
    ).toEqual({ kind: "absent" });
  });

  it("is unreadable on any other read error", () => {
    expect(
      readTrackFile("x", () => {
        throw errno("EBUSY");
      }).kind,
    ).toBe("unreadable");
  });

  it("parses what it read", () => {
    expect(readTrackFile("x", () => fileText()).kind).toBe("ok");
  });
});

describe("trackFileMismatch", () => {
  function parsed(overrides: Record<string, unknown> = {}): ParsedTrackFile {
    const result = parseTrackFile(fileText(overrides));

    if (result.kind !== "ok") throw new Error("fixture did not parse");

    return result.file;
  }

  it("accepts the same track, whatever its length or version", () => {
    expect(trackFileMismatch(parsed({ trackLength: "7.00 km", trackVersion: "old" }), TRACK)).toBeNull();
  });

  it("accepts a file with no sim recorded", () => {
    expect(trackFileMismatch(parsed({ sim: undefined }), TRACK)).toBeNull();
  });

  it("compares the envelope's sim with the identity's", () => {
    expect(trackFileMismatch(parsed({ sim: "other-sim" }), { ...TRACK, sim: "other-sim" })).toBeNull();
    expect(trackFileMismatch(parsed(), { ...TRACK, sim: "other-sim" })).toBe('sim "iracing" is not "other-sim"');
  });

  it.each([
    ["trackId", { trackId: 102 }],
    ["trackName", { trackName: "monza" }],
    ["trackConfigName", { trackConfigName: "Oval" }],
    ["sim", { sim: "othersim" }],
  ])("refuses a different %s", (field, overrides) => {
    expect(trackFileMismatch(parsed(overrides), TRACK)).toContain(field);
  });
});

describe("buildTrackFile", () => {
  const section = { version: 1, trackLength: "6.93 km", trackVersion: "2025.03.01.02", landmarks: {} };

  it("writes the envelope from the session's identity", () => {
    expect(buildTrackFile(undefined, TRACK, section)).toEqual({
      version: TRACK_FILE_VERSION,
      sim: "iracing",
      trackId: 101,
      trackName: "spa 2024 gp",
      trackConfigName: "Grand Prix",
      trackLength: "6.93 km",
      trackVersion: "2025.03.01.02",
      pitLane: section,
    });
  });

  it("carries every unknown key of the base and replaces the known ones", () => {
    const base = parseTrackFile(fileText({ trackLength: "old", futureKey: [1, 2], sim: "" }));

    if (base.kind !== "ok") throw new Error("fixture did not parse");

    const file = buildTrackFile(base.file, TRACK, section);

    expect(file.futureKey).toEqual([1, 2]);
    expect(file.trackLength).toBe("6.93 km");
    expect(file.sim).toBe("iracing");
    expect(file.pitLane).toBe(section);
  });

  it("names the identity's sim in the envelope", () => {
    expect(buildTrackFile(undefined, { ...TRACK, sim: "other-sim" }, section).sim).toBe("other-sim");
  });
});

describe("the sim's folder", () => {
  it.each(["iracing", "sim-2", "a", "0", "x".repeat(32)])("accepts %j as a folder name", (sim) => {
    expect(isTrackDataSim(sim)).toBe(true);
    expect(trackSimDirectory("C:/data/Track Data", sim)).toBe(join("C:/data/Track Data", sim));
  });

  it.each([
    "",
    "iRacing",
    "../up",
    "a/b",
    "a\\b",
    ".",
    "..",
    "-lead",
    "a.b",
    "has space",
    "con",
    "nul",
    "com1",
    "lpt9",
    "x".repeat(33),
    3,
    null,
    undefined,
  ])("refuses %j", (sim) => {
    expect(isTrackDataSim(sim)).toBe(false);
    expect(() => trackSimDirectory("C:/data/Track Data", sim as string)).toThrow(RangeError);
    expect(() => trackFilePath("C:/data/Track Data", sim as string, 101)).toThrow(RangeError);
  });

  it("puts a track's file in its sim's folder", () => {
    expect(trackFilePath("C:/data/Track Data", "iracing", 101)).toBe(
      join("C:/data/Track Data", "iracing", "track_101.json"),
    );
  });
});
