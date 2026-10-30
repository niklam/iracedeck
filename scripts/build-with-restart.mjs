/**
 * `pnpm build:with-restart`: stops a running Stream Deck app, runs the build
 * and starts the app again, or says plainly that it could not (#1523).
 *
 * This file only wires the real process functions in; the decisions live in
 * `lib/build-restart.mjs`, where they can be tested.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { buildWithRestart } from "./lib/build-restart.mjs";
import { spawnSyncShim } from "./lib/spawn-shim.mjs";

// `process.exitCode` rather than `process.exit`, as in `host-app.mjs`: on a
// Windows TTY stdout is asynchronous, and exiting outright can truncate the
// line saying whether Stream Deck was restarted.
process.exitCode = await buildWithRestart({
  build: () => {
    const result = spawnSyncShim("turbo", ["run", "build"], { stdio: "inherit" });
    if (result.error) throw result.error;

    return result.status ?? 1;
  },
  spawnSync,
  spawn,
  exists: existsSync,
});
