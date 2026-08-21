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
 * Uses 'enforce: pre' and 'resolveId' to intercept SVG imports
 * before Vite's default asset handling converts them to URLs.
 */
function svgPlugin(): Plugin {
  return {
    name: "svg-raw",
    enforce: "pre",
    resolveId(source, importer) {
      // Only handle .svg imports that are relative imports
      if (source.endsWith(".svg") && importer) {
        // Return the source as-is to handle it in load
        return null;
      }

      return null;
    },
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
 * Absolute path to a file inside `packages/`, anchored on this config's own
 * directory.
 *
 * Uses `import.meta.dirname` rather than `__dirname`: this file is ESM, so the
 * CJS global only resolved because Vite's default config loader bundles the
 * config to CommonJS first. That loader is being replaced by `configLoader:
 * 'native'`, under which `__dirname` is simply undefined.
 */
const packageSrc = (relativePath: string): string => resolve(import.meta.dirname, "packages", relativePath);

export default defineConfig({
  plugins: [svgPlugin()],
  resolve: {
    alias: {
      "@iracedeck/audio-native": packageSrc("audio-native/src/index.ts"),
      "@iracedeck/audio-scenarios/pit-crew": packageSrc("audio-scenarios/src/catalog/pit-crew/index.ts"),
      "@iracedeck/audio-scenarios": packageSrc("audio-scenarios/src/index.ts"),
      "@iracedeck/audio-service": packageSrc("audio-service/src/index.ts"),
      "@iracedeck/deck-core": packageSrc("deck-core/src/index.ts"),
      "@iracedeck/event-bus": packageSrc("event-bus/src/index.ts"),
      "@iracedeck/icon-composer": packageSrc("icon-composer/src/index.ts"),
      "@iracedeck/iracing-sdk": packageSrc("iracing-sdk/src/index.ts"),
      "@iracedeck/iracing-native": packageSrc("iracing-native/src/index.ts"),
      "@iracedeck/logger": packageSrc("logger/src/index.ts"),
      "@iracedeck/sim-events-iracing": packageSrc("sim-events-iracing/src/index.ts"),
    },
  },
  test: {
    globals: true,
    setupFiles: ["./test-setup.ts"],
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
