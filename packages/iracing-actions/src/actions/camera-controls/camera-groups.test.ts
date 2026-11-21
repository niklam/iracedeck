import { describe, expect, it } from "vitest";

import {
  computeCameraCarousel,
  computeSubCameraCarousel,
  findSessionGroupByName,
  findSessionGroupByNum,
  getNextSelectedGroup,
  getNextSelectedGroupEntry,
  matchSessionGroup,
  normalizeGroupName,
  normalizeSessionGroups,
  parseGroupSubset,
  resolveEnabledSessionGroups,
} from "./camera-groups.js";

const SESSION_GROUPS = [
  { groupNum: 1, groupName: "Nose" },
  { groupNum: 9, groupName: "Cockpit" },
  { groupNum: 12, groupName: "Chase" },
  { groupNum: 17, groupName: "TV1" },
];

describe("parseGroupSubset", () => {
  it("returns the enabled names from a JSON string", () => {
    expect(parseGroupSubset(JSON.stringify({ groups: { Nose: true, Cockpit: false, Chase: true } }))).toEqual([
      "Nose",
      "Chase",
    ]);
  });

  it("returns undefined for a missing / unparseable value", () => {
    expect(parseGroupSubset(undefined)).toBeUndefined();
    expect(parseGroupSubset("not json")).toBeUndefined();
    expect(parseGroupSubset({})).toBeUndefined();
  });

  it("rejects malformed groups shapes instead of reading them as valid subsets", () => {
    // A string would otherwise yield numeric character keys via Object.entries,
    // silently disabling every camera instead of falling back.
    expect(parseGroupSubset({ groups: "Nose" })).toBeUndefined();
    expect(parseGroupSubset({ groups: ["Nose", "Chase"] })).toBeUndefined();
    expect(parseGroupSubset({ groups: 5 })).toBeUndefined();
    expect(parseGroupSubset(JSON.stringify({ groups: "Nose" }))).toBeUndefined();
  });

  it("only counts strict-true values as enabled", () => {
    expect(parseGroupSubset({ groups: { Nose: true, Cockpit: "true", Chase: 1, TV1: false } })).toEqual(["Nose"]);
  });

  it("keeps an all-disabled map distinct from a malformed one", () => {
    // {} and all-false are VALID subsets (nothing enabled) — not a fallback.
    expect(parseGroupSubset({ groups: {} })).toEqual([]);
    expect(parseGroupSubset({ groups: { Nose: false } })).toEqual([]);
  });
});

describe("computeCameraCarousel", () => {
  const enabled = ["Nose", "Cockpit", "Chase", "TV1"];

  it("resolves the current group and the enabled-subset neighbours", () => {
    const carousel = computeCameraCarousel(9, enabled, SESSION_GROUPS);

    expect(carousel.current?.groupName).toBe("Cockpit");
    expect(carousel.prev?.groupName).toBe("Nose");
    expect(carousel.next?.groupName).toBe("Chase");
  });

  it("wraps at the ends of the enabled subset", () => {
    // Current = TV1 (last enabled): next wraps to the first (Nose), prev is Chase.
    const carousel = computeCameraCarousel(17, enabled, SESSION_GROUPS);

    expect(carousel.next?.groupName).toBe("Nose");
    expect(carousel.prev?.groupName).toBe("Chase");
  });

  it("still renders the current group when it is outside the enabled subset", () => {
    // Cockpit is the active group but NOT enabled — current resolves, and the
    // neighbours are the enabled groups straddling group 9 (Nose < 9 < Chase).
    const enabledExclCurrent = ["Nose", "Chase", "TV1"];
    const carousel = computeCameraCarousel(9, enabledExclCurrent, SESSION_GROUPS);

    expect(carousel.current?.groupName).toBe("Cockpit");
    expect(carousel.next?.groupName).toBe("Chase");
    expect(carousel.prev?.groupName).toBe("Nose");
  });

  it("returns null neighbours when the enabled subset is empty", () => {
    const carousel = computeCameraCarousel(9, [], SESSION_GROUPS);

    expect(carousel.current?.groupName).toBe("Cockpit");
    expect(carousel.prev).toBeNull();
    expect(carousel.next).toBeNull();
  });

  it("shares the wrap logic with getNextSelectedGroup", () => {
    const carousel = computeCameraCarousel(17, enabled, SESSION_GROUPS);

    expect(carousel.next?.groupNum).toBe(getNextSelectedGroup(17, enabled, SESSION_GROUPS, 1));
    expect(carousel.prev?.groupNum).toBe(getNextSelectedGroup(17, enabled, SESSION_GROUPS, -1));
  });
});

