/**
 * Start/stop for the deck host applications (#1040), split out of
 * `scripts/host-app.mjs` so the decisions in here can be tested — the sibling
 * `plugin-link.mjs` already follows this shape (injected `env`/`log`, return an
 * exit code, never call `process.exit`).
 *
 * The assertion that motivated the split: a `taskkill` that FAILS must not be
 * reported as "was not running". The dev loop is `stop && switch-test-env &&
 * start`, so a stop that only looked like it worked lets the build proceed into
 * the EPERM-on-iracing_native.node failure the stop step exists to prevent.
 */
import { lstatSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { resolvePluginsDirSource } from "./deck-hosts.mjs";

/** `taskkill` exit codes: 0 = terminated, 128 = no such process, else = failure. */
export const TASKKILL_NOT_FOUND = 128;

/**
 * Classifies a taskkill result. Verified on Windows: killing an absent image
 * exits 128 ("ERROR: The process ... not found"), while a refused kill exits 1
 * ("Access is denied") — so "not running" and "could not kill" are genuinely
 * distinguishable and must not be collapsed.
 *
 * @returns {"stopped" | "not-running" | "failed"}
 */
export function interpretTaskkill(status) {
  if (status === 0) return "stopped";
  if (status === TASKKILL_NOT_FOUND) return "not-running";

  return "failed";
}

/**
 * Force-stops the host by image name.
 *
 * @returns {number} 0 when the host is now stopped (including "was not
 *   running"), 1 when the kill was attempted and refused.
 */
export function stopHost(host, { appPath, spawnSync, log = console } = {}) {
  const image = basename(appPath);
  const result = spawnSync("taskkill", ["/IM", image, "/F"], { encoding: "utf8", windowsHide: true });

  if (result.error) {
    log.error(`Error: could not run taskkill: ${result.error.message}`);

    return 1;
  }

  switch (interpretTaskkill(result.status)) {
    case "stopped":
      log.log(`Stopped ${image}.`);

      return 0;

    case "not-running":
      log.log(`${image} was not running.`);

      return 0;

    default: {
      // Surface taskkill's own words — "Access is denied" is the whole
      // diagnosis, and it is the usual outcome when the host runs elevated
      // and this shell does not.
      const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
      log.error(`Error: could not stop ${image} (taskkill exit ${result.status}).`);
      if (detail) log.error(`  ${detail}`);
      log.error(`  A build will fail with EPERM while ${host.label} still holds the native module.`);

      return 1;
    }
  }
}

/**
 * Launches the host detached, after reporting which plugin build it will load.
 *
 * Success is reported from the `spawn` event, not before it: `spawn()` reports
 * ENOENT asynchronously, so printing "Started ..." eagerly puts a success line
 * above the error in the one-liner's output, which is the line a developer skims.
 *
 * `windowsHide` is deliberately NOT set here. It maps to STARTF_USESHOWWINDOW
 * with SW_HIDE, which suppresses a console window — but a GUI host that honours
 * the inherited nCmdShow then comes up invisible while still running, and the
 * next start is refused as a second instance.
 *
 * @returns {Promise<number>}
 */
export function startHost(host, { appPath, spawn, env = process.env, platform = process.platform, log = console } = {}) {
  describeLinkTarget(host, { env, platform, log });

  return new Promise((resolve) => {
    const child = spawn(appPath, [], { detached: true, stdio: "ignore" });

    child.on("error", (error) => {
      log.error(`Error: could not start ${appPath}\n  ${error.message}`);
      resolve(1);
    });

    child.on("spawn", () => {
      log.log(`Started ${basename(appPath)}.`);
      child.unref();
      resolve(0);
    });
  });
}

/**
 * Prints where the host's plugin entry currently points.
 *
 * This is why `start` is a script rather than a manual launch: the junction
 * serves exactly ONE worktree, and a developer testing someone else's checkout
 * is the most common cause of "my fix isn't working".
 */
export function describeLinkTarget(host, { env = process.env, platform = process.platform, log = console } = {}) {
  const dest = resolvePluginsDirSource(host, { env, platform }).path;
  if (!dest) return;

  const link = join(dest, host.pluginFolder);
  const stat = lstatSync(link, { throwIfNoEntry: false });

  if (!stat) {
    log.log(`Note: no ${host.label} plugin at ${link} — run \`pnpm ${host.linkScript}\` first.`);

    return;
  }

  if (!stat.isSymbolicLink()) {
    log.log(`${host.label} plugin is an installed copy (not linked):\n  ${link}`);

    return;
  }

  let target;
  try {
    target = readlinkSync(link);
  } catch {
    target = undefined;
  }

  log.log(target ? `${host.label} plugin links to:\n  ${target}` : `${host.label} plugin is linked at ${link}.`);
}
