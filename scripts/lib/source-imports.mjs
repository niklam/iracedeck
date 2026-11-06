/**
 * Reading what a workspace package's sources import and which of them are
 * tests, shared by the guards that hold the package boundaries (#1375):
 * `scripts/plugin-shell-dependencies.test.mjs`,
 * `scripts/cross-package-reach.test.mjs` and
 * `scripts/testing-entries-test-only.test.mjs`.
 *
 * Imports are read with TypeScript's own scanner (`ts.preProcessFile`), so a
 * comment can neither add nor hide one.
 */
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import ts from "typescript";

/** A JavaScript or TypeScript source, by extension. */
export const CODE = /\.[cm]?[jt]sx?$/;

/**
 * A test, or support that only tests load: `*.test.*`, `*.test-support.*`,
 * `*.test-util.*`, `*.fixture-cases.*`, and anything under a `test-support/`
 * folder. Takes a `/`-separated path.
 */
export const TEST = /\.test\.[cm]?[jt]sx?$|\.test-support\.|\.test-util\.|\.fixture-cases\.|(^|\/)test-support\//;

/** True when `file` (a `/`-separated path) is a test or test-only support. */
export function isTestSource(file) {
  return TEST.test(file);
}

/**
 * Tracked sources under `packages/` that are not ours to hold to a rule, each
 * with the reason. They are left out of {@link trackedPackageSources}.
 */
export const VENDORED_SOURCES = {
  "packages/pi-components/browser/sdpi-components.js":
    "the vendored, minified sdpi-components bundle (`sdpi-components.md`), copied in as published",
};

/** A path segment that holds build output or a plugin bundle rather than source. */
const NOT_SOURCE_SEGMENT = /^(dist|node_modules)$|\.sdPlugin$|\.ulanziPlugin$/;

/**
 * Every git-tracked JavaScript or TypeScript source under `packages/`,
 * repo-relative with `/` separators, sorted: no `dist/`, `node_modules/` or
 * plugin bundle folder (`*.sdPlugin/`, `*.ulanziPlugin/`), and none of
 * {@link VENDORED_SOURCES}.
 *
 * @param {string} root The repository root.
 * @returns {string[]}
 */
export function trackedPackageSources(root) {
  return execFileSync("git", ["ls-files", "packages"], { cwd: root, encoding: "utf-8" })
    .split("\n")
    .filter((file) => CODE.test(file))
    .filter((file) => !file.split("/").some((segment) => NOT_SOURCE_SEGMENT.test(segment)))
    .filter((file) => !Object.hasOwn(VENDORED_SOURCES, file))
    .sort();
}

/**
 * Every module `source` names: static, type-only, side-effect, re-export,
 * dynamic, `require` and `import("…")` types (`kind: "import"`, with `pos`
 * the offset of the specifier's opening quote), and triple-slash `path`
 * references (`kind: "reference"`, which sit in a comment and carry no `pos`).
 *
 * @param {string} source
 * @returns {({ specifier: string, kind: "import", pos: number } | { specifier: string, kind: "reference" })[]}
 */
export function moduleReferences(source) {
  const { importedFiles, referencedFiles } = ts.preProcessFile(source, true, true);

  return [
    ...importedFiles.map(({ fileName, pos }) => ({ specifier: fileName, kind: "import", pos })),
    ...referencedFiles.map(({ fileName }) => ({ specifier: fileName, kind: "reference" })),
  ];
}

/** The package a bare specifier names (`@scope/name/sub` → `@scope/name`), or null for a relative path or a Node builtin. */
export function packageOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];

  return builtinModules.includes(name) ? null : name;
}

/** The packages `source` imports: static, type-only, side-effect, re-export, dynamic and `require`. */
export function importedPackages(source) {
  return new Set(
    moduleReferences(source)
      .filter(({ kind }) => kind === "import")
      .map(({ specifier }) => packageOf(specifier))
      .filter((name) => name !== null),
  );
}
