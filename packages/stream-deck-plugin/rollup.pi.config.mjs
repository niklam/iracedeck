import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";

/**
 * Rollup config for building PI components as a standalone browser bundle.
 * Outputs pi-components.js directly to the sdPlugin ui/ folder.
 */
export default {
  input: "src/pi-components/index.ts",
  output: {
    file: "com.iracedeck.sd.core.sdPlugin/ui/pi-components.js",
    format: "iife",
    name: "IRaceDeckPI",
    sourcemap: false,
  },
  plugins: [
    typescript({
      tsconfig: "./tsconfig.pi.json",
    }),
    terser({
      format: {
        comments: false,
      },
    }),
  ],
};
