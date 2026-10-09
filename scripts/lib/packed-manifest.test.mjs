import {
  configure,
  TextReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readPackedManifestVersion, setPackedManifestVersion } from "./packed-manifest.mjs";

configure({ useWebWorkers: false });

const FOLDER = "com.ulanzi.iracedeck.ulanziPlugin";

// Hand-built archives for the cases the CLI fixture does not cover, in the
// CLI's entry shape: file entries only, under the folder name, each with a
// zip64 extra and a data descriptor.
async function packed(entries) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { zip64: true, dataDescriptor: true });
  for (const [name, text] of Object.entries(entries)) await writer.add(name, new TextReader(text));
  return writer.close();
}

async function unpacked(zip) {
  const reader = new ZipReader(new Uint8ArrayReader(zip));
  const out = {};
  for (const entry of await reader.getEntries()) out[entry.filename] = await entry.getData(new TextWriter());
  await reader.close();
  return out;
}

// A real archive, packed by `npx @elgato/cli@1.7.4 pack <folder> --force
// --ignore-validation` (the release-pack.yml invocation) from a folder whose
// manifest said 3.6.0. The CLI's own layout — a 16-byte zip64 extra on every
// entry, no zip64 end record, 0xFFFFFFFF in every 32-bit size — is what fflate
// misread on the first CI run (#1298), so the code is held to the real thing.
const CLI_PACKED = readFileSync(new URL("./fixtures/cli-1.7.4-packed-ulanzi.zip", import.meta.url));

describe("packed manifest", () => {
  it("reads and rewrites an archive @elgato/cli 1.7.4 packed", async () => {
    // The CLI padded the folder's 3.6.0 on its way into the archive.
    expect(await readPackedManifestVersion(CLI_PACKED)).toBe("3.6.0.0");

    const before = await unpacked(CLI_PACKED);
    const after = await unpacked(await setPackedManifestVersion(CLI_PACKED, "3.6.0"));

    expect(JSON.parse(after[`${FOLDER}/manifest.json`])).toEqual({
      ...JSON.parse(before[`${FOLDER}/manifest.json`]),
      Version: "3.6.0",
    });
    for (const name of Object.keys(before).filter((name) => name !== `${FOLDER}/manifest.json`)) {
      expect(after[name], name).toBe(before[name]);
    }
    expect(Object.keys(after)).toEqual(Object.keys(before));
  });

  it("reads the plugin manifest's Version", async () => {
    const zip = await packed({ [`${FOLDER}/manifest.json`]: JSON.stringify({ Version: "3.6.0.0" }) });

    expect(await readPackedManifestVersion(zip)).toBe("3.6.0.0");
  });

  it("sets the Version and carries every other entry and field over", async () => {
    const zip = await packed({
      [`${FOLDER}/manifest.json`]: JSON.stringify({ Name: "iRaceDeck", Version: "3.6.0.0", UUID: "x" }),
      [`${FOLDER}/bin/plugin.js`]: "console.log(1);",
      [`${FOLDER}/bin/node_modules/dep/manifest.json`]: JSON.stringify({ Version: "9.9.9.9" }),
    });

    const entries = await unpacked(await setPackedManifestVersion(zip, "3.6.0"));

    expect(JSON.parse(entries[`${FOLDER}/manifest.json`])).toEqual({ Name: "iRaceDeck", Version: "3.6.0", UUID: "x" });
    expect(entries[`${FOLDER}/bin/plugin.js`]).toBe("console.log(1);");
    // A nested manifest.json is a dependency's, not the plugin's.
    expect(JSON.parse(entries[`${FOLDER}/bin/node_modules/dep/manifest.json`]).Version).toBe("9.9.9.9");
    expect(Object.keys(entries)).toHaveLength(3);
  });

  it("refuses an archive without exactly one plugin manifest", async () => {
    await expect(readPackedManifestVersion(await packed({ [`${FOLDER}/bin/plugin.js`]: "" }))).rejects.toThrow(
      /found 0/,
    );
    await expect(
      setPackedManifestVersion(
        await packed({ "a.ulanziPlugin/manifest.json": "{}", "b.ulanziPlugin/manifest.json": "{}" }),
        "3.6.0",
      ),
    ).rejects.toThrow(/found 2/);
  });
});
