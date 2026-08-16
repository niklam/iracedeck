import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BRAND_LOGO_EXTENSIONS,
  brandGroupsFor,
  BRANDS,
  brandsFor,
  type Ecosystem,
  ECOSYSTEMS,
  toSentenceList,
} from "./brands.js";

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

describe("brandGroupsFor", () => {
  it("keeps one group per requested ecosystem, in the requested order", () => {
    expect(brandGroupsFor(["ulanzi", "elgato"]).map((group) => group.ecosystem)).toEqual(["ulanzi", "elgato"]);
  });

  it("wraps a single ecosystem in one group", () => {
    const groups = brandGroupsFor("mirabox");

    expect(groups).toHaveLength(1);
    expect(groups[0].brands).toEqual(brandsFor("mirabox"));
  });

  // The "and more" tile is rendered per group, so completeness has to travel
  // with the brands it describes — otherwise a caller that lists Mirabox first
  // would end up marking the last ecosystem as the open-ended one.
  it("carries each ecosystem's own completeness flag", () => {
    const groups = brandGroupsFor(["mirabox", "elgato"]);

    expect(groups.map((group) => group.listIsComplete)).toEqual([false, true]);
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

  // Existing on disk is not enough: BrandStrip resolves logos through a glob
  // with a fixed extension list, so a `.jpg` next to the others would pass the
  // existence check above and still fail the Astro build.
  it("gives every declared logo an extension the strip can resolve", () => {
    for (const brand of BRANDS) {
      if (!brand.logo) continue;

      const extension = brand.logo.slice(brand.logo.lastIndexOf("."));

      expect(BRAND_LOGO_EXTENSIONS, `${brand.name} logo ${brand.logo}`).toContain(extension);
    }
  });

  // Both flags describe how a logo is rendered, so neither means anything on a
  // brand that has none — setting one there reads as an effect that never lands.
  it("only sets the logo rendering flags on brands that have a logo", () => {
    for (const brand of BRANDS) {
      if (brand.logo) continue;

      expect(brand.logoNeedsName, `${brand.name} sets logoNeedsName without a logo`).toBeUndefined();
      expect(brand.preserveBrandColor, `${brand.name} sets preserveBrandColor without a logo`).toBeUndefined();
    }
  });
});