describe("computeSubCameraCarousel", () => {
  // Deliberately UNSORTED input to prove the helper orders by cameraNum.
  const CAMERAS = [
    { cameraNum: 2, cameraName: "Roll Bar" },
    { cameraNum: 1, cameraName: "Cockpit" },
    { cameraNum: 3, cameraName: "Gyro" },
  ];

  it("resolves the current camera and its ascending-cameraNum neighbours", () => {
    const carousel = computeSubCameraCarousel(2, CAMERAS);

    expect(carousel.current?.cameraName).toBe("Roll Bar");
    expect(carousel.prev?.cameraName).toBe("Cockpit"); // cameraNum 1
    expect(carousel.next?.cameraName).toBe("Gyro"); // cameraNum 3
  });

  it("wraps at the ends of the camera list", () => {
    // Current = last camera (cameraNum 3): next wraps to the first (cameraNum 1),
    // prev is cameraNum 2.
    const carousel = computeSubCameraCarousel(3, CAMERAS);

    expect(carousel.current?.cameraName).toBe("Gyro");
    expect(carousel.next?.cameraName).toBe("Cockpit");
    expect(carousel.prev?.cameraName).toBe("Roll Bar");

    // First camera (cameraNum 1): prev wraps to the last (cameraNum 3).
    const first = computeSubCameraCarousel(1, CAMERAS);

    expect(first.prev?.cameraName).toBe("Gyro");
    expect(first.next?.cameraName).toBe("Roll Bar");
  });

  it("shows a single-camera group as current only (no neighbours)", () => {
    const carousel = computeSubCameraCarousel(1, [{ cameraNum: 1, cameraName: "CamNose" }]);

    expect(carousel.current?.cameraName).toBe("CamNose");
    expect(carousel.prev).toBeNull();
    expect(carousel.next).toBeNull();
  });

  it("returns all-null for an empty camera list", () => {
    expect(computeSubCameraCarousel(1, [])).toEqual({ current: null, prev: null, next: null });
  });

  it("recovers to the list ends when the focused camera number is not in the list", () => {
    // The active CamCameraNumber (5) is not a member of the group's Cameras[] —
    // this is the Scenic-group reality (issue #803): a large multi-camera group
    // whose current camera number the carousel can't anchor on. Rather than
    // returning null neighbours (which made the dispatch fall back to a synthetic
    // cameraNum ± 1 that iRacing rejects → the sub-camera no-op), re-enter the
    // list at its natural end: next → first camera, previous → last camera.
    const carousel = computeSubCameraCarousel(5, CAMERAS);

    expect(carousel.current).toBeNull();
    expect(carousel.next?.cameraName).toBe("Cockpit"); // first camera (cameraNum 1)
    expect(carousel.prev?.cameraName).toBe("Gyro"); // last camera (cameraNum 3)
  });

  it("recovers to the sole camera's end even for a single-camera group with an unmatched current", () => {
    // Degenerate: current camera not the sole listed one. Still recover to a real
    // camera rather than leaving the dispatch with nothing to target.
    const carousel = computeSubCameraCarousel(9, [{ cameraNum: 4, cameraName: "Only" }]);

    expect(carousel.current).toBeNull();
    expect(carousel.next?.cameraName).toBe("Only");
    expect(carousel.prev?.cameraName).toBe("Only");
  });
});

