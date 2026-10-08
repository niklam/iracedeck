/**
 * The Rollup log policy shared by the three plugin builds (#1176).
 *
 * Three layers: the policy on synthesised logs (cheap, covers every branch), the
 * policy inside a real Rollup run (proves `handler("error", …)` actually fails a
 * build in the Rollup the plugins use, rather than trusting the docs), and two
 * guards on the world outside this file — that zod still carries the comments
 * the filter exists for, and that every plugin build is wired to the helper.
 *
 * Since #1349 the wiring lives in one place: `@iracedeck/plugin-build`'s
 * `createPluginRollupConfig` sets `onLog`, and each plugin's `rollup.config.mjs`
 * only calls it. So the wiring guard reads the factory once, then checks that
 * every plugin config calls it, declares the package (which orders and
 * invalidates its build), and sets no log handler of its own.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { pluginConfigShapeProblems } from "./plugin-config-shape.mjs";
import { isInsidePackage, isWorkspaceSource, pluginBuildOnLog, REPO_ROOT } from "./rollup-logs.mjs";
import { allPluginManifestRelPaths } from "./version-discovery.mjs";

/** Plugin package directory names, discovered from the committed manifests like the other plugin guards. */
const PLUGIN_PACKAGES = [...new Set(allPluginManifestRelPaths(REPO_ROOT).map((relPath) => relPath.split("/")[1]))];

/** Absolute id of a (possibly imaginary) file, joined onto the real repo root so the workspace check applies. */
const repoFile = (...segments) => join(REPO_ROOT, ...segments);

const ZOD_UTIL = repoFile("node_modules", ".pnpm", "zod@4.5.4", "node_modules", "zod", "v4", "core", "util.js");
const ZOD_UTIL_POSIX = "/home/ci/repo/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/util.js";
const ZOD_UTIL_WIN = "C:\\repo\\node_modules\\.pnpm\\zod@4.5.4\\node_modules\\zod\\v4\\core\\util.js";

/** Run the policy on one log and report what reached the default handler. */
function route(level, log) {
  const handler = vi.fn();
  pluginBuildOnLog(level, log, handler);
  return handler.mock.calls;
}

describe("isInsidePackage", () => {
  it("matches a module inside the package with either separator", () => {
    expect(isInsidePackage(ZOD_UTIL_POSIX, "zod")).toBe(true);
    expect(isInsidePackage(ZOD_UTIL_WIN, "zod")).toBe(true);
  });

  it("does not match a package whose name merely starts with it, or a workspace folder of that name", () => {
    expect(isInsidePackage("/repo/node_modules/zod-extra/index.js", "zod")).toBe(false);
    expect(isInsidePackage("/repo/packages/zod/index.js", "zod")).toBe(false);
    expect(isInsidePackage(undefined, "zod")).toBe(false);
  });

  it("handles a scoped package name", () => {
    expect(isInsidePackage("C:\\r\\node_modules\\@scope\\pkg\\a.js", "@scope/pkg")).toBe(true);
    expect(isInsidePackage("/r/node_modules/@scope/pkg/a.js", "@scope/pkg")).toBe(true);
    expect(isInsidePackage("/r/node_modules/@scope/other/a.js", "@scope/pkg")).toBe(false);
  });
});

describe("isWorkspaceSource", () => {
  it("accepts a file inside the repo and outside node_modules", () => {
    expect(isWorkspaceSource(repoFile("packages", "deck-core", "dist", "sdk-singleton.js"))).toBe(true);
  });

  it("rejects a dependency, a virtual id, a relative id and a path outside the repo", () => {
    expect(isWorkspaceSource(ZOD_UTIL)).toBe(false);
    expect(isWorkspaceSource("\0commonjsHelpers.js")).toBe(false);
    expect(isWorkspaceSource("packages/deck-core/dist/a.js")).toBe(false);
    expect(isWorkspaceSource(join(dirname(REPO_ROOT), "elsewhere", "a.js"))).toBe(false);
    expect(isWorkspaceSource(REPO_ROOT)).toBe(false);
  });
});

