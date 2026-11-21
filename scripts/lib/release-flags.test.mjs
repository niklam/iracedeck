// The release flags the pack-author reference reads (#1113): pure over a
// hand-built set of files, plus what the committed files say today.
import { describe, expect, it } from "vitest";

import { PLUGIN_FLAG_FILES, readReleaseFlags, withheldDevelopmentFeatures } from "./release-flags.mjs";

/** A reader over three hand-built files, in {@link PLUGIN_FLAG_FILES}' order. */
function reader(...features) {
  return (relative) => ({ features: features[PLUGIN_FLAG_FILES.indexOf(relative)] });
}

const FEATURE = {
  flag: "devThing",
  withheld: { contracts: ["pit-crew.dev-thing"], vars: ["dev.var"], conds: ["dev.cond"], cases: [] },
};
const OTHER = {
  flag: "otherThing",
  withheld: { contracts: ["pit-crew.other"], vars: [], conds: [], cases: ["other.case"] },
};

describe("readReleaseFlags", () => {
  it("reads the three committed plugin files, and no local override", () => {
    expect(PLUGIN_FLAG_FILES).toEqual([
      "packages/iracing-plugin-stream-deck/platform-features.json",
      "packages/iracing-plugin-mirabox/platform-features.json",
      "packages/iracing-plugin-ulanzi/platform-features.json",
    ]);
  });

  it("calls a flag released when any one plugin ships it on, and not when none does", () => {
    const flags = readReleaseFlags(
      reader({ a: false, b: true, c: false }, { a: false, b: false, c: false }, { a: false, b: false, c: true }),
    );

    expect([...flags]).toEqual([
      ["a", false],
      ["b", true],
      ["c", true],
    ]);
  });

  it("has the rejoin warnings unreleased today: trafficRejoin is off in every plugin (#1113)", () => {
    expect(readReleaseFlags().get("trafficRejoin")).toBe(false);
  });
});

describe("withheldDevelopmentFeatures", () => {
  it("withholds every name of each feature no plugin ships, merged, and nothing of a released one", () => {
    const flags = new Map([
      ["devThing", false],
      ["otherThing", true],
    ]);

    expect(withheldDevelopmentFeatures([FEATURE, OTHER], flags)).toEqual(FEATURE.withheld);
    expect(withheldDevelopmentFeatures([FEATURE, OTHER], new Map([...flags, ["otherThing", false]]))).toEqual({
      contracts: ["pit-crew.dev-thing", "pit-crew.other"],
      vars: ["dev.var"],
      conds: ["dev.cond"],
      cases: ["other.case"],
    });
  });

  it("withholds nothing when there is no development feature", () => {
    expect(withheldDevelopmentFeatures([], new Map())).toEqual({ contracts: [], vars: [], conds: [], cases: [] });
  });

  it("refuses a feature whose flag the plugin files do not declare, naming it", () => {
    expect(() => withheldDevelopmentFeatures([FEATURE], new Map([["otherThing", false]]))).toThrow(
      /platform flag "devThing", which .* do not declare/,
    );
  });
});
