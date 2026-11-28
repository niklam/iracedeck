import type { CameraGroup } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import {
  AUTO_GROUP_DEFAULT_GROUPS,
  autoGroupCandidates,
  autoGroupNames,
  AutoGroupPickField,
  AutoGroupSubsetField,
  isAutoGroupUnavailable,
  pickAutoGroup,
} from "./auto-group-pick.js";

/** A session's groups in the sim's order, numbered from 1 as the sim numbers them. */
function session(...names: string[]): CameraGroup[] {
  return names.map((groupName, i) => ({ groupNum: i + 1, groupName }));
}

const TRACK = session("Nose", "Cockpit", "TV1", "TV2", "TV3", "Chase");

function groupNum(groups: CameraGroup[], name: string): number {
  const found = groups.find((g) => g.groupName === name);

  if (!found) throw new Error(`no ${name}`);

  return found.groupNum;
}

describe("auto group settings fields", () => {
  it("default to TV1, TV2 and TV3, picked in order", () => {
    expect(AUTO_GROUP_DEFAULT_GROUPS).toEqual(["TV1", "TV2", "TV3"]);
    expect(autoGroupNames(AutoGroupSubsetField.parse(undefined))).toEqual(["TV1", "TV2", "TV3"]);
    expect(AutoGroupPickField.parse(undefined)).toBe("in-order");
  });

  it("read junk in either field as the default", () => {
    for (const junk of [42, true, null, ["TV1"]]) {
      expect(autoGroupNames(AutoGroupSubsetField.parse(junk))).toEqual(["TV1", "TV2", "TV3"]);
    }

    for (const junk of ["not json", '{"groups":"TV1"}', { groups: ["TV1"] }, { groups: null }]) {
      expect(autoGroupNames(AutoGroupSubsetField.parse(junk))).toEqual(["TV1", "TV2", "TV3"]);
    }

    for (const junk of ["sideways", 3, null, {}]) {
      expect(AutoGroupPickField.parse(junk)).toBe("in-order");
    }
  });

  it("keep a stored list, as an object or as JSON, with its names canonically spelled", () => {
    expect(autoGroupNames({ groups: { Chase: true, TV1: false, Blimp: true } })).toEqual(["Chase", "Blimp"]);
    expect(autoGroupNames(JSON.stringify({ groups: { Cockpit: true } }))).toEqual(["Cockpit"]);
    expect(AutoGroupPickField.parse("random")).toBe("random");
  });

  it("keep a list with nothing ticked as empty, never the default", () => {
    expect(autoGroupNames({ groups: { TV1: false, TV2: false } })).toEqual([]);
    expect(autoGroupNames({ groups: {} })).toEqual([]);
  });
});

describe("autoGroupCandidates", () => {
  it("keeps the session's order, not the list's, and skips the names the track lacks", () => {
    const result = autoGroupCandidates(["TV3", "Blimp", "Nose", "TV1"], TRACK);

    expect(result.groups.map((g) => g.groupName)).toEqual(["Nose", "TV1", "TV3"]);
    expect(result.missing).toEqual(["Blimp"]);
    expect(result.ambiguous).toEqual([]);
  });

  it("matches a name in another case, and reports one that matches several groups", () => {
    const custom = session("DynamicTV", "Pit", "PIT");
    const result = autoGroupCandidates(["dynamictv", "pit", "PIT"], custom);

    expect(result.groups.map((g) => g.groupName)).toEqual(["DynamicTV", "PIT"]);
    expect(result.ambiguous).toEqual(["pit"]);
    expect(result.missing).toEqual([]);
  });
});

describe("isAutoGroupUnavailable", () => {
  it("is unavailable while a session is loaded and no ticked name is in it", () => {
    expect(isAutoGroupUnavailable(["Blimp"], TRACK)).toBe(true);
  });

  it("counts an empty list as no candidates", () => {
    expect(isAutoGroupUnavailable([], TRACK)).toBe(true);
  });

  it("is available when one ticked name is in the session", () => {
    expect(isAutoGroupUnavailable(["Blimp", "TV2"], TRACK)).toBe(false);
  });

  it("is never unavailable with no session's groups to judge by", () => {
    expect(isAutoGroupUnavailable([], [])).toBe(false);
    expect(isAutoGroupUnavailable(["Blimp"], [])).toBe(false);
  });
});

