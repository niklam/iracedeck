import { STANDARD_CAMERA_GROUP_OPTIONS } from "@iracedeck/app-constants";
import { describe, expect, it } from "vitest";

import {
  CAMERA_CATALOG_LAST_SEEN_REFRESH_MS,
  CAMERA_GROUP_NAME_MAX_LENGTH,
  type CameraCatalog,
  type CameraGroupObservation,
  emptyCameraCatalog,
  parseCameraCatalog,
  recordCameraGroups,
  removeCameraGroup,
  toCameraCatalogView,
} from "./camera-catalog.js";

const T0 = new Date("2026-11-08T12:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const HOUR = 60 * 60 * 1000;

const spa: CameraGroupObservation = {
  trackId: 13,
  trackName: "Circuit de Spa-Francorchamps",
  trackConfig: "Grand Prix",
  groups: ["Nose", "TV1", "DynamicTV"],
};

/** A deep, JSON-shaped copy, for comparing a catalog to a literal and for proving nothing was mutated. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function record(catalog: CameraCatalog, observation: CameraGroupObservation, now: Date): CameraCatalog {
  const update = recordCameraGroups(catalog, observation, now);

  expect(update.changed).toBe(true);

  return update.catalog;
}

describe("recordCameraGroups (#1653)", () => {
  it("records a new track and its groups", () => {
    const update = recordCameraGroups(emptyCameraCatalog(), spa, T0);

    expect(update.changed).toBe(true);
    expect(plain(update.catalog)).toEqual({
      version: 1,
      tracks: {
        "13": {
          name: "Circuit de Spa-Francorchamps",
          config: "Grand Prix",
          groups: ["Nose", "TV1", "DynamicTV"],
          lastSeen: T0.toISOString(),
        },
      },
      groups: {
        Nose: { firstSeen: T0.toISOString(), lastSeen: T0.toISOString() },
        TV1: { firstSeen: T0.toISOString(), lastSeen: T0.toISOString() },
        DynamicTV: { firstSeen: T0.toISOString(), lastSeen: T0.toISOString() },
      },
    });
  });

  it("replaces a track's list with a later one, keeping a dropped group in groups", () => {
    const first = record(emptyCameraCatalog(), spa, T0);
    const second = record(first, { ...spa, groups: ["Nose", "TV1", "SpeedCam"] }, at(HOUR));

    expect(second.tracks["13"].groups).toEqual(["Nose", "TV1", "SpeedCam"]);
    expect(Object.keys(second.groups).sort()).toEqual(["DynamicTV", "Nose", "SpeedCam", "TV1"]);
    // The dropped group keeps its times; the observed ones are refreshed, a new one starts.
    expect(second.groups.DynamicTV).toEqual({ firstSeen: T0.toISOString(), lastSeen: T0.toISOString() });
    expect(second.groups.Nose).toEqual({ firstSeen: T0.toISOString(), lastSeen: at(HOUR).toISOString() });
    expect(second.groups.SpeedCam).toEqual({ firstSeen: at(HOUR).toISOString(), lastSeen: at(HOUR).toISOString() });
    expect(second.tracks["13"].lastSeen).toBe(at(HOUR).toISOString());
  });

  it("treats a reordered list as a change, since the order is the sim's", () => {
    const first = record(emptyCameraCatalog(), spa, T0);

    expect(recordCameraGroups(first, { ...spa, groups: ["TV1", "Nose", "DynamicTV"] }, at(HOUR)).changed).toBe(true);
  });

  it("records a replay under its own track, beside the live one", () => {
    const live = record(emptyCameraCatalog(), spa, T0);
    const replay = record(live, { trackId: 42, trackName: "Lakeland", trackConfig: "", groups: ["Blimp"] }, at(HOUR));

    expect(Object.keys(replay.tracks).sort()).toEqual(["13", "42"]);
    expect(replay.tracks["13"]).toEqual(live.tracks["13"]);
    expect(replay.tracks["42"].groups).toEqual(["Blimp"]);
  });

  it("changes nothing for an identical observation within a day", () => {
    const first = record(emptyCameraCatalog(), spa, T0);
    const update = recordCameraGroups(first, { ...spa, groups: [...spa.groups] }, at(23 * HOUR));

    expect(update.changed).toBe(false);
    expect(update.catalog).toBe(first);
  });

  it("refreshes lastSeen of the track and its groups once the track's is a day old", () => {
    const first = record(emptyCameraCatalog(), spa, T0);
    const update = recordCameraGroups(first, spa, at(CAMERA_CATALOG_LAST_SEEN_REFRESH_MS));

    expect(update.changed).toBe(true);
    expect(update.catalog.tracks["13"].lastSeen).toBe(at(CAMERA_CATALOG_LAST_SEEN_REFRESH_MS).toISOString());
    expect(update.catalog.groups.TV1).toEqual({
      firstSeen: T0.toISOString(),
      lastSeen: at(CAMERA_CATALOG_LAST_SEEN_REFRESH_MS).toISOString(),
    });
  });

  it("refreshes a lastSeen a day in the future or unreadable", () => {
    const first = record(emptyCameraCatalog(), spa, T0);

    expect(recordCameraGroups(first, spa, at(-CAMERA_CATALOG_LAST_SEEN_REFRESH_MS)).changed).toBe(true);

    const unreadable: CameraCatalog = { ...first, tracks: { "13": { ...first.tracks["13"], lastSeen: "" } } };

    expect(recordCameraGroups(unreadable, spa, T0).changed).toBe(true);
  });

  it("counts a changed track name or configuration as a change", () => {
    const first = record(emptyCameraCatalog(), spa, T0);

    expect(recordCameraGroups(first, { ...spa, trackName: "Spa" }, at(HOUR)).changed).toBe(true);
    expect(recordCameraGroups(first, { ...spa, trackConfig: "Endurance" }, at(HOUR)).changed).toBe(true);
  });

  it("re-adds a removed name the track's file still has, though the list is unchanged", () => {
    const first = record(emptyCameraCatalog(), spa, T0);
    const removed = removeCameraGroup(first, "DynamicTV").catalog;
    const update = recordCameraGroups(removed, spa, at(HOUR));

    expect(update.changed).toBe(true);
    expect(update.catalog.groups.DynamicTV).toEqual({
      firstSeen: at(HOUR).toISOString(),
      lastSeen: at(HOUR).toISOString(),
    });
  });

  it("normalises names, so Pit Lane2 and Pit Lane 2 are one entry, and keeps each once", () => {
    const update = recordCameraGroups(
      emptyCameraCatalog(),
      { ...spa, groups: ["Pit Lane2", "Pit Lane 2", "TV1", "TV1"] },
      T0,
    );

    expect(update.catalog.tracks["13"].groups).toEqual(["Pit Lane 2", "TV1"]);
    expect(Object.keys(update.catalog.groups)).toEqual(["Pit Lane 2", "TV1"]);
  });

  it("skips blank and over-long names", () => {
    const long = "x".repeat(CAMERA_GROUP_NAME_MAX_LENGTH + 1);
    const update = recordCameraGroups(emptyCameraCatalog(), { ...spa, groups: ["", "  ", long, "TV1"] }, T0);

    expect(update.catalog.tracks["13"].groups).toEqual(["TV1"]);
  });

  it("ignores an observation with no usable track id or no recordable name", () => {
    const empty = emptyCameraCatalog();

    for (const trackId of [0, -3, 1.5, NaN, 2 ** 53]) {
      expect(recordCameraGroups(empty, { ...spa, trackId }, T0)).toEqual({ catalog: empty, changed: false });
    }

    expect(recordCameraGroups(empty, { ...spa, groups: [] }, T0)).toEqual({ catalog: empty, changed: false });
    expect(recordCameraGroups(empty, { ...spa, groups: ["", " "] }, T0).changed).toBe(false);
  });

  it("never mutates its input", () => {
    const first = record(emptyCameraCatalog(), spa, T0);
    const before = plain(first);

    record(first, { ...spa, groups: ["SpeedCam"] }, at(HOUR));
    record(first, { ...spa, trackId: 7 }, at(HOUR));

    expect(plain(first)).toEqual(before);
  });

  it("holds names that are prototype keys as ordinary entries", () => {
    const update = recordCameraGroups(
      emptyCameraCatalog(),
      { ...spa, groups: ["__proto__", "constructor", "toString"] },
      T0,
    );

    expect(Object.keys(update.catalog.groups)).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.getPrototypeOf(update.catalog.groups)).toBeNull();
    // Recording the same list again is no change, so "constructor" was not found on a prototype.
    expect(
      recordCameraGroups(update.catalog, { ...spa, groups: ["__proto__", "constructor", "toString"] }, T0).changed,
    ).toBe(false);
    expect(toCameraCatalogView(update.catalog, null).groups).toHaveLength(3);
  });
});

describe("removeCameraGroup (#1653)", () => {
  it("drops the name from groups only, leaving tracks' lists as they are", () => {
    const catalog = record(emptyCameraCatalog(), spa, T0);
    const update = removeCameraGroup(catalog, "DynamicTV");

    expect(update.changed).toBe(true);
    expect(Object.keys(update.catalog.groups)).toEqual(["Nose", "TV1"]);
    expect(update.catalog.tracks).toBe(catalog.tracks);
    expect(update.catalog.tracks["13"].groups).toContain("DynamicTV");
    expect(Object.keys(catalog.groups)).toContain("DynamicTV");
  });

  it("changes nothing for an unknown name, an inherited key included", () => {
    const catalog = record(emptyCameraCatalog(), spa, T0);

    for (const name of ["Drone", "", "dynamictv", "constructor", "__proto__"]) {
      expect(removeCameraGroup(catalog, name)).toEqual({ catalog, changed: false });
    }
  });
});

describe("parseCameraCatalog (#1653)", () => {
  const valid = {
    version: 1,
    tracks: {
      "13": { name: "Spa", config: "GP", groups: ["Nose", "Pit Lane2"], lastSeen: "2026-11-01T00:00:00.000Z" },
    },
    groups: {
      Nose: { firstSeen: "2026-10-01T00:00:00.000Z", lastSeen: "2026-11-01T00:00:00.000Z" },
      "Pit Lane 2": { firstSeen: "2026-10-01T00:00:00.000Z", lastSeen: "2026-11-01T00:00:00.000Z" },
    },
  };

  it("reads a version 1 file, normalising names", () => {
    const result = parseCameraCatalog(valid);

    expect(result.kind).toBe("ok");

    if (result.kind !== "ok") return;

    expect(result.dropped).toBe(0);
    expect(plain(result.catalog)).toEqual({
      ...valid,
      tracks: { "13": { ...valid.tracks["13"], groups: ["Nose", "Pit Lane 2"] } },
    });
  });

  it("round-trips what recordCameraGroups writes", () => {
    const catalog = record(record(emptyCameraCatalog(), spa, T0), { ...spa, trackId: 9, groups: ["Drone"] }, T0);
    const result = parseCameraCatalog(plain(catalog));

    expect(result.kind === "ok" && plain(result.catalog)).toEqual(plain(catalog));
  });

  it("drops malformed entries and counts them", () => {
    const result = parseCameraCatalog({
      version: 1,
      tracks: {
        "13": valid.tracks["13"],
        "0": valid.tracks["13"],
        "013": valid.tracks["13"],
        spa: valid.tracks["13"],
        "99999999999999999999": valid.tracks["13"],
        "14": "x",
        "15": { name: "No list", groups: "Nose" },
        "16": { groups: ["TV1", 7, null, ""] },
      },
      groups: { Nose: valid.groups.Nose, Bad: "x", "": { firstSeen: "", lastSeen: "" }, List: [] },
    });

    expect(result.kind).toBe("ok");

    if (result.kind !== "ok") return;

    expect(result.dropped).toBe(9);
    expect(Object.keys(result.catalog.tracks)).toEqual(["13", "16"]);
    // A kept entry's non-text fields read as empty, and a non-text name is skipped.
    expect(plain(result.catalog.tracks["16"])).toEqual({ name: "", config: "", groups: ["TV1"], lastSeen: "" });
    expect(Object.keys(result.catalog.groups)).toEqual(["Nose"]);
  });

  it("merges two names that normalise to one, earliest firstSeen and latest lastSeen", () => {
    const result = parseCameraCatalog({
      version: 1,
      tracks: {},
      groups: {
        "Pit Lane2": { firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-03-01T00:00:00.000Z" },
        "Pit Lane 2": { firstSeen: "2026-02-01T00:00:00.000Z", lastSeen: "2026-04-01T00:00:00.000Z" },
      },
    });

    expect(result.kind === "ok" && plain(result.catalog.groups)).toEqual({
      "Pit Lane 2": { firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-04-01T00:00:00.000Z" },
    });
  });

  it("holds a __proto__ name from the file as an ordinary entry", () => {
    const raw = JSON.parse('{"version":1,"tracks":{},"groups":{"__proto__":{"firstSeen":"a","lastSeen":"b"}}}');
    const result = parseCameraCatalog(raw);

    expect(result.kind === "ok" && Object.keys(result.catalog.groups)).toEqual(["__proto__"]);
  });

  it("is unusable for another version or a shape that is not version 1's", () => {
    for (const raw of [
      null,
      [],
      "x",
      {},
      { version: 2, tracks: {}, groups: {} },
      { version: "1", tracks: {}, groups: {} },
      { version: 1, tracks: [], groups: {} },
      { version: 1, tracks: {}, groups: null },
      { version: 1, groups: {} },
    ]) {
      expect(parseCameraCatalog(raw).kind, JSON.stringify(raw)).toBe("unusable");
    }
  });
});

describe("toCameraCatalogView (#1653)", () => {
  it("lists tracks by id and groups by name, with the tracks whose latest list holds each", () => {
    let catalog = record(emptyCameraCatalog(), { ...spa, groups: ["Nose", "Drone", "TV1"] }, T0);

    catalog = record(
      catalog,
      { trackId: 5, trackName: "Lakeland", trackConfig: "", groups: ["TV1", "blimp"] },
      at(HOUR),
    );
    catalog = record(catalog, { ...spa, groups: ["Nose", "TV1"] }, at(2 * HOUR));

    const view = toCameraCatalogView(catalog, { trackId: 13, groups: ["Nose", "TV1"] });

    expect(view).toEqual({
      version: 1,
      tracks: [
        { id: 5, name: "Lakeland", config: "" },
        { id: 13, name: "Circuit de Spa-Francorchamps", config: "Grand Prix" },
      ],
      groups: [
        { name: "blimp", tracks: [0], lastSeen: at(HOUR).toISOString() },
        // Seen before, on no track's latest list.
        { name: "Drone", tracks: [], lastSeen: T0.toISOString() },
        { name: "Nose", tracks: [1], lastSeen: at(2 * HOUR).toISOString() },
        { name: "TV1", tracks: [0, 1], lastSeen: at(2 * HOUR).toISOString() },
      ],
      current: { trackId: 13, groups: ["Nose", "TV1"] },
    });
  });

  it("leaves out a name the user removed, though a track still holds it", () => {
    const catalog = removeCameraGroup(record(emptyCameraCatalog(), spa, T0), "DynamicTV").catalog;

    expect(toCameraCatalogView(catalog, null).groups.map((g) => g.name)).toEqual(["Nose", "TV1"]);
  });

  it("orders names case-insensitively, then by code unit, and gives null current with no session", () => {
    const catalog = record(emptyCameraCatalog(), { ...spa, groups: ["b", "B", "a", "C"] }, T0);
    const view = toCameraCatalogView(catalog, null);

    expect(view.groups.map((g) => g.name)).toEqual(["a", "B", "b", "C"]);
    expect(view.current).toBeNull();
  });

  it("copies current rather than sharing its list", () => {
    const groups = ["Nose"];
    const view = toCameraCatalogView(emptyCameraCatalog(), { trackId: 1, groups });

    groups.push("TV1");
    expect(view.current?.groups).toEqual(["Nose"]);
  });

  /**
   * The order of magnitude the requester reported (spec Testing): 300+ camera
   * files and 40–50 groups on one track. Each track here holds the 25 standard
   * groups plus 20 of 1,975 custom names (2,000 in all), every custom name on
   * about three tracks, with realistic track names and full ISO times.
   *
   * The published JSON rides every settings push to every open Property
   * Inspector and the settings window (the loopback channel pushes the whole
   * cache) and the once-per-start deck-host mirror, so its size is a cost paid
   * on every setting change. Measured at 232,493 bytes (about 227 KiB), of
   * which the per-group `lastSeen` is the largest single part (about 45 %).
   * The bound, 300 KiB, is about 1.3 times that: tight enough to fail on a
   * change of SHAPE (a second timestamp per group adds about 100 KB, a
   * per-group list of track names far more), not a cap on the catalog itself.
   */
  it("keeps a 300-track, 2,000-name catalog's published JSON under 300 KiB", () => {
    const standard = STANDARD_CAMERA_GROUP_OPTIONS.map((option) => option.name);
    const custom = Array.from(
      { length: 2000 - standard.length },
      (_, i) => `Custom_Shot_${i.toString().padStart(4, "0")}`,
    );
    let catalog = emptyCameraCatalog();

    for (let track = 0; track < 300; track++) {
      const picks = Array.from({ length: 20 }, (_, j) => custom[(track * 20 + j) % custom.length]);

      catalog = recordCameraGroups(
        catalog,
        {
          trackId: 100 + track,
          trackName: `Some Long Track Name International Raceway ${track}`,
          trackConfig: "Grand Prix Circuit",
          groups: [...standard, ...picks],
        },
        at(track * HOUR),
      ).catalog;
    }

    expect(Object.keys(catalog.tracks)).toHaveLength(300);
    expect(Object.keys(catalog.groups)).toHaveLength(2000);

    const view = toCameraCatalogView(catalog, { trackId: 100, groups: catalog.tracks["100"].groups as string[] });
    const bytes = Buffer.byteLength(JSON.stringify(view), "utf-8");

    expect(bytes).toBeLessThan(300 * 1024);
  });
});
