import { spawnSync as realSpawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  buildWithRestart,
  findRunning,
  parseProcessList,
  processListArgs,
  processListScript,
  readableStderr,
  restartPath,
  STREAM_DECK,
} from "./build-restart.mjs";
import { TASKKILL_NOT_FOUND } from "./host-control.mjs";

const APP = "C:\\Program Files\\Elgato\\StreamDeck\\StreamDeck.exe";
const ENV = { ProgramFiles: "C:\\Program Files" };

function fakeLog() {
  return { log: vi.fn(), error: vi.fn() };
}

function output(log) {
  return [...log.log.mock.calls, ...log.error.mock.calls].map((args) => args.join(" ")).join("\n");
}

/**
 * A `spawnSync` that answers the process lister and `taskkill` separately, and
 * records the order of every call so the tests can assert stop → build → start.
 */
function fakeSpawnSync({ list, kill = { status: 0, stdout: "SUCCESS", stderr: "" } }, calls) {
  return vi.fn((cmd) => {
    calls.push(cmd);
    if (cmd === "powershell.exe") return list;
    if (cmd === "taskkill") return kill;
    throw new Error(`unexpected spawnSync(${cmd})`);
  });
}

/** A `spawn` whose child emits `spawn` (or `error`) once a listener is attached. */
function fakeSpawn(calls, { fail } = {}) {
  return vi.fn((cmd) => {
    calls.push(`start ${cmd}`);
    const handlers = {};
    const child = {
      on(event, handler) {
        handlers[event] = handler;

        return this;
      },
      unref: vi.fn(),
    };
    queueMicrotask(() => (fail ? handlers.error?.(new Error(fail)) : handlers.spawn?.()));

    return child;
  });
}

function run({ list, kill, spawnFail, buildStatus = 0, exists = () => true, platform = "win32" } = {}) {
  const calls = [];
  const log = fakeLog();
  const build = vi.fn(() => {
    calls.push("build");

    return buildStatus;
  });
  const pending = buildWithRestart({
    build,
    spawnSync: fakeSpawnSync({ list, kill }, calls),
    spawn: fakeSpawn(calls, { fail: spawnFail }),
    exists,
    env: ENV,
    platform,
    log,
  });

  return { pending, calls, log, build };
}

const RUNNING = { status: 0, stdout: `4242|${APP}\r\n`, stderr: "" };
const NOT_RUNNING = { status: 0, stdout: "", stderr: "" };