describe("camera group name normalisation (#958)", () => {
  // One capture of 75 reports "Pit Lane2"; every other says "Pit Lane 2".
  const PIT_LANE2_SESSION = [
    { groupNum: 19, groupName: "Pit Lane" },
    { groupNum: 20, groupName: "Pit Lane2" },
    { groupNum: 24, groupName: "Spotter" },
  ];

  it("maps the known variant to its canonical name and leaves every other name alone", () => {
    expect(normalizeGroupName("Pit Lane2")).toBe("Pit Lane 2");
    expect(normalizeGroupName("Pit Lane 2")).toBe("Pit Lane 2");
    expect(normalizeGroupName("TV Static")).toBe("TV Static");
  });

  it("canonicalises the session's group names once, keeping the sim's numbers", () => {
    expect(normalizeSessionGroups(PIT_LANE2_SESSION)).toEqual([
      { groupNum: 19, groupName: "Pit Lane" },
      { groupNum: 20, groupName: "Pit Lane 2" },
      { groupNum: 24, groupName: "Spotter" },
    ]);
  });

  it("finds a normalised session group by name, whichever spelling is asked for", () => {
    const session = normalizeSessionGroups(PIT_LANE2_SESSION);

    expect(findSessionGroupByName(session, "Pit Lane 2")?.groupNum).toBe(20);
    expect(findSessionGroupByName(session, "Pit Lane2")?.groupNum).toBe(20);
    expect(findSessionGroupByName(session, "Spotter")?.groupNum).toBe(24);
  });

  it("returns undefined for a group the session does not have", () => {
    expect(findSessionGroupByName(normalizeSessionGroups(PIT_LANE2_SESSION), "TV4")).toBeUndefined();
  });

  it("finds a session group by the sim's number, or null", () => {
    expect(findSessionGroupByNum(PIT_LANE2_SESSION, 24)?.groupName).toBe("Spotter");
    expect(findSessionGroupByNum(PIT_LANE2_SESSION, 7)).toBeNull();
  });

  it("cycles into a session group the sim spells differently from the enabled name", () => {
    expect(getNextSelectedGroup(19, ["Pit Lane 2"], normalizeSessionGroups(PIT_LANE2_SESSION), 1)).toBe(20);
  });
});

// A broadcaster-style camera file (#1653): custom names beside standard ones,
// in the sim's own numbering.
const CUSTOM_SESSION = normalizeSessionGroups([
  { groupNum: 1, groupName: "Nose" },
  { groupNum: 2, groupName: "DynamicTV" },
  { groupNum: 3, groupName: "Grid_Pole" },
  { groupNum: 4, groupName: "TV1" },
  { groupNum: 5, groupName: "SpeedCam" },
  { groupNum: 6, groupName: "Pit Lane2" },
]);

describe("matchSessionGroup (#1653)", () => {
  it("finds a custom group by its exact name", () => {
    expect(matchSessionGroup(CUSTOM_SESSION, "DynamicTV")).toEqual({
      kind: "found",
      group: { groupNum: 2, groupName: "DynamicTV" },
    });
  });

  it("finds a typed name in another case when only one group matches it", () => {
    expect(matchSessionGroup(CUSTOM_SESSION, "dynamictv")).toEqual({
      kind: "found",
      group: { groupNum: 2, groupName: "DynamicTV" },
    });
    expect(matchSessionGroup(CUSTOM_SESSION, "GRID_POLE")).toMatchObject({ kind: "found", group: { groupNum: 3 } });
  });

  it("reports a name the session does not have as absent", () => {
    expect(matchSessionGroup(CUSTOM_SESSION, "Drone")).toEqual({ kind: "absent" });
    expect(matchSessionGroup([], "Nose")).toEqual({ kind: "absent" });
  });

  it("lets the exact match decide between groups that differ only in case", () => {
    const session = [
      { groupNum: 7, groupName: "Static" },
      { groupNum: 8, groupName: "STATIC" },
    ];

    expect(matchSessionGroup(session, "STATIC")).toMatchObject({ kind: "found", group: { groupNum: 8 } });
    expect(matchSessionGroup(session, "Static")).toMatchObject({ kind: "found", group: { groupNum: 7 } });
  });

  it("reports a case-insensitive name that matches several groups as ambiguous", () => {
    const session = [
      { groupNum: 7, groupName: "Static" },
      { groupNum: 8, groupName: "STATIC" },
    ];

    expect(matchSessionGroup(session, "static")).toEqual({ kind: "ambiguous", candidates: session });
  });

  it("matches Pit Lane2 to Pit Lane 2 in every spelling, and in any case", () => {
    expect(matchSessionGroup(CUSTOM_SESSION, "Pit Lane 2")).toMatchObject({ kind: "found", group: { groupNum: 6 } });
    expect(matchSessionGroup(CUSTOM_SESSION, "Pit Lane2")).toMatchObject({ kind: "found", group: { groupNum: 6 } });
    expect(matchSessionGroup(CUSTOM_SESSION, "pit lane2")).toMatchObject({ kind: "found", group: { groupNum: 6 } });
    expect(matchSessionGroup(CUSTOM_SESSION, "PIT LANE 2")).toMatchObject({ kind: "found", group: { groupNum: 6 } });
  });

  it("never finds an ambiguous name through findSessionGroupByName", () => {
    const session = [
      { groupNum: 7, groupName: "Static" },
      { groupNum: 8, groupName: "STATIC" },
    ];

    expect(findSessionGroupByName(session, "static")).toBeUndefined();
    expect(findSessionGroupByName(CUSTOM_SESSION, "speedcam")?.groupNum).toBe(5);
  });
});

