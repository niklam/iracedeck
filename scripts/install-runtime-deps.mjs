/**
 * Installs a plugin's runtime dependencies: `npm install` in its `bin/` folder,
 * against the `package.json` that `lib/runtime-deps.mjs` emitted there (#1177).
 *
 * Usage (from a plugin package, as its `postbuild`):
 *   node ../../scripts/install-runtime-deps.mjs <plugin folder>/bin
 *
 * A Node script rather than `cd … && npm install` so npm starts without pnpm's
 * own `npm_config_*` keys — see `lib/runtime-install-env.mjs` (#1205).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { runtimeInstallEnv } from "./lib/runtime-install-env.mjs";

const binDir = process.argv[2];
if (!binDir) {
  console.error("usage: node install-runtime-deps.mjs <bin folder>");
  process.exit(1);
}

// `shell` because npm is `npm.cmd` on Windows, which Node will not spawn directly;
// the command line is a constant, so nothing is interpolated into it.
const result = spawnSync("npm install", {
  cwd: path.resolve(binDir),
  env: runtimeInstallEnv(process.env),
  shell: true,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