describe("processListScript / processListArgs", () => {
  it("asks Win32_Process for the image, the class wmic read", () => {
    expect(processListScript("StreamDeck.exe")).toContain(
      `Get-CimInstance Win32_Process -Filter "Name='StreamDeck.exe'"`,
    );
    expect(processListScript("StreamDeck.exe")).toContain("$ErrorActionPreference = 'Stop'");
    expect(processListScript("StreamDeck.exe")).toContain("exit 1");
  });

  it("passes the script encoded, so no quote crosses Node's argument quoting", () => {
    const args = processListArgs("StreamDeck.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(args[3], "base64").toString("utf16le")).toBe(processListScript("StreamDeck.exe"));
  });

  it("refuses an image name that could break out of the filter", () => {
    expect(() => processListScript("x' OR Name='y")).toThrow();
  });
});

describe("readableStderr", () => {
  it("passes plain text through", () => {
    expect(readableStderr("Invalid class \r\n")).toBe("Invalid class");
    expect(readableStderr(undefined)).toBe("");
  });

  it("pulls the error text out of CLIXML", () => {
    const clixml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">At line:1 char:226_x000D__x000A_</S>' +
      '<S S="Error">The Try statement is missing its Catch or Finally block._x000D__x000A_</S></Objs>';

    expect(readableStderr(clixml)).toBe(
      "At line:1 char:226\r\nThe Try statement is missing its Catch or Finally block.",
    );
  });
});

describe("parseProcessList", () => {
  it("reads one process per line, with an empty path as unknown", () => {
    expect(parseProcessList(`4242|${APP}\r\n17|\r\n`)).toEqual([
      { pid: 4242, path: APP },
      { pid: 17, path: undefined },
    ]);
  });

  it("reads empty output as no processes", () => {
    expect(parseProcessList("\r\n")).toEqual([]);
  });

  it("refuses output it cannot read rather than skipping a line", () => {
    expect(parseProcessList(`4242|${APP}\nsomething else\n`)).toBeUndefined();
  });
});

describe("findRunning", () => {
  it("reports the running processes", () => {
    const spawnSync = vi.fn(() => RUNNING);
    expect(findRunning("StreamDeck.exe", { spawnSync })).toEqual({
      state: "running",
      processes: [{ pid: 4242, path: APP }],
    });
    expect(spawnSync).toHaveBeenCalledWith("powershell.exe", processListArgs("StreamDeck.exe"), expect.anything());
  });

  it("reports an empty list as not running", () => {
    expect(findRunning("StreamDeck.exe", { spawnSync: () => NOT_RUNNING })).toEqual({ state: "not-running" });
  });

  // The #1523 regression: wmic missing read as "not running". A lister that
  // fails must never be taken for an empty list.
  it.each([
    ["cannot be run", { error: new Error("spawn powershell.exe ENOENT") }, "ENOENT"],
    ["exits non-zero", { status: 1, stdout: "", stderr: "Get-CimInstance : Invalid class" }, "Invalid class"],
    ["prints something unreadable", { status: 0, stdout: "garbage\n", stderr: "" }, "garbage"],
  ])("reports unknown when the lister %s", (_name, result, detail) => {
    const found = findRunning("StreamDeck.exe", { spawnSync: () => result });
    expect(found.state).toBe("unknown");
    expect(found.reason).toContain(detail);
  });
});

describe("restartPath", () => {
  it("prefers the running process's own path", () => {
    const own = "D:\\Elgato\\StreamDeck.exe";
    expect(
      restartPath(
        [
          { pid: 1, path: undefined },
          { pid: 2, path: own },
        ],
        { env: ENV, exists: () => true },
      ),
    ).toBe(own);
  });

  it("falls back to the standard install path when the process hides its path", () => {
    expect(restartPath([{ pid: 1, path: undefined }], { env: ENV, exists: (p) => p === APP })).toBe(APP);
    expect(STREAM_DECK.defaultAppPath(ENV)).toBe(APP);
  });

  it("gives nothing when the fallback does not exist", () => {
    expect(restartPath([{ pid: 1, path: undefined }], { env: ENV, exists: () => false })).toBeUndefined();
    expect(restartPath([{ pid: 1, path: undefined }], { env: {}, exists: () => true })).toBeUndefined();
  });
});

describe("buildWithRestart", () => {
  it("stops, builds and starts the app again, in that order", async () => {
    const { pending, calls, log } = run({ list: RUNNING });

    expect(await pending).toBe(0);
    expect(calls).toEqual(["powershell.exe", "taskkill", "build", `start ${APP}`]);
    expect(output(log)).toContain("Started StreamDeck.exe.");
  });

  it("starts the app again after a failed build, and returns the build's code", async () => {
    const { pending, calls } = run({ list: RUNNING, buildStatus: 2 });

    expect(await pending).toBe(2);
    expect(calls.at(-1)).toBe(`start ${APP}`);
  });

  it("builds without a restart, and says so, when the app is not running", async () => {
    const { pending, calls, log } = run({ list: NOT_RUNNING });

    expect(await pending).toBe(0);
    expect(calls).toEqual(["powershell.exe", "build"]);
    expect(output(log)).toContain("not running — building without a restart");
  });

  it("builds nothing and exits 1 when it cannot tell whether the app runs", async () => {
    const { pending, build, log } = run({ list: { error: new Error("spawn powershell.exe ENOENT") } });

    expect(await pending).toBe(1);
    expect(build).not.toHaveBeenCalled();
    expect(output(log)).toContain("could not tell whether Stream Deck is running");
    expect(output(log)).toContain("restart Stream Deck yourself");
  });

  it("leaves the app running and builds nothing when it could not start it again", async () => {
    const { pending, calls, log } = run({
      list: { status: 0, stdout: "4242|\n", stderr: "" },
      exists: () => false,
    });

    expect(await pending).toBe(1);
    expect(calls).toEqual(["powershell.exe"]);
    expect(output(log)).toContain(`${APP} does not exist`);
    expect(output(log)).toContain("was left running");
  });

  it("restarts from the install path when the process hides its own", async () => {
    const { pending, calls } = run({ list: { status: 0, stdout: "4242|\n", stderr: "" } });

    expect(await pending).toBe(0);
    expect(calls.at(-1)).toBe(`start ${APP}`);
  });

  it("builds nothing and exits 1 when the stop is refused", async () => {
    const { pending, calls, log } = run({
      list: RUNNING,
      kill: { status: 1, stdout: "", stderr: "ERROR: Access is denied." },
    });

    expect(await pending).toBe(1);
    expect(calls).toEqual(["powershell.exe", "taskkill"]);
    expect(output(log)).toContain("Access is denied.");
    expect(output(log)).toContain("Nothing was built");
  });

  it("still builds and restarts when the app exited between the check and the stop", async () => {
    const { pending, calls } = run({
      list: RUNNING,
      kill: { status: TASKKILL_NOT_FOUND, stdout: "", stderr: "not found" },
    });

    expect(await pending).toBe(0);
    expect(calls).toEqual(["powershell.exe", "taskkill", "build", `start ${APP}`]);
  });

  it("exits 1 and says so when the restart fails after a green build", async () => {
    const { pending, log } = run({ list: RUNNING, spawnFail: "spawn ENOENT" });

    expect(await pending).toBe(1);
    expect(output(log)).toContain("could not be started again. Start it yourself.");
    expect(output(log)).not.toContain("Started StreamDeck.exe.");
  });

  it("starts the app again when the build throws, then lets the error through", async () => {
    const calls = [];
    const pending = buildWithRestart({
      build: () => {
        throw new Error("turbo missing");
      },
      spawnSync: fakeSpawnSync({ list: RUNNING }, calls),
      spawn: fakeSpawn(calls),
      exists: () => true,
      env: ENV,
      platform: "win32",
      log: fakeLog(),
    });

    await expect(pending).rejects.toThrow("turbo missing");
    expect(calls.at(-1)).toBe(`start ${APP}`);
  });

  it("only builds off Windows", async () => {
    const { pending, calls, log } = run({ platform: "linux" });

    expect(await pending).toBe(0);
    expect(calls).toEqual(["build"]);
    expect(output(log)).toContain("Windows-only");
  });
});

// The positive control the injected lister cannot give: the real PowerShell
// command, on the real machine, finds this test's own process. Read-only — it
// lists processes and touches none.
describe.runIf(process.platform === "win32")("findRunning against the real system", () => {
  it("finds the running node.exe processes, this one among them, with their paths", () => {
    const found = findRunning("node.exe", { spawnSync: realSpawnSync });

    expect(found.state).toBe("running");
    const self = found.processes.find((entry) => entry.pid === process.pid);
    expect(self?.path?.toLowerCase()).toBe(process.execPath.toLowerCase());
  });

  it("reports an image nobody runs as not running", () => {
    expect(findRunning("iracedeck-no-such-process.exe", { spawnSync: realSpawnSync })).toEqual({
      state: "not-running",
    });
  });

  it("reports a WMI failure as unknown, in plain words rather than CLIXML", () => {
    // The same script with the class swapped for one that does not exist.
    const broken = (cmd, args, options) => {
      const script = processListScript("node.exe").replace("Win32_Process", "Win32_IraceDeckNoSuchClass");

      return realSpawnSync(cmd, [...args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")], options);
    };
    const found = findRunning("node.exe", { spawnSync: broken });

    expect(found.state).toBe("unknown");
    // WMI's own words, which Windows localises, so only their presence is checked.
    expect(found.reason).toMatch(/^powershell\.exe exited 1: \S/);
    expect(found.reason).not.toContain("CLIXML");
  });
});
