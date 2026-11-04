/**
 * The capture's view of the browser's processes (#1544): is one still running,
 * which processes belong to this run's browser, and kill one with everything
 * it started.
 *
 * Kept apart from the orchestration in `capture.mjs`, which receives these as
 * injected collaborators so its teardown is tested with fakes; the OS calls are
 * injected here in turn, so this is tested without starting a process.
 *
 * A browser's processes are recognised by its profile folder. The capture
 * gives each run a `--user-data-dir` of its own (`iracedeck-capture-<pid>`),
 * and every process of that browser's tree names it on its command line — the
 * browser, its renderers, GPU and utility processes, its crash handler. That
 * is an identity a bare pid is not: a pid the browser has given up can be
 * handed to an unrelated process within moments on Windows, while no other
 * process names this run's profile.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readableStderr } from "../build-restart.mjs";
import { interpretTaskkill } from "../host-control.mjs";

/** How long `taskkill` may run before it is given up on. */
export const KILL_TREE_TIMEOUT_MS = 10_000;

/** How long one listing of the processes may take before it is given up on. */
export const LIST_PROCESSES_TIMEOUT_MS = 15_000;

/**
 * Whether a process is still running.
 *
 * Signal 0 checks for the process without signalling it. `ESRCH` means there
 * is no such process; `EPERM` means there is one we may not signal, which is
 * still a running process, as is any other answer — a wrong "gone" would end
 * the wait for a browser that still holds its profile.
 *
 * @param {number} pid
 * @param {object} [deps]
 * @param {(pid: number, signal: number | string) => unknown} [deps.kill] - `process.kill`, injected for tests.
 * @returns {boolean}
 */
export function isProcessAlive(pid, deps = {}) {
  const { kill = (target, signal) => process.kill(target, signal) } = deps;

  try {
    kill(pid, 0);

    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error)?.code !== "ESRCH";
  }
}

/**
 * Kill a process and every process it started.
 *
 * On Windows `taskkill /T /F` takes the tree. Its exit code 128 is "no such
 * process", which here is a process that went by itself — common, since
 * killing a browser's tree takes its children with it before their own turn
 * comes — so it is told apart from a kill rather than failing. Elsewhere
 * `SIGKILL`, with `ESRCH` read the same way; it is only reached after the
 * browser ignored `Browser.close`, so it is not asked twice.
 *
 * @param {number} pid - A process the caller has just seen naming the profile.
 * @param {object} [deps]
 * @param {NodeJS.Platform} [deps.platform]
 * @param {(file: string, args: string[], options: object) => Promise<unknown>} [deps.execFileImpl] - Promisified `execFile`, injected for tests.
 * @param {(pid: number, signal: number | string) => unknown} [deps.kill] - `process.kill`, injected for tests.
 * @returns {Promise<"stopped" | "not-running">} Whether this call stopped it.
 * @throws When the kill was attempted and refused, or could not be sent.
 */
