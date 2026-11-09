import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * The `version` of the package `name` as installed for the module at `from`
 * (its `import.meta.url`) — the one `require(name)` from that module would
 * load, so the version in an identity is the version of the code that ran.
 *
 * Read from the package's own `package.json`. First through the
 * `<name>/package.json` subpath, which every package without an `exports`
 * map (ffmpeg-static) and most with one (fflate names it) allow; when a
 * package's `exports` map withholds it (`ERR_PACKAGE_PATH_NOT_EXPORTED`), the
 * manifest is found by walking up from the package's resolved entry to the
 * nearest `package.json` that declares that `name`. A dependency bump that
 * tightens an `exports` map therefore cannot stop the identity from reading
 * its version, which would otherwise fail the release hook and the publish
 * script rather than a build.
 *
 * @param {string} name — a bare package name, as in an import specifier
 * @param {string} from — the requiring module's `import.meta.url`
 * @returns {string}
 */
export function installedPackageVersion(name, from) {
  const require = createRequire(from);
  let manifestPath;

  try {
    manifestPath = require.resolve(`${name}/package.json`);
  } catch (err) {
    if (
      !(err instanceof Error) ||
      /** @type {NodeJS.ErrnoException} */ (err).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED"
    ) {
      throw new Error(`installedPackageVersion: cannot resolve "${name}" from ${from}: ${errorMessage(err)}`);
    }

    manifestPath = nearestOwnManifest(require.resolve(name), name);
  }

  const version = JSON.parse(readFileSync(manifestPath, "utf-8")).version;

  if (typeof version !== "string" || version === "") {
    throw new Error(`installedPackageVersion: ${manifestPath} has no "version"`);
  }

  return version;
}

/**
 * The nearest `package.json` above `entry` whose `name` is `name`. A package's
 * entry can sit under a subdirectory (`esm/index.mjs`), and a nested
 * `package.json` there may be a module-type marker without a name, so the walk
 * reads each candidate and stops only at the package's own.
 *
 * @param {string} entry — the package's resolved entry file
 * @param {string} name
 * @returns {string}
 */
function nearestOwnManifest(entry, name) {
  let dir = path.dirname(entry);

  for (;;) {
    const candidate = path.join(dir, "package.json");

    if (existsSync(candidate)) {
      let manifest;

      try {
        manifest = JSON.parse(readFileSync(candidate, "utf-8"));
      } catch {
        manifest = undefined;
      }

      if (manifest?.name === name) return candidate;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      throw new Error(`installedPackageVersion: no package.json naming "${name}" above ${entry}`);
    }

    dir = parent;
  }
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
