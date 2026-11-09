/**
 * `pnpm release` / `pnpm release:dry`: the wrapper around release-it.
 *
 * It strips the `--` separator pnpm inserts, exports `GITHUB_TOKEN` from
 * `gh auth token` when the variable is not already set, and makes the dry run
 * a real preview of the two hooks: `before:bump` (`scripts/release-hooks.mjs`,
 * the bump, the fold and the voice-pack seal) and `after:bump`
 * (`scripts/release-capture.mjs`, the stable release's Settings-window
 * screenshot capture, #1536).
 *
 * That last part exists because release-it 21.1.1 does NOT run hooks in a dry
 * run: `lib/shell.js` turns every write-mode exec — hooks included, they run
 * `external: true` — into a logged `! <command>` and a no-op, so
 * `npx release-it --dry-run` shows `! node scripts/release-hooks.mjs <version>`
 * and never runs it. The hooks' own `RELEASE_IT_DRY_RUN=1` branches, which
 * print the version files they would bump, the changelog section they would
 * write, the voice-pack records they would seal (#1386, #1667) and the build
 * and capture they would run (#1536), were therefore never reached by
 * `pnpm release:dry`. So on a dry run this wrapper first asks release-it which
 * version it would release (`--release-version`, which runs only the `init`
 * lifecycle — the clean-tree check and a `git fetch` — prints the version and
 * exits), runs each hook in release order with that version and the flag set,
 * stops at the first that refuses (a stale pack record, a malformed fragment
 * or a developer-tree marker then shows in the preview, as it would stop the
 * real release), and only then runs release-it's own dry run. Nothing in that
 * sequence writes: each hook's dry-run branch exits before any write or
 * `git add`, and release-it's dry run logs its commands instead of running
 * them. `scripts/release.test.mjs` drives the sequence with fakes; the real
 * `pnpm release:dry 9.9.9-rc.1 --ci` leaves `git status --porcelain` empty and
 * creates no tag.
 *
 * The flag is still set for release-it's own dry run, so that should a
 * release-it upgrade run hooks in a dry run again, the hooks still write
 * nothing.
 */
import { execSync, spawnSync } from "node:child_process";
import url from "node:url";
import semver from "semver";

import { spawnSyncShim } from "./lib/spawn-shim.mjs";

const hookPath = url.fileURLToPath(new URL("./release-hooks.mjs", import.meta.url));
const captureHookPath = url.fileURLToPath(new URL("./release-capture.mjs", import.meta.url));

/** The spellings release-it accepts for a dry run, and so this wrapper. */
const DRY_RUN_FLAGS = new Set(["--dry-run", "-d", "--dry-run=true"]);

/**
 * release-it's arguments: everything after the script path, minus a leading
 * `--`. pnpm forwards that separator when the maintainer types
 * `pnpm release -- minor --preRelease=alpha`; release-it treats it as a
 * positional argument and silently drops everything after it.
 *
 * @param {readonly string[]} rawArgs
 */
export function releaseItArgs(rawArgs) {
  return rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];
}

/** @param {readonly string[]} args */
export function isDryRun(args) {
  return args.some((arg) => DRY_RUN_FLAGS.has(arg));
}

/**
 * The arguments that make release-it print the version the given arguments
 * would release and exit: the same increment, pre-release and config flags
 * without the dry-run flag, plus `--release-version` (which implies `--ci`, so
 * nothing prompts).
 *
 * @param {readonly string[]} args
 */
export function releaseVersionArgs(args) {
  return [...args.filter((arg) => !DRY_RUN_FLAGS.has(arg)), "--release-version"];
}

/**
 * `args` with `--ci` once: release-it then resolves the version from the
 * arguments and its default increment, as `--release-version` does, instead of
 * prompting for one.
 *
 * @param {readonly string[]} args
 */
export function withCi(args) {
  return args.includes("--ci") ? [...args] : [...args, "--ci"];
}

