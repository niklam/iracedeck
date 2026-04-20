import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";
import process from "node:process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { browserDir, partialsDir, piTemplatePlugin } from "@iracedeck/pi-components/build";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const rootPackageJson = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8"));
const iconsPackagePath = path.resolve(__dirname, "../icons");
const actionsPackagePath = path.resolve(__dirname, "../iracing-actions/src");
const actionTemplatesDir = path.join(actionsPackagePath, "actions");
const audioAssetsPath = path.resolve(__dirname, "../audio-assets");

/**
 * Rollup plugin to copy shared audio assets into the sdPlugin directory.
 * `audio-assets/` is the single source of truth for MP3s used by both the
 * Elgato and Mirabox plugins.
 */
function copyAudioAssetsPlugin(sdPlugin) {
	return {
		name: "copy-audio-assets",
		generateBundle() {
			const dest = path.join(sdPlugin, "assets", "audio");
			if (existsSync(audioAssetsPath)) {
				cpSync(audioAssetsPath, dest, { recursive: true, filter: (src) => !src.endsWith("package.json") });
				this.info?.("Copied audio assets from @iracedeck/audio-assets");
			}
		},
	};
}

/**
 * Deep-merge two plain objects. `override` keys win on collision. Nested
 * objects are merged recursively; arrays and primitives are replaced.
 */
