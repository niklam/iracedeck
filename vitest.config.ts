import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, Plugin } from "vitest/config";

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

export default defineConfig({
  plugins: [svgPlugin()],
  resolve: {
    alias: {
      "@iracedeck/audio-native": resolve(__dirname, "packages/audio-native/src/index.ts"),
      "@iracedeck/audio-scenarios/pit-crew": resolve(
        __dirname,
        "packages/audio-scenarios/src/catalog/pit-crew/index.ts",
      ),
      "@iracedeck/audio-scenarios": resolve(__dirname, "packages/audio-scenarios/src/index.ts"),
      "@iracedeck/audio-service": resolve(__dirname, "packages/audio-service/src/index.ts"),
      "@iracedeck/deck-core": resolve(__dirname, "packages/deck-core/src/index.ts"),
      "@iracedeck/event-bus": resolve(__dirname, "packages/event-bus/src/index.ts"),
      "@iracedeck/icon-composer": resolve(__dirname, "packages/icon-composer/src/index.ts"),
      "@iracedeck/iracing-sdk": resolve(__dirname, "packages/iracing-sdk/src/index.ts"),
      "@iracedeck/iracing-native": resolve(__dirname, "packages/iracing-native/src/index.ts"),
      "@iracedeck/logger": resolve(__dirname, "packages/logger/src/index.ts"),
      "@iracedeck/sim-events-iracing": resolve(__dirname, "packages/sim-events-iracing/src/index.ts"),
    },
  },
  test: {
    globals: true,
    setupFiles: ["./test-setup.ts"],
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