/**
 * The version from `release-it --release-version`'s stdout: its last non-empty
 * line, which must be a semver version. `null` for anything else, so a warning
 * or an error that landed on stdout is never run through the hook as a
 * version.
 *
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseReleaseVersion(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  const last = lines.at(-1)?.trim();

  return last !== undefined && semver.valid(last) === last ? last : null;
}

/**
 * The wrapper, with release-it and the hook injectable so the sequence is
 * tested without either. Returns the exit code.
 *
 * @param {readonly string[]} rawArgs — everything after the script path
 * @param {object} [deps]
 * @param {NodeJS.ProcessEnv} [deps.env] — read for `GITHUB_TOKEN`, handed to every child with `RELEASE_IT_DRY_RUN` set on a dry run
 * @param {(args: string[], options: import("node:child_process").SpawnSyncOptions) => import("node:child_process").SpawnSyncReturns<string>} [deps.runReleaseIt]
 * @param {(version: string, env: NodeJS.ProcessEnv) => import("node:child_process").SpawnSyncReturns<string>} [deps.runHook] — the `before:bump` hook
 * @param {(version: string, env: NodeJS.ProcessEnv) => import("node:child_process").SpawnSyncReturns<string>} [deps.runCaptureHook] — the `after:bump` hook
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.warn]
 * @param {(line: string) => void} [deps.error]
 * @returns {number}
 */
export function main(
  rawArgs,
  {
    env = process.env,
    runReleaseIt = (args, options) => spawnSyncShim("npx", ["release-it", ...args], options),
    runHook = (version, hookEnv) =>
      spawnSync(process.execPath, [hookPath, version], { stdio: "inherit", env: hookEnv }),
    runCaptureHook = (version, hookEnv) =>
      spawnSync(process.execPath, [captureHookPath, version], { stdio: "inherit", env: hookEnv }),
    log = console.log,
    warn = console.warn,
    error = console.error,
  } = {},
) {
  if (!env.GITHUB_TOKEN) {
    try {
      env.GITHUB_TOKEN = execSync("gh auth token", { encoding: "utf-8", env }).trim();
    } catch {
      warn("Warning: Could not get GitHub token from gh CLI. GitHub Releases may fail.");
    }
  }

  const args = releaseItArgs(rawArgs);
  const childEnv = { ...env };

  if (isDryRun(args)) {
    // The hook reads this and writes nothing; see the header for why the wrapper
    // runs the hook itself.
    childEnv.RELEASE_IT_DRY_RUN = "1";

    const resolved = runReleaseIt(releaseVersionArgs(args), {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv,
    });

    if (resolved.error) {
      error(String(resolved.error));

      return 1;
    }

    const version = resolved.status === 0 ? parseReleaseVersion(resolved.stdout ?? "") : null;

    if (version === null) {
      error(
        `Could not resolve the version the dry run would release (release-it --release-version exited ` +
          `${resolved.status} with ${JSON.stringify((resolved.stdout ?? "").trim())}); the dry run stops here.`,
      );

      return 1;
    }

    // In release order: the bump and fold, then the screenshot capture that
    // builds what the bump produced. Each hook's dry-run branch reads the tree
    // only, so the second previews the same tree the first did.
    for (const [name, run] of [
      ["before:bump", runHook],
      ["after:bump", runCaptureHook],
    ]) {
      log(`Previewing the ${name} hook for ${version} (release-it skips hooks in a dry run):`);

      const hook = run(version, childEnv);

      if (hook.error) {
        error(String(hook.error));

        return 1;
      }

      if (hook.status !== 0) {
        error(`The ${name} hook refused ${version}, so the release would stop there; the dry run stops here.`);

        return hook.status ?? 1;
      }
    }
  }

  // A dry run runs with `--ci`, so release-it resolves the version the way the
  // probe did instead of prompting for one: interactively its version prompt
  // would otherwise let the maintainer pick a version the preview above did not
  // describe, and a prompt in a dry run decides nothing anyway.
  const result = runReleaseIt(isDryRun(args) ? withCi(args) : args, { stdio: "inherit", env: childEnv });

  if (result.error) {
    error(String(result.error));

    return 1;
  }

  return result.status ?? 1;
}

// Direct-exec guard: only run when this file was executed as the entry script,
// so importing the helpers (the tests do) releases nothing.
const invokedPath = process.argv[1];
if (
  invokedPath &&
  (import.meta.url === url.pathToFileURL(invokedPath).href || invokedPath === url.fileURLToPath(import.meta.url))
) {
  process.exit(main(process.argv.slice(2)));
}