describe("pluginBuildOnLog", () => {
  describe("INVALID_ANNOTATION", () => {
    it("drops it when the module is inside zod", () => {
      expect(route("warn", { code: "INVALID_ANNOTATION", id: ZOD_UTIL_WIN, message: "m" })).toEqual([]);
      expect(route("warn", { code: "INVALID_ANNOTATION", id: ZOD_UTIL_POSIX, message: "m" })).toEqual([]);
    });

    it("keeps the same code from our own sources", () => {
      const log = { code: "INVALID_ANNOTATION", id: repoFile("packages", "deck-core", "src", "a.ts"), message: "m" };
      expect(route("warn", log)).toEqual([["warn", log]]);
    });

    it("keeps the same code from any other dependency", () => {
      const log = { code: "INVALID_ANNOTATION", id: "/r/node_modules/zod-extra/a.js", message: "m" };
      expect(route("warn", log)).toEqual([["warn", log]]);
    });

    it("keeps it when Rollup gives no module id", () => {
      const log = { code: "INVALID_ANNOTATION", message: "m" };
      expect(route("warn", log)).toEqual([["warn", log]]);
    });
  });

  describe("CIRCULAR_DEPENDENCY", () => {
    const workspaceCycle = [
      repoFile("packages", "deck-core", "dist", "sdk-singleton.js"),
      repoFile("packages", "deck-core", "dist", "window-focus-service.js"),
      repoFile("packages", "deck-core", "dist", "sdk-singleton.js"),
    ];

    it("promotes a cycle among workspace sources to an error, keeping Rollup's own text", () => {
      const log = { code: "CIRCULAR_DEPENDENCY", ids: workspaceCycle, message: "Circular dependency: a -> b -> a" };
      const calls = route("warn", log);
      expect(calls).toHaveLength(1);
      const [level, promoted] = calls[0];
      expect(level).toBe("error");
      expect(promoted.code).toBe("CIRCULAR_DEPENDENCY");
      expect(promoted.ids).toEqual(workspaceCycle);
      expect(promoted.message).toMatch(/^Circular dependency: a -> b -> a\n/);
      expect(promoted.message).toContain("plugin-structure.md");
    });

    it("keeps a cycle that touches another dependency as a warning", () => {
      const log = {
        code: "CIRCULAR_DEPENDENCY",
        ids: [workspaceCycle[0], "/r/node_modules/some-dep/a.js", workspaceCycle[0]],
        message: "m",
      };
      expect(route("warn", log)).toEqual([["warn", log]]);
    });

    it("keeps a cycle through a virtual module as a warning", () => {
      const log = {
        code: "CIRCULAR_DEPENDENCY",
        ids: [workspaceCycle[0], "\0virtual", workspaceCycle[0]],
        message: "m",
      };
      expect(route("warn", log)).toEqual([["warn", log]]);
    });

    it("drops zod's and semver's internal cycles, as the configs always have", () => {
      for (const pkg of ["zod", "semver"]) {
        const a = `/r/node_modules/${pkg}/a.js`;
        const b = `C:\\r\\node_modules\\${pkg}\\b.js`;
        expect(route("warn", { code: "CIRCULAR_DEPENDENCY", ids: [a, b, a], message: "m" })).toEqual([]);
      }
    });

    it("keeps a cycle that only passes through zod or semver, rather than dropping it as theirs", () => {
      for (const pkg of ["zod", "semver"]) {
        const log = {
          code: "CIRCULAR_DEPENDENCY",
          ids: [workspaceCycle[0], `/r/node_modules/${pkg}/a.js`, workspaceCycle[0]],
          message: "m",
        };
        expect(route("warn", log)).toEqual([["warn", log]]);
      }
    });

    it("keeps a cycle spanning zod AND semver, since neither package owns it", () => {
      const log = {
        code: "CIRCULAR_DEPENDENCY",
        ids: ["/r/node_modules/zod/a.js", "/r/node_modules/semver/b.js", "/r/node_modules/zod/a.js"],
        message: "m",
      };
      expect(route("warn", log)).toEqual([["warn", log]]);
    });

    it("keeps a malformed log with no ids as a warning rather than failing on it", () => {
      const log = { code: "CIRCULAR_DEPENDENCY", message: "m" };
      expect(route("warn", log)).toEqual([["warn", log]]);
    });
  });

  it("passes every other log through at its own level", () => {
    const info = { code: "PLUGIN_LOG", message: "Copied PI browser assets" };
    const warn = { code: "UNRESOLVED_IMPORT", id: ZOD_UTIL, message: "m" };
    expect(route("info", info)).toEqual([["info", info]]);
    expect(route("warn", warn)).toEqual([["warn", warn]]);
  });
});

