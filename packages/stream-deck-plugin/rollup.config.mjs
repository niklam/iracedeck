import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";
import process from "node:process";
import { readFileSync, readdirSync } from "node:fs";
import { piTemplatePlugin } from "./src/build/pi-template-plugin.mjs";

/**
 * Rollup plugin to import SVG files as strings
 */
function svgPlugin() {
	return {
		name: "svg",
		resolveId(source, importer) {
			if (source.endsWith(".svg") && importer) {
				return path.resolve(path.dirname(importer), source);
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
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
		},
		inlineDynamicImports: true
	},
	external: ["@iracedeck/iracing-native", "yaml", "keysender"],
	plugins: [
		svgPlugin(),
		piTemplatePlugin({
			templatesDir: "src/pi",
			outputDir: `${sdPlugin}/ui`,
			partialsDir: "src/pi-templates/partials",
		}),
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
				// Watch icons directory for SVG changes
				try {
					const iconsDir = path.resolve("icons");
					readdirSync(iconsDir)
						.filter(f => f.endsWith(".svg"))
						.forEach(f => this.addWatchFile(path.join(iconsDir, f)));
				} catch {
					// icons directory may not exist
				}
			},
		},
		typescript({
			mapRoot: isWatching ? "./" : undefined
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
	],
};

export default config;
