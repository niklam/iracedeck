import {
  type CameraCatalogView,
  type CameraCatalogViewGroup,
  type CameraCatalogViewTrack,
  STANDARD_CAMERA_GROUP_OPTIONS,
} from "@iracedeck/app-constants";
import { describe, expect, it } from "vitest";

import { installCameraGroupHelpers } from "./camera-groups-install.js";
import {
  buildCameraGroupPicker,
  buildRememberedGroups,
  CAMERA_GROUP_HELPERS,
  CAMERA_GROUP_NAME_MAX_LENGTH,
  cameraGroupWrite,
  clearRemembered,
  effectiveCameraGroupName,
  formatTrackList,
  isAcceptableCameraGroupName,
  isCustomCameraFile,
  isStandardCameraGroup,
  matchCameraGroupName,
  normalizeCameraGroupName,
  parseCameraCatalog,
  PICKER_HEADINGS,
  resolveTypedCameraGroupName,
  selectAllRemembered,
} from "./camera-groups-view.js";

const STANDARD_NAMES = STANDARD_CAMERA_GROUP_OPTIONS.map((o) => o.name);

const TRACKS: CameraCatalogViewTrack[] = [
  { id: 1, name: "Spa", config: "Grand Prix Pits" },
  { id: 2, name: "Monza", config: "Grand Prix" },
  { id: 3, name: "Daytona", config: "Oval" },
  { id: 4, name: "Sebring", config: "International" },
  { id: 5, name: "Spa", config: "Endurance" },
];

function group(name: string, tracks: number[] = [], lastSeen = "2026-11-08T12:00:00.000Z"): CameraCatalogViewGroup {
  return { name, tracks, lastSeen };
}

function catalog(
  groups: CameraCatalogViewGroup[],
  current: CameraCatalogView["current"] = null,
  tracks: CameraCatalogViewTrack[] = TRACKS,
): CameraCatalogView {
  return { version: 1, tracks, groups, current };
}

describe("parseCameraCatalog", () => {
  it("reads a version-1 view from its JSON", () => {
    const view = catalog([group("Drone", [0])], { trackId: 2, groups: ["TV1", "Drone"] });

    expect(parseCameraCatalog(JSON.stringify(view))).toEqual(view);
  });

  it.each([
    ["an empty string", ""],
    ["JSON that does not parse", "{not json"],
    ["another version", JSON.stringify({ version: 2, tracks: [], groups: [], current: null })],
    ["no tracks array", JSON.stringify({ version: 1, groups: [], current: null })],
    ["an array", "[]"],
    ["undefined", undefined],
    ["a number", 5],
  ])("is null for %s", (_label, raw) => {
    expect(parseCameraCatalog(raw)).toBeNull();
  });

  it("keeps a malformed track's position, as an unnamed track, so group indices still point right", () => {
    const view = parseCameraCatalog(
      JSON.stringify({
        version: 1,
        tracks: [{ id: "x" }, { id: 2, name: "Monza", config: "GP" }],
        groups: [{ name: "Drone", tracks: [1], lastSeen: "t" }],
        current: null,
      }),
    );

    expect(view?.tracks[0].name).toBe("");
    expect(view?.tracks[1].name).toBe("Monza");
  });

  it("drops unnamed groups and repeated names, and keeps only whole-number track indices", () => {
    const view = parseCameraCatalog({
      version: 1,
      tracks: TRACKS,
      groups: [{ name: "" }, { name: "Drone", tracks: [0, "1", 1.5, 2] }, { name: "Drone", tracks: [3] }, 7],
      current: null,
    });

    expect(view?.groups).toEqual([{ name: "Drone", tracks: [0, 2], lastSeen: "" }]);
  });

  it("reads a current session with junk names cleaned and the legacy spelling folded", () => {
    const view = parseCameraCatalog({
      version: 1,
      tracks: [],
      groups: [],
      current: { trackId: 9, groups: ["Pit Lane2", "Pit Lane 2", 3, "", "Drone"] },
    });

    expect(view?.current).toEqual({ trackId: 9, groups: ["Pit Lane 2", "Drone"] });
  });

  it("reads a malformed current session as no session", () => {
    expect(parseCameraCatalog({ version: 1, tracks: [], groups: [], current: { groups: [] } })?.current).toBeNull();
  });
});