export async function killProcessTree(pid, deps = {}) {
  const {
    platform = process.platform,
    execFileImpl = promisify(execFile),
    kill = (target, signal) => process.kill(target, signal),
  } = deps;

  if (platform !== "win32") {
    try {
      kill(pid, "SIGKILL");

      return "stopped";
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ESRCH") return "not-running";

      throw error;
    }
  }

  try {
    await execFileImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: KILL_TREE_TIMEOUT_MS,
    });

    return "stopped";
  } catch (error) {
    const { code, stderr } = /** @type {{code?: unknown, stderr?: string}} */ (error);

    // A number is taskkill's own exit code; anything else (ENOENT, a timeout)
    // means it never gave one.
    if (typeof code !== "number") throw error;

    if (interpretTaskkill(code) === "not-running") return "not-running";

    // One line: taskkill wraps its reason onto a second one.
    const detail = `${stderr ?? ""}`.replace(/\s+/g, " ").trim();

    throw new Error(`taskkill exited ${code}${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * `text` as a single-quoted PowerShell literal. Nothing inside one is
 * interpreted — no `$`, no backtick — except a `'`, which is written twice.
 *
 * @param {string} text
 * @returns {string}
 */
export function powerShellLiteral(text) {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * The PowerShell that prints the pid of every process whose command line names
 * `dir`, one per line.
 *
 * Named means the folder itself, not a longer name it prefixes: `…-123` must
 * not match a concurrent run's `…-1234`, so the character after it has to end
 * the path or start a part of it inside the folder. Case-insensitive, as
 * Windows paths are. Filtered here rather than through WMI's `-Filter`, whose
 * `LIKE` would need a second escaping scheme for `[`, `_` and `%`.
 *
 * The shell running this never matches itself: it is started with
 * `-EncodedCommand`, so its command line carries the folder only as base64,
 * and `$PID` is excluded as well.
 *
 * The rest follows `build-restart.mjs`'s lister: `Stop` turns a WMI error into
 * a non-zero exit, so a failed listing is never read as an empty one; the
 * error is written as plain text, not CLIXML; output is UTF-8.
 *
 * @param {string} dir
 * @returns {string}
 */
export function profileProcessListScript(dir) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    `$pattern = [regex]::Escape(${powerShellLiteral(dir)}) + '(?![^\\\\/"\\s])'`,
    // One element: a `;` between `try {}` and `catch {}` is a parse error.
    "try { Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and " +
      "$_.CommandLine -match $pattern } | ForEach-Object { $_.ProcessId } } " +
      "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  ].join("; ");
}

/**
 * The arguments that run {@link profileProcessListScript}, encoded.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function profileProcessListArgs(dir) {
  const encoded = Buffer.from(profileProcessListScript(dir), "utf16le").toString("base64");

  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

/**
 * Whether a command line names `dir` itself, by the rule in
 * {@link profileProcessListScript}. Case-sensitive: this is the POSIX side.
 *
 * @param {string} commandLine
 * @param {string} dir
 * @returns {boolean}
 */
export function commandLineNamesDir(commandLine, dir) {
  for (let at = commandLine.indexOf(dir); at >= 0; at = commandLine.indexOf(dir, at + 1)) {
    const next = commandLine[at + dir.length];

    if (next === undefined || /[\\/"\s]/.test(next)) return true;
  }

  return false;
}

/**
 * Parse the Windows lister's output: a pid per line. Any other line makes the
 * whole listing unreadable rather than being skipped, since a skipped line
 * could be the one process still holding the profile.
 *
 * @param {string} stdout
 * @returns {number[] | undefined}
 */
export function parsePidLines(stdout) {
  const pids = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (!/^\d+$/.test(trimmed)) return undefined;

    pids.push(Number(trimmed));
  }

  return pids;
}

/**
 * Parse `ps -Ao pid=,args=` and keep the processes naming `dir`.
 *
 * @param {string} stdout
 * @param {string} dir
 * @returns {number[] | undefined} `undefined` when a line is not `<pid> <args>`.
 */
export function parsePsOutput(stdout, dir) {
  const pids = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const match = /^\s*(\d+)\s(.*)$/.exec(line);

    if (!match) return undefined;

    if (commandLineNamesDir(match[2], dir)) pids.push(Number(match[1]));
  }

  return pids;
}

/**
 * Every running process whose command line names `dir`.
 *
 * @param {string} dir - The browser's `--user-data-dir`.
 * @param {object} [deps]
 * @param {NodeJS.Platform} [deps.platform]
 * @param {(file: string, args: string[], options: object) => Promise<{stdout: string}>} [deps.execFileImpl] - Promisified `execFile`, injected for tests.
 * @returns {Promise<{state: "listed", pids: number[]} | {state: "unknown", reason: string}>}
 *   Never a throw: a listing that failed is "could not tell", never "none".
 */
export async function listProcessesNamingDir(dir, deps = {}) {
  const { platform = process.platform, execFileImpl = promisify(execFile) } = deps;
  const windows = platform === "win32";
  const [file, args] = windows ? ["powershell.exe", profileProcessListArgs(dir)] : ["ps", ["-Ao", "pid=,args="]];

  let stdout;

  try {
    ({ stdout } = await execFileImpl(file, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: LIST_PROCESSES_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    const { code, stderr, message } = /** @type {{code?: unknown, stderr?: string, message?: string}} */ (error);

    if (typeof code !== "number") return { state: "unknown", reason: `could not run ${file}: ${message}` };

    const detail = readableStderr(stderr);

    return { state: "unknown", reason: `${file} exited ${code}${detail ? `: ${detail}` : ""}` };
  }

  const text = `${stdout ?? ""}`;
  const pids = windows ? parsePidLines(text) : parsePsOutput(text, dir);

  if (!pids) return { state: "unknown", reason: `unexpected output from ${file}: ${text.trim().slice(0, 200)}` };

  return { state: "listed", pids };
}
