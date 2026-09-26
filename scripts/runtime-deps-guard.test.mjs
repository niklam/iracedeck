/**
 * The plugins ship the dependency versions the workspace tests (#1177).
 *
 * Each plugin's `bin/package.json` — what the installed plugin runs
 * `npm install` against — used to carry version literals typed into its rollup
 * config. Dependabot cannot see those, so they drifted: `yaml` stayed on a
 * version the workspace had moved past, and Mirabox's `ws` sat inside a
 * published advisory the workspace's own `ws` was clear of. The emitted file is
 * now produced by `scripts/lib/runtime-deps.mjs` from the config's `external`
 * array and the workspace `package.json` files; this guard holds the properties
 * that make that true, each one edit away from being lost:
 *
 * - every plugin config emits the file through the shared helper, and carries
 *   no version literal for any runtime dependency;
 * - for the real workspace, every third-party external resolves to the single
 *   exact version the workspace declares (checked here independently of the
 *   helper's own lookup), and the two native workspace packages keep their
 *   `file:` links;
 * - `keysender` — declared for Dependabot's sake by a package that never
 *   imports it statically — is optional, and pnpm is never told to compile it;
 * - the helper's walk covers the whole workspace, and turbo hashes what it reads;
 * - the `bin/` install runs through `install-runtime-deps.mjs`, so npm never sees
 *   the `npm_config_*` keys it does not define and warns about them (#1205).
 *
 * Shaped like `third-party-licenses.test.mjs`: the plugin list is discovered
 * from the committed manifests, so a fourth deck ecosystem is covered the day
 * its package appears.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { DECLARING_SECTIONS, runtimePackageJson, WORKSPACE_SCOPE } from "./lib/runtime-deps.mjs";
import { allPluginManifestRelPaths } from "./lib/version-discovery.mjs";

// scripts/runtime-deps-guard.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** [plugin package dir, package name, plugin folder] triples, discovered from the committed plugin manifests. */
const PLUGINS = allPluginManifestRelPaths(repoRoot).map((relPath) => {
  const [, pkg, folder] = relPath.split("/");
  const { name } = readJson(join(repoRoot, "packages", pkg, "package.json"));
  return [pkg, name, folder];
});

/** The `file:` links the two native workspace packages have always shipped with. */
const NATIVE_LINKS = {
  "@iracedeck/audio-native": "file:../../../audio-native",
  "@iracedeck/iracing-native": "file:../../../iracing-native",
};

