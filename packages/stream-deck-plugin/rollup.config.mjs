import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "fi.lampen.niklas.iracedeck.sdPlugin";

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
		}
	},
	external: ['@iracedeck/iracing-native', 'yaml'],
	plugins: [
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
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
				return id.endsWith('.node');
			}
		}),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				const pkg = {
					type: "module",
					dependencies: {
						"@iracedeck/iracing-native": "file:../../../iracing-native",
						"yaml": "^2.8.2"
					}
				};
				this.emitFile({ fileName: "package.json", source: JSON.stringify(pkg, null, 2), type: "asset" });
			}
		}
	]
};

export default config;
