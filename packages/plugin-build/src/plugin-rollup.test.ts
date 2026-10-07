import { SETTINGS_WINDOW_HTML } from "@iracedeck/app-constants";
import { PI_SETTINGS_BRIDGE, SETTINGS_WINDOW_BRIDGE } from "@iracedeck/pi-components/build";
import typescript from "@rollup/plugin-typescript";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import type { Plugin, RollupOptions } from "rollup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DEV_VOICE_PACKS_ROOT, DEV_LOCAL_FILE } from "../../../scripts/lib/dev-local.mjs";
import { pluginBuildOnLog } from "../../../scripts/lib/rollup-logs.mjs";
import { BASE_EXTERNALS, pluginExternals } from "./externals.mjs";
import {
  copyActionIcons,
  createPluginRollupConfig,
  deepMergeObjects,
  partitionOverride,
  resolvePlatformFeatures,
  SOURCES,
} from "./plugin-rollup.mjs";

// node:fs passes through to the real module, with two exceptions. The copy-list test stubs
// copyFileSync and mkdirSync for one call so the step's cwd-relative ui folder is never written
// in the real working directory. And existsSync answers false for the repo root's gitignored
// feature-flags.local.json — exactly that path — so a developer's local override (say, a copy
// of the committed .example) never decides the flags these tests assert; the factory reads
// the file only behind that check.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { default: nodePath } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const localFeatures = nodePath.resolve(
    nodePath.dirname(fileURLToPath(import.meta.url)),
    "../../../feature-flags.local.json",
  );

  return {
    ...actual,
    copyFileSync: vi.fn(actual.copyFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    existsSync: vi.fn((file: import("node:fs").PathLike) =>
      typeof file === "string" && nodePath.resolve(file) === localFeatures ? false : actual.existsSync(file),
    ),
  };
});
vi.mock("@rollup/plugin-commonjs", () => ({ default: vi.fn((opts?: unknown) => ({ name: "stub:commonjs", opts })) }));
vi.mock("@rollup/plugin-json", () => ({ default: vi.fn((opts?: unknown) => ({ name: "stub:json", opts })) }));
vi.mock("@rollup/plugin-node-resolve", () => ({
  default: vi.fn((opts?: unknown) => ({ name: "stub:node-resolve", opts })),
}));
vi.mock("@rollup/plugin-replace", () => ({ default: vi.fn((opts?: unknown) => ({ name: "stub:replace", opts })) }));
vi.mock("@rollup/plugin-terser", () => ({ default: vi.fn((opts?: unknown) => ({ name: "stub:terser", opts })) }));
vi.mock("@rollup/plugin-typescript", () => ({
  default: vi.fn((opts?: unknown) => ({ name: "stub:typescript", opts })),
}));
vi.mock("@iracedeck/pi-components/build", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/pi-components/build")>();

  return {
    ...actual,
    piTemplatePlugin: vi.fn((opts: unknown) => ({ name: "stub:pi-template", opts })),
    injectBridgeScriptPlugin: vi.fn((opts: { bridge: string }) => ({ name: `stub:inject:${opts.bridge}`, opts })),
    assertBridgeInjectionPlugin: vi.fn((opts: unknown) => ({ name: "stub:assert-bridge", opts })),
  };
});
vi.mock("@iracedeck/audio-assets/build", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/audio-assets/build")>();

  return { ...actual, processAndCopyAudioAssetsPlugin: vi.fn((opts: unknown) => ({ name: "stub:audio", opts })) };
});

type Options = Parameters<typeof createPluginRollupConfig>[0];
type AnyHook = (this: unknown, ...args: unknown[]) => unknown;
type Stub = { name: string; opts: Record<string, unknown> };

const SD_PLUGIN_DIR = "com.example.test.sdPlugin";
const COMMITTED_FEATURES = { features: { dialExtendedGestures: true, profiles: false, pngRasterization: false } };

