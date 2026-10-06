// @ts-check
/** The externals every plugin leaves out of the bundle; bin/package.json installs exactly these (+ a plugin's extras). */
export const BASE_EXTERNALS = [
  "@iracedeck/audio-native",
  "@iracedeck/iracing-native",
  "@resvg/resvg-js",
  "yaml",
  "keysender",
];
/** @param {string[]} [extraExternals] */
export function pluginExternals(extraExternals = []) {
  return [...BASE_EXTERNALS, ...extraExternals];
}
