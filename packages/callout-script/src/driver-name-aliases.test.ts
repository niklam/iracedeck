import { describe, expect, it } from "vitest";

import {
  DRIVER_NAME_ALIASES,
  DRIVER_NAME_GROUPS,
  resolveDriverNameSlug,
  validateDriverNameAliases,
} from "./driver-name-aliases.js";

describe("DRIVER_NAME_ALIASES (#1580)", () => {
  it("passes every rule", () => {
    expect(validateDriverNameAliases(DRIVER_NAME_ALIASES)).toEqual([]);
  });

  it("holds the three spoken pairs", () => {
    expect(DRIVER_NAME_ALIASES).toEqual({ dominik: "dominic", geoff: "jeff", kris: "chris" });
  });

  it("is sorted by key", () => {
    const keys = Object.keys(DRIVER_NAME_ALIASES);

    expect(keys).toEqual([...keys].sort());
  });

  it("is frozen, as is the group list", () => {
    expect(Object.isFrozen(DRIVER_NAME_ALIASES)).toBe(true);
    expect(Object.isFrozen(DRIVER_NAME_GROUPS)).toBe(true);
  });
});

describe("DRIVER_NAME_GROUPS (#1580)", () => {
  it("names the names group first and the four greeting groups", () => {
    expect(DRIVER_NAME_GROUPS).toEqual([
      "names",
      "session-start-greeting",
      "race-start-greeting",
      "race-end-greeting",
      "position-overtake-come-on",
    ]);
  });
});

describe("validateDriverNameAliases (#1580)", () => {
  it("accepts slugs with digits and single hyphens", () => {
    expect(validateDriverNameAliases({ "jean-luc": "jean-luc-2", r2d2: "artoo" })).toEqual([]);
  });

  it.each([
    ["an uppercase alias", { Geoff: "jeff" }, "Geoff: the alias is not a name slug"],
    ["a doubled hyphen", { "a--b": "ab" }, "a--b: the alias is not a name slug"],
    ["a trailing hyphen", { "ab-": "ab" }, "ab-: the alias is not a name slug"],
    ["a non-ASCII letter", { jørgen: "jurgen" }, "jørgen: the alias is not a name slug"],
    ["an empty alias", { "": "jeff" }, ": the alias is not a name slug"],
    ["a non-slug canonical", { geoff: "Jeff" }, 'geoff: the canonical "Jeff" is not a name slug'],
    ["a take suffix on the alias", { "geoff-01": "jeff" }, "geoff-01: the alias ends in a take suffix"],
    ["a take suffix on the canonical", { geoff: "jeff-01" }, 'geoff: the canonical "jeff-01" ends in a take suffix'],
    ["an alias equal to its canonical", { jeff: "jeff" }, "jeff: an alias cannot be its own canonical"],
  ])("refuses %s", (_label, map, expected) => {
    const problems = validateDriverNameAliases(map);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(expected);
  });

  it("refuses a chain once from each side, naming each broken entry once", () => {
    // `geoff → jeff → jeffrey`: `geoff`'s canonical is itself a key (a second
    // hop), and `jeff` is an alias that is also `geoff`'s canonical.
    const problems = validateDriverNameAliases({ geoff: "jeff", jeff: "jeffrey" });

    expect(problems).toEqual([
      'geoff: its canonical "jeff" is itself an alias (of "jeffrey"); resolution is one hop, so name the final canonical',
      'jeff: is the canonical of "geoff", so it cannot be an alias',
    ]);
  });

  it("names every alias whose canonical is an alias", () => {
    const problems = validateDriverNameAliases({ geoff: "jeff", jef: "jeff", jeff: "jeffrey" });

    expect(problems).toHaveLength(3);
    expect(problems[2]).toBe('jeff: is the canonical of "geoff", "jef", so it cannot be an alias');
  });

  it("reports one problem per broken entry and none for the sound ones", () => {
    const problems = validateDriverNameAliases({ dominik: "dominic", "kris-01": "chris", tom: "tom", geoff: "Jeff" });

    expect(problems.map((problem) => problem.split(":")[0])).toEqual(["kris-01", "tom", "geoff"]);
  });

  it("does not take a self-alias for a chain", () => {
    expect(validateDriverNameAliases({ jeff: "jeff" })).toEqual(["jeff: an alias cannot be its own canonical"]);
  });
});

describe("resolveDriverNameSlug (#1580)", () => {
  const aliases = { geoff: "jeff" };

  it("returns the spelling when the voice records it, even when it is an alias", () => {
    expect(resolveDriverNameSlug("geoff", new Set(["geoff", "jeff"]), aliases)).toBe("geoff");
  });

  it("returns the canonical when the voice records only that", () => {
    expect(resolveDriverNameSlug("geoff", new Set(["jeff"]), aliases)).toBe("jeff");
  });

  it("returns null when the voice records neither", () => {
    expect(resolveDriverNameSlug("geoff", new Set(["adam"]), aliases)).toBeNull();
  });

  it("returns null for an unrecorded name that is no alias", () => {
    expect(resolveDriverNameSlug("adam", new Set(["jeff"]), aliases)).toBeNull();
  });

  it("returns the spelling for a recorded name that is no alias", () => {
    expect(resolveDriverNameSlug("jeff", new Set(["jeff"]), aliases)).toBe("jeff");
  });

  it("does not read the map's prototype", () => {
    expect(resolveDriverNameSlug("constructor", new Set(["jeff"]), aliases)).toBeNull();
  });

  it("uses DRIVER_NAME_ALIASES by default", () => {
    expect(resolveDriverNameSlug("dominik", new Set(["dominic"]))).toBe("dominic");
    expect(resolveDriverNameSlug("kris", new Set(["chris"]))).toBe("chris");
    expect(resolveDriverNameSlug("geoff", new Set(["jeff"]))).toBe("jeff");
  });
});
