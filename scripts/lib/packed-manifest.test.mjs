import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { readPackedManifestVersion, setPackedManifestVersion } from "./packed-manifest.mjs";

const FOLDER = "com.ulanzi.iracedeck.ulanziPlugin";

// The shape `@elgato/cli pack` writes: file entries only, under the folder name.
function packed(entries) {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])));
}

describe("packed manifest", () => {
  it("reads the plugin manifest's Version", () => {
    const zip = packed({ [`${FOLDER}/manifest.json`]: JSON.stringify({ Version: "3.6.0.0" }) });

    expect(readPackedManifestVersion(zip)).toBe("3.6.0.0");
  });

  it("sets the Version and carries every other entry and field over", () => {
    const zip = packed({
      [`${FOLDER}/manifest.json`]: JSON.stringify({ Name: "iRaceDeck", Version: "3.6.0.0", UUID: "x" }),
      [`${FOLDER}/bin/plugin.js`]: "console.log(1);",
      [`${FOLDER}/bin/node_modules/dep/manifest.json`]: JSON.stringify({ Version: "9.9.9.9" }),
    });

    const entries = unzipSync(setPackedManifestVersion(zip, "3.6.0"));

    expect(JSON.parse(strFromU8(entries[`${FOLDER}/manifest.json`]))).toEqual({
      Name: "iRaceDeck",
      Version: "3.6.0",
      UUID: "x",
    });
    expect(strFromU8(entries[`${FOLDER}/bin/plugin.js`])).toBe("console.log(1);");
    // A nested manifest.json is a dependency's, not the plugin's.
    expect(JSON.parse(strFromU8(entries[`${FOLDER}/bin/node_modules/dep/manifest.json`])).Version).toBe("9.9.9.9");
    expect(Object.keys(entries)).toHaveLength(3);
  });

  it("refuses an archive without exactly one plugin manifest", () => {
    expect(() => readPackedManifestVersion(packed({ [`${FOLDER}/bin/plugin.js`]: "" }))).toThrow(/found 0/);
    expect(() =>
      setPackedManifestVersion(
        packed({ "a.ulanziPlugin/manifest.json": "{}", "b.ulanziPlugin/manifest.json": "{}" }),
        "3.6.0",
      ),
    ).toThrow(/found 2/);
  });
});