describe("the custom-file heading heuristic", () => {
  it("calls a session with one non-standard group a custom camera file", () => {
    expect(isCustomCameraFile({ trackId: 1, groups: [...STANDARD_NAMES, "DynamicTV"] })).toBe(true);
  });

  it("does not call the 25 standard groups alone a custom file", () => {
    expect(isCustomCameraFile({ trackId: 1, groups: STANDARD_NAMES })).toBe(false);
  });

  it("reads the legacy Pit Lane2 spelling as the standard group", () => {
    expect(isCustomCameraFile({ trackId: 1, groups: ["Nose", "Pit Lane2"] })).toBe(false);
  });

  it("is false with no session", () => {
    expect(isCustomCameraFile(null)).toBe(false);
  });
});

describe("effectiveCameraGroupName", () => {
  it("prefers a non-empty stored name", () => {
    expect(effectiveCameraGroupName("  Drone ", 17)).toBe("Drone");
  });

  it("reads an empty name from the number, as every key saved before #1653", () => {
    expect(effectiveCameraGroupName("", 17)).toBe("TV1");
    expect(effectiveCameraGroupName(undefined, "4")).toBe("LF Susp");
  });

  it("reads a missing or unknown number as the action does: Cockpit", () => {
    expect(effectiveCameraGroupName("", undefined)).toBe("Cockpit");
    expect(effectiveCameraGroupName("", 99)).toBe("Cockpit");
  });
});

describe("formatTrackList", () => {
  it("shows up to three tracks, then how many more", () => {
    expect(formatTrackList(["A", "B"])).toBe("A, B");
    expect(formatTrackList(["A", "B", "C"])).toBe("A, B, C");
    expect(formatTrackList(["A", "B", "C", "D", "E"])).toBe("A, B, C +2");
  });
});