/** Everything a workspace package resolves for itself — for a plugin, the same modules its build uses. */
function packageRequire(pkg) {
  return createRequire(join(REPO_ROOT, "packages", pkg, "package.json"));
}

/** The plugins' own Rollup, loaded through its ESM entry. */
async function loadRollup() {
  const rollupDir = dirname(packageRequire(PLUGIN_PACKAGES[0]).resolve("rollup/package.json"));
  return import(pathToFileURL(join(rollupDir, "dist", "es", "rollup.js")).href);
}

/**
 * Bundle in-memory modules through the real Rollup with the real policy.
 *
 * @param {Record<string, string>} modules absolute id → source; the first entry is the input
 */
async function bundleWithPolicy(modules) {
  const { rollup } = await loadRollup();
  const ids = Object.keys(modules);
  const passed = [];
  const bundle = await rollup({
    input: ids[0],
    // Record what the policy lets through; only an error goes on to Rollup's own
    // handler (to fail the build) — a passed-through warning would just print.
    onLog: (level, log, handler) =>
      pluginBuildOnLog(level, log, (lvl, l) => {
        passed.push([lvl, l]);
        if (lvl === "error") handler(lvl, l);
      }),
    plugins: [
      {
        name: "in-memory",
        resolveId(source, importer) {
          if (modules[source] !== undefined) return source;
          if (importer) return ids.find((id) => id.endsWith(source.replace(/^\.\//, "")));
          return null;
        },
        load: (id) => modules[id],
      },
    ],
  });
  await bundle.close();
  return passed;
}

describe("the policy inside a real Rollup build", () => {
  it("fails the build on a cycle among workspace sources", async () => {
    const a = repoFile("packages", "__rollup_logs_fixture__", "a.js");
    const b = repoFile("packages", "__rollup_logs_fixture__", "b.js");
    await expect(
      bundleWithPolicy({
        [a]: 'import { b } from "./b.js"; export const a = () => b();',
        [b]: 'import { a } from "./a.js"; export const b = () => a;',
      }),
    ).rejects.toMatchObject({ code: "CIRCULAR_DEPENDENCY" });
  }, 30_000);

  it("still builds, with the warning passed through, when the cycle runs through a dependency", async () => {
    const a = repoFile("packages", "__rollup_logs_fixture__", "a.js");
    const b = repoFile("node_modules", "__rollup_logs_fixture__", "b.js");
    const passed = await bundleWithPolicy({
      [a]: 'import { b } from "./b.js"; export const a = () => b();',
      [b]: 'import { a } from "./a.js"; export const b = () => a;',
    });
    expect(passed.filter(([, log]) => log.code === "CIRCULAR_DEPENDENCY").map(([level]) => level)).toEqual(["warn"]);
  }, 30_000);
});

/** Every workspace package by name: its directory under packages/ and its parsed package.json. */
const WORKSPACE_PACKAGES = new Map(
  readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(REPO_ROOT, "packages", entry.name, "package.json")))
    .map((entry) => {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "packages", entry.name, "package.json"), "utf-8"));
      return [manifest.name, { dir: entry.name, manifest }];
    }),
);

/**
 * The workspace packages whose zod a plugin bundle can contain: every package in
 * the plugins' runtime closure (`dependencies`, followed through `workspace:`
 * links) that declares zod itself. Rollup's node-resolve resolves `zod` from the
 * importing file, so these are the packages a bundled zod is resolved from —
 * deck-core, iracing-actions, callout-script, audio-assets, app-updates and settings-window today. The plugin
 * packages are not the place to ask: since #1349 Mirabox and Ulanzi declare no
 * zod, and resolving it from them would only reach whatever pnpm hoisted.
 */
const ZOD_DECLARERS = (() => {
  const seen = new Set();
  const queue = PLUGIN_PACKAGES.map(
    (pkg) => JSON.parse(readFileSync(join(REPO_ROOT, "packages", pkg, "package.json"), "utf-8")).name,
  );
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const [dep, range] of Object.entries(WORKSPACE_PACKAGES.get(name).manifest.dependencies ?? {})) {
      if (range.startsWith("workspace:")) queue.push(dep);
    }
  }
  return [...seen].filter((name) => WORKSPACE_PACKAGES.get(name).manifest.dependencies?.zod !== undefined);
})();

