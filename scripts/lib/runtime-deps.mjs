/**
 * The runtime `package.json` every plugin ships next to `bin/plugin.js` (#1177).
 *
 * Rollup leaves a module out of the bundle when the config lists it under
 * `external`, and the installed plugin's `bin/` then runs `npm install` against
 * the `package.json` this module emits to get it back. Its versions used to be
 * string literals in three rollup configs, which Dependabot cannot see, so they
 * drifted from what the workspace builds and tests against — a `yaml` the
 * workspace had moved past, and a `ws` on Mirabox inside a published advisory.
 *
 * So nothing here is typed by hand. The dependency list IS the config's
 * `external` array (an external the bin does not install fails at runtime, so
 * the two lists could never legitimately differ), and each version is read from
 * the workspace `package.json` that declares it:
 *
 * - an `@iracedeck/*` external is a workspace package, linked with a `file:`
 *   path from the bin folder to its package directory;
 * - any other external must be declared, at one exact version, by at least one
 *   workspace `package.json` — the root or a `packages/*` package — in
 *   `dependencies`, `optionalDependencies` or `devDependencies`. It ships under
 *   `optionalDependencies` when every declaration is optional, and under
 *   `dependencies` otherwise.
 *
 * Every other case THROWS, naming the package and the files involved. A silent
 * fallback — a default version, the first declaration found — is exactly how the
 * drift this exists to end came about. `peerDependencies` are not declarations:
 * they name a range some other package is expected to supply, not a version
 * this workspace installs.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The `package.json` sections that install a version in the workspace. */
export const DECLARING_SECTIONS = ["dependencies", "optionalDependencies", "devDependencies"];

/** The scope every workspace package is published under. */
export const WORKSPACE_SCOPE = "@iracedeck/";

/** An exact semver, as `save-exact` writes it. A range would let `npm install` pick an untested version. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Every workspace `package.json`: the root one, then one per `packages/*`
 * directory that has one. `pnpm-workspace.yaml` names `packages/*` and nothing
 * else — the guard test pins that, so this walk stays exhaustive.
 *
 * @param {string} root Repo root.
 * @returns {{ file: string, dir: string, manifest: Record<string, any> }[]} `file` is repo-relative and forward-slashed.
 */
export function readWorkspaceManifests(root) {
  const manifests = [{ file: "package.json", dir: root, manifest: readJson(path.join(root, "package.json")) }];

  const packagesDir = path.join(root, "packages");
  for (const name of readdirSync(packagesDir).sort()) {
    const dir = path.join(packagesDir, name);
    const file = path.join(dir, "package.json");
    if (!existsSync(file)) continue;

    manifests.push({ file: `packages/${name}/package.json`, dir, manifest: readJson(file) });
  }

  return manifests;
}

/**
 * Every workspace declaration of a third-party package.
 *
 * @param {{ file: string, manifest: Record<string, any> }[]} manifests From {@link readWorkspaceManifests}.
 * @param {string} name A package name.
 * @returns {{ file: string, section: string, version: string }[]}
 */
export function workspaceDeclarations(manifests, name) {
  const declarations = [];
  for (const { file, manifest } of manifests) {
    for (const section of DECLARING_SECTIONS) {
      const version = manifest[section]?.[name];
      if (version !== undefined) declarations.push({ file, section, version });
    }
  }

  return declarations;
}

/**
 * The runtime `package.json` for one plugin build.
 *
 * @param {object} options
 * @param {string} options.root Repo root.
 * @param {string} options.binDir Absolute path of the folder the `package.json` is written to (the bin folder).
 * @param {unknown} options.external The rollup config's `external` option — must be an array of package names.
 * @returns {{ type: "module", dependencies: Record<string, string>, optionalDependencies?: Record<string, string> }}
 */
