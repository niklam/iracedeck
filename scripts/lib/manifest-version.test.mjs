import { describe, expect, it } from "vitest";

import { manifestVersionFor, ULANZI_MANIFEST_VERSION } from "./manifest-version.mjs";
import { PLUGIN_FOLDER_SUFFIXES } from "./version-discovery.mjs";

const ELGATO = "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json";
const MIRABOX = "packages/iracing-plugin-mirabox/com.iracedeck.sd.core.sdPlugin/manifest.json";
const ULANZI = "packages/iracing-plugin-ulanzi/com.ulanzi.iracedeck.ulanziPlugin/manifest.json";

// Elgato's manifest schema.
const FOUR_PART = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/;

describe("manifestVersionFor", () => {
  it.each([ELGATO, MIRABOX])("stamps %s with x.y.z.<build>", (rel) => {
    expect(manifestVersionFor(rel, "3.6.0", "2409")).toBe("3.6.0.2409");
    expect(manifestVersionFor(rel, "3.6.0", "2409")).toMatch(FOUR_PART);
  });

  it.each([ELGATO, MIRABOX])("strips a semver suffix from %s but keeps the build slot", (rel) => {
    expect(manifestVersionFor(rel, "3.6.0-rc.1", "2410")).toBe("3.6.0.2410");
    expect(manifestVersionFor(rel, "3.6.0+meta", "2410")).toBe("3.6.0.2410");
  });

  it("stamps the Ulanzi manifest with plain x.y.z the marketplace accepts", () => {
    expect(manifestVersionFor(ULANZI, "3.6.0", "2409")).toBe("3.6.0");
    expect(manifestVersionFor(ULANZI, "3.6.0", "2409")).toMatch(ULANZI_MANIFEST_VERSION);
  });

  it("gives an Ulanzi pre-release the same version as its final", () => {
    expect(manifestVersionFor(ULANZI, "3.6.0-rc.1", "2410")).toBe("3.6.0");
  });

  it.each(PLUGIN_FOLDER_SUFFIXES)("has a decided format for every discovered plugin folder (%s)", (suffix) => {
    // A suffix discovery bumps but this module cannot format would throw only
    // in the middle of `pnpm release`; this fails it in CI instead.
    expect(() => manifestVersionFor(`packages/x/com.example${suffix}/manifest.json`, "3.6.0", "1")).not.toThrow();
  });

  it("refuses a plugin folder whose ecosystem has no decided format", () => {
    expect(() => manifestVersionFor("packages/x/com.example.otherPlugin/manifest.json", "3.6.0", "1")).toThrow(
      /com\.example\.otherPlugin/,
    );
  });
});
