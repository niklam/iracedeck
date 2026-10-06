// @ts-check
/**
 * The externals every plugin leaves out of the bundle; bin/package.json installs exactly these (+ a plugin's extras).
 * Frozen like `PLATFORMS` and `SOURCES`: a caller that pushed onto it would change every plugin's bundle and bin/.
 */
export const BASE_EXTERNALS = Object.freeze([
  "@iracedeck/audio-native",
  "@iracedeck/iracing-native",
  "@resvg/resvg-js",
  "yaml",
  "keysender",
]);
/** @param {string[]} [extraExternals] */
export function pluginExternals(extraExternals = []) {
  return [...BASE_EXTERNALS, ...extraExternals];
}
