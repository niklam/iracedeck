import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

/**
 * Rollup config for building the PI browser bundles into browser/ so consumer
 * plugins can copy them alongside the vendored sdpi-components.js into their own
 * ui/ folder:
 *
 * - pi-components.js     — the shared `ird-*` web components (all plugins).
 * - ulanzi-pi-bridge.js  — the Ulanzi-only shim that adapts sdpi-components'
 *                          Elgato PI socket to UlanziStudio's `cmd` protocol.
 *                          Injected before sdpi-components.js in Ulanzi PI HTML.
 * - settings-window-bridge.js — the shim for the dedicated settings window (#992):
 *                          redirects sdpi-components' socket to the plugin's
 *                          loopback fake host (carrying the launch token) and
 *                          drives connectElgatoStreamDeckSocket. Injected before
 *                          sdpi-components.js in settings-window.html on all hosts.
 */
const terserPlugin = terser({ format: { comments: false } });

export default [
  {
    input: "src/components/index.ts",
    output: {
      file: "browser/pi-components.js",
      format: "iife",
      name: "IRaceDeckPI",
      sourcemap: false,
    },
    plugins: [typescript({ tsconfig: "./tsconfig.pi.json" }), terserPlugin],
  },
  {
    input: "src/ulanzi-bridge/index.ts",
    output: {
      file: "browser/ulanzi-pi-bridge.js",
      format: "iife",
      name: "IRaceDeckUlanziBridge",
      sourcemap: false,
    },
    plugins: [typescript({ tsconfig: "./tsconfig.ulanzi.json" }), terserPlugin],
  },
  {
    input: "src/settings-window-bridge/index.ts",
    output: {
      file: "browser/settings-window-bridge.js",
      format: "iife",
      name: "IRaceDeckSettingsWindowBridge",
      sourcemap: false,
    },
    plugins: [typescript({ tsconfig: "./tsconfig.settings-window.json" }), terserPlugin],
  },
];
