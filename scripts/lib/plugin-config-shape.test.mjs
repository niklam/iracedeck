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
  stripComments,
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

  it("reads the real export past a commented-out call, and names a wrapper that drops the factory's steps", () => {
    const source = `${FACTORY_IMPORT}

// ${FACTORY_CALL}
/* ${FACTORY_CALL} }); */
const config = createPluginRollupConfig({ configUrl: import.meta.url });
export default { ...config, plugins: [] };
`;
    const problems = pluginConfigShapeProblems(source, GOOD_PACKAGE);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not default-export the factory's config");
    expect(problems[0]).toContain("const config = createPluginRollupConfig");
  });

  it("names a wrapper around the call", () => {
    const source = GOOD_CONFIG.replace(FACTORY_CALL, "export default { ...createPluginRollupConfig({").replace(
      "});",
      "}), plugins: [] };",
    );
    const problems = pluginConfigShapeProblems(source, GOOD_PACKAGE);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not default-export the factory's config");
  });

  it.each([
    [
      "a statement between the imports and the export",
      (/** @type {string} */ s) => s.replace(FACTORY_CALL, `const x = 1;\n${FACTORY_CALL}`),
      "does not default-export the factory's config",
    ],
    [
      "a statement after the call",
      (/** @type {string} */ s) => s.concat("console.log(1);\n"),
      "code after the factory call",
    ],
    [
      "a second export after the call",
      (/** @type {string} */ s) => s.concat("export const extra = 1;\n"),
      "code after the factory call",
    ],
    [
      "a call chained on the call",
      (/** @type {string} */ s) => s.replace("});", "}).valueOf();"),
      "does not end the factory call with `});`",
    ],
    ["a second argument", (/** @type {string} */ s) => s.replace("});", "}, {});"), "more than its one object literal"],
    [
      "an identifier for the argument",
      (/** @type {string} */ s) => s.replace(FACTORY_CALL, "export default createPluginRollupConfig(OPTIONS, {"),
      "something other than an object literal",
    ],
    [
      "an unclosed object literal",
      (/** @type {string} */ s) => s.replace("});", ""),
      "never closes the factory's object literal",
    ],
    [
      'an import that is not `import … from "…";`',
      (/** @type {string} */ s) => s.replace(FACTORY_IMPORT, `${FACTORY_IMPORT}\nimport "side-effect";`),
      "has an import that is not",
    ],
    ["an unterminated string", (/** @type {string} */ s) => s.replace('"mirabox"', '"mirabox'), "unterminated string"],
    [
      "a regular expression",
      (/** @type {string} */ s) => s.replace('"mirabox"', "/mirabox/.source"),
      "a regular expression or a division",
    ],
  ])("names %s", (_label, edit, message) => {
    const problems = pluginConfigShapeProblems(edit(GOOD_CONFIG), GOOD_PACKAGE);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(message);
  });

  it("takes a // or /* inside a string for text, not a comment", () => {
    const source = GOOD_CONFIG.replace(
      '  platform: "mirabox",',
      '  platform: "mirabox", // the host\n  url: "https://example.com/a", pattern: \'/* not a comment */\', /* a real one */',
    );

    expect(pluginConfigShapeProblems(source, GOOD_PACKAGE)).toEqual([]);
    expect(stripComments(source)).toContain('"https://example.com/a"');
    expect(stripComments(source)).toContain("'/* not a comment */'");
    expect(stripComments(source)).not.toContain("the host");
    expect(stripComments(source)).not.toContain("a real one");
  });

  it("accepts every real plugin config", () => {
    for (const { pkg } of discoverPlugins(repoRoot)) {
      const { configSource, packageJson } = readPluginPackage(repoRoot, pkg);

      expect(pluginConfigShapeProblems(configSource, packageJson), pkg).toEqual([]);
    }
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

  it("decodes an escaped entry the way JavaScript does, so the guards see the real package", () => {
    // Built from a char code so no editor or tool can decode the escape early.
    const escaped = `extraExternals: ["left-${String.fromCharCode(92)}u0070ad"],`;
    expect(escaped).toContain("u0070");
    expect(parseExtraExternals(escaped)).toEqual(["left-pad"]);
  });

  it("throws on an escape it cannot decode instead of returning it raw", () => {
    expect(() => parseExtraExternals(String.raw`extraExternals: ["left-\x70ad"],`)).toThrow(/cannot decode/);
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

  it.each([
    ["followed by a comma", 'createPluginRollupConfig({ extraExternals: ["ws"], platform: "x" });'],
    ["closing the object", 'createPluginRollupConfig({ extraExternals: ["ws"] });'],
    [
      "with a comment before the comma",
      'createPluginRollupConfig({ extraExternals: ["ws"] /* why */, platform: "x" });',
    ],
  ])("reads the literal array %s", (_label, source) => {
    expect(parseExtraExternals(source)).toEqual(["ws"]);
  });

  it.each([
    ["a concat", 'createPluginRollupConfig({ extraExternals: ["ws"].concat(["left-pad"]) });', ".concat"],
    ["a filter", 'createPluginRollupConfig({ extraExternals: ["ws"].filter(Boolean) });', ".filter"],
    ["an ||", 'createPluginRollupConfig({ extraExternals: ["ws"] || [] });', "||"],
    ["a call", 'createPluginRollupConfig({ extraExternals: ["ws"](), });', "()"],
  ])("refuses %s built on the literal array", (_label, source, found) => {
    expect(() => parseExtraExternals(source)).toThrow(
      'extraExternals must be the literal array alone, followed by "," or "}"',
    );
    expect(() => parseExtraExternals(source)).toThrow(found);
  });

  it("refuses a spread elsewhere in the config, which could carry another list", () => {
    expect(() => parseExtraExternals('createPluginRollupConfig({ extraExternals: ["ws"], ...MORE });')).toThrow(
      "spreads a value",
    );
  });

  it("refuses a second extraExternals", () => {
    expect(() =>
      parseExtraExternals('createPluginRollupConfig({ extraExternals: ["ws"], extraExternals: ["left-pad"] });'),
    ).toThrow("extraExternals must be given once");
  });

  it("ignores extraExternals in a comment or a string", () => {
    expect(
      parseExtraExternals('// extraExternals: ["left-pad"]\ncreatePluginRollupConfig({ a: "extraExternals" });'),
    ).toEqual([]);
  });

  it("parses every real plugin config", () => {
    for (const { pkg } of discoverPlugins(repoRoot)) {
      const { configSource } = readPluginPackage(repoRoot, pkg);

      expect(() => parseExtraExternals(configSource), pkg).not.toThrow();
    }
  });
});
