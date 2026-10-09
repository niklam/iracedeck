/** The only manifest `Version` form the Ulanzi marketplace accepts (#1298). */
export const ULANZI_MANIFEST_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * The manifest `Version` the release stamps into each plugin folder, chosen by
 * the folder's suffix because the two ecosystems demand opposite formats
 * (issue #1298):
 *
 * - `*.sdPlugin` (Elgato, Mirabox): Elgato's manifest schema requires a strict
 *   4-part numeric `{major}.{minor}.{patch}.{build}`
 *   (`^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$`). The build slot is the git commit
 *   count, so each release (pre or final alike) gets a unique version, and the
 *   final outranks its pre-releases because release-it commits the version bump
 *   between runs, which advances the count.
 * - `*.ulanziPlugin` (Ulanzi): the Ulanzi marketplace refuses any `Version` not
 *   matching `^\d+\.\d+\.\d+$`, so it gets the plain `x.y.z`. The UlanziStudio
 *   host loads a 4-part version too, so nothing fails before publish time.
 *   `@elgato/cli pack` pads it back to four parts inside the archive, which
 *   `scripts/stamp-ulanzi-package-version.mjs` undoes after packing. A
 *   pre-release and its final therefore share one Ulanzi version — harmless as
 *   long as pre-releases are not published to the Ulanzi store.
 *
 * A folder with neither suffix throws rather than falling back to one format, so
 * a new ecosystem added to `PLUGIN_FOLDER_SUFFIXES` forces a decision here.
 *
 * @param {string} manifestRel forward-slashed path ending `<folder>/manifest.json`
 * @param {string} version the release version, possibly with a semver suffix
 * @param {string} buildNumber the git commit count
 * @returns {string}
 */
export function manifestVersionFor(manifestRel, version, buildNumber) {
  const numericVersion = version.replace(/[-+].*$/, "");
  const folder = manifestRel.split("/").at(-2) ?? "";

  if (folder.endsWith(".ulanziPlugin")) return numericVersion;
  if (folder.endsWith(".sdPlugin")) return `${numericVersion}.${buildNumber}`;

  throw new Error(`No manifest version format for plugin folder "${folder}" (${manifestRel})`);
}
