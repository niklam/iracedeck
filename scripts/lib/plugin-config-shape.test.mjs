import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  discoverPlugins,
  FACTORY_CALL,
  FACTORY_IMPORT,
  parseExtraExternals,
  PLUGIN_BUILD_PACKAGE,
  pluginConfigShapeProblems,
  readPluginPackage,
} from "./plugin-config-shape.mjs";

// scripts/lib/ is two below the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const GOOD_CONFIG = `${FACTORY_IMPORT}

${FACTORY_CALL}
  configUrl: import.meta.url,
  sdPluginDir: "com.example.test.sdPlugin",
  platform: "mirabox",
  extraExternals: ["ws"],
  assetCopy: { actionIcons: ["icon.svg"] },
});
`;
const GOOD_PACKAGE = { devDependencies: { [PLUGIN_BUILD_PACKAGE]: "workspace:*" } };

describe("discoverPlugins", () => {
  it("finds the three deck plugins from their manifests, each with a rollup config", () => {
    const plugins = discoverPlugins(repoRoot);

    expect(plugins.map(({ pkg }) => pkg).sort()).toEqual(
      expect.arrayContaining(["iracing-plugin-mirabox", "iracing-plugin-stream-deck", "iracing-plugin-ulanzi"]),
    );
    for (const { pkg, folder } of plugins) {
      expect(existsSync(join(repoRoot, "packages", pkg, folder, "manifest.json"))).toBe(true);
      expect(existsSync(join(repoRoot, "packages", pkg, "rollup.config.mjs"))).toBe(true);
    }
  });

  it("does not take a package for a plugin because it has a rollup config", () => {
    expect(existsSync(join(repoRoot, "packages", "pi-components", "rollup.config.mjs"))).toBe(true);
    expect(discoverPlugins(repoRoot).map(({ pkg }) => pkg)).not.toContain("pi-components");
  });
});

describe("readPluginPackage", () => {
  it("reads a plugin's config source and package.json", () => {
    const { configSource, packageJson } = readPluginPackage(repoRoot, "iracing-plugin-mirabox");

    expect(configSource).toContain(FACTORY_CALL);
    expect(packageJson.name).toBe("@iracedeck/iracing-plugin-mirabox");
  });
});

describe("pluginConfigShapeProblems", () => {
  it("has nothing to say about a config that builds through the factory", () => {
    expect(pluginConfigShapeProblems(GOOD_CONFIG, GOOD_PACKAGE)).toEqual([]);
  });

  it("names a missing factory import", () => {
    const problems = pluginConfigShapeProblems(GOOD_CONFIG.replace(FACTORY_IMPORT, ""), GOOD_PACKAGE);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not import the factory");
  });

  it("names a default export that is not the factory's call", () => {
    const source = GOOD_CONFIG.replace(FACTORY_CALL, "const config = createPluginRollupConfig({").concat(
      "export default { ...config, onLog: undefined };\n",
    );
    const problems = pluginConfigShapeProblems(source, GOOD_PACKAGE);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not default-export the factory's config");
  });

  it.each([
    ["no devDependencies", {}],
    ["the package missing", { devDependencies: { rollup: "4.64.0" } }],
    ["a pinned version instead of the workspace link", { devDependencies: { [PLUGIN_BUILD_PACKAGE]: "3.6.0" } }],
  ])("names %s", (_label, packageJson) => {
    const problems = pluginConfigShapeProblems(GOOD_CONFIG, packageJson);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`"${PLUGIN_BUILD_PACKAGE}": "workspace:*"`);
  });

  it("names every problem at once", () => {
    expect(pluginConfigShapeProblems("export default {};\n", {})).toHaveLength(3);
  });
});

describe("parseExtraExternals", () => {
  it("is empty when the config passes none", () => {
    expect(parseExtraExternals(GOOD_CONFIG.replace('  extraExternals: ["ws"],\n', ""))).toEqual([]);
  });

  it("reads a literal list, across lines and with a trailing comma", () => {
    expect(parseExtraExternals(GOOD_CONFIG)).toEqual(["ws"]);
    expect(parseExtraExternals('extraExternals: [\n  "ws",\n  "left-pad",\n],')).toEqual(["ws", "left-pad"]);
  });

  it.each([
    ["an identifier", "extraExternals: EXTRAS,"],
    ["an identifier shorthand", "createPluginRollupConfig({ extraExternals });"],
  ])("refuses %s in place of the literal array", (_label, source) => {
    expect(() => parseExtraExternals(source)).toThrow("extraExternals must be a literal array");
  });

  it.each([
    ["an identifier entry", 'extraExternals: ["ws", LEFT_PAD],'],
    ["a spread", 'extraExternals: ["ws", ...MORE],'],
    ["a single-quoted entry", "extraExternals: ['ws'],"],
    ["a template literal", "extraExternals: [`ws`],"],
  ])("refuses %s, which would hide an external", (_label, source) => {
    expect(() => parseExtraExternals(source)).toThrow("extraExternals entries must be string literals");
  });

  it("parses every real plugin config", () => {
    for (const { pkg } of discoverPlugins(repoRoot)) {
      const { configSource } = readPluginPackage(repoRoot, pkg);

      expect(() => parseExtraExternals(configSource), pkg).not.toThrow();
    }
  });
});
