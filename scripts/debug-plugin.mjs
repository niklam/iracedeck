#!/usr/bin/env node
/**
 * `pnpm debug:plugin on|off|status` — the local debug switch for the Elgato
 * plugin (#1338).
 *
 * `on` adds `"Debug": "--inspect=127.0.0.1:9229"` to the manifest's `Nodejs`
 * block of THIS checkout, `off` removes exactly that line, `status` reports
 * off, on, or a Debug value the switch did not set. Stream Deck acts on the key
 * only in developer mode and only when it (re)starts the plugin.
 *
 * Never shipped: `assert-release-build` (the first step of `pack:plugin`), the
 * pre-bash commit hook and `scripts/manifest-no-debug.test.mjs` each refuse a
 * manifest that carries the key.
 *
 * Argument handling only — the behaviour lives in `lib/debug-plugin.mjs`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDebugPlugin } from "./lib/debug-plugin.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// `process.exitCode` rather than `process.exit`: a Windows TTY's stdout is
// asynchronous, and exiting outright can truncate the line naming the fix.
process.exitCode = runDebugPlugin(process.argv[2], { root });
