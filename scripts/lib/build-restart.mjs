/**
 * `pnpm build:with-restart` (#1523): stops a running Stream Deck app, builds,
 * and starts it again, because a host reads its plugins at start only. Split
 * out of `scripts/build-with-restart.mjs` so the decisions can be tested, in
 * the shape of `host-control.mjs` (injected `spawnSync`/`spawn`/`env`/`log`, an
 * exit code returned, never `process.exit`).
 *
 * The rule this module exists to keep: the script restarts Stream Deck or says
 * plainly that it could not. Until #1523 it looked the app up with `wmic`,
 * which current Windows 11 no longer ships; the failed call read as "not
 * running", so the script built, restarted nothing and exited 0. So a lister
 * that fails is "could not tell", never "not running", and every way the
 * restart can fail exits non-zero with a message naming what to do by hand.
 */
import { win32 } from "node:path";

import { launchApp, stopHost } from "./host-control.mjs";

/**
 * Elgato's app. Not a `deck-hosts.mjs` descriptor: those carry linking that
 * Elgato does through its own CLI.
 */
export const STREAM_DECK = {
  label: "Stream Deck",
  image: "StreamDeck.exe",
  // Windows rules whatever runs the code, as `host-control.mjs`'s `exeName`
  // explains: the Linux CI box runs these tests too.
  defaultAppPath: (env) =>
    env.ProgramFiles ? win32.join(env.ProgramFiles, "Elgato", "StreamDeck", "StreamDeck.exe") : undefined,
};

/**
 * The PowerShell that lists the running processes of one image, one
 * `<pid>|<executable path>` line each. `Win32_Process` is the class `wmic`
 * read; `Get-CimInstance` ships with every Windows 10 and 11 (in Windows
 * PowerShell 5.1, `powershell.exe`, which is present where `pwsh` may not be).
 * The path is empty when Windows will not give it, e.g. for an elevated process
 * seen from an unelevated shell. `Stop` turns a WMI error into a non-zero exit,
 * which is what tells "could not tell" apart from an empty list. The error is
 * caught and written as plain text because PowerShell started with
 * `-EncodedCommand` and a redirected stderr writes its errors, and progress, as
 * CLIXML, which buries the one line that explains the failure.
 */
export function processListScript(image) {
  if (!/^[\w.-]+$/.test(image)) throw new Error(`unexpected image name ${JSON.stringify(image)}`);

  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    // One element: a `;` between `try {}` and `catch {}` is a parse error.
    `try { Get-CimInstance Win32_Process -Filter "Name='${image}'" | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.ExecutablePath } } ` +
      "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  ].join("; ");
}

/**
 * PowerShell's stderr as text. What the script's `catch` cannot reach — a
 * parse error, a failure before the script runs — still arrives as CLIXML, so
 * its error strings are pulled out, unescaped as XML, and their
 * `_x000D__x000A_` escapes undone.
 */
export function readableStderr(stderr) {
  const text = `${stderr ?? ""}`.trim();
  if (!text.startsWith("#< CLIXML")) return text;

  return [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map(([, line]) =>
      line
        .replace(/&(lt|gt|quot|apos|amp);/g, (_m, name) => XML_ENTITIES[name])
        .replace(/_x([0-9A-F]{4})_/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))),
    )
    .join("")
    .trim();
}

const XML_ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/**
 * `-EncodedCommand` (base64 of UTF-16LE) rather than `-Command`, so the
 * script's quotes reach PowerShell without passing through Node's Windows
 * argument quoting, whose `\"` escapes PowerShell does not read the same way.
 */
export function processListArgs(image) {
  const encoded = Buffer.from(processListScript(image), "utf16le").toString("base64");

  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

/**
 * Parses the lister's output. A line that is not `<pid>|<path>` makes the
 * whole result unreadable (`undefined`) rather than being skipped, since a
 * skipped line could be the one process that was running.
 *
 * @returns {{ pid: number, path: string | undefined }[] | undefined}
 */
export function parseProcessList(stdout) {
  const processes = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = /^(\d+)\|(.*)$/.exec(trimmed);
    if (!match) return undefined;

    processes.push({ pid: Number(match[1]), path: match[2].trim() || undefined });
  }

  return processes;
}

