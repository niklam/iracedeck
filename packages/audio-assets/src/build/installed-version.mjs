import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

/**
 * The `version` of the package `name` as installed for the module at `from`
 * (its `import.meta.url`) — the one `require(name)` from that module would
 * load, so the version in an identity is the version of the code that ran.
 *
 * Read from the package's own `package.json`. First through the
 * `<name>/package.json` subpath, which every package without an `exports`
 * map (ffmpeg-static) and most with one (fflate names it) allow. When a
 * package's `exports` map withholds it (`ERR_PACKAGE_PATH_NOT_EXPORTED`), the
 * manifest is found the way Node's own lookup finds the package, with no
 * `exports` map in the way: walking up from `from`'s directory to the nearest
 * `node_modules/<name>/package.json` whose `name` is `name`. It does NOT go
 * through `require.resolve(name)`, which an `exports` map offering only
 * `import` conditions refuses with the same code — and since
 * `PIPELINE_IDENTITY` is computed when `index.mjs` is imported, an uncaught
 * refusal there would break every consumer of the `./build` entry, not one
 * release. A dependency bump that tightens an `exports` map therefore cannot
 * stop the identity from reading its version. A package found nowhere is
 * refused, naming it.
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

    manifestPath = installedManifest(name, from);
  }

  const version = JSON.parse(readFileSync(manifestPath, "utf-8")).version;

  if (typeof version !== "string" || version === "") {
    throw new Error(`installedPackageVersion: ${manifestPath} has no "version"`);
  }

  return version;
}

/**
 * The `package.json` of `name` as installed for `from`: Node's `node_modules`
 * lookup — `<dir>/node_modules/<name>/package.json` for `from`'s directory and
 * each ancestor, nearest first — reading no `exports` map, and taking only a
 * manifest whose `name` is `name`, so a directory that merely bears the name
 * (a stray folder, a half-removed install) is passed over.
 *
 * @param {string} name
 * @param {string} from — the requiring module's `import.meta.url`
 * @returns {string}
 */
function installedManifest(name, from) {
  let dir = path.dirname(url.fileURLToPath(from));

  for (;;) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"), "package.json");

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
      throw new Error(`installedPackageVersion: no node_modules/${name}/package.json naming "${name}" above ${from}`);
    }

    dir = parent;
  }
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
