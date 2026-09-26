import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The icon the Windows Volume Mixer shows for our audio session (#1253) is the
// website favicon, copied verbatim. Only the Elgato plugin commits a copy: the
// Mirabox and Ulanzi builds copy the Elgato plugin's whole `imgs/plugin/` into
// their own (gitignored) tree, so a logo change reaches all three from one file.

// scripts/plugin-session-icon.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE = "assets/favicon/favicon.ico";
const ELGATO_ICON = "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/imgs/plugin/iracedeck.ico";

const PLUGINS = [
  { name: "stream-deck", dir: "com.iracedeck.sd.core.sdPlugin" },
  { name: "mirabox", dir: "com.iracedeck.sd.core.sdPlugin" },
  { name: "ulanzi", dir: "com.ulanzi.iracedeck.ulanziPlugin" },
];

const read = (rel) => readFileSync(join(repoRoot, rel));

describe("audio session icon (#1253)", () => {
  it("the Elgato plugin's committed icon is byte-identical to the favicon", () => {
    expect(existsSync(join(repoRoot, ELGATO_ICON)), `${ELGATO_ICON} is missing`).toBe(true);
    expect(read(ELGATO_ICON).equals(read(SOURCE)), `${ELGATO_ICON} differs from ${SOURCE}`).toBe(true);
  });

  for (const { name } of PLUGINS) {
    it(`${name}: plugin.ts names the session and points at imgs/plugin/iracedeck.ico`, () => {
      const source = read(`packages/iracing-plugin-${name}/src/plugin.ts`).toString("utf-8");
      expect(source).toContain('displayName: "iRaceDeck"');
      expect(source).toContain('iconPath: join(__binDir, "..", "imgs", "plugin", "iracedeck.ico")');
    });
  }

  for (const name of ["mirabox", "ulanzi"]) {
    it(`${name}: the build copies imgs/plugin from the Elgato plugin`, () => {
      const config = read(`packages/iracing-plugin-${name}/rollup.config.mjs`).toString("utf-8");
      expect(config).toContain('path.join(elgatoPluginPath, "com.iracedeck.sd.core.sdPlugin", "imgs", "plugin")');
    });
  }

  // The Mirabox and Ulanzi copies exist once those plugins have been built (CI
  // builds before it tests); compare them too, so a stale or broken copy step
  // cannot ship a different icon than the one committed. The Elgato plugin's
  // icon is the committed file itself, checked above.
  for (const { name, dir } of PLUGINS.filter((p) => p.name !== "stream-deck")) {
    const built = `packages/iracing-plugin-${name}/${dir}/imgs/plugin/iracedeck.ico`;
    const pluginBuilt = existsSync(join(repoRoot, `packages/iracing-plugin-${name}/${dir}/bin`));

    it.skipIf(!pluginBuilt)(`${name}: the built plugin carries the same icon`, () => {
      expect(existsSync(join(repoRoot, built)), `${built} is missing from the built plugin`).toBe(true);
      expect(read(built).equals(read(SOURCE)), `${built} differs from ${SOURCE}`).toBe(true);
    });
  }
});
