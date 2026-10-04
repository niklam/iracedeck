#!/usr/bin/env node
/**
 * Runs ONE package's tests through the root Vitest suite (#1021).
 *
 * Every package with test files carries the same two scripts, byte-identical
 * across packages (guarded by `package-test-scripts.test.mjs`):
 *
 *   "test": "node ../../scripts/test-package.mjs",
 *   "test:watch": "node ../../scripts/test-package.mjs --watch"
 *
 * pnpm runs a script with the package directory as its cwd. This script turns
 * that directory into its workspace-relative form, `packages/<name>/`, and runs
 * the root suite from the workspace root with it as the Vitest filter — so the
 * root `vitest.config.ts` (its `include` globs, aliases and native-mock env)
 * applies exactly as it does to `pnpm test <path>`. The trailing slash matters:
 * a Vitest filter is a substring match on the file path, and `packages/icon`
 * would also match `packages/icons` and `packages/icon-composer`.
 *
 * The Vitest arguments come from the root `package.json`'s own `test` /
 * `test:watch` scripts, so `--configLoader native` lives in one place and the
 * per-package run cannot drift from the root run. Any further arguments are
 * forwarded to Vitest after the filter (`pnpm --filter <pkg> test -t "name"`),
 * and the child's exit code is this script's. Forward OPTIONS only: Vitest ORs
 * positional filters, so a path given here would widen the run beyond the
 * package rather than narrow it. Narrow to a file with `pnpm test <path>` at
 * the root.
 *
 * Why a script at all rather than none: pnpm skips a missing `test` script
 * silently with exit 0, so a package with tests and no working `test` script
 * reports green having run nothing. Design record:
 * docs/superpowers/specs/2026-10-04-issue-1021-per-package-test-runner.md
 */
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

/** The workspace root: this script lives in `<root>/scripts/`. */
export const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..");

/** The flag the `test:watch` script passes to select the root `test:watch` script. */
export const WATCH_FLAG = "--watch";

/**
 * The Vitest filter for the package directory `cwd`: `packages/<name>/`, with
 * forward slashes and a trailing slash. Throws when `cwd` is not a direct
 * `packages/<name>` directory of the workspace at `root` — the workspace root
 * itself, `packages/`, a directory inside a package, and anything outside the
 * workspace (another worktree's package included) are all refused.
 */
export function packageFilter(cwd, root) {
  const rel = path.relative(path.resolve(root), path.resolve(cwd));
  const parts = rel.split(path.sep);
  if (path.isAbsolute(rel) || parts.length !== 2 || parts[0] !== "packages" || !parts[1] || parts[1] === "..") {
    throw new Error(
      `test-package: run this from a package directory directly under ${path.join(root, "packages")} ` +
        `(pnpm does this for \`pnpm --filter <pkg> test\` and \`pnpm test\` inside a package); ` +
        `it was started in ${path.resolve(cwd)}. To run the whole suite, use \`pnpm test\` at the workspace root.`,
    );
  }
  return `packages/${parts[1]}/`;
}

/**
 * The Vitest arguments in a root `package.json` script, e.g.
 * `"vitest run --configLoader native"` → `["run", "--configLoader", "native"]`.
 * The script must start with `vitest` and be plain words: a quote or shell
 * operator would mean it no longer splits on whitespace into an argument list,
 * and running it differently from the root would defeat the point.
 */
export function vitestArgs(script, scriptName) {
  const words = typeof script === "string" ? script.trim().split(/\s+/) : [];
  if (words[0] !== "vitest") {
    throw new Error(
      `test-package: the root package.json "${scriptName}" script must start with \`vitest\` — ` +
        `scripts/test-package.mjs reads its Vitest arguments from it (got: ${JSON.stringify(script)}).`,
    );
  }
  if (words.some((w) => /["'`$&|;<>()^%]/.test(w))) {
    throw new Error(
      `test-package: the root package.json "${scriptName}" script must be plain words for ` +
        `scripts/test-package.mjs to reuse as an argument list (got: ${JSON.stringify(script)}).`,
    );
  }
  return words.slice(1);
}

/**
 * Splits this script's own arguments into the root script to read and the
 * arguments to forward to Vitest. A leading `--watch` (the `test:watch`
 * script's) selects `test:watch`; a leading `--` that pnpm passes through from
 * `pnpm test -- <args>` is dropped, because Vitest would read everything after
 * it as positional rather than as options.
 */
export function splitArgs(argv) {
  let rest = [...argv];
  let scriptName = "test";
  if (rest[0] === WATCH_FLAG) {
    scriptName = "test:watch";
    rest = rest.slice(1);
  }
  if (rest[0] === "--") rest = rest.slice(1);
  return { scriptName, forwarded: rest };
}

/** Absolute path of the Vitest CLI entry, resolved from the workspace root's dependencies. */
export function vitestBin(root) {
  const require = createRequire(path.join(root, "package.json"));
  const manifestPath = require.resolve("vitest/package.json");
  const { bin } = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rel = typeof bin === "string" ? bin : bin?.vitest;
  if (!rel) throw new Error(`test-package: ${manifestPath} declares no \`vitest\` bin.`);
  return path.resolve(path.dirname(manifestPath), rel);
}

function main() {
  const root = WORKSPACE_ROOT;
  let args;
  try {
    // Real path, because WORKSPACE_ROOT comes from the already-realpath'ed
    // module URL while a cwd reached through a junction or `subst` drive keeps
    // that form, and the two would never relate.
    const filter = packageFilter(realpathSync.native(process.cwd()), root);
    const { scriptName, forwarded } = splitArgs(process.argv.slice(2));
    const rootScripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
    args = [vitestBin(root), ...vitestArgs(rootScripts[scriptName], scriptName), filter, ...forwarded];
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  // stderr, so a reporter writing to stdout (`--reporter=json > out.json`) stays parseable.
  console.error(`test-package: vitest ${args.slice(1).join(" ")}  (in ${root})`);
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
  // Never exit ahead of Vitest, which would leave it (and, in watch mode, its
  // worker pool) running orphaned. A Ctrl+C reaches Vitest directly — the
  // console or the foreground process group delivers it to both — so SIGINT
  // only keeps this process waiting while Vitest tears itself down; forwarding
  // it would turn that into a hard kill on Windows. A stop aimed at this
  // process alone is passed on.
  process.on("SIGINT", () => {});
  for (const sig of ["SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(sig);
    });
  }
  child.on("error", (err) => {
    console.error(`test-package: could not start Vitest: ${err.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) console.error(`test-package: Vitest was terminated by ${signal}.`);
    process.exitCode = code ?? 1;
  });
}

// Run only when invoked directly (not when imported by the tests).
if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