describe("pickAutoGroup", () => {
  const tvs = autoGroupCandidates(["TV1", "TV2", "TV3"], TRACK).groups;
  const tv1 = groupNum(TRACK, "TV1");
  const tv2 = groupNum(TRACK, "TV2");
  const tv3 = groupNum(TRACK, "TV3");
  const nose = groupNum(TRACK, "Nose");

  describe("no candidates and one candidate (spec decision 5)", () => {
    it("sends nothing with no candidates, either pick", () => {
      expect(pickAutoGroup([], nose, "in-order", null)).toBeNull();
      expect(pickAutoGroup([], nose, "random", null, () => 0)).toBeNull();
    });

    it("switches to the one candidate when the camera is elsewhere, either pick", () => {
      const one = autoGroupCandidates(["TV2"], TRACK).groups;

      expect(pickAutoGroup(one, nose, "in-order", null)?.groupName).toBe("TV2");
      expect(pickAutoGroup(one, nose, "in-order", "TV2")?.groupName).toBe("TV2");
      expect(pickAutoGroup(one, nose, "random", null, () => 0.99)?.groupName).toBe("TV2");
    });

    it("sends nothing when the camera is already in the one candidate, either pick", () => {
      const one = autoGroupCandidates(["TV2"], TRACK).groups;

      expect(pickAutoGroup(one, tv2, "in-order", null)).toBeNull();
      expect(pickAutoGroup(one, tv2, "in-order", "TV2")).toBeNull();
      expect(pickAutoGroup(one, tv2, "random", null, () => 0)).toBeNull();
    });
  });

  describe("in order", () => {
    it("starts at the first candidate", () => {
      expect(pickAutoGroup(tvs, nose, "in-order", null)?.groupName).toBe("TV1");
    });

    it("steps from the last pick and wraps at the end", () => {
      expect(pickAutoGroup(tvs, nose, "in-order", "TV1")?.groupName).toBe("TV2");
      expect(pickAutoGroup(tvs, nose, "in-order", "TV2")?.groupName).toBe("TV3");
      expect(pickAutoGroup(tvs, nose, "in-order", "TV3")?.groupName).toBe("TV1");
    });

    it("walks a whole cycle from a camera that moves on with each pick", () => {
      const picked: string[] = [];
      let last: string | null = null;
      let current = nose;

      for (let i = 0; i < 6; i++) {
        const next = pickAutoGroup(tvs, current, "in-order", last);

        if (next === null) throw new Error("nothing picked");

        picked.push(next.groupName);
        last = next.groupName;
        current = next.groupNum;
      }

      expect(picked).toEqual(["TV1", "TV2", "TV3", "TV1", "TV2", "TV3"]);
    });

    it("steps once more when the next candidate is the camera's group", () => {
      expect(pickAutoGroup(tvs, tv1, "in-order", null)?.groupName).toBe("TV2");
      expect(pickAutoGroup(tvs, tv2, "in-order", "TV1")?.groupName).toBe("TV3");
      expect(pickAutoGroup(tvs, tv1, "in-order", "TV3")?.groupName).toBe("TV2");
    });

    it("never repeats the camera's group with two or more candidates", () => {
      const two = autoGroupCandidates(["TV1", "TV3"], TRACK).groups;

      for (const current of [tv1, tv3, nose]) {
        for (const last of [null, "TV1", "TV3", "Gone"]) {
          const next = pickAutoGroup(two, current, "in-order", last);

          expect(next).not.toBeNull();
          expect(next?.groupNum).not.toBe(current);
        }
      }
    });

    it("finds the last pick by name, so a session that numbers the groups differently carries on", () => {
      const renumbered = session("TV3", "Chase", "TV2", "TV1");
      const candidates = autoGroupCandidates(["TV1", "TV2", "TV3"], renumbered).groups;

      // Session order is TV3, TV2, TV1: after TV2 comes TV1.
      expect(pickAutoGroup(candidates, groupNum(renumbered, "Chase"), "in-order", "TV2")?.groupName).toBe("TV1");
    });

    it("finds the last pick in another case", () => {
      const custom = session("DynamicTV", "Static");
      const candidates = autoGroupCandidates(["DynamicTV", "Static"], custom).groups;

      expect(pickAutoGroup(candidates, null, "in-order", "dynamictv")?.groupName).toBe("Static");
    });

    it("starts over when the last pick matches two candidates only in case, and takes an exact match over them", () => {
      // Two groups differing only in case, each ticked by its own spelling, so both are candidates.
      const custom = session("Pit", "PIT", "Static");
      const candidates = autoGroupCandidates(["Pit", "PIT", "Static"], custom).groups;

      expect(candidates.map((g) => g.groupName)).toEqual(["Pit", "PIT", "Static"]);
      // "pit" cannot say which was picked: In order starts at the first candidate.
      expect(pickAutoGroup(candidates, groupNum(custom, "Static"), "in-order", "pit")?.groupName).toBe("Pit");
      // An exact spelling still finds its own.
      expect(pickAutoGroup(candidates, null, "in-order", "Pit")?.groupName).toBe("PIT");
      expect(pickAutoGroup(candidates, null, "in-order", "PIT")?.groupName).toBe("Static");
    });

    it("starts over at the first candidate when the last pick is no longer one", () => {
      expect(pickAutoGroup(tvs, nose, "in-order", "Blimp")?.groupName).toBe("TV1");
    });

    it("skips names the track lacks", () => {
      const candidates = autoGroupCandidates(["TV1", "Blimp", "TV3"], TRACK).groups;

      expect(pickAutoGroup(candidates, nose, "in-order", "TV1")?.groupName).toBe("TV3");
      expect(pickAutoGroup(candidates, nose, "in-order", "TV3")?.groupName).toBe("TV1");
    });

    it("picks from an unknown camera group as from any other", () => {
      expect(pickAutoGroup(tvs, null, "in-order", null)?.groupName).toBe("TV1");
    });
  });

  describe("random", () => {
    it("picks uniformly from the candidates other than the camera's group", () => {
      // The camera is in TV2: the others are TV1 and TV3, half of [0, 1) each.
      expect(pickAutoGroup(tvs, tv2, "random", null, () => 0)?.groupName).toBe("TV1");
      expect(pickAutoGroup(tvs, tv2, "random", null, () => 0.49)?.groupName).toBe("TV1");
      expect(pickAutoGroup(tvs, tv2, "random", null, () => 0.5)?.groupName).toBe("TV3");
      expect(pickAutoGroup(tvs, tv2, "random", null, () => 0.999)?.groupName).toBe("TV3");
    });

    it("picks from every candidate when the camera is in none of them", () => {
      expect(pickAutoGroup(tvs, nose, "random", null, () => 0)?.groupName).toBe("TV1");
      expect(pickAutoGroup(tvs, nose, "random", null, () => 0.4)?.groupName).toBe("TV2");
      expect(pickAutoGroup(tvs, nose, "random", null, () => 0.7)?.groupName).toBe("TV3");
    });

    it("always picks one of the other candidates with two or more, whatever the draw", () => {
      for (const current of [tv1, tv2, tv3]) {
        const others = tvs.filter((g) => g.groupNum !== current).map((g) => g.groupNum);

        for (let draw = 0; draw < 1; draw += 0.05) {
          const picked = pickAutoGroup(tvs, current, "random", null, () => draw);

          // A null pick fails here too: another group is always available.
          expect(others).toContain(picked?.groupNum);
        }
      }
    });

    it("stays in range for a draw at or past the ends", () => {
      expect(pickAutoGroup(tvs, tv2, "random", null, () => 1)?.groupName).toBe("TV3");
      expect(pickAutoGroup(tvs, tv2, "random", null, () => -0.5)?.groupName).toBe("TV1");
    });

    it("ignores the last pick", () => {
      expect(pickAutoGroup(tvs, nose, "random", "TV1", () => 0)?.groupName).toBe("TV1");
    });
  });
});
