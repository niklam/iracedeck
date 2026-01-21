import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";

/**
 * Rollup config for building PI components as a standalone browser bundle.
 * The main package build uses tsc (see package.json "build" script).
 * This config is specifically for the Property Inspector components.
 */
export default {
  input: "src/pi/index.ts",
  output: {
    file: "dist/pi-components.js",
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
