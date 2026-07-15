import { describe, expect, it } from "vitest";

import {
  computeCameraCarousel,
  computeSubCameraCarousel,
  getNextSelectedGroup,
  parseGroupSubset,
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