describe("buildCameraGroupPicker", () => {
  const headings = (model: ReturnType<typeof buildCameraGroupPicker>): (string | null)[] =>
    model.sections.map((s) => s.heading);
  const section = (model: ReturnType<typeof buildCameraGroupPicker>, heading: string) =>
    model.sections.find((s) => s.heading === heading);

  describe("with no session", () => {
    it("is exactly today's picker: the four standard sections, no markings", () => {
      const model = buildCameraGroupPicker(null, "Cockpit");

      expect(headings(model)).toEqual(["Car", "Chase", "Track", "Aerial"]);

      const options = model.sections.flatMap((s) => s.options);

      expect(options.map((o) => o.value)).toEqual(STANDARD_NAMES);
      expect(options.map((o) => o.label)).toEqual(STANDARD_CAMERA_GROUP_OPTIONS.map((o) => o.label));
      expect(model.selected).toBe("Cockpit");
    });

    it("lists remembered groups with the tracks that have them, without claiming a 'this track'", () => {
      const model = buildCameraGroupPicker(
        catalog([group("Drone", [0, 1, 2, 3, 4]), group("Grid_Pole", []), group("TV1", [0])]),
        "Cockpit",
      );
      const remembered = section(model, PICKER_HEADINGS.remembered);

      expect(remembered?.options).toEqual([
        // Spa's two layouts read as one track; four distinct names, three shown.
        { value: "Drone", label: "Drone (on Daytona, Monza, Sebring +1)" },
        { value: "Grid_Pole", label: "Grid_Pole (seen before)" },
      ]);
    });

    it("shows a stored name nothing lists as not seen yet, and keeps it selected", () => {
      const model = buildCameraGroupPicker(null, "MyCam");

      expect(section(model, PICKER_HEADINGS.stored)?.options).toEqual([
        { value: "MyCam", label: "MyCam (not seen yet)" },
      ]);
      expect(model.selected).toBe("MyCam");
    });
  });

  describe("with a session loaded", () => {
    const view = catalog(
      [group("Drone", [0, 1]), group("CrankItUp", []), group("DynamicTV", [1]), group("Nose", [1])],
      { trackId: 2, groups: ["TV1", "DynamicTV", "Nose", "Scenic"] },
    );

    it("orders the five groups: this track, standard, remembered, stored, (Other… is the component's)", () => {
      const model = buildCameraGroupPicker(view, "Ghost");

      expect(headings(model)).toEqual([
        PICKER_HEADINGS.onTrackCustom,
        "Car",
        "Chase",
        "Track",
        "Aerial",
        PICKER_HEADINGS.remembered,
        PICKER_HEADINGS.stored,
      ]);
    });

    it("lists this track's groups first, in the sim's order, standard and custom alike", () => {
      const model = buildCameraGroupPicker(view, "TV1");

      expect(model.sections[0].options).toEqual([
        { value: "TV1", label: "TV1" },
        { value: "DynamicTV", label: "DynamicTV" },
        { value: "Nose", label: "Nose" },
        { value: "Scenic", label: "Scenic" },
      ]);
    });

    it("heads them plainly when every group is standard", () => {
      const model = buildCameraGroupPicker(catalog([], { trackId: 2, groups: ["TV1", "Nose"] }), "TV1");

      expect(model.sections[0].heading).toBe(PICKER_HEADINGS.onTrack);
    });

    it("marks the standard groups not on this track, and leaves out the ones that are", () => {
      const model = buildCameraGroupPicker(view, "TV1");
      const car = section(model, "Car");
      const track = section(model, "Track");

      expect(car?.options[0]).toEqual({ value: "Gearbox", label: "Gearbox (not on this track)" });
      expect(car?.options.map((o) => o.value)).not.toContain("Nose");
      expect(track?.options.map((o) => o.value)).not.toContain("TV1");
      expect(section(model, "Car")?.options).toContainEqual({
        value: "LF Susp",
        label: "Suspension - Left Front (not on this track)",
      });
    });

    it("labels other remembered groups with the tracks they were seen on, never this one", () => {
      const model = buildCameraGroupPicker(view, "TV1");

      expect(section(model, PICKER_HEADINGS.remembered)?.options).toEqual([
        { value: "CrankItUp", label: "CrankItUp (seen before)" },
        { value: "Drone", label: "Drone (not on this track: Spa)" },
      ]);
    });

    it("shows a stored name absent from everything as not on this track, and keeps it selected", () => {
      const model = buildCameraGroupPicker(view, "Ghost");

      expect(section(model, PICKER_HEADINGS.stored)?.options).toEqual([
        { value: "Ghost", label: "Ghost (not on this track)" },
      ]);
      expect(model.selected).toBe("Ghost");
    });

    it("selects a stored name the file has in another case, as the press resolves it", () => {
      const model = buildCameraGroupPicker(view, "dynamictv");

      expect(model.selected).toBe("DynamicTV");
      expect(section(model, PICKER_HEADINGS.stored)).toBeUndefined();
    });

    it("selects this track's group over a standard one that differs only in case (#1653 review)", () => {
      // The file names its group `tv1`; the key stores the standard `TV1`, which
      // the press resolves case-insensitively to the session's `tv1`.
      const lowerTv1 = { ...view, current: { trackId: view.current!.trackId, groups: ["tv1", "Nose"] } };
      const model = buildCameraGroupPicker(lowerTv1, "TV1");

      expect(model.selected).toBe("tv1");
    });

    it("lists every name once across the whole picker", () => {
      const values = buildCameraGroupPicker(view, "Ghost").sections.flatMap((s) => s.options.map((o) => o.value));

      expect(new Set(values).size).toBe(values.length);
    });
  });
});

describe("matchCameraGroupName", () => {
  it("prefers the exact spelling, then the one case-insensitive match", () => {
    expect(matchCameraGroupName("Drone", ["drone", "Drone"])).toBe("Drone");
    expect(matchCameraGroupName("DRONE", ["Drone"])).toBe("Drone");
  });

  it("refuses to choose between two names that differ only in case", () => {
    expect(matchCameraGroupName("DRONE", ["Drone", "drone"])).toBeUndefined();
  });
});

