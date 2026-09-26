/**
 * Spawning a `.cmd` shim — `pnpm`, `npx`, `tsx`, `streamdeck` — the one way
 * Node lets us on Windows without a deprecation (#1149).
 *
 * Two Node rules pin the shape:
 *
 * - A `.cmd` cannot be spawned WITHOUT a shell: since the CVE-2024-27980
 *   hardening, `spawnSync("pnpm.cmd", args)` fails with `EINVAL`. Resolving the
 *   shim to its real path does not help, because the real path is still a
 *   `.cmd`.
 * - An args ARRAY alongside `shell: true` is deprecated (DEP0190, Node 24) and
 *   announced to become an error. Node never quoted that array anyway — it
 *   space-joined it into the command line.
 *
 * So on Windows the shell stays and the array goes: `cmd` and `args` are joined
 * here into ONE quoted command line, handed to `spawnSync` with `shell: true`
 * and no args array. Everywhere else the shim is a real executable and is
 * spawned directly, with no shell at all, so the arguments arrive intact.
 *
 * The join is safe for the arguments this repo passes — fixed literals, plus
 * the maintainer's own `pnpm release` flags. It is not a general escaper for
 * untrusted input: an argument `cmd.exe` would still reinterpret inside double
 * quotes is refused rather than mangled (see {@link shellCommandLine}).
 */
import { spawnSync } from "node:child_process";

/** `cmd.exe` operators that split or redirect a command line outside quotes. */
const CMD_METACHARACTERS = /[&|<>^()]/;

/**
 * Joins a command and its arguments into ONE `cmd.exe` command line. An
 * argument containing whitespace, a double quote or a `cmd.exe` operator is
 * wrapped in double quotes, an inner `"` escaped as `\"` for the program's own
 * argument parser. Pure — exported so the quoting is tested without spawning.
 *
 * Throws on an argument the quoting cannot carry: `%` (`cmd.exe` expands
 * `%NAME%` even inside quotes), a line break, and a `"` in the same argument as
 * an operator (`cmd.exe` does not read `\"` as an escape, so the operator would
 * land outside its quotes).
 */
export function shellCommandLine(cmd, args) {
  return [cmd, ...args].map((arg) => quoteShellArg(String(arg))).join(" ");
}

function quoteShellArg(arg) {
  if (/[%\r\n]/.test(arg) || (arg.includes('"') && CMD_METACHARACTERS.test(arg))) {
    throw new TypeError(`Cannot pass ${JSON.stringify(arg)} through cmd.exe intact.`);
  }
  return /[\s"]/.test(arg) || CMD_METACHARACTERS.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * `spawnSync` for a `.cmd` shim: one quoted command line through the shell on
 * Windows, a direct no-shell spawn elsewhere. `options` pass through to
 * `spawnSync` unchanged, except that `shell` is decided here.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 * @param {NodeJS.Platform} [platform] injected by the tests
 */
export function spawnSyncShim(cmd, args, options = {}, platform = process.platform) {
  return platform === "win32"
    ? spawnSync(shellCommandLine(cmd, args), { ...options, shell: true })
    : spawnSync(cmd, args, { ...options, shell: false });
}