/** The plugin names the factory emits, in order, for the given switches. */
function expectedNames({
  elgatoPluginImgs = false,
  stripHtmlLang = false,
  piBridge = PI_SETTINGS_BRIDGE,
} = {}): string[] {
  return [
    "resolve-actions-ts",
    "svg",
    "stub:json",
    "stub:replace",
    "stub:pi-template",
    `stub:inject:${SETTINGS_WINDOW_BRIDGE}`,
    `stub:inject:${piBridge}`,
    "copy-action-icons",
    ...(elgatoPluginImgs ? ["copy-plugin-imgs"] : []),
    "stub:audio",
    "copy-rasterizer-fonts",
    "copy-license-files",
    "copy-pi-browser-assets",
    "watch-externals",
    "stub:typescript",
    "stub:node-resolve",
    "stub:commonjs",
    ...(stripHtmlLang ? ["strip-html-lang"] : []),
    "stub:terser",
    "emit-module-package-file",
    "emit-plugin-config",
    "stub:assert-bridge",
  ];
}

function pluginsOf(config: RollupOptions): Plugin[] {
  return (config.plugins as (Plugin | false)[]).filter((p): p is Plugin => Boolean(p));
}

function pluginNamed(config: RollupOptions, name: string): Plugin {
  const plugin = pluginsOf(config).find((p) => p.name === name);

  if (!plugin) throw new Error(`no plugin named ${name}`);

  return plugin;
}

function stubNamed(config: RollupOptions, name: string): Stub {
  return pluginNamed(config, name) as unknown as Stub;
}

function hook(plugin: Plugin, name: "generateBundle" | "buildStart" | "writeBundle"): AnyHook {
  const fn = plugin[name];

  if (typeof fn !== "function") throw new Error(`${plugin.name} has no ${name} hook`);

  return fn as unknown as AnyHook;
}