/**
 * Whether an image is running, through the injected `spawnSync`.
 *
 * @returns {{ state: "running", processes: { pid: number, path: string | undefined }[] }
 *   | { state: "not-running" }
 *   | { state: "unknown", reason: string }}
 */
export function findRunning(image, { spawnSync }) {
  const result = spawnSync("powershell.exe", processListArgs(image), { encoding: "utf8", windowsHide: true });

  if (result.error) return { state: "unknown", reason: `could not run powershell.exe: ${result.error.message}` };

  if (result.status !== 0) {
    const detail = readableStderr(result.stderr);

    return { state: "unknown", reason: `powershell.exe exited ${result.status}${detail ? `: ${detail}` : ""}` };
  }

  const processes = parseProcessList(result.stdout ?? "");
  if (!processes) return { state: "unknown", reason: `unexpected output from powershell.exe: ${result.stdout.trim()}` };

  return processes.length > 0 ? { state: "running", processes } : { state: "not-running" };
}

/**
 * The executable to start again: the running process's own path, else the
 * standard install path when that exists. `undefined` when neither, and then
 * the app is not stopped at all — a stop the script cannot undo is worse than
 * no restart.
 */
export function restartPath(processes, { env = process.env, exists }) {
  const fromProcess = processes.find((entry) => entry.path)?.path;
  if (fromProcess) return fromProcess;

  const fallback = STREAM_DECK.defaultAppPath(env);

  return fallback && exists(fallback) ? fallback : undefined;
}

const DO_IT_BY_HAND = "Nothing was built. Run `pnpm build`, then restart Stream Deck yourself.";

/**
 * Stop, build, start. The build runs whether or not the app was running, and
 * the app is started again even when the build fails — the old script's
 * `finally`, so a red build never leaves the deck dark.
 *
 * @param {object} deps
 * @param {() => number} deps.build Runs the build, returning its exit code.
 * @returns {Promise<number>} the build's exit code, or 1 when the restart could not be done.
 */
export async function buildWithRestart({
  build,
  spawnSync,
  spawn,
  exists,
  env = process.env,
  platform = process.platform,
  log = console,
}) {
  const { label, image } = STREAM_DECK;

  if (platform !== "win32") {
    log.log(`${label} restart is Windows-only — building without one.`);

    return build();
  }

  const found = findRunning(image, { spawnSync });

  if (found.state === "unknown") {
    log.error(`Error: could not tell whether ${label} is running: ${found.reason}`);
    log.error(`  ${DO_IT_BY_HAND}`);

    return 1;
  }

  if (found.state === "not-running") {
    log.log(`${label} is not running — building without a restart.`);

    return build();
  }

  const appPath = restartPath(found.processes, { env, exists });

  if (!appPath) {
    const fallback = STREAM_DECK.defaultAppPath(env);
    log.error(`Error: ${label} is running, but its executable could not be read from the process`);
    log.error(
      `  and ${fallback ? `${fallback} does not exist` : "%ProgramFiles% is not set"}, so it would not be started again.`,
    );
    log.error(`  ${label} was left running. ${DO_IT_BY_HAND}`);

    return 1;
  }

  log.log(`${label} is running — stopping it before the build...`);

  if (stopHost({ label }, { appPath, spawnSync, log }) !== 0) {
    log.error(`  ${DO_IT_BY_HAND}`);

    return 1;
  }

  let status;
  try {
    status = build();
  } finally {
    log.log(`Restarting ${label}...`);
    if ((await launchApp(appPath, { spawn, log })) !== 0) {
      log.error(`Error: ${label} was stopped for the build and could not be started again. Start it yourself.`);
      status = 1;
    }
  }

  return status;
}
