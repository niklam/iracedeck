import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

/**
 * Every browser bundle compiles through this rather than calling `typescript()`
 * directly. Without `noEmitOnError`, @rollup/plugin-typescript reports type
 * errors as rollup WARNINGS and emits anyway (see its `emitDiagnostic`), so a
 * build reports success while shipping broken output — that is how an undefined
 * identifier once reached a released plugin bundle (#987). These four bundles
 * are the PI framework every plugin loads, so the same failure here breaks a
 * Property Inspector with nothing pointing at the cause.
 */
const tsBundle = (tsconfig) => typescript({ tsconfig, noEmitOnError: true });

/**
 * The one package import a browser bundle may make (#1277): deck-core's
 * dependency-free key map and default parser, through its own subpath —
 * deck-core's `exports` point it at the built `dist/key-binding-defaults.js`,
 * which turbo builds first because deck-core is a dependency of this package.
 * node-resolve's `resolveOnly` matches package NAMES, not subpaths, so it can
 * only narrow resolution to deck-core; the guard in front of it refuses every
 * other deck-core import by name, so the barrel (Node built-ins, native
 * addons) can never be followed into a Property Inspector.
 */
const DECK_CORE_KEY_BINDING_DEFAULTS = "@iracedeck/deck-core/key-binding-defaults";
const resolveBrowserImports = () => [
  {
    name: "deck-core-subpath-guard",
    resolveId(source) {
      if (source.startsWith("@iracedeck/deck-core") && source !== DECK_CORE_KEY_BINDING_DEFAULTS) {
        this.error(
          `"${source}" is not browser-safe: a Property Inspector bundle may import only ${DECK_CORE_KEY_BINDING_DEFAULTS} from deck-core`,
        );
      }

      return null;
    },
  },
  nodeResolve({ browser: true, resolveOnly: ["@iracedeck/deck-core"] }),
];

/**
 * An import the bundle cannot resolve would otherwise be left as an IIFE
 * global that does not exist in the PI page — a warning on a green build and a
 * dead Property Inspector at runtime. Fail instead.
 */
const FATAL_LOG_CODES = new Set(["UNRESOLVED_IMPORT", "MISSING_GLOBAL_NAME"]);
const onLog = (level, log, handler) => {
  if (FATAL_LOG_CODES.has(log.code)) {
    handler("error", log);

    return;
  }

  handler(level, log);
};

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
 * - pi-settings-bridge.js — the Elgato/Mirabox PI shim (#993, phase 2): pre-defines
 *                          connectElgatoStreamDeckSocket so it runs before sdpi's
 *                          own definition, then arms a one-shot WebSocket
 *                          interceptor that hands sdpi a PiSettingsBridgeSocket
 *                          routing global-settings frames through the shared
 *                          settings-channel router to the plugin's loopback
 *                          settings server. Injected before sdpi-components.js
 *                          in every other action PI HTML on Elgato and Mirabox.
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
    onLog,
    plugins: [tsBundle("./tsconfig.pi.json"), ...resolveBrowserImports(), terserPlugin],
  },
  {
    input: "src/ulanzi-bridge/index.ts",
    output: {
      file: "browser/ulanzi-pi-bridge.js",
      format: "iife",
      name: "IRaceDeckUlanziBridge",
      sourcemap: false,
    },
    onLog,
    plugins: [tsBundle("./tsconfig.ulanzi.json"), terserPlugin],
  },
  {
    input: "src/settings-window-bridge/index.ts",
    output: {
      file: "browser/settings-window-bridge.js",
      format: "iife",
      name: "IRaceDeckSettingsWindowBridge",
      sourcemap: false,
    },
    onLog,
    plugins: [tsBundle("./tsconfig.settings-window.json"), terserPlugin],
  },
  {
    input: "src/pi-settings-bridge/index.ts",
    output: {
      file: "browser/pi-settings-bridge.js",
      format: "iife",
      name: "IRaceDeckPiSettingsBridge",
      sourcemap: false,
    },
    onLog,
    plugins: [tsBundle("./tsconfig.pi-settings-bridge.json"), terserPlugin],
  },
];
