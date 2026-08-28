#!/usr/bin/env node
/**
 * Starts or stops a deck host application (#1040):
 *
 *   node scripts/host-app.mjs start ulanzi
 *   node scripts/host-app.mjs stop mirabox
 *
 * Backs `pnpm start:ulanzi` / `stop:ulanzi` / `start:mirabox` / `stop:mirabox`.
 * The executable is env-configurable (`ULANZI_APP_PATH`, `MIRABOX_APP_PATH`,
 * settable in a gitignored `.env.local`) with a `%ProgramFiles(x86)%` default,
 * because two Mirabox-compatible hosts are commonly installed side by side
 * (StreamDock and VSD Craft) and a hardcoded path would be wrong for one of them.
 *
 * Why this is part of the dev loop rather than a convenience: the hosts read
 * their plugins directory at start ONLY, so a relink without a restart changes
 * nothing. And the host must be stopped BEFORE `pnpm build`, not before the
 * relink — a running host holds `iracing_native.node` open and the build fails
 * with EPERM.
 *
 * This file is argument handling only; the decisions live in
 * `lib/host-control.mjs`, where they can be tested.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findHost, hostNames, resolveAppPathSource } from "./lib/deck-hosts.mjs";
import { loadEnvLocal } from "./lib/env-local.mjs";
import { startHost, stopHost } from "./lib/host-control.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [, , action, hostId] = process.argv;

// `process.exitCode` rather than `process.exit`: on a Windows TTY stdout is
// asynchronous, and exiting outright can truncate the pending write — which
// here is the line naming which worktree now owns the host.
process.exitCode = await main();

async function main() {
  if (action !== "start" && action !== "stop") {
    console.error(`Error: expected "start" or "stop", got ${JSON.stringify(action ?? "")}.`);
    console.error("Usage: node scripts/host-app.mjs <start|stop> <ulanzi|mirabox>");

    return 1;
  }

  const host = findHost(hostId);
  if (!host) {
    console.error(`Error: unknown host ${JSON.stringify(hostId ?? "")}. Expected one of: ${hostNames()}`);

    return 1;
  }

  loadEnvLocal(root);

  if (process.platform !== "win32") {
    console.log(`${host.label} host control is Windows-only — nothing to ${action}.`);

    return 0;
  }

  const { path: appPath } = resolveAppPathSource(host);
  if (!appPath) {
    console.error(`Error: ${host.appPathEnv} is not set and no default could be derived.`);
    console.error("Set it in your shell or in .env.local at the repo root, e.g.:");
    console.error(`  ${host.appPathEnv}="${host.exampleAppPath}"`);

    return 1;
  }

  return action === "stop" ? stopHost(host, { appPath, spawnSync }) : await startHost(host, { appPath, spawn });
}
