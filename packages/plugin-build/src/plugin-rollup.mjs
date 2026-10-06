import { processAndCopyAudioAssetsPlugin } from "@iracedeck/audio-assets/build";
import {
  assertBridgeInjectionPlugin,
  browserDir,
  injectBridgeScriptPlugin,
  partialsDir,
  PI_SETTINGS_BRIDGE,
  piTemplatePlugin,
  SETTINGS_WINDOW_BRIDGE,
  SETTINGS_WINDOW_HTML,
  SETTINGS_WINDOW_ICON,
  SETTINGS_WINDOW_LOGO,
} from "@iracedeck/pi-components/build";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

import { DEV_LOCAL_FILE, resolveDevVoicePacksRoot } from "../../../scripts/lib/dev-local.mjs";
import { pluginBuildOnLog } from "../../../scripts/lib/rollup-logs.mjs";
import { runtimePackageJsonPlugin } from "../../../scripts/lib/runtime-deps.mjs";
import { BASE_EXTERNALS, pluginExternals } from "./externals.mjs";

// The factory runs from packages/plugin-build/src, not from the plugin, so every
// path that used to be relative to a plugin's own config is anchored on the repo
// root here. What stays relative is relative to the CWD, which is the plugin
// package: `rollup -c` runs there, exactly as before the factory existed.
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");

/**
 * The repo-anchored sources the factory reads from.
 *
 * @internal Exported for testing
 */
export const SOURCES = Object.freeze({
  repoRoot,
  actionTemplatesDir: path.join(repoRoot, "packages", "iracing-actions", "src", "actions"),
  iconsPackageDir: path.join(repoRoot, "packages", "icons"),
  rasterizerFontsDir: path.join(repoRoot, "packages", "rasterizer", "fonts"),
  // Plugin-level icons (category icon, marketplace art) for Mirabox and Ulanzi are
  // still sourced from the Elgato plugin until the branding assets get their own package.
  elgatoPluginImgsDir: path.join(
    repoRoot,
    "packages",
    "iracing-plugin-stream-deck",
    "com.iracedeck.sd.core.sdPlugin",
    "imgs",
    "plugin",
  ),
  rootPackageJson: path.join(repoRoot, "package.json"),
  localFeaturesPath: path.join(repoRoot, "feature-flags.local.json"),
  devLocalPath: path.join(repoRoot, DEV_LOCAL_FILE),
});

/** The `config.json` platforms, one per deck host. */
export const PLATFORMS = Object.freeze(["stream-deck", "mirabox", "ulanzi"]);

const OPTION_KEYS = [
  "configUrl",
  "sdPluginDir",
  "platform",
  "extraExternals",
  "assetCopy",
  "piBridge",
  "stripHtmlLang",
];
const REQUIRED_OPTION_KEYS = ["configUrl", "sdPluginDir", "platform", "assetCopy"];
const ASSET_COPY_KEYS = ["actionIcons", "elgatoPluginImgs"];

/**
 * @typedef {object} PluginAssetCopy
 * @property {string[]} actionIcons The per-action SVGs copied into `imgs/actions/<name>/` (e.g. `icon.svg`, `key.svg`, `dial.svg`).
 * @property {boolean} [elgatoPluginImgs] Copy `imgs/plugin/` from the Elgato plugin (Mirabox, Ulanzi). Default false.
 */

/**
 * @typedef {object} PluginRollupOptions
 * @property {string} configUrl The calling `rollup.config.mjs`'s `import.meta.url`; its directory is the plugin package.
 * @property {string} sdPluginDir The plugin folder inside the package, relative to it (e.g. `com.iracedeck.sd.core.sdPlugin`).
 * @property {"stream-deck" | "mirabox" | "ulanzi"} platform The `platform` written into `bin/config.json`.
 * @property {string[]} [extraExternals] Externals beyond {@link BASE_EXTERNALS}, appended after them (e.g. `ws`).
 * @property {PluginAssetCopy} assetCopy Which static assets the plugin copies.
 * @property {string} [piBridge] The bridge every action PI loads, copied into `ui/` and injected. Default `PI_SETTINGS_BRIDGE`.
 * @property {boolean} [stripHtmlLang] Strip `lang` from `<html>` in the generated PI pages (VSD Craft requires it). Default false.
 */

