import nodeResolve from "@rollup/plugin-node-resolve";

/**
 * What a Property Inspector browser bundle may import, for `rollup.config.mjs`.
 * Kept out of the config so `browser-import-guard.test.ts` can bundle a fixture
 * through the same plugins and prove the guard fires (#1375).
 */

/**
 * The only package imports a browser bundle may make (#1277, spec #1351):
 * the two dependency-free leaves, `@iracedeck/app-constants` (the key map,
 * the default parser, the shared setting keys and value sets) and
 * `@iracedeck/fetch-utils` (the request deadline), each built against the DOM
 * lib with no Node types so it runs in a WebView as it is. Their `exports`
 * point at the built `dist/index.js`, which turbo builds first because both
 * are dependencies of this package. node-resolve's `resolveOnly` matches
 * package NAMES, not subpaths, so it narrows resolution to those two and
 * leaves every other bare import unresolved (fatal, see `onLog`); the guard in
 * front of it refuses every other `@iracedeck/` import, any subpath of the two
 * leaves included, so no workspace package built for Node (deck-core and
 * settings today, the packages #1351 splits out next) can be followed into a
 * Property Inspector. It is an allowlist rather than a list of refused names
 * so a new package needs no edit here, and it names the offending import
 * instead of leaving it to a later, vaguer MISSING_GLOBAL_NAME.
 */
export const BROWSER_SAFE_PACKAGES = ["@iracedeck/app-constants", "@iracedeck/fetch-utils"];

/** The guard's plugin name, which a refusal carries as `RollupError.plugin`. */
export const BROWSER_IMPORT_GUARD = "browser-import-guard";

/** The plugins that resolve a browser bundle's package imports: the guard, then node-resolve. */
export const resolveBrowserImports = () => [
  {
    name: BROWSER_IMPORT_GUARD,
    resolveId(source) {
      if (source.startsWith("@iracedeck/") && !BROWSER_SAFE_PACKAGES.includes(source)) {
        this.error(
          `"${source}" is not browser-safe: a Property Inspector bundle may import only ${BROWSER_SAFE_PACKAGES.join(" and ")}, each by its bare name`,
        );
      }

      return null;
    },
  },
  nodeResolve({ browser: true, resolveOnly: BROWSER_SAFE_PACKAGES }),
];

/**
 * An import the bundle cannot resolve would otherwise be left as an IIFE
 * global that does not exist in the PI page — a warning on a green build and a
 * dead Property Inspector at runtime. Fail instead.
 */
const FATAL_LOG_CODES = new Set(["UNRESOLVED_IMPORT", "MISSING_GLOBAL_NAME"]);

/** Rollup `onLog` for every browser bundle: the codes above become build errors. */
export const onLog = (level, log, handler) => {
  if (FATAL_LOG_CODES.has(log.code)) {
    handler("error", log);

    return;
  }

  handler(level, log);
};
