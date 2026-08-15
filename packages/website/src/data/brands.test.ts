import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BRANDS, brandsFor, type Ecosystem, ECOSYSTEMS, hasIncompleteList, toSentenceList } from "./brands.js";

const dataDir = dirname(fileURLToPath(import.meta.url));
const brandAssetsDir = join(dataDir, "..", "assets", "brands");

const ecosystemKeys = Object.keys(ECOSYSTEMS) as Ecosystem[];

describe("brandsFor", () => {
  it("returns only the brands of the requested ecosystem", () => {
    const result = brandsFor("elgato");

    expect(result.length).toBeGreaterThan(0);
    expect(result.every((brand) => brand.ecosystem === "elgato")).toBe(true);
  });

  it("accepts several ecosystems and keeps the requested ecosystem order", () => {
    const result = brandsFor(["ulanzi", "elgato"]);
    const ecosystemsInOrder = result.map((brand) => brand.ecosystem);
    const firstElgato = ecosystemsInOrder.indexOf("elgato");
    const lastUlanzi = ecosystemsInOrder.lastIndexOf("ulanzi");

    expect(lastUlanzi).toBeLessThan(firstElgato);
  });

  it("preserves the declaration order within an ecosystem", () => {
    const declared = BRANDS.filter((brand) => brand.ecosystem === "mirabox").map((brand) => brand.name);

    expect(brandsFor("mirabox").map((brand) => brand.name)).toEqual(declared);
  });
});

describe("hasIncompleteList", () => {
  it("is false when every requested ecosystem lists all of its brands", () => {
    expect(hasIncompleteList(["elgato", "ulanzi"])).toBe(false);
  });

  it("is true when any requested ecosystem has more brands than it lists", () => {
    expect(hasIncompleteList(["mirabox"])).toBe(true);
    expect(hasIncompleteList(["elgato", "mirabox", "ulanzi"])).toBe(true);
  });
});

describe("toSentenceList", () => {
  it("returns nothing for an empty list", () => {
    expect(toSentenceList([])).toEqual([]);
  });

  it("leaves a single item without a trailing separator", () => {
    expect(toSentenceList(["Nouvolo"])).toEqual([{ value: "Nouvolo", separator: "" }]);
  });

  it("joins two items with a plain and", () => {
    expect(toSentenceList(["SOOMFON", "VAPOURD"])).toEqual([
      { value: "SOOMFON", separator: " and " },
      { value: "VAPOURD", separator: "" },
    ]);
  });

  it("uses an Oxford comma from three items up", () => {
    expect(toSentenceList(["A", "B", "C"])).toEqual([
      { value: "A", separator: ", " },
      { value: "B", separator: ", and " },
      { value: "C", separator: "" },
    ]);
  });
});

describe("brand data", () => {
  it("gives every ecosystem at least one brand", () => {
    for (const ecosystem of ecosystemKeys) {
      expect(brandsFor(ecosystem).length, `ecosystem ${ecosystem} has no brands`).toBeGreaterThan(0);
    }
  });

  it("only assigns brands to declared ecosystems", () => {
    for (const brand of BRANDS) {
      expect(ecosystemKeys, `brand ${brand.name}`).toContain(brand.ecosystem);
    }
  });

  it("keeps brand names unique", () => {
    const seen = BRANDS.map((brand) => brand.name.toLowerCase());

    expect(new Set(seen).size).toBe(seen.length);
  });

  it("gives every ecosystem a label and a device list for the prose surfaces", () => {
    for (const ecosystem of ecosystemKeys) {
      expect(ECOSYSTEMS[ecosystem].label.length, `ecosystem ${ecosystem}`).toBeGreaterThan(0);
      expect(ECOSYSTEMS[ecosystem].devices.length, `ecosystem ${ecosystem}`).toBeGreaterThan(0);
    }
  });

  // Logo assets are opt-in: a brand without one renders as a wordmark tile. A
  // declared logo that does not exist would silently fall back to a wordmark,
  // so the file has to be there.
  it("points every declared logo at a file that exists", () => {
    for (const brand of BRANDS) {
      if (!brand.logo) continue;

      expect(existsSync(join(brandAssetsDir, brand.logo)), `${brand.name} logo ${brand.logo}`).toBe(true);
    }
  });
});