describe("resolveTypedCameraGroupName", () => {
  const view = catalog([group("DynamicTV", [0])], { trackId: 2, groups: ["SpeedCam"] });

  it("stores nothing for an empty or blank entry", () => {
    expect(resolveTypedCameraGroupName("   ", view)).toBeNull();
  });

  it("stores a standard name typed in any case as the canonical one", () => {
    expect(resolveTypedCameraGroupName("  tv1 ", view)).toBe("TV1");
    expect(resolveTypedCameraGroupName("pit lane2", view)).toBe("Pit Lane 2");
  });

  it("stores a known custom name in the file's own spelling", () => {
    expect(resolveTypedCameraGroupName("dynamictv", view)).toBe("DynamicTV");
    expect(resolveTypedCameraGroupName("speedcam", view)).toBe("SpeedCam");
  });

  it("stores an unknown name as typed, trimmed", () => {
    expect(resolveTypedCameraGroupName(" My Chicane ", view)).toBe("My Chicane");
  });

  describe("a session name and a remembered one that differ only in case (#1653 review)", () => {
    it("stores the session's one match, not the remembered spelling", () => {
      const view = catalog([group("drone", [0])], { trackId: 2, groups: ["Drone"] });

      expect(resolveTypedCameraGroupName("dRoNe", view)).toBe("Drone");
    });

    it("never lets a remembered name break a tie between two of the session's", () => {
      const view = catalog([group("static", [0])], { trackId: 2, groups: ["Static", "STATIC"] });

      expect(resolveTypedCameraGroupName("sTaTiC", view)).toBe("sTaTiC");
    });

    it("stores a remembered name's spelling when the session has none", () => {
      expect(
        resolveTypedCameraGroupName("DRONE", catalog([group("drone", [0])], { trackId: 2, groups: ["Nose"] })),
      ).toBe("drone");
      expect(resolveTypedCameraGroupName("DRONE", catalog([group("drone", [0])], null))).toBe("drone");
    });
  });

  describe("a session group that differs from a standard one only in case (#1653 review)", () => {
    const twins = catalog([], { trackId: 2, groups: ["TV1", "tv1"] });

    it("stores the session's exact match, with no number", () => {
      expect(resolveTypedCameraGroupName(" tv1 ", twins)).toBe("tv1");
      expect(cameraGroupWrite("tv1")).toEqual({ name: "tv1" });
    });

    it("stores the standard group for its own spelling and for one the session does not list", () => {
      expect(resolveTypedCameraGroupName("TV1", twins)).toBe("TV1");
      expect(resolveTypedCameraGroupName("Tv1", twins)).toBe("TV1");
    });

    it("still stores the standard group, with its number, with no session loaded", () => {
      expect(resolveTypedCameraGroupName("tv1", catalog([], null))).toBe("TV1");
      expect(resolveTypedCameraGroupName("tv1", null)).toBe("TV1");
      expect(cameraGroupWrite("TV1")).toEqual({ name: "TV1", number: "17" });
    });
  });
});

describe("cameraGroupWrite", () => {
  it("writes the name and the number for every standard group", () => {
    for (const option of STANDARD_CAMERA_GROUP_OPTIONS) {
      expect(cameraGroupWrite(option.name)).toEqual({ name: option.name, number: String(option.value) });
    }
  });

  it("writes only the name for a custom group", () => {
    expect(cameraGroupWrite("DynamicTV")).toEqual({ name: "DynamicTV" });
  });
});

describe("buildRememberedGroups", () => {
  it("puts this track's custom groups first in the sim's order, the rest alphabetically and dimmed — 50 on the track", () => {
    // Fifty custom groups in a deliberately non-alphabetical sim order.
    const onTrack = Array.from({ length: 50 }, (_, i) => `Cam${String(50 - i).padStart(2, "0")}`);
    const elsewhere = ["zeta", "Alpha", "mike", "Bravo"];
    const view = catalog(
      [...elsewhere.map((n) => group(n, [0])), ...onTrack.map((n) => group(n, [1])), group("TV1", [0, 1])],
      { trackId: 2, groups: ["Nose", ...onTrack, "TV1"] },
    );

    const entries = buildRememberedGroups(view, {});

    expect(entries.slice(0, 50).map((e) => e.name)).toEqual(onTrack);
    expect(entries.slice(0, 50).every((e) => !e.dimmed)).toBe(true);
    expect(entries.slice(50).map((e) => e.name)).toEqual(["Alpha", "Bravo", "mike", "zeta"]);
    expect(entries.slice(50).every((e) => e.dimmed)).toBe(true);
  });

  it("lists no standard group, whatever the catalog or the subset holds", () => {
    const entries = buildRememberedGroups(catalog([group("TV1", [0]), group("Nose")]), {
      Cockpit: true,
      "Pit Lane2": true,
    });

    expect(entries).toEqual([]);
  });

  it("includes a custom name the stored subset ticks even when the catalog lacks it", () => {
    const entries = buildRememberedGroups(catalog([group("Drone", [0])], { trackId: 2, groups: [] }), {
      Removed: true,
      Unticked: false,
    });

    expect(entries.map((e) => e.name)).toEqual(["Drone", "Removed"]);
    expect(entries.find((e) => e.name === "Removed")?.title).toBe("Not on this track — no longer remembered");
  });

  it("dims nothing with no session, since there is no track to contrast with", () => {
    const entries = buildRememberedGroups(catalog([group("Drone", [0]), group("CrankItUp")]), null);

    expect(entries).toEqual([
      { name: "CrankItUp", dimmed: false, title: "Seen before" },
      { name: "Drone", dimmed: false, title: "Seen on Spa" },
    ]);
  });

  it("lists nothing with no catalog and nothing ticked", () => {
    expect(buildRememberedGroups(null, undefined)).toEqual([]);
  });
});

