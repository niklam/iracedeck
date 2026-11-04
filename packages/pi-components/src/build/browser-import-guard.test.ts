import path from "node:path";
import url from "node:url";
import { type OutputChunk, type Plugin, rollup, type RollupError, type RollupOptions } from "rollup";
import { describe, expect, it, vi } from "vitest";

import rollupConfig from "../../rollup.config.mjs";
import { BROWSER_IMPORT_GUARD, BROWSER_SAFE_PACKAGES, onLog, resolveBrowserImports } from "./browser-import-guard.mjs";

// The config builds its TypeScript plugins when imported, from tsconfig paths
// relative to the package directory that `rollup -c` runs in; the suite runs
// from the repo root. The wiring checks below need only the plugin names.
vi.mock("@rollup/plugin-typescript", () => ({ default: () => ({ name: "typescript" }) }));

/**
 * Positive control for the browser-import guard (#1375). The guard is the only
 * thing that keeps a Node-built workspace package out of a Property Inspector
 * bundle, and until this file nothing showed that it fires: a guard that never
 * matched would leave the build exactly as green.
 *
 * Each case bundles a one-line fixture through the real plugins with Rollup
 * itself. The fixture is served from memory under a path inside this package,
 * so node-resolve looks for packages from here exactly as it does for
 * `src/components/index.ts`: through this package's `node_modules`, where the
 * two browser-safe leaves are linked and built.
 */

/** Where the in-memory entry claims to live: beside this file, inside the package. */
const ENTRY = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "__browser-import-guard-fixture__.js");

function fixture(code: string): Plugin {
  return {
    name: "fixture-entry",
    resolveId(source) {
      return source === ENTRY ? ENTRY : null;
    },
    load(id) {
      return id === ENTRY ? code : null;
    },
  };
}

/**
 * Bundles `code` the way `rollup.config.mjs` bundles `pi-components.js`, minus
 * TypeScript and terser: the same resolving plugins, the same `onLog`, the same
 * IIFE output.
 */
async function bundle(code: string, logHandler: RollupOptions["onLog"] = onLog): Promise<OutputChunk> {
  const build = await rollup({ input: ENTRY, onLog: logHandler, plugins: [fixture(code), ...resolveBrowserImports()] });

  try {
    const { output } = await build.generate({ format: "iife", name: "Fixture" });

    return output[0];
  } finally {
    await build.close();
  }
}

/** The error `bundle(code)` rejects with; fails the test if it builds. */
async function bundleError(code: string): Promise<RollupError> {
  try {
    await bundle(code);
  } catch (error) {
    return error as RollupError;
  }

  throw new Error("expected the bundle to be refused, but it built");
}

describe("browser-import guard (#1375)", () => {
  it("refuses a workspace package that is not browser-safe, naming it", async () => {
    const error = await bundleError(
      'import { GlobalSettingsSchema } from "@iracedeck/settings";\nconsole.log(GlobalSettingsSchema);',
    );

    expect(error.plugin).toBe(BROWSER_IMPORT_GUARD);
    expect(error.message).toContain('"@iracedeck/settings" is not browser-safe');
    expect(error.message).toContain("@iracedeck/app-constants and @iracedeck/fetch-utils, each by its bare name");
  });

  it("refuses a workspace package this package does not depend on", async () => {
    const error = await bundleError('import { x } from "@iracedeck/deck-core";\nconsole.log(x);');

    expect(error.plugin).toBe(BROWSER_IMPORT_GUARD);
    expect(error.message).toContain('"@iracedeck/deck-core" is not browser-safe');
  });

  it("refuses a subpath of a browser-safe package: only the bare name is allowed", async () => {
    const error = await bundleError(
      'import { PROFILE_CAPTURE_STATUS_KEY } from "@iracedeck/app-constants/dist/index.js";\nconsole.log(PROFILE_CAPTURE_STATUS_KEY);',
    );

    expect(error.plugin).toBe(BROWSER_IMPORT_GUARD);
    expect(error.message).toContain('"@iracedeck/app-constants/dist/index.js" is not browser-safe');
  });

  it("bundles the browser-safe packages by their bare names, inlining them", async () => {
    const chunk = await bundle(
      'import { PROFILE_CAPTURE_STATUS_KEY } from "@iracedeck/app-constants";\nimport { abortAfter } from "@iracedeck/fetch-utils";\nconsole.log(PROFILE_CAPTURE_STATUS_KEY, abortAfter);',
    );

    expect(chunk.code).toContain('"_profileCaptureStatus"');
    expect(chunk.code).toContain("function abortAfter");
    // Nothing left for the page to supply: an external would be an IIFE global.
    expect(chunk.imports).toEqual([]);
  });

  it("bundles an entry that imports no package at all", async () => {
    const chunk = await bundle('console.log("no imports");');

    expect(chunk.code).toContain('"no imports"');
    expect(chunk.imports).toEqual([]);
  });

  describe("a bare import outside @iracedeck/", () => {
    const LEFT_PAD = 'import { x } from "left-pad";\nconsole.log(x);';

    it("passes the guard, is left unresolved by node-resolve, and onLog makes that fatal", async () => {
      const error = await bundleError(LEFT_PAD);

      expect(error.plugin).not.toBe(BROWSER_IMPORT_GUARD);
      // Rollup 4 leaves an unresolved bare import external without a log and
      // reports it at output as a missing IIFE global; onLog makes either code fatal.
      expect(["UNRESOLVED_IMPORT", "MISSING_GLOBAL_NAME"]).toContain(error.code);
      expect(error.message).toContain("left-pad");
    });

    it("would build without onLog, so onLog is what refuses it", async () => {
      const chunk = await bundle(LEFT_PAD, () => {});

      expect(chunk.imports).toEqual(["left-pad"]);
    });
  });

  it("allows exactly the two dependency-free leaves", () => {
    expect(BROWSER_SAFE_PACKAGES).toEqual(["@iracedeck/app-constants", "@iracedeck/fetch-utils"]);
  });
});

describe("rollup.config.mjs wiring", () => {
  const bundles = Array.isArray(rollupConfig) ? rollupConfig : [rollupConfig];
  const pluginNames = (plugins: unknown): string[] =>
    (Array.isArray(plugins) ? plugins : [plugins]).flat().map((plugin) => (plugin as Plugin).name);
  const cases = bundles.map((options) => [String(options.input), options] as const);

  it("builds the four PI bundles", () => {
    expect(bundles).toHaveLength(4);
  });

  it.each(cases)("%s fails on an unresolved import", (_input, options) => {
    expect(options.onLog).toBe(onLog);
  });

  it.each(cases)("%s resolves packages only behind the guard", (_input, options) => {
    const names = pluginNames(options.plugins);
    const resolver = names.indexOf("node-resolve");

    if (resolver < 0) return;

    expect(names.indexOf(BROWSER_IMPORT_GUARD)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(BROWSER_IMPORT_GUARD)).toBeLessThan(resolver);
  });

  it("guards the components bundle, the one that resolves packages", () => {
    const components = bundles.find((options) => options.input === "src/components/index.ts");

    expect(pluginNames(components?.plugins)).toEqual(expect.arrayContaining([BROWSER_IMPORT_GUARD, "node-resolve"]));
  });
});
