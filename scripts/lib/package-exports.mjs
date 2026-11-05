/**
 * Resolving a workspace package's `exports` the way a test's `import` does,
 * shared by `scripts/vitest-alias-coverage.test.mjs` and
 * `scripts/testing-entries-test-only.test.mjs` (#1375).
 */

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