describe("Select All and Clear on the remembered groups", () => {
  const view = catalog([group("Drone", [0]), group("SpeedCam", [1])], { trackId: 2, groups: ["TV1", "SpeedCam"] });

  it("Select All ticks this track's custom groups and leaves the others as they were", () => {
    const next = selectAllRemembered({ Nose: true, Drone: false, Elsewhere: true }, view);

    expect(next).toEqual({ Nose: true, Drone: false, Elsewhere: true, SpeedCam: true });
  });

  it("Select All adds nothing with no session", () => {
    expect(selectAllRemembered({ Nose: true }, catalog([group("Drone", [0])]))).toEqual({ Nose: true });
  });

  it("Clear drops every custom name and keeps the standard ones for the template to set", () => {
    expect(clearRemembered({ Nose: true, TV1: false, Drone: true, SpeedCam: false })).toEqual({
      Nose: true,
      TV1: false,
    });
  });

  it("returns new maps rather than editing the one it was given", () => {
    const state = { Drone: true };

    clearRemembered(state);
    selectAllRemembered(state, view);

    expect(state).toEqual({ Drone: true });
  });
});

describe("names Object.prototype also uses (#1653): own keys only", () => {
  // A camera file may name a group anything. On a plain object `constructor` and
  // `toString` read as functions, and assigning `__proto__` sets the prototype
  // rather than adding a group.
  const ODD = ["constructor", "__proto__", "toString", "hasOwnProperty"];
  const view = (): CameraCatalogView =>
    parseCameraCatalog(
      JSON.stringify({
        version: 1,
        tracks: TRACKS,
        groups: ODD.map((name) => ({ name, tracks: [0], lastSeen: "" })),
        current: { trackId: 2, groups: ["TV1", "constructor", "__proto__"] },
      }),
    ) as CameraCatalogView;

  it("normalises each to itself", () => {
    for (const name of ODD) expect(normalizeCameraGroupName(name)).toBe(name);
  });

  it("reads them as custom groups, never as standard ones", () => {
    for (const name of ODD) expect(isStandardCameraGroup(name)).toBe(false);

    expect(isCustomCameraFile({ trackId: 1, groups: ["constructor"] })).toBe(true);
  });

  it("parses them from the catalog and the session as names", () => {
    expect(view().groups.map((g) => g.name)).toEqual(ODD);
    expect(view().current?.groups).toEqual(["TV1", "constructor", "__proto__"]);
  });

  it("offers them in the picker and selects a stored one", () => {
    const model = buildCameraGroupPicker(view(), "__proto__");
    const values = model.sections.flatMap((s) => s.options.map((o) => o.value));

    expect(model.sections[0].options.map((o) => o.value)).toEqual(["TV1", "constructor", "__proto__"]);
    expect(values).toContain("toString");
    expect(values).toContain("hasOwnProperty");
    expect(model.selected).toBe("__proto__");
    expect(buildCameraGroupPicker(view(), "constructor").selected).toBe("constructor");
  });

  it("resolves a typed one to itself, and writes only its name", () => {
    expect(resolveTypedCameraGroupName("constructor", view())).toBe("constructor");
    expect(resolveTypedCameraGroupName("__PROTO__", view())).toBe("__proto__");
    expect(cameraGroupWrite("toString")).toEqual({ name: "toString" });
  });

  it("lists them in the grid's Remembered section, ticked as the parsed subset says", () => {
    const subset = JSON.parse('{"__proto__":true,"constructor":true,"toString":false}') as Record<string, unknown>;
    const entries = buildRememberedGroups(view(), subset);

    expect(entries.map((e) => e.name)).toEqual(["constructor", "__proto__", "hasOwnProperty", "toString"]);
  });

  it("lists a ticked one the catalog no longer has", () => {
    const subset = JSON.parse('{"__proto__":true,"valueOf":true}') as Record<string, unknown>;

    expect(buildRememberedGroups(null, subset).map((e) => e.name)).toEqual(["__proto__", "valueOf"]);
  });

  it("Select All adds them as own entries that survive serialisation", () => {
    const next = selectAllRemembered({ Nose: true }, view());

    expect(Object.hasOwn(next, "__proto__")).toBe(true);
    expect(Object.hasOwn(next, "constructor")).toBe(true);
    expect(JSON.parse(JSON.stringify({ groups: next }))).toEqual(
      JSON.parse('{"groups":{"Nose":true,"constructor":true,"__proto__":true}}'),
    );
  });

  it("Select All keeps own entries it was given, `__proto__` included", () => {
    const state = JSON.parse('{"__proto__":false,"Nose":true}') as Record<string, boolean>;
    const next = selectAllRemembered(state, null);

    expect(Object.hasOwn(next, "__proto__")).toBe(true);
    expect(next.__proto__).toBe(false);
  });

  it("Clear drops them, leaving only standard names", () => {
    const state = JSON.parse('{"__proto__":true,"constructor":true,"Nose":true}') as Record<string, boolean>;

    expect(Object.keys(clearRemembered(state))).toEqual(["Nose"]);
  });
});