function fail(message) {
  throw new Error(`createPluginRollupConfig: ${message}`);
}

/**
 * Reject anything the factory would otherwise build with silently: an unknown
 * key (a typo like `stripHtmlLnag` must not fall back to the default), a missing
 * required key, an unknown platform, or an extra external that is already a base one.
 */
function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) fail(`unknown option "${key}"`);
  }
  for (const key of REQUIRED_OPTION_KEYS) {
    if (options[key] === undefined) fail(`missing required option "${key}"`);
  }

  const { configUrl, sdPluginDir, platform, extraExternals, assetCopy, piBridge, stripHtmlLang } = options;

  if (typeof configUrl !== "string" || !configUrl.startsWith("file:")) {
    fail(`option "configUrl" must be the config's import.meta.url (a file: URL), got ${JSON.stringify(configUrl)}`);
  }
  if (typeof sdPluginDir !== "string" || sdPluginDir === "" || path.isAbsolute(sdPluginDir)) {
    fail(
      `option "sdPluginDir" must be a folder name relative to the plugin package, got ${JSON.stringify(sdPluginDir)}`,
    );
  }
  if (!PLATFORMS.includes(platform)) {
    fail(`option "platform" must be one of ${PLATFORMS.join(", ")}, got ${JSON.stringify(platform)}`);
  }
  if (extraExternals !== undefined) {
    if (!Array.isArray(extraExternals) || extraExternals.some((name) => typeof name !== "string")) {
      fail(`option "extraExternals" must be an array of package names`);
    }
    for (const name of extraExternals) {
      if (BASE_EXTERNALS.includes(name)) fail(`option "extraExternals" repeats the base external "${name}"`);
    }
  }
  if (assetCopy === null || typeof assetCopy !== "object" || Array.isArray(assetCopy)) {
    fail(`option "assetCopy" must be an object`);
  }
  for (const key of Object.keys(assetCopy)) {
    if (!ASSET_COPY_KEYS.includes(key)) fail(`unknown option "assetCopy.${key}"`);
  }
  if (
    !Array.isArray(assetCopy.actionIcons) ||
    assetCopy.actionIcons.length === 0 ||
    assetCopy.actionIcons.some((file) => typeof file !== "string")
  ) {
    fail(`option "assetCopy.actionIcons" must be a non-empty array of file names`);
  }
  if (assetCopy.elgatoPluginImgs !== undefined && typeof assetCopy.elgatoPluginImgs !== "boolean") {
    fail(`option "assetCopy.elgatoPluginImgs" must be a boolean`);
  }
  if (piBridge !== undefined && (typeof piBridge !== "string" || piBridge === "")) {
    fail(`option "piBridge" must be a file name`);
  }
  if (stripHtmlLang !== undefined && typeof stripHtmlLang !== "boolean") {
    fail(`option "stripHtmlLang" must be a boolean`);
  }
}

/**
 * Deep-merge two plain objects. `override` keys win on collision. Nested
 * objects are merged recursively; arrays and primitives are replaced.
 *
 * @internal Exported for testing
 */
