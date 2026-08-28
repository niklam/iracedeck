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
 */
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readlinkSync, lstatSync } from "node:fs";
import { requireHost, resolveAppPath, resolvePluginsDir } from "./lib/deck-hosts.mjs";
import { loadEnvLocal } from "./lib/env-local.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [, , action, hostId] = process.argv;

if (action !== "start" && action !== "stop") {
  console.error(`Error: expected "start" or "stop", got ${JSON.stringify(action ?? "")}.`);
  console.error("Usage: node scripts/host-app.mjs <start|stop> <ulanzi|mirabox>");
  process.exit(1);
}

const host = requireHost(hostId);
loadEnvLocal(root);

if (process.platform !== "win32") {
  console.log(`${host.label} host control is Windows-only — nothing to ${action}.`);
  process.exit(0);
}

const appPath = resolveAppPath(host);
if (!appPath) {
  console.error(`Error: ${host.appPathEnv} is not set and no default could be derived.`);
  console.error("Set it in your shell or in .env.local at the repo root, e.g.:");
  console.error(`  ${host.appPathEnv}="${host.exampleAppPath}"`);
  process.exit(1);
}

if (action === "stop") {
  stopHost();
} else {
  startHost();
}

/**
 * Force-kills the host by image name. Not running is a success, matching the
 * `|| exit 0` on the existing `stop:stream-deck` script — the point is to reach
 * a stopped state, not to assert it was running.
 */
function stopHost() {
  const image = basename(appPath);
  const result = spawnSync("taskkill", ["/IM", image, "/F"], { encoding: "utf8", windowsHide: true });

  if (result.error) {
    console.error(`Error: could not run taskkill: ${result.error.message}`);
    process.exit(1);
  }

  console.log(result.status === 0 ? `Stopped ${image}.` : `${image} was not running.`);
}

/**
 * Launches the host detached, after reporting which plugin build it is about to
 * load. That echo is the whole point: like the Stream Deck link, the junction
 * points at exactly ONE worktree, and "my fix isn't working" is nearly always
 * the host serving somebody else's checkout.
 */
function startHost() {
  reportLinkTarget();

  const child = spawn(appPath, [], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (error) => {
    console.error(`Error: could not start ${appPath}\n  ${error.message}`);
    process.exit(1);
  });
  child.unref();

  console.log(`Started ${basename(appPath)}.`);
}

/** Prints where the host's plugin entry currently points, when it is a link. */
function reportLinkTarget() {
  const dest = resolvePluginsDir(host);
  if (!dest) return;

  const link = join(dest, host.pluginFolder);
  const stat = lstatSync(link, { throwIfNoEntry: false });

  if (!stat) {
    console.log(`Note: no ${host.label} plugin at ${link} — run \`pnpm link:${host.id}\` first.`);

    return;
  }

  if (!stat.isSymbolicLink()) {
    console.log(`${host.label} plugin is an installed copy (not linked):\n  ${link}`);

    return;
  }

  try {
    console.log(`${host.label} plugin links to:\n  ${readlinkSync(link)}`);
  } catch {
    console.log(`${host.label} plugin is linked at ${link} (target unreadable).`);
  }
}