describe("resolveEnabledSessionGroups (#1653)", () => {
  it("resolves enabled names the session has, in any case, in the session's order", () => {
    expect(resolveEnabledSessionGroups(["SpeedCam", "nose", "Drone", "dynamictv"], CUSTOM_SESSION)).toEqual({
      groups: [
        { groupNum: 1, groupName: "Nose" },
        { groupNum: 2, groupName: "DynamicTV" },
        { groupNum: 5, groupName: "SpeedCam" },
      ],
      ambiguous: [],
    });
  });

  it("yields a group once when two enabled names resolve to it", () => {
    expect(resolveEnabledSessionGroups(["TV1", "tv1"], CUSTOM_SESSION).groups).toEqual([
      { groupNum: 4, groupName: "TV1" },
    ]);
  });

  it("skips an ambiguous name and reports it", () => {
    const session = [
      { groupNum: 7, groupName: "Static" },
      { groupNum: 8, groupName: "STATIC" },
      { groupNum: 9, groupName: "Chase" },
    ];

    expect(resolveEnabledSessionGroups(["static", "Chase"], session)).toEqual({
      groups: [{ groupNum: 9, groupName: "Chase" }],
      ambiguous: ["static"],
    });
  });

  it("resolves a subset's Pit Lane2 against a session's Pit Lane2", () => {
    expect(resolveEnabledSessionGroups(["Pit Lane2"], CUSTOM_SESSION).groups).toEqual([
      { groupNum: 6, groupName: "Pit Lane 2" },
    ]);
  });
});

describe("Cycle Camera's walk over custom groups (#1653)", () => {
  it("cycles through custom groups the subset names, in any case", () => {
    const enabled = ["DynamicTV", "speedcam"];

    expect(getNextSelectedGroupEntry(1, enabled, CUSTOM_SESSION, 1)?.groupName).toBe("DynamicTV");
    expect(getNextSelectedGroupEntry(2, enabled, CUSTOM_SESSION, 1)?.groupName).toBe("SpeedCam");
    expect(getNextSelectedGroupEntry(5, enabled, CUSTOM_SESSION, 1)?.groupName).toBe("DynamicTV");
  });

  it("finds no group when the subset names only groups another track has", () => {
    expect(getNextSelectedGroupEntry(1, ["Drone", "Spotter"], CUSTOM_SESSION, 1)).toBeNull();
  });

  it("previews the dial carousel's neighbours through the same lookup", () => {
    const carousel = computeCameraCarousel(4, ["dynamictv", "SpeedCam"], CUSTOM_SESSION);

    expect(carousel.current?.groupName).toBe("TV1");
    expect(carousel.prev?.groupName).toBe("DynamicTV");
    expect(carousel.next?.groupName).toBe("SpeedCam");
  });
});