describe("the names the plugin records (deck-iracing's isRecordableName)", () => {
  it("accepts a name up to the limit, Unicode included", () => {
    expect(isAcceptableCameraGroupName("x".repeat(CAMERA_GROUP_NAME_MAX_LENGTH))).toBe(true);
    expect(isAcceptableCameraGroupName("Ünïcödé 名前")).toBe(true);
  });

  it("refuses a blank, an over-long or a control-character name", () => {
    expect(isAcceptableCameraGroupName("   ")).toBe(false);
    expect(isAcceptableCameraGroupName("x".repeat(CAMERA_GROUP_NAME_MAX_LENGTH + 1))).toBe(false);
    expect(isAcceptableCameraGroupName(`Tab${String.fromCharCode(9)}here`)).toBe(false);
    expect(isAcceptableCameraGroupName(`Del${String.fromCharCode(0x7f)}`)).toBe(false);
    expect(isAcceptableCameraGroupName(5)).toBe(false);
  });

  it("stores no typed name the plugin would not record", () => {
    expect(resolveTypedCameraGroupName("x".repeat(CAMERA_GROUP_NAME_MAX_LENGTH + 1), null)).toBeNull();
    expect(resolveTypedCameraGroupName(`a${String.fromCharCode(10)}b`, null)).toBeNull();
  });

  it("drops such names from a published view", () => {
    const parsed = parseCameraCatalog({
      version: 1,
      tracks: [],
      groups: [
        { name: `bad${String.fromCharCode(1)}` },
        { name: "x".repeat(CAMERA_GROUP_NAME_MAX_LENGTH + 1) },
        { name: "ok" },
      ],
      current: { trackId: 1, groups: [`bad${String.fromCharCode(27)}`, "ok"] },
    });

    expect(parsed?.groups.map((g) => g.name)).toEqual(["ok"]);
    expect(parsed?.current?.groups).toEqual(["ok"]);
  });
});

describe("installCameraGroupHelpers", () => {
  it("exposes the helpers once, and leaves an existing surface alone", () => {
    const win: { irdCameraGroups?: typeof CAMERA_GROUP_HELPERS } = {};

    installCameraGroupHelpers(win);
    expect(win.irdCameraGroups).toBe(CAMERA_GROUP_HELPERS);

    const other = { ...CAMERA_GROUP_HELPERS };

    win.irdCameraGroups = other;
    installCameraGroupHelpers(win);
    expect(win.irdCameraGroups).toBe(other);
  });
});
