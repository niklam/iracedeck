import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// `Plugin` is a type-only export, so the `type` modifier is load-bearing: under
// `configLoader: 'native'` Node strips the types itself and cannot infer which
// named imports are types, so a plain `Plugin` becomes a value import of an
// export that does not exist. Vite's compatibility warning does not cover this.
import { defineConfig, type Plugin } from "vitest/config";

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
  },
});
