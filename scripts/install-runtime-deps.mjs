/**
 * Installs a plugin's runtime dependencies: `npm install` in its `bin/` folder,
 * against the `package.json` that `lib/runtime-deps.mjs` emitted there (#1177).
 *
 * Usage (from a plugin package, as its `postbuild`):
 *   node ../../scripts/install-runtime-deps.mjs <plugin folder>/bin
 *
 * A Node script rather than `cd … && npm install` so npm starts without the
 * pnpm-only `npm_config_*` keys it would warn about. Argument handling only; the
 * behaviour is `lib/runtime-install-env.mjs` (#1205).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { installRuntimeDeps } from "./lib/runtime-install-env.mjs";

process.exitCode = installRuntimeDeps(process.argv[2], {
  env: process.env,
  exists: existsSync,
  missingPath: (label) => path.join(tmpdir(), `iracedeck-${process.pid}-no-${label}-npmrc`),
  run: (command, { cwd, env, capture }) =>
    spawnSync(command, { cwd, env, shell: true, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" }),
  log: (message) => console.error(message),
});