const workspaceConfig = parseYaml(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf-8"));
const turbo = readJson(join(repoRoot, "turbo.json"));

/**
 * Every workspace declaration, gathered with a plain loop of this file's own
 * rather than the helper's lookup, so the version assertions below are not the
 * helper checking itself: name → [{ file, section, version }].
 */
const DECLARED = (() => {
  const files = [
    "package.json",
    ...readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/package.json`)
      .filter((file) => existsSync(join(repoRoot, file))),
  ];
  const declared = new Map();
  for (const file of files) {
    const manifest = readJson(join(repoRoot, file));
    for (const section of ["dependencies", "optionalDependencies", "devDependencies"]) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (!declared.has(name)) declared.set(name, []);
        declared.get(name).push({ file, section, version });
      }
    }
  }

  return declared;
})();

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf-8"));
}

/** The literal `external: [...]` array of a rollup config (the same parse `third-party-licenses.test.mjs` makes). */
function rollupExternals(configSource) {
  const match = configSource.match(/external:\s*\[([^\]]*)\]/);
  expect(match, "rollup config must declare a literal external array").not.toBeNull();

  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("plugins ship the workspace's runtime dependency versions (#1177)", () => {
  it("discovers every plugin package (an empty list would silently skip every per-plugin check)", () => {
    expect(PLUGINS.length).toBeGreaterThanOrEqual(3);
  });

  it("the helper's walk (root + packages/*) is the whole pnpm workspace", () => {
    // runtime-deps.mjs reads the root package.json and packages/*/package.json.
    // A second workspace glob would hold declarations it never sees.
    // Parsed, not scanned: the file also holds lists that are not globs (`minimumReleaseAgeExclude`).
    expect(workspaceConfig.packages).toEqual(["packages/*"]);
  });

  it("the independent declaration scan reads the same sections the helper does", () => {
    expect(DECLARING_SECTIONS).toEqual(["dependencies", "optionalDependencies", "devDependencies"]);
  });

  describe("keysender", () => {
    it("is declared in the workspace, and only ever under optionalDependencies", () => {
      // Its install script is `node-gyp rebuild` and it is Windows-only, so any
      // other section would make a workspace install depend on compiling it.
      const declarations = DECLARED.get("keysender") ?? [];
      expect(declarations.length, "keysender needs a declaration Dependabot can see").toBeGreaterThan(0);
      for (const { file, section } of declarations) {
        expect(section, `${file} declares keysender outside optionalDependencies`).toBe("optionalDependencies");
      }
    });

    it("is never built by pnpm (a workspace install must not compile it — it failed Linux CI before)", () => {
      // `true` compiles it; left out, pnpm fails every install on the undeclared build script.
      expect(workspaceConfig.allowBuilds?.keysender).toBe(false);
    });
  });

  describe.each(PLUGINS)("%s", (pkg, packageName, folder) => {
    const configSource = readFileSync(join(repoRoot, "packages", pkg, "rollup.config.mjs"), "utf-8");
    const externals = rollupExternals(configSource);
    const thirdParty = externals.filter((name) => !name.startsWith(WORKSPACE_SCOPE));
    const binDir = join(repoRoot, "packages", pkg, folder, "bin");

    it("has third-party externals (or every per-dependency check below is vacuous)", () => {
      expect(thirdParty.length).toBeGreaterThan(0);
    });

    it("emits bin/package.json through the shared helper", () => {
      expect(configSource).toContain(`import { runtimePackageJsonPlugin } from "../../scripts/lib/runtime-deps.mjs";`);
      expect(configSource).toContain("runtimePackageJsonPlugin({ root: repoRoot }),");
      // The hand-written step the helper replaced — a second emitter would
      // overwrite the helper's file with whatever it typed in.
      expect(configSource).not.toContain('name: "emit-module-package-file"');
    });

    it.each(thirdParty)("carries no hard-coded version for %s", (name) => {
      const quoted = `["']${escapeRegExp(name)}["']`;
      const bare = /^[A-Za-z_$][\w$]*$/.test(name) ? `|\\b${escapeRegExp(name)}\\b` : "";
      const literal = new RegExp(`(?:${quoted}${bare})\\s*:\\s*["'][~^<>=]*\\d`);
      expect(configSource, `${pkg}/rollup.config.mjs types a version for ${name}`).not.toMatch(literal);
    });

    it.each(thirdParty)("ships %s at the one version the workspace declares", (name) => {
      const declarations = DECLARED.get(name) ?? [];
      expect(declarations.length, `no workspace package.json declares ${name}`).toBeGreaterThan(0);
      const versions = [...new Set(declarations.map((d) => d.version))];
      expect(versions, `${name} is declared at more than one version`).toHaveLength(1);

      const pkgJson = runtimePackageJson({ root: repoRoot, binDir, external: externals });
      const shipped = pkgJson.dependencies[name] ?? pkgJson.optionalDependencies?.[name];
      expect(shipped).toBe(versions[0]);
    });

    it("installs exactly its externals, the native ones through their file: links", () => {
      const pkgJson = runtimePackageJson({ root: repoRoot, binDir, external: externals });
      const shipped = { ...pkgJson.dependencies, ...pkgJson.optionalDependencies };
      expect(Object.keys(shipped).sort()).toEqual([...externals].sort());

      for (const name of externals.filter((n) => n.startsWith(WORKSPACE_SCOPE))) {
        expect(NATIVE_LINKS, `${name} is a new workspace external — add its expected link here`).toHaveProperty(name);
        expect(pkgJson.dependencies[name]).toBe(NATIVE_LINKS[name]);
      }
    });

    it("installs keysender as optional, so a machine that cannot compile it still gets a working bin", () => {
      expect(externals).toContain("keysender");
      const pkgJson = runtimePackageJson({ root: repoRoot, binDir, external: externals });
      expect(pkgJson.optionalDependencies).toEqual({ keysender: DECLARED.get("keysender")[0].version });
    });

    it("installs bin/ through the shared script, which turbo hashes", () => {
      const { scripts } = readJson(join(repoRoot, "packages", pkg, "package.json"));
      expect(scripts.build).toMatch(/&& pnpm run postbuild$/);
      expect(scripts.postbuild).toBe(`node ../../scripts/install-runtime-deps.mjs ${folder}/bin`);

      const { inputs } = turbo.tasks[`${packageName}#build`];
      expect(inputs).toContain("$TURBO_ROOT$/scripts/install-runtime-deps.mjs");
      expect(inputs).toContain("$TURBO_ROOT$/scripts/lib/runtime-install-env.mjs");
    });

    it("turbo hashes everything the helper reads as an input of this plugin's build", () => {
      const task = turbo.tasks[`${packageName}#build`];
      expect(task, `turbo.json needs a "${packageName}#build" task`).toBeDefined();
      expect(task.inputs).toContain("$TURBO_DEFAULT$");
      expect(task.inputs).toContain("$TURBO_ROOT$/scripts/lib/runtime-deps.mjs");
      // The helper reads every workspace package.json — to find the declaring
      // package and to refuse a conflicting one — and a conflict can sit in a
      // package outside this plugin's dependency graph, which `^build` alone
      // would never re-hash.
      expect(task.inputs).toContain("$TURBO_ROOT$/package.json");
      expect(task.inputs).toContain("$TURBO_ROOT$/packages/*/package.json");
    });
  });
});
