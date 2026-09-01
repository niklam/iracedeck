import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// `Plugin` is a type-only export, so the `type` modifier is load-bearing: under
// `configLoader: 'native'` Node strips the types itself and cannot infer which
// named imports are types, so a plain `Plugin` becomes a value import of an
// export that does not exist. Vite's compatibility warning does not cover this.
import { defaultExclude, defineConfig, type Plugin } from "vitest/config";

/**
 * Vitest plugin to load SVG files as raw strings.
 * Matches the behavior of our Rollup svgPlugin.
 *
 * `enforce: 'pre'` runs the `load` hook ahead of Vite's default asset handling,
 * which would otherwise turn an SVG import into a URL.
 */
function svgPlugin(): Plugin {
  return {
    name: "svg-raw",
    enforce: "pre",
    load(id) {
      if (id.endsWith(".svg")) {
        const content = readFileSync(id, "utf-8");

        return `export default ${JSON.stringify(content)};`;
      }

      return null;
    },
  };
}

/**
 * Absolute path to a file inside a package, anchored on this config's own
 * directory rather than on the current working directory.
 *
 * Uses `import.meta.dirname` rather than `__dirname`: this file is an ES module,
 * where `__dirname` is not declared at all, so reading it throws a
 * `ReferenceError`. It only ever worked because Vite's default config loader
 * bundles the config and *defines* `__dirname` (and `import.meta.dirname`) as
 * this directory — regardless of the bundle's module format. Under
 * `configLoader: 'native'` there is no bundler and no such define.
 */
const packageSrc = (pkg: string, sub = "src/index.ts"): string => resolve(import.meta.dirname, "packages", pkg, sub);

export default defineConfig({
  plugins: [svgPlugin()],
  resolve: {
    alias: {
      "@iracedeck/audio-native": packageSrc("audio-native"),
      "@iracedeck/audio-scenarios/pit-crew": packageSrc("audio-scenarios", "src/catalog/pit-crew/index.ts"),
      "@iracedeck/audio-scenarios": packageSrc("audio-scenarios"),
      "@iracedeck/audio-service": packageSrc("audio-service"),
      "@iracedeck/deck-core": packageSrc("deck-core"),
      "@iracedeck/event-bus": packageSrc("event-bus"),
      "@iracedeck/icon-composer": packageSrc("icon-composer"),
      "@iracedeck/iracing-sdk": packageSrc("iracing-sdk"),
      "@iracedeck/iracing-native": packageSrc("iracing-native"),
      "@iracedeck/logger": packageSrc("logger"),
      "@iracedeck/sim-events-iracing": packageSrc("sim-events-iracing"),
    },
  },
  test: {
    globals: true,
    setupFiles: ["./test-setup.ts"],
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // `scripts/typecheck-script-coverage.test.mjs` proves a package's typecheck
    // really checks its tests by writing a file that cannot compile beside them,
    // running the package's own script, and deleting it again (#1086). The probe
    // has to be named `*.test.ts` to be included exactly the way a real test file
    // is — a probe the compiler picks up differently would prove a weaker claim
    // than the guard makes — which puts it squarely inside `include` above.
    //
    // The exact basename is excluded, never a pattern: a broad exclude that
    // quietly swallowed a genuine test file would be a worse version of the bug
    // being fixed. `defaultExclude` is spread rather than replaced, because
    // assigning `exclude` overrides vitest's defaults (node_modules, dist, …)
    // instead of adding to them.
    exclude: [...defaultExclude, "**/__typecheck_coverage_probe__.test.ts"],
    // Run the suite's WORKERS against the native mocks, never a compiled addon.
    //
    // `@iracedeck/iracing-native` `require()`s its `.node` in MODULE SCOPE, and
    // the same module re-exports `defines.ts` — so importing a plain TypeScript
    // enum such as `Flags` maps a native binary into the worker. Measured
    // 2026-09-01: 68 of the 301 `.test.ts` files reach that package through an
    // unmocked, non-type-only import, overwhelmingly via `@iracedeck/iracing-sdk`
    // -> `penalty-flag-utils.ts`. Nothing re-derives that number; it is dated
    // because it is a measurement rather than an invariant.
    //
    // `@iracedeck/audio-native` has the same module-scope load but is reached by
    // ZERO test files today — every test import of it is type-only, and
    // `audio-service` declares its own `AudioChannel`. The variable covers both
    // packages because it is one lever; only iracing-native is loaded in practice.
    //
    // Nothing in the suite wants either: no test constructs `IRacingNative` or
    // `AudioNative`, and the enums are identical under the mock. Loading a native
    // binary into test workers is wrong on its own terms, independent of any
    // failure it may or may not cause. It does NOT claim to fix #1084.
    //
    // Scope, three limits worth knowing:
    //   * WORKERS only. `config.env` never reaches the main Vitest process, so a
    //     future `globalSetup` or Vite plugin importing a barrel would still load
    //     the addon, outside everything this comment asserts.
    //   * It PROPAGATES to child processes. The `scripts/**/*.test.mjs` files in
    //     the include glob above shell out — `typecheck-script-coverage.test.mjs`
    //     runs a package's real typecheck script (#1086) — and those children
    //     inherit it. Inert today: none of them loads a native addon. A child
    //     that constructed a native class would silently run mocked.
    //   * The addon-loading branch in both packages now runs in no automated
    //     check at all — it was already skipped on Linux CI, and is now skipped
    //     locally too. Combined with the bare `catch {}` there, a broken path or
    //     an ABI-incompatible `.node` produces no signal from any test.
    //
    // Escape hatch: set `IRACEDECK_REAL_NATIVE=1` to load the real addon — needed
    // to reproduce #1084, or to check a freshly built `.node` loads at all. An
    // external `IRACEDECK_MOCK=0` does NOT work: both consumers test
    // `!!process.env.IRACEDECK_MOCK`, so any non-empty string forces the mock.
    env: { IRACEDECK_MOCK: process.env.IRACEDECK_REAL_NATIVE ? "" : "1" },
  },
});