function deepMergeObjects(base, override) {
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
 */
function partitionOverride(committed, override, prefix = "") {
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
 * 1. Read committed `platform-features.json` next to this rollup config.
 * 2. If `feature-flags.local.json` exists at the repo root, strip any keys
 *    not declared in the committed file (warning about each), then deep-merge
 *    what remains on top of the committed values.
 * The merged object feeds `@rollup/plugin-replace` (compile-time constants),
 * `piTemplatePlugin` (EJS `platform` variable), and the emitted `config.json`.
 */
const platformFeaturesPath = path.resolve(__dirname, "platform-features.json");
const localFeaturesPath = path.resolve(__dirname, "../../feature-flags.local.json");
const committedFeatures = JSON.parse(readFileSync(platformFeaturesPath, "utf-8"));
let platformFeatures = committedFeatures;
if (existsSync(localFeaturesPath)) {
	const localFeatures = JSON.parse(readFileSync(localFeaturesPath, "utf-8"));
	const { known, unknown } = partitionOverride(committedFeatures, localFeatures);
	if (unknown.length > 0) {
		console.warn(
			`[platform-features] feature-flags.local.json has unknown keys (ignored): ${unknown.join(", ")}`,
		);
	}
	platformFeatures = deepMergeObjects(committedFeatures, known);
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
					return path.join(iconsPackagePath, relativePath);
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
		}
	};
}

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.iracedeck.sd.core.sdPlugin";

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	onwarn(warning, warn) {
		// Suppress circular dependency warnings from zod and semver internals
		if (warning.code === "CIRCULAR_DEPENDENCY" && warning.ids?.some(id => id.includes("node_modules\\zod\\") || id.includes("node_modules/zod/") || id.includes("node_modules\\semver\\") || id.includes("node_modules/semver/"))) return;
		warn(warning);
	},
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
		},
		inlineDynamicImports: true
	},
	external: ["@iracedeck/audio-native", "@iracedeck/audio-service", "@iracedeck/iracing-native", "yaml", "keysender"],
	plugins: [
		// Resolve .js imports to .ts files for the raw-TypeScript actions package.
		// Only applies to relative imports (starting with ".") within the actions package.
		{
			name: "resolve-actions-ts",
			resolveId(source, importer) {
				if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
				// Only handle imports from the actions package
				const normalizedImporter = importer.replace(/\\/g, "/");
				if (!normalizedImporter.includes("/iracing-actions/src/")) return null;
				const tsPath = path.resolve(path.dirname(importer), source.replace(/\.js$/, ".ts"));
				return tsPath;
			},
		},
		svgPlugin(),
		json(),
		replace({
			preventAssignment: true,
			values: {
				__CAPABILITY_SVG_FILTERS__: JSON.stringify(platformFeatures.capabilities.svgFilters),
				__CAPABILITY_SVG_MASKS__: JSON.stringify(platformFeatures.capabilities.svgMasks),
				__CAPABILITY_SVG_PATTERNS__: JSON.stringify(platformFeatures.capabilities.svgPatterns),
				__FEATURE_BORDER_GLOW__: JSON.stringify(platformFeatures.features.borderGlow),
			},
		}),
		piTemplatePlugin({
			templatesDir: actionTemplatesDir,
			outputDir: `${sdPlugin}/ui`,
			partialsDir,
			version: rootPackageJson.version,
			platformFeatures,
		}),
		// Copy per-action static icons from @iracedeck/iracing-actions into {sdPlugin}/imgs/actions/<name>/.
		// Source of truth: `packages/iracing-actions/src/actions/<name>/{icon,key}.svg`.
		{
			name: "copy-action-icons",
			generateBundle() {
				const destRoot = `${sdPlugin}/imgs/actions`;
				for (const entry of readdirSync(actionTemplatesDir, { withFileTypes: true })) {
					if (!entry.isDirectory() || entry.name === "data") continue;
					const actionDir = path.join(actionTemplatesDir, entry.name);
					for (const file of ["icon.svg", "key.svg"]) {
						const src = path.join(actionDir, file);
						if (!existsSync(src)) continue;
						const destDir = path.join(destRoot, entry.name);
						mkdirSync(destDir, { recursive: true });
						copyFileSync(src, path.join(destDir, file));
					}
				}
			},
		},
		// Copy shared audio assets from @iracedeck/audio-assets
		copyAudioAssetsPlugin(sdPlugin),
		// Copy vendored sdpi-components.js and built pi-components.js from @iracedeck/pi-components
		{
			name: "copy-pi-browser-assets",
			generateBundle() {
				const uiDir = `${sdPlugin}/ui`;
				if (!existsSync(uiDir)) mkdirSync(uiDir, { recursive: true });
				for (const file of ["sdpi-components.js", "pi-components.js"]) {
					const src = path.join(browserDir, file);
					if (!existsSync(src)) {
						this.error(`Missing ${file} in @iracedeck/pi-components. Build it first: pnpm --filter @iracedeck/pi-components build`);
					}
					copyFileSync(src, path.join(uiDir, file));
				}
				this.info?.("Copied PI browser assets from @iracedeck/pi-components");
			},
		},
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
				this.addWatchFile(platformFeaturesPath);
				if (existsSync(localFeaturesPath)) this.addWatchFile(localFeaturesPath);
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
				watchSvgsRecursive(path.resolve("icons"));
				watchSvgsRecursive(iconsPackagePath);
				watchSvgsRecursive(actionTemplatesDir);
			},
		},
		typescript({
			mapRoot: isWatching ? "./" : undefined,
			// Include both the plugin source and the raw-TypeScript actions package
			include: ["src/**/*.ts", "../iracing-actions/src/**/*.ts"],
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true
		}),
		commonjs({
			ignore: (id) => {
				// Exclude .node native modules from bundling
				return id.endsWith(".node");
			},
		}),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				const pkg = {
					type: "module",
					dependencies: {
						"@iracedeck/audio-native": "file:../../../audio-native",
						"@iracedeck/audio-service": "file:../../../audio-service",
						"@iracedeck/iracing-native": "file:../../../iracing-native",
						yaml: "2.8.2",
					},
					optionalDependencies: {
						"keysender": "2.4.0",
					}
				};
				this.emitFile({ fileName: "package.json", source: JSON.stringify(pkg, null, 2), type: "asset" });
			},
		},
		{
			name: "emit-plugin-config",
			generateBundle() {
				const config = {
					version: rootPackageJson.version,
					platform: "stream-deck",
					featureFlags: platformFeatures,
				};
				this.emitFile({ fileName: "config.json", source: JSON.stringify(config, null, 2), type: "asset" });
			},
		},
	],
};

export default config;
