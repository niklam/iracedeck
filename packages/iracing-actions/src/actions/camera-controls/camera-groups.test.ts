import { describe, expect, it } from "vitest";

import { computeCameraCarousel, getNextSelectedGroup, parseGroupSubset } from "./camera-groups.js";

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