export function deepMergeObjects(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const overrideVal = override[key];
    if (overrideVal && typeof overrideVal === "object" && !Array.isArray(overrideVal)) {
      result[key] = deepMergeObjects(base[key] ?? {}, overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Split `override` into `known` (keys whose path and shape exist in `committed`)
 * and `unknown` (dotted paths that don't match). Lets us warn about typos and
 * shape mismatches in the local override file while guaranteeing they don't
 * leak into the merged flags or crash the build.
 *
 * @internal Exported for testing
 */
export function partitionOverride(committed, override, prefix = "") {
  const known = {};
  const unknown = [];
  for (const key of Object.keys(override)) {
    if (!Object.prototype.hasOwnProperty.call(committed, key)) {
      unknown.push(`${prefix}${key}`);
      continue;
    }
    const committedVal = committed[key];
    const overrideVal = override[key];
    if (isPlainObject(overrideVal)) {
      if (!isPlainObject(committedVal)) {
        // Nested object where committed has a leaf → treat as unknown
        unknown.push(`${prefix}${key}`);
        continue;
      }
      const nested = partitionOverride(committedVal, overrideVal, `${prefix}${key}.`);
      known[key] = nested.known;
      unknown.push(...nested.unknown);
    } else if (isPlainObject(committedVal)) {
      // Leaf override for a nested branch → treat as unknown
      unknown.push(`${prefix}${key}`);
    } else {
      known[key] = overrideVal;
    }
  }
  return { known, unknown };
}

/**
 * Resolve platform feature flags for this build:
 * 1. Read the plugin's committed `platform-features.json`.
 * 2. If `feature-flags.local.json` exists at the repo root, strip any keys
 *    not declared in the committed file (warning about each), then deep-merge
 *    what remains on top of the committed values.
 * The merged object feeds `@rollup/plugin-replace` (compile-time constants),
 * `piTemplatePlugin` (EJS `platform` variable), and the emitted `config.json`.
 *
 * @internal Exported for testing
 * @param {string} platformFeaturesPath
 * @param {string} localFeaturesPath
 */
export function resolvePlatformFeatures(platformFeaturesPath, localFeaturesPath) {
  const committedFeatures = JSON.parse(readFileSync(platformFeaturesPath, "utf-8"));
  let platformFeatures = committedFeatures;
  if (existsSync(localFeaturesPath)) {
    const localFeatures = JSON.parse(readFileSync(localFeaturesPath, "utf-8"));
    const { known, unknown } = partitionOverride(committedFeatures, localFeatures);
    if (unknown.length > 0) {
      console.warn(`[platform-features] feature-flags.local.json has unknown keys (ignored): ${unknown.join(", ")}`);
    }
    platformFeatures = deepMergeObjects(committedFeatures, known);
  }
  return platformFeatures;
}

/**
 * Copy the listed per-action static icons from each action folder under
 * `templatesDir` into `destRoot/<action>/`, skipping `data/` and any file an
 * action does not have.
 *
 * @internal Exported for testing
 * @param {string} templatesDir
 * @param {string} destRoot
 * @param {string[]} files
 */
export function copyActionIcons(templatesDir, destRoot, files) {
  for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "data") continue;
    const actionDir = path.join(templatesDir, entry.name);
    for (const file of files) {
      const src = path.join(actionDir, file);
      if (!existsSync(src)) continue;
      const destDir = path.join(destRoot, entry.name);
      mkdirSync(destDir, { recursive: true });
      copyFileSync(src, path.join(destDir, file));
    }
  }
}

/**
 * Rollup plugin to import SVG files as strings.
 * Handles both relative imports and @iracedeck/icons/ package imports.
 */
function svgPlugin() {
  return {
    name: "svg",
    resolveId(source, importer) {
      if (source.endsWith(".svg")) {
        if (source.startsWith("@iracedeck/icons/")) {
          const relativePath = source.replace("@iracedeck/icons/", "");
          return path.join(SOURCES.iconsPackageDir, relativePath);
        }
        if (importer) {
          return path.resolve(path.dirname(importer), source);
        }
      }
    },
    load(id) {
      if (id.endsWith(".svg")) {
        const content = readFileSync(id, "utf-8");
        return `export default ${JSON.stringify(content)};`;
      }
    },
  };
}

/**
 * Rollup plugin to strip lang="en" from generated HTML files.
 * VSD Craft requires <html> without a lang attribute.
 */
function stripHtmlLangPlugin(outputDir) {
  return {
    name: "strip-html-lang",
    writeBundle() {
      if (!existsSync(outputDir)) return;

      const htmlFiles = readdirSync(outputDir).filter((f) => f.endsWith(".html"));
      for (const file of htmlFiles) {
        const filePath = path.join(outputDir, file);
        const content = readFileSync(filePath, "utf-8");
        const updated = content.replace(/<html\s+lang="[^"]*"/, "<html");
        if (updated !== content) {
          writeFileSync(filePath, updated, "utf-8");
        }
      }
    },
  };
}

/**
 * The Rollup config every deck plugin builds with. A plugin's `rollup.config.mjs`
 * passes only what differs between the plugins; everything else is shared here.
 *
 * Synchronous, and free of side effects until called: the feature flags, the
 * development voice root and the watch flag are all read at call time.
 *
 * @param {PluginRollupOptions} options
 * @returns {import("rollup").RollupOptions}
 */
export function createPluginRollupConfig(options) {
  validateOptions(options);

  const {
    configUrl,
    sdPluginDir,
    platform,
    extraExternals = [],
    assetCopy: { actionIcons, elgatoPluginImgs = false },
    piBridge = PI_SETTINGS_BRIDGE,
    stripHtmlLang = false,
  } = options;

  // The plugin package is the directory of the calling config.
  const packageDir = path.dirname(url.fileURLToPath(configUrl));
  const manifestPath = path.join(packageDir, sdPluginDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(
      `no manifest at ${manifestPath}: option "sdPluginDir" (${sdPluginDir}) names no plugin folder in ${packageDir}`,
    );
  }

  const rootPackageJson = JSON.parse(readFileSync(SOURCES.rootPackageJson, "utf-8"));
  const actionTemplatesDir = SOURCES.actionTemplatesDir;
  const platformFeaturesPath = path.join(packageDir, "platform-features.json");
  const localFeaturesPath = SOURCES.localFeaturesPath;
  const platformFeatures = resolvePlatformFeatures(platformFeaturesPath, localFeaturesPath);

  // A development voice root (#1143, #1214): the gitignored dev.local.json at
  // the repo root, or the machine-wide IRACEDECK_DEV_VOICES=1 opt-in, resolved to
  // an absolute path and carried in bin/config.json. Absent in every release
  // build: the file is not in git and CI never sets the variable. One line in the
  // build log when it is on, because under a machine-wide opt-in the mistake to
  // catch is being ON by accident.
  const devLocalPath = SOURCES.devLocalPath;
  const devVoices = resolveDevVoicePacksRoot(repoRoot);
  if (devVoices.voicePacksRoot !== undefined) {
    console.log(`[dev-voices] development voice root on via ${devVoices.source}: ${devVoices.voicePacksRoot}`);
  }

  const isWatching = !!process.env.ROLLUP_WATCH;

  return {
    input: "src/plugin.ts",
    // Shared log policy (#1176): drops zod's prose-comment INVALID_ANNOTATION and
    // zod/semver internal cycles, and FAILS the build on a cycle among our own
    // sources. Everything else prints as Rollup would. See scripts/lib/rollup-logs.mjs.
    onLog: pluginBuildOnLog,
    output: {
      file: `${sdPluginDir}/bin/plugin.js`,
      sourcemap: isWatching,
      sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
        return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
      },
      inlineDynamicImports: true,
    },
    // Left out of the bundle and installed beside it at runtime, so this list is
    // also exactly what bin/package.json installs (runtimePackageJsonPlugin below).
    external: pluginExternals(extraExternals),
    plugins: [
      // Resolve .js imports to .ts files for the raw-TypeScript workspace packages.
      // Only applies to relative imports (starting with ".") within the raw-TypeScript packages (iracing-actions, plugin-runtime).
      {
        name: "resolve-actions-ts",
        resolveId(source, importer) {
          if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
          // Only handle imports from within the raw-TypeScript packages (iracing-actions, plugin-runtime)
          const normalizedImporter = importer.replace(/\\/g, "/");
          if (
            !normalizedImporter.includes("/iracing-actions/src/") &&
            !normalizedImporter.includes("/plugin-runtime/src/")
          )
            return null;
          const tsPath = path.resolve(path.dirname(importer), source.replace(/\.js$/, ".ts"));
          return tsPath;
        },
      },
      svgPlugin(),
      json(),
      replace({
        preventAssignment: true,
        values: {
          __FEATURE_DIAL_EXTENDED_GESTURES__: JSON.stringify(platformFeatures.features.dialExtendedGestures),
          __FEATURE_PNG_RASTERIZATION__: JSON.stringify(platformFeatures.features.pngRasterization),
        },
      }),
      piTemplatePlugin({
        templatesDir: actionTemplatesDir,
        outputDir: `${sdPluginDir}/ui`,
        partialsDir,
        version: rootPackageJson.version,
        platformFeatures,
      }),
      // Settings-window bridge into settings-window.html only (#992): it must load
      // before sdpi-components.js so it can redirect the socket to the plugin's
      // loopback fake host with the launch token.
      injectBridgeScriptPlugin({
        outputDir: `${sdPluginDir}/ui`,
        bridge: SETTINGS_WINDOW_BRIDGE,
        include: (file) => file === SETTINGS_WINDOW_HTML,
      }),
      // The plugin's PI bridge into every action PI — but NOT the settings window,
      // which has its own bridge; two bridges must never share a page (#992, #993).
      injectBridgeScriptPlugin({
        outputDir: `${sdPluginDir}/ui`,
        bridge: piBridge,
        include: (file) => file !== SETTINGS_WINDOW_HTML,
      }),
      // Copy per-action static icons from @iracedeck/iracing-actions into {sdPlugin}/imgs/actions/<name>/.
      // Source of truth: `packages/iracing-actions/src/actions/<name>/{icon,key,dial}.svg`.
      // dial.svg (optional) is the manifest `Encoder.Icon` default for dual-surface actions (#775);
      // only a plugin whose host has dials lists it.
      {
        name: "copy-action-icons",
        generateBundle() {
          copyActionIcons(actionTemplatesDir, `${sdPluginDir}/imgs/actions`, actionIcons);
        },
      },
      // Copy plugin-level icons (category-icon, marketplace, etc.) from the Elgato plugin.
      // TODO: move to a dedicated branding package when that refactor lands.
      ...(elgatoPluginImgs
        ? [
            {
              name: "copy-plugin-imgs",
              generateBundle() {
                const destPluginImgs = path.join(sdPluginDir, "imgs", "plugin");
                if (existsSync(SOURCES.elgatoPluginImgsDir)) {
                  cpSync(SOURCES.elgatoPluginImgsDir, destPluginImgs, { recursive: true });
                }
              },
            },
          ]
        : []),
      // Copy shared audio assets from @iracedeck/audio-assets, applying the
      // radio-engineer ffmpeg treatment to voice categories and caching output.
      processAndCopyAudioAssetsPlugin({ sdPlugin: sdPluginDir }),
      // Copy the bundled Arimo fonts from @iracedeck/rasterizer into {sdPlugin}/assets/fonts
      {
        name: "copy-rasterizer-fonts",
        generateBundle() {
          const fontsSrc = SOURCES.rasterizerFontsDir;
          const destDir = path.join(sdPluginDir, "assets", "fonts");
          mkdirSync(destDir, { recursive: true });
          for (const file of readdirSync(fontsSrc)) {
            copyFileSync(path.join(fontsSrc, file), path.join(destDir, file));
          }
        },
      },
      // Ship the project license and aggregated third-party notices at the plugin root (#905)
      {
        name: "copy-license-files",
        generateBundle() {
          for (const file of ["LICENSE", "THIRD-PARTY-LICENSES.md"]) {
            copyFileSync(path.join(repoRoot, file), path.join(sdPluginDir, file));
          }
        },
      },
      // Copy vendored sdpi-components.js, built pi-components.js and the bridges from @iracedeck/pi-components
      {
        name: "copy-pi-browser-assets",
        generateBundle() {
          const uiDir = `${sdPluginDir}/ui`;
          if (!existsSync(uiDir)) mkdirSync(uiDir, { recursive: true });
          for (const file of [
            "sdpi-components.js",
            "pi-components.js",
            piBridge,
            SETTINGS_WINDOW_BRIDGE,
            SETTINGS_WINDOW_LOGO,
            SETTINGS_WINDOW_ICON,
          ]) {
            const src = path.join(browserDir, file);
            if (!existsSync(src)) {
              this.error(
                `Missing ${file} in @iracedeck/pi-components. Build it first: pnpm --filter @iracedeck/pi-components build`,
              );
            }
            copyFileSync(src, path.join(uiDir, file));
          }
          this.info?.("Copied PI browser assets from @iracedeck/pi-components");
        },
      },
      {
        name: "watch-externals",
        buildStart: function () {
          this.addWatchFile(manifestPath);
          this.addWatchFile(platformFeaturesPath);
          if (existsSync(localFeaturesPath)) this.addWatchFile(localFeaturesPath);
          if (existsSync(devLocalPath)) this.addWatchFile(devLocalPath);
          // Recursively watch SVG files in a directory
          const watchSvgsRecursive = (dir) => {
            try {
              for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) watchSvgsRecursive(fullPath);
                else if (entry.name.endsWith(".svg")) this.addWatchFile(fullPath);
              }
            } catch {
              // directory may not exist
            }
          };
          // Watch local icons directory, shared icons package, and per-action static assets
          watchSvgsRecursive(path.join(packageDir, "icons"));
          watchSvgsRecursive(SOURCES.iconsPackageDir);
          watchSvgsRecursive(actionTemplatesDir);
        },
      },
      typescript({
        mapRoot: isWatching ? "./" : undefined,
        // Include the plugin source and the raw-TypeScript workspace packages (iracing-actions, plugin-runtime)
        include: ["src/**/*.ts", "../iracing-actions/src/**/*.ts", "../plugin-runtime/src/**/*.ts"],
        // Without this, @rollup/plugin-typescript reports every type error as a
        // rollup WARNING and emits anyway (see its `emitDiagnostic`), so the build
        // succeeds while shipping broken output — an undefined identifier reached
        // a released bundle that way (#987). Fail at authoring time instead of
        // relying on CI to notice afterwards.
        noEmitOnError: true,
      }),
      nodeResolve({
        browser: false,
        exportConditions: ["node"],
        preferBuiltins: true,
      }),
      commonjs({
        ignore: (id) => {
          // Exclude .node native modules from bundling
          return id.endsWith(".node");
        },
      }),
      // Strip lang="en" from generated HTML (VSD Craft requirement)
      ...(stripHtmlLang ? [stripHtmlLangPlugin(`${sdPluginDir}/ui`)] : []),
      !isWatching && terser(),
      // bin/package.json, which the installed plugin runs `npm install` against:
      // one entry per `external` above, each at the version the workspace
      // declares (#1177). Never a version literal here — see runtime-deps.mjs.
      runtimePackageJsonPlugin({ root: repoRoot }),
      {
        name: "emit-plugin-config",
        generateBundle() {
          const config = {
            version: rootPackageJson.version,
            platform,
            featureFlags: platformFeatures,
            ...(devVoices.voicePacksRoot === undefined ? {} : { devVoicePacksRoot: devVoices.voicePacksRoot }),
          };
          this.emitFile({ fileName: "config.json", source: JSON.stringify(config, null, 2), type: "asset" });
        },
      },
      // Build-time guard (#993 phase 2): every generated PI page carries exactly
      // its one bridge, immediately before sdpi-components.js, and no other bridge.
      assertBridgeInjectionPlugin({
        outputDir: `${sdPluginDir}/ui`,
        expectedBridge: (file) => (file === SETTINGS_WINDOW_HTML ? SETTINGS_WINDOW_BRIDGE : piBridge),
      }),
    ],
  };
}