describe("createPluginRollupConfig", () => {
  let tmp: string;
  let packageDir: string;
  let configUrl: string;

  function options(overrides: Partial<Options> = {}): Options {
    return {
      configUrl,
      sdPluginDir: SD_PLUGIN_DIR,
      platform: "stream-deck",
      assetCopy: { actionIcons: ["icon.svg", "key.svg", "dial.svg"] },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("IRACEDECK_DEV_VOICES", "0");
    vi.stubEnv("ROLLUP_WATCH", "");
    tmp = mkdtempSync(path.join(os.tmpdir(), "ird-plugin-build-"));
    packageDir = path.join(tmp, "iracing-plugin-test");
    mkdirSync(path.join(packageDir, SD_PLUGIN_DIR), { recursive: true });
    writeFileSync(path.join(packageDir, SD_PLUGIN_DIR, "manifest.json"), "{}");
    writeFileSync(path.join(packageDir, "platform-features.json"), JSON.stringify(COMMITTED_FEATURES));
    configUrl = url.pathToFileURL(path.join(packageDir, "rollup.config.mjs")).href;
    // `rollup -c` runs in the plugin package; the factory asserts it.
    vi.spyOn(process, "cwd").mockReturnValue(packageDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("the returned config", () => {
    it("keeps the cwd-relative input and output, and the shared log policy", () => {
      const config = createPluginRollupConfig(options());
      const output = config.output as { file: string; inlineDynamicImports: boolean; sourcemap: boolean };

      expect(config.input).toBe("src/plugin.ts");
      expect(output.file).toBe(`${SD_PLUGIN_DIR}/bin/plugin.js`);
      expect(output.inlineDynamicImports).toBe(true);
      expect(output.sourcemap).toBe(false);
      expect(config.onLog).toBe(pluginBuildOnLog);
    });

    it("leaves out the base externals, and a plugin's extras after them", () => {
      expect(createPluginRollupConfig(options()).external).toEqual([...BASE_EXTERNALS]);
      expect(createPluginRollupConfig(options({ extraExternals: ["ws"] })).external).toEqual([
        ...BASE_EXTERNALS,
        "ws",
      ]);
      expect(pluginExternals(["ws"])).toEqual([...BASE_EXTERNALS, "ws"]);
    });

    it("orders the plugins in the common order, with the optional steps off by default", () => {
      expect(pluginsOf(createPluginRollupConfig(options())).map((p) => p.name)).toEqual(expectedNames());
    });

    it("adds copy-plugin-imgs only with elgatoPluginImgs and strip-html-lang only with stripHtmlLang", () => {
      const mirabox = createPluginRollupConfig(
        options({
          platform: "mirabox",
          extraExternals: ["ws"],
          assetCopy: { actionIcons: ["icon.svg", "key.svg"], elgatoPluginImgs: true },
          stripHtmlLang: true,
        }),
      );
      expect(pluginsOf(mirabox).map((p) => p.name)).toEqual(
        expectedNames({ elgatoPluginImgs: true, stripHtmlLang: true }),
      );

      const ulanzi = createPluginRollupConfig(
        options({
          platform: "ulanzi",
          assetCopy: { actionIcons: ["icon.svg", "key.svg"], elgatoPluginImgs: true },
          piBridge: "ulanzi-pi-bridge.js",
        }),
      );
      expect(pluginsOf(ulanzi).map((p) => p.name)).toEqual(
        expectedNames({ elgatoPluginImgs: true, piBridge: "ulanzi-pi-bridge.js" }),
      );
    });

    it("drops terser while watching", () => {
      vi.stubEnv("ROLLUP_WATCH", "true");
      const names = pluginsOf(createPluginRollupConfig(options())).map((p) => p.name);

      expect(names).not.toContain("stub:terser");
    });

    it("gives typescript the three cwd-relative include globs and noEmitOnError", () => {
      createPluginRollupConfig(options());

      expect(vi.mocked(typescript)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(typescript).mock.calls[0][0]).toMatchObject({
        include: ["src/**/*.ts", "../iracing-actions/src/**/*.ts", "../plugin-runtime/src/**/*.ts"],
        noEmitOnError: true,
      });
    });

    it("hands the cwd-relative ui folder and plugin folder to the PI and audio steps", () => {
      const config = createPluginRollupConfig(options());

      expect(stubNamed(config, "stub:pi-template").opts).toMatchObject({
        templatesDir: SOURCES.actionTemplatesDir,
        outputDir: `${SD_PLUGIN_DIR}/ui`,
        platformFeatures: COMMITTED_FEATURES,
      });
      expect(stubNamed(config, "stub:audio").opts).toEqual({ sdPlugin: SD_PLUGIN_DIR });
    });

    it("never sees a developer's feature-flags.local.json, and the stub hides nothing else", () => {
      // The node:fs mock above hides exactly the path the factory reads, whether or
      // not the file exists in this checkout; every assertion on flags rests on it.
      expect(existsSync(SOURCES.localFeaturesPath)).toBe(false);
      expect(existsSync(SOURCES.rootPackageJson)).toBe(true);
      expect(existsSync(path.join(packageDir, "platform-features.json"))).toBe(true);
    });
  });

  describe("bridges", () => {
    it.each([
      ["the default", undefined, PI_SETTINGS_BRIDGE],
      ["Ulanzi's", "ulanzi-pi-bridge.js", "ulanzi-pi-bridge.js"],
    ])("injects and asserts %s PI bridge everywhere but the settings window", (_label, piBridge, expected) => {
      const config = createPluginRollupConfig(options(piBridge === undefined ? {} : { piBridge }));
      const windowInjector = stubNamed(config, `stub:inject:${SETTINGS_WINDOW_BRIDGE}`).opts as {
        outputDir: string;
        include: (file: string) => boolean;
      };
      const piInjector = stubNamed(config, `stub:inject:${expected}`).opts as {
        outputDir: string;
        include: (file: string) => boolean;
      };
      const assert = stubNamed(config, "stub:assert-bridge").opts as {
        outputDir: string;
        expectedBridge: (file: string) => string;
      };

      for (const opts of [windowInjector, piInjector, assert]) expect(opts.outputDir).toBe(`${SD_PLUGIN_DIR}/ui`);

      expect(windowInjector.include(SETTINGS_WINDOW_HTML)).toBe(true);
      expect(windowInjector.include("x.html")).toBe(false);
      expect(piInjector.include(SETTINGS_WINDOW_HTML)).toBe(false);
      expect(piInjector.include("x.html")).toBe(true);
      expect(assert.expectedBridge(SETTINGS_WINDOW_HTML)).toBe(SETTINGS_WINDOW_BRIDGE);
      expect(assert.expectedBridge("x.html")).toBe(expected);
    });

    it.each([
      ["the default", undefined, PI_SETTINGS_BRIDGE],
      ["Ulanzi's", "ulanzi-pi-bridge.js", "ulanzi-pi-bridge.js"],
    ])("copies %s PI bridge into ui/ with the other browser assets", (_label, piBridge, expected) => {
      const config = createPluginRollupConfig(options(piBridge === undefined ? {} : { piBridge }));
      // Stubbed for this one call: the step's ui folder is cwd-relative, and the
      // real working directory is never the temp package.
      vi.mocked(copyFileSync).mockImplementation(() => undefined);
      vi.mocked(mkdirSync).mockImplementation(() => undefined);
      const ctx = { error: vi.fn(), info: vi.fn() };
      let destinations: string[] = [];

      try {
        hook(pluginNamed(config, "copy-pi-browser-assets"), "generateBundle").call(ctx);
        destinations = vi.mocked(copyFileSync).mock.calls.map(([, dest]) => String(dest));
      } finally {
        // Back to the pass-through implementations for every other test.
        vi.mocked(copyFileSync).mockReset();
        vi.mocked(mkdirSync).mockReset();
      }

      expect(destinations.map((dest) => path.basename(dest))).toEqual([
        "sdpi-components.js",
        "pi-components.js",
        expected,
        SETTINGS_WINDOW_BRIDGE,
        "iracedeck-logo.png",
        "iracedeck-icon.png",
      ]);

      for (const dest of destinations) expect(path.dirname(dest)).toBe(path.join(SD_PLUGIN_DIR, "ui"));
    });
  });

  describe("emit-plugin-config", () => {
    function emitted(config: RollupOptions): Record<string, unknown> {
      const emitFile = vi.fn();
      hook(pluginNamed(config, "emit-plugin-config"), "generateBundle").call({ emitFile });

      expect(emitFile).toHaveBeenCalledTimes(1);
      const [file] = emitFile.mock.calls[0] as [{ fileName: string; source: string; type: string }];
      expect(file.fileName).toBe("config.json");
      expect(file.type).toBe("asset");

      return JSON.parse(file.source) as Record<string, unknown>;
    }

    it("emits version, platform and flags, and no dev voice root with the opt-in off", (ctx) => {
      if (existsSync(path.join(SOURCES.repoRoot, DEV_LOCAL_FILE))) {
        ctx.skip(`${DEV_LOCAL_FILE} exists at the repo root and decides the dev voice root`);
      }

      const rootVersion = (JSON.parse(readFileSync(SOURCES.rootPackageJson, "utf-8")) as { version: string }).version;

      expect(emitted(createPluginRollupConfig(options({ platform: "mirabox" })))).toEqual({
        version: rootVersion,
        platform: "mirabox",
        featureFlags: COMMITTED_FEATURES,
      });
    });

    it("carries the default dev voice root under IRACEDECK_DEV_VOICES=1", (ctx) => {
      if (existsSync(path.join(SOURCES.repoRoot, DEV_LOCAL_FILE))) {
        ctx.skip(`${DEV_LOCAL_FILE} exists at the repo root and decides the dev voice root`);
      }

      vi.stubEnv("IRACEDECK_DEV_VOICES", "1");
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const config = emitted(createPluginRollupConfig(options()));

      expect(config.devVoicePacksRoot).toBe(path.resolve(SOURCES.repoRoot, DEFAULT_DEV_VOICE_PACKS_ROOT));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("[dev-voices] development voice root on via"));
      log.mockRestore();
    });
  });

  describe("copies", () => {
    it("copyActionIcons copies exactly the listed files and skips data/", () => {
      const templates = path.join(tmp, "actions");
      const dest = path.join(tmp, "out");

      for (const [dir, files] of [
        ["alpha", ["icon.svg", "key.svg", "dial.svg", "alpha.ts"]],
        ["beta", ["icon.svg"]],
        ["data", ["icon.svg", "key.svg"]],
      ] as const) {
        mkdirSync(path.join(templates, dir), { recursive: true });

        for (const file of files) writeFileSync(path.join(templates, dir, file), `${dir}/${file}`);
      }

      writeFileSync(path.join(templates, "loose.svg"), "not an action");

      copyActionIcons(templates, dest, ["icon.svg", "key.svg"]);

      expect(readdirSync(dest).sort()).toEqual(["alpha", "beta"]);
      expect(readdirSync(path.join(dest, "alpha")).sort()).toEqual(["icon.svg", "key.svg"]);
      expect(readdirSync(path.join(dest, "beta"))).toEqual(["icon.svg"]);
      expect(readFileSync(path.join(dest, "alpha", "key.svg"), "utf-8")).toBe("alpha/key.svg");
    });

    it("reads its re-anchored sources from places that exist", () => {
      expect(existsSync(SOURCES.actionTemplatesDir)).toBe(true);
      expect(readdirSync(SOURCES.actionTemplatesDir)).toContain("data");
      expect(existsSync(SOURCES.iconsPackageDir)).toBe(true);
      expect(readdirSync(SOURCES.elgatoPluginImgsDir).length).toBeGreaterThan(0);
      expect(readdirSync(SOURCES.rasterizerFontsDir).length).toBeGreaterThan(0);
      expect(existsSync(SOURCES.rootPackageJson)).toBe(true);

      for (const file of ["LICENSE", "THIRD-PARTY-LICENSES.md"]) {
        expect(existsSync(path.join(SOURCES.repoRoot, file))).toBe(true);
      }
    });

    it("anchors the repo on the factory's own location", () => {
      const here = path.dirname(url.fileURLToPath(import.meta.url));

      expect(SOURCES.repoRoot).toBe(path.resolve(here, "../../.."));
    });
  });

  describe("the plugin package directory", () => {
    it("is the directory of configUrl", () => {
      const config = createPluginRollupConfig(options());
      const addWatchFile = vi.fn();

      hook(pluginNamed(config, "watch-externals"), "buildStart").call({ addWatchFile });

      expect(addWatchFile).toHaveBeenCalledWith(path.join(packageDir, SD_PLUGIN_DIR, "manifest.json"));
      expect(addWatchFile).toHaveBeenCalledWith(path.join(packageDir, "platform-features.json"));
    });

    it("must be the working directory, compared by real path", () => {
      const spelled =
        process.platform === "win32" ? `${packageDir.toUpperCase()}${path.sep}` : `${packageDir}${path.sep}`;
      vi.mocked(process.cwd).mockReturnValue(spelled);

      expect(() => createPluginRollupConfig(options())).not.toThrow();
    });

    it("fails fast from any other working directory, naming both paths", () => {
      vi.mocked(process.cwd).mockReturnValue(tmp);
      let message = "";

      try {
        createPluginRollupConfig(options());
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain("must be run from its package directory");
      expect(message).toContain(realpathSync.native(tmp));
      expect(message).toContain(realpathSync.native(packageDir));
    });

    it("reads platform-features.json from that directory", () => {
      writeFileSync(
        path.join(packageDir, "platform-features.json"),
        JSON.stringify({ features: { dialExtendedGestures: false, pngRasterization: true } }),
      );

      const config = createPluginRollupConfig(options());

      expect(stubNamed(config, "stub:replace").opts).toMatchObject({
        values: { __FEATURE_DIAL_EXTENDED_GESTURES__: "false", __FEATURE_PNG_RASTERIZATION__: "true" },
      });
    });
  });

  describe("validation", () => {
    function rejects(opts: unknown, ...fragments: string[]): void {
      let message = "";

      try {
        createPluginRollupConfig(opts as Options);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).not.toBe("");

      for (const fragment of fragments) expect(message).toContain(fragment);
    }

    it("rejects an unknown key, naming it", () => {
      rejects({ ...options(), stripHtmlLnag: true }, '"stripHtmlLnag"');
      rejects(
        { ...options(), assetCopy: { actionIcons: ["icon.svg"], elgatoPluginImg: true } },
        "assetCopy.elgatoPluginImg",
      );
    });

    it.each(["configUrl", "sdPluginDir", "platform", "assetCopy"] as const)("rejects a missing %s", (key) => {
      const opts: Record<string, unknown> = { ...options() };
      delete opts[key];

      rejects(opts, "missing", `"${key}"`);
    });

    it("rejects a platform outside the three", () => {
      rejects(options({ platform: "loupedeck" as Options["platform"] }), '"platform"', "loupedeck");
    });

    it("rejects an extra external that is already a base one", () => {
      rejects(options({ extraExternals: ["ws", "yaml"] }), '"extraExternals"', "yaml");
    });

    it("rejects an extra external listed twice", () => {
      rejects(options({ extraExternals: ["ws", "ws"] }), '"extraExternals"', '"ws" twice');
    });

    it.each([
      ["absolute", path.resolve("com.example.abs.sdPlugin")],
      ["parent-relative", "../elsewhere/com.example.test.sdPlugin"],
      ["parent-relative with backslashes", String.raw`sub\..\..\com.example.test.sdPlugin`],
    ])("rejects an sdPluginDir that is %s", (_label, sdPluginDir) => {
      rejects(options({ sdPluginDir }), '"sdPluginDir" must be a folder inside the plugin package');
    });

    it("rejects an empty or malformed actionIcons list", () => {
      rejects(options({ assetCopy: { actionIcons: [] } }), "assetCopy.actionIcons");
    });

    it("rejects a configUrl that is not a file URL", () => {
      rejects(options({ configUrl: packageDir }), '"configUrl"');
    });

    it("fails fast when the plugin folder has no manifest under the config's directory", () => {
      rejects(options({ sdPluginDir: "com.example.missing.sdPlugin" }), "no manifest", "com.example.missing.sdPlugin");
    });
  });
});

describe("feature-flag merge", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "ird-plugin-flags-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("partitionOverride drops unknown keys and nested-versus-leaf mismatches", () => {
    const committed = { features: { a: true, nested: { b: 1 } }, top: 1 };
    const override = { features: { a: false, nested: 5, typo: true }, top: { x: 1 }, extra: 1 };

    expect(partitionOverride(committed, override)).toEqual({
      known: { features: { a: false } },
      unknown: ["features.nested", "features.typo", "top", "extra"],
    });
  });

  it("deepMergeObjects lets the override win and replaces arrays", () => {
    expect(deepMergeObjects({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] })).toEqual({
      a: { b: 1, c: 3 },
      list: [9],
    });
  });

  it("resolvePlatformFeatures returns the committed flags when there is no local override", () => {
    const committed = path.join(tmp, "platform-features.json");
    writeFileSync(committed, JSON.stringify(COMMITTED_FEATURES));

    expect(resolvePlatformFeatures(committed, path.join(tmp, "absent.json"))).toEqual(COMMITTED_FEATURES);
  });

  it("resolvePlatformFeatures merges the known override keys and warns about the rest", () => {
    const committed = path.join(tmp, "platform-features.json");
    const local = path.join(tmp, "feature-flags.local.json");
    writeFileSync(committed, JSON.stringify(COMMITTED_FEATURES));
    writeFileSync(local, JSON.stringify({ features: { pngRasterization: true, typo: true, profiles: { x: 1 } } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(resolvePlatformFeatures(committed, local)).toEqual({
      features: { dialExtendedGestures: true, profiles: false, pngRasterization: true },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[platform-features] feature-flags.local.json has unknown keys (ignored): features.typo, features.profiles",
    );
  });
});
