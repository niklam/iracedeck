/**
 * Test support for other packages' tests (#1375); never imported by production
 * code. Reached as `@iracedeck/sim-events-iracing/testing`.
 *
 * `captureFixturePath` resolves one of this package's captured telemetry
 * fixtures (`src/diff/__fixtures__/`, see its `README.md`), so another
 * package's test reads a capture by package name rather than by a relative
 * path into this package's `src/`. Nothing here imports `vitest`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The fixtures folder, relative to this module. `../src/` names the same folder
 * from `src/testing.ts` (the vitest alias) and from `dist/testing.js` (the
 * built entry), since `src/` and `dist/` are siblings, and the JSON captures
 * are never copied into `dist/`.
 */
const FIXTURES_DIR = new URL("../src/diff/__fixtures__/", import.meta.url);

/** A bare fixture file name: no directory part, so no name resolves outside the folder. */
const FIXTURE_NAME = /^[a-z0-9][a-z0-9-]*\.json$/;

/**
 * The absolute path of the captured fixture `name` (e.g.
 * `caution-road-20260918.json`). Throws on a name that is not a bare `.json`
 * file name, and on one the folder does not hold, naming the folder.
 */
export function captureFixturePath(name: string): string {
  if (!FIXTURE_NAME.test(name)) {
    throw new Error(`captureFixturePath: "${name}" is not a bare fixture file name ending in .json`);
  }

  const path = fileURLToPath(new URL(name, FIXTURES_DIR));

  if (!existsSync(path)) {
    throw new Error(`captureFixturePath: no fixture "${name}" in ${fileURLToPath(FIXTURES_DIR)}`);
  }

  return path;
}
