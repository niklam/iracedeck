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
      "@iracedeck/deck-core": resolve(__dirname, "packages/deck-core/src/index.ts"),
    },
  },
  test: {
    globals: true,
    include: ["packages/*/src/**/*.test.ts"],
  },
});
