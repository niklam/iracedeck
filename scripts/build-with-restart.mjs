/**
 * `pnpm build:with-restart`: stops a running Stream Deck app, runs the build
 * and starts the app again, or says plainly that it could not (#1523).
 *
 * This file only wires the real process functions in; the decisions live in
 * `lib/build-restart.mjs`, where they can be tested.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { buildWithRestart } from "./lib/build-restart.mjs";

// turbo's own JS entry, run with this Node rather than through the
// `node_modules/.bin/turbo.cmd` shim: that is a batch file, and on Ctrl+C
// `cmd.exe` stops at "Terminate batch job (Y/N)?", holding the restart until
// someone answers.
const turbo = createRequire(import.meta.url).resolve("turbo/bin/turbo");

// `process.exitCode` rather than `process.exit`, as in `host-app.mjs`: on a
// Windows TTY stdout is asynchronous, and exiting outright can truncate the
// line saying whether Stream Deck was restarted.
process.exitCode = await buildWithRestart({
  build: () => {
    // Ctrl+C reaches this process as well as turbo. Without a listener Node
    // exits at once, skipping the restart, and Stream Deck stays stopped with
    // nothing said. A listener holds the signal until `spawnSync` returns, so
    // the interrupted build ends as a failed one and the app is started again.
    const holdInterrupt = () => {};
    process.on("SIGINT", holdInterrupt);
    try {
      const result = spawnSync(process.execPath, [turbo, "run", "build"], { stdio: "inherit" });
      if (result.error) throw result.error;

      return result.status ?? 1;
    } finally {
      process.off("SIGINT", holdInterrupt);
    }
  },
  spawnSync,
  spawn,
  exists: existsSync,
});
