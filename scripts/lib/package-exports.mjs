/**
 * Resolving a workspace package's `exports` the way a test's `import` does,
 * shared by `scripts/vitest-alias-coverage.test.mjs` and
 * `scripts/testing-entries-test-only.test.mjs` (#1375), and the source each
 * package's `./testing` entry is built from, which that guard and
 * `packages/replay-engine/src/index.test.ts`'s barrel consumer check (#1661)
 * both leave out of production code.
 */
import path from "node:path";

const P = path.posix;

/**
 * The export conditions active when a test `import`s a workspace package.
 * Vitest resolves it through Vite's server environment, whose conditions are
 * Vite's `defaultServerConditions` less `module` — `node` and
 * `development|production`, which is `development` under test — plus the
 * `import` and `default` Vite adds for an ESM import. `require` is not here:
 * Vite activates it only for a CommonJS `require()` call, and a test's import
 * of `@iracedeck/*` is ESM, so `{ "require": "./dist/x.cjs", "import": … }`
 * resolves to the `import` target. `types` is TypeScript's, never a runtime
 * condition. The set has no order: see `pickTarget`.
 */
export const IMPORT_CONDITIONS = new Set(["import", "node", "development", "default"]);

/**
 * The file an `exports` value resolves to for a test's `import`, or null.
 *
 * A conditions object resolves the way Node and Vite resolve it: by the
 * OBJECT's key order, taking the first key in the active set and recursing
 * into its value, so `{ "node": "./dist/x.js", "import": "./src/x.ts" }` is
 * dist. Walking the active set in an order of its own instead would class that
 * as source. A key whose value yields nothing (a nested object with no active
 * key) falls through to the next, as in Node.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function pickTarget(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = pickTarget(v);
      if (t) return t;
    }

    return null;
  }

  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (IMPORT_CONDITIONS.has(key)) {
        const t = pickTarget(value[key]);
        if (t) return t;
      }
    }
  }

  return null;
}

/** The source extension each compiled `dist/` extension is built from. */
const SOURCE_EXTENSION = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts" };

/**
 * The source file a package's `./testing` export is built from, repo-relative,
 * or undefined when it declares none. The target is resolved through nested
 * conditions as a test's `import` resolves it (`pickTarget`); `./dist/<x>.js`
 * then maps to `src/<x>.ts`, the layout every package building to `dist/`
 * shares, and a source export is taken as it is.
 *
 * Throws when the package declares `./testing` but no file can be derived from
 * it, so an entry never drops out of the guard unseen.
 *
 * @param {string} dir the package's directory under `packages/`
 * @param {{ exports?: unknown }} manifest
 * @returns {string | undefined}
 */
export function testingEntrySource(dir, manifest) {
  const { exports } = manifest;
  const target =
    exports !== null && typeof exports === "object" && !Array.isArray(exports) ? exports["./testing"] : undefined;

  // `null` is Node's way of saying the subpath is not exported.
  if (target === undefined || target === null) return undefined;
  const file = pickTarget(target);

  if (file === null) {
    throw new Error(
      `packages/${dir}/package.json declares a ./testing export (${JSON.stringify(target)}) with no import, node, ` +
        `development or default target: give it one, or teach testingEntrySource this shape`,
    );
  }

  const relative = P.normalize(file.replaceAll("\\", "/"));

  if (!relative.startsWith("dist/")) return P.join("packages", dir, relative);
  const extension = P.extname(relative);

  if (!Object.hasOwn(SOURCE_EXTENSION, extension)) {
    throw new Error(
      `packages/${dir}/package.json's ./testing export ${file} is a dist/ file whose source cannot be derived: ` +
        `teach testingEntrySource its extension`,
    );
  }

  return P.join(
    "packages",
    dir,
    `src/${relative.slice("dist/".length, -extension.length)}${SOURCE_EXTENSION[extension]}`,
  );
}

/**
 * Each package's testing entry source, and one line for every package whose
 * `./testing` export names no source file, or one git does not track.
 *
 * @param {string[]} dirs package directories under `packages/`
 * @param {(dir: string) => { exports?: unknown }} manifestOf
 * @param {Set<string>} tracked every tracked package source
 * @returns {{ sources: Set<string>, problems: string[] }}
 */
export function testingEntrySources(dirs, manifestOf, tracked) {
  const sources = new Set();
  const problems = [];

  for (const dir of dirs) {
    let source;

    try {
      source = testingEntrySource(dir, manifestOf(dir));
    } catch (error) {
      problems.push(error.message);
      continue;
    }

    if (source === undefined) continue;
    if (!tracked.has(source)) {
      problems.push(
        `packages/${dir}/package.json's ./testing export is built from ${source}, which git does not track as a ` +
          `package source: fix the export, or teach testingEntrySource the package's layout`,
      );
      continue;
    }

    sources.add(source);
  }

  return { sources, problems };
}
