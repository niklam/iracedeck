import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The icon the Windows Volume Mixer shows for our audio session (#1253) is the
// website favicon, copied verbatim. Only the Elgato plugin commits a copy: the
// Mirabox and Ulanzi builds copy the Elgato plugin's whole `imgs/plugin/` into
// their own (gitignored) tree, so a logo change reaches all three from one file.
//
// Where each plugin points the session is deck-core's `pluginAudioSessionIdentity`,
// unit-tested beside it; this file checks the artifacts that path must find.

// scripts/plugin-session-icon.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE = "assets/favicon/favicon.ico";
const ICON_FILE = "iracedeck.ico";
const ELGATO_ICON = `packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/imgs/plugin/${ICON_FILE}`;

const COPYING_PLUGINS = [
  { name: "mirabox", dir: "com.iracedeck.sd.core.sdPlugin" },
  { name: "ulanzi", dir: "com.ulanzi.iracedeck.ulanziPlugin" },
];

const read = (rel) => readFileSync(join(repoRoot, rel));

/**
 * Whether a plugin's built bundle comes from a tree that names the session.
 * The copied icon only has to exist in a build of this change or later; a
 * bundle built before it (a stale local `bin/`) would otherwise fail the suite
 * over an artifact nobody asked it to produce. CI builds before it tests, so
 * there the check always runs.
 */
function builtWithSessionIdentity(pluginDir) {
  const bundle = join(repoRoot, pluginDir, "bin", "plugin.js");

  return existsSync(bundle) && readFileSync(bundle, "utf-8").includes(ICON_FILE);
}

describe("audio session icon (#1253)", () => {
  it("the Elgato plugin's committed icon is byte-identical to the favicon", () => {
    expect(existsSync(join(repoRoot, ELGATO_ICON)), `${ELGATO_ICON} is missing`).toBe(true);
    expect(read(ELGATO_ICON).equals(read(SOURCE)), `${ELGATO_ICON} differs from ${SOURCE}`).toBe(true);
  });

  // The Mirabox and Ulanzi copies exist once those plugins have been built;
  // compare them too, so a stale or broken copy step cannot ship a different
  // icon than the one committed — or none, leaving the session iconless. The
  // Elgato plugin's icon is the committed file itself, checked above.
  for (const { name, dir } of COPYING_PLUGINS) {
    const pluginDir = `packages/iracing-plugin-${name}/${dir}`;
    const built = `${pluginDir}/imgs/plugin/${ICON_FILE}`;

    it.skipIf(!builtWithSessionIdentity(pluginDir))(`${name}: the built plugin carries the same icon`, () => {
      expect(existsSync(join(repoRoot, built)), `${built} is missing from the built plugin`).toBe(true);
      expect(read(built).equals(read(SOURCE)), `${built} differs from ${SOURCE}`).toBe(true);
    });
  }
});
