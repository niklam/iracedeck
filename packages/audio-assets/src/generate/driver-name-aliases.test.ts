import { DRIVER_NAME_ALIASES, DRIVER_NAME_GROUPS } from "@iracedeck/callout-script";
import { describe, expect, it } from "vitest";

import type { Entry } from "./config.ts";
import { describeDriverNameAlias, driverNameAliasOf, findDriverNameAliasEntries } from "./driver-name-aliases.ts";

const entry = (name: string, text = "Jeff"): Entry => ({ name, text }) as Entry;

describe("driverNameAliasOf (#1580)", () => {
  it.each(DRIVER_NAME_GROUPS)("names the canonical of an alias entry in %s", (group) => {
    expect(driverNameAliasOf(group, "geoff")).toBe("jeff");
  });

  it("reads a take as its base, as the engine does", () => {
    expect(driverNameAliasOf("names", "kris-01")).toBe("chris");
  });

  it("passes a canonical and any other name", () => {
    expect(driverNameAliasOf("names", "jeff")).toBeNull();
    expect(driverNameAliasOf("names", "niklas")).toBeNull();
  });

  it("passes an alias spelling outside the driver-name groups", () => {
    expect(driverNameAliasOf("corner-names", "geoff")).toBeNull();
    expect(driverNameAliasOf("acknowledgment", "kris")).toBeNull();
  });

  it("does not read the map's prototype", () => {
    expect(driverNameAliasOf("names", "constructor")).toBeNull();
  });

  it("takes the map to check against", () => {
    expect(driverNameAliasOf("names", "jon", { jon: "john" })).toBe("john");
    expect(driverNameAliasOf("names", "geoff", { jon: "john" })).toBeNull();
  });

  it("refuses every alias of the committed map", () => {
    for (const [alias, canonical] of Object.entries(DRIVER_NAME_ALIASES)) {
      expect(driverNameAliasOf("names", alias)).toBe(canonical);
    }
  });
});

describe("findDriverNameAliasEntries (#1580)", () => {
  it("lists each alias entry in each driver-name group, and nothing else", () => {
    const voice = {
      groups: {
        names: [entry("jeff"), entry("geoff")],
        "race-end-greeting": [entry("dominik-02", "Dominik,")],
        "corner-names": [entry("kris")],
        acknowledgment: [entry("geoff")],
      },
    };

    expect(findDriverNameAliasEntries(voice)).toEqual([
      { group: "names", name: "geoff", canonical: "jeff" },
      { group: "race-end-greeting", name: "dominik-02", canonical: "dominic" },
    ]);
  });

  it("finds nothing in a voice without the groups", () => {
    expect(findDriverNameAliasEntries({ groups: {} })).toEqual([]);
  });
});

describe("describeDriverNameAlias (#1580)", () => {
  it("names the alias, its canonical and the fix", () => {
    expect(describeDriverNameAlias("geoff-01", "jeff")).toBe(
      '"geoff" is a driver-name alias of "jeff" and plays its clips — record "jeff" instead and remove this entry',
    );
  });
});