export function runtimePackageJson({ root, binDir, external }) {
  if (!Array.isArray(external) || external.some((name) => typeof name !== "string")) {
    throw new Error(
      "runtime-deps: the rollup `external` option must be an array of package names — it is also the list of " +
        "packages the plugin's bin folder installs, so a function or a pattern cannot be turned into one",
    );
  }

  const manifests = readWorkspaceManifests(root);
  const dependencies = {};
  const optionalDependencies = {};

  for (const name of [...external].sort()) {
    if (name.startsWith(WORKSPACE_SCOPE)) {
      dependencies[name] = workspaceLink(manifests, name, binDir);
      continue;
    }

    const { version, optional } = declaredVersion(manifests, name);
    (optional ? optionalDependencies : dependencies)[name] = version;
  }

  return {
    type: "module",
    dependencies,
    ...(Object.keys(optionalDependencies).length > 0 ? { optionalDependencies } : {}),
  };
}

/**
 * The rollup plugin each plugin's config uses to emit that `package.json`.
 *
 * It reads `external` from the input options rather than taking a second list,
 * so what is left out of the bundle and what the bin installs cannot drift
 * apart, and it resolves `file:` links from the output file's folder, which is
 * where the asset lands. Every workspace manifest it reads is a watch file, so
 * `rollup -w` re-emits the file when a declared version changes — the watch
 * counterpart of the turbo inputs that make a normal build re-run.
 *
 * @param {{ root: string }} options Repo root.
 * @returns {import("rollup").Plugin}
 */
export function runtimePackageJsonPlugin({ root }) {
  let external;

  return {
    name: "emit-module-package-file",
    options(inputOptions) {
      external = inputOptions.external;

      return null;
    },
    buildStart() {
      for (const { dir } of readWorkspaceManifests(root)) {
        this.addWatchFile(path.join(dir, "package.json"));
      }
    },
    generateBundle(outputOptions) {
      if (typeof outputOptions.file !== "string") {
        this.error("runtime-deps: expected a single-file output (`output.file`) to place package.json beside");
      }

      const binDir = path.dirname(path.resolve(outputOptions.file));
      const pkg = runtimePackageJson({ root, binDir, external });
      this.emitFile({ fileName: "package.json", source: JSON.stringify(pkg, null, 2), type: "asset" });
    },
  };
}

function declaredVersion(manifests, name) {
  const declarations = workspaceDeclarations(manifests, name);
  if (declarations.length === 0) {
    throw new Error(
      `runtime-deps: "${name}" is a rollup external, so the plugin's bin folder installs it, but no workspace ` +
        `package.json declares it (looked in ${DECLARING_SECTIONS.join(", ")} of package.json and ` +
        `packages/*/package.json). Declare it, at an exact version, in the package whose code loads it.`,
    );
  }

  const versions = [...new Set(declarations.map((d) => d.version))];
  if (versions.length > 1) {
    const where = declarations.map((d) => `${d.file} (${d.section}): ${d.version}`).join("; ");
    throw new Error(
      `runtime-deps: "${name}" is declared at more than one version, so there is no single version to ship — ` +
        `align them: ${where}`,
    );
  }

  const [version] = versions;
  if (!EXACT_VERSION.test(version)) {
    const where = declarations.map((d) => `${d.file} (${d.section})`).join("; ");
    throw new Error(
      `runtime-deps: "${name}" is declared as "${version}", which is not an exact version, so the plugin would ` +
        `install whatever it resolves to on the user's machine rather than what was tested — pin it in: ${where}`,
    );
  }

  return { version, optional: declarations.every((d) => d.section === "optionalDependencies") };
}

function workspaceLink(manifests, name, binDir) {
  const owner = manifests.find(({ file, manifest }) => file !== "package.json" && manifest.name === name);
  if (owner === undefined) {
    throw new Error(
      `runtime-deps: "${name}" is a rollup external in the ${WORKSPACE_SCOPE} scope, but no packages/*/package.json ` +
        `is named "${name}", so there is no workspace package to link it to`,
    );
  }

  return `file:${path.relative(binDir, owner.dir).split(path.sep).join("/")}`;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`runtime-deps: cannot read ${file} (${err.message})`);
  }
}