/** The distinct zod installations those packages resolve, with plain Node resolution. */
const PLUGIN_ZODS = [
  ...new Map(
    ZOD_DECLARERS.map((name) => {
      const zodDir = dirname(
        realpathSync(packageRequire(WORKSPACE_PACKAGES.get(name).dir).resolve("zod/package.json")),
      );
      const { version } = JSON.parse(readFileSync(join(zodDir, "package.json"), "utf-8"));
      return [zodDir, { zodDir, version }];
    }),
  ).values(),
];

describe("zod still carries the comments the INVALID_ANNOTATION filter exists for", () => {
  it("finds the bundled packages that declare zod, among them the actions that import it most", () => {
    expect(ZOD_DECLARERS).toContain("@iracedeck/iracing-actions");
    expect(ZOD_DECLARERS).toContain("@iracedeck/deck-core");
  });

  it("resolves at least one zod from them", () => {
    expect(PLUGIN_ZODS.length).toBeGreaterThan(0);
  });

  it.each(PLUGIN_ZODS)(
    "zod $version",
    async ({ zodDir, version }) => {
      const { rollup } = await loadRollup();
      const logs = [];
      const bundle = await rollup({ input: join(zodDir, "index.js"), onLog: (level, log) => logs.push([level, log]) });
      await bundle.close();

      const fromZod = logs.filter(([, log]) => log.code === "INVALID_ANNOTATION" && log.id?.startsWith(zodDir));
      expect(
        fromZod.length,
        `zod ${version} no longer makes Rollup log INVALID_ANNOTATION — its prose \`@__PURE__\` comments are gone. ` +
          `Remove "zod" from ANNOTATION_NOISE_PACKAGES in scripts/lib/rollup-logs.mjs (and this guard with it).`,
      ).toBeGreaterThan(0);

      // And the policy the plugins run drops every one of them.
      for (const [level, log] of fromZod) expect(route(level, log)).toEqual([]);
    },
    60_000,
  );
});

describe("every plugin build is wired to the policy", () => {
  const turbo = JSON.parse(readFileSync(join(REPO_ROOT, "turbo.json"), "utf-8"));
  const FACTORY_SOURCE = readFileSync(join(REPO_ROOT, "packages", "plugin-build", "src", "plugin-rollup.mjs"), "utf-8");

  it("discovers the three plugin packages (an empty list would skip every check below)", () => {
    expect(PLUGIN_PACKAGES.length).toBeGreaterThanOrEqual(3);
  });

  describe("the shared factory (@iracedeck/plugin-build)", () => {
    it("imports the helper and uses it as onLog", () => {
      expect(FACTORY_SOURCE).toContain('import { pluginBuildOnLog } from "../../../scripts/lib/rollup-logs.mjs";');
      expect(FACTORY_SOURCE).toContain("onLog: pluginBuildOnLog,");
    });

    it("keeps no onwarn, so the policy is the one place a plugin build filters logs", () => {
      expect(FACTORY_SOURCE).not.toMatch(/\bonwarn\b/);
    });
  });

  describe.each(PLUGIN_PACKAGES)("%s", (pkg) => {
    const source = readFileSync(join(REPO_ROOT, "packages", pkg, "rollup.config.mjs"), "utf-8");
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "packages", pkg, "package.json"), "utf-8"));
    const { name } = packageJson;

    it("builds through the shared factory, and declares it (which orders and invalidates its build)", () => {
      expect(pluginConfigShapeProblems(source, packageJson)).toEqual([]);
    });

    it("sets no log handler of its own, so the factory's policy is the only one", () => {
      expect(source).not.toMatch(/\bonwarn\b/);
      expect(source).not.toMatch(/\bonLog\b/);
    });

    it("hashes the helper as a turbo build input, so a policy change is never served from the cache", () => {
      // The factory reads the helper by relative path, so it is hashed here by path
      // rather than through a package dependency.
      expect(turbo.tasks[`${name}#build`]?.inputs).toContain("$TURBO_ROOT$/scripts/lib/rollup-logs.mjs");
    });
  });
});
