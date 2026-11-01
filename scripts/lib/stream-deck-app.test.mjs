import { describe, expect, it, vi } from "vitest";

import { TASKKILL_NOT_FOUND } from "./host-control.mjs";
import { EXIT_WAIT_ATTEMPTS, EXIT_WAIT_INTERVAL_MS, startStreamDeck, stopStreamDeck } from "./stream-deck-app.mjs";

const APP = "C:\\Program Files\\Elgato\\StreamDeck\\StreamDeck.exe";
const ENV = { ProgramFiles: "C:\\Program Files" };

const RUNNING = { status: 0, stdout: `4242|${APP}\r\n`, stderr: "" };
const NOT_RUNNING = { status: 0, stdout: "", stderr: "" };
const LISTER_FAILS = { status: 1, stdout: "", stderr: "Get-CimInstance : Invalid class" };

const KILLED = { status: 0, stdout: "SUCCESS: The process has been terminated.", stderr: "" };
const ABSENT = { status: TASKKILL_NOT_FOUND, stdout: "", stderr: 'ERROR: The process "StreamDeck.exe" not found.' };
const DENIED = { status: 1, stdout: "", stderr: "ERROR: Access is denied." };

function fakeLog() {
  return { log: vi.fn(), error: vi.fn() };
}

function output(log) {
  return [...log.log.mock.calls, ...log.error.mock.calls].map((args) => args.join(" ")).join("\n");
}

/**
 * A `spawnSync` answering `taskkill` with `kill` and the process lister with
 * each of `lists` in turn (the last one repeating), recording every call.
 */
function fakeSpawnSync({ kill = KILLED, lists = [NOT_RUNNING] } = {}, calls = []) {
  let listed = 0;

  return vi.fn((cmd, args) => {
    calls.push(cmd);
    if (cmd === "taskkill") {
      expect(args).toEqual(["/IM", "StreamDeck.exe", "/F"]);

      return kill;
    }
    if (cmd === "powershell.exe") return lists[Math.min(listed++, lists.length - 1)];
    throw new Error(`unexpected spawnSync(${cmd})`);
  });
}

/** A `spawn` whose child emits `spawn` (or `error`) once a listener is attached. */
function fakeSpawn(calls = [], { fail } = {}) {
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

function stop({ kill, lists, platform = "win32" } = {}) {
  const calls = [];
  const log = fakeLog();
  const sleep = vi.fn(async () => {});
  const pending = stopStreamDeck({ spawnSync: fakeSpawnSync({ kill, lists }, calls), platform, sleep, log });

  return { pending, calls, log, sleep };
}

function start({ lists = [NOT_RUNNING], exists = () => true, env = ENV, spawnFail, platform = "win32" } = {}) {
  const calls = [];
  const log = fakeLog();
  const spawn = fakeSpawn(calls, { fail: spawnFail });
  const pending = startStreamDeck({
    spawn,
    spawnSync: fakeSpawnSync({ lists }, calls),
    exists,
    env,
    platform,
    log,
  });

  return { pending, calls, log, spawn };
}

describe("stopStreamDeck", () => {
  it("kills Stream Deck and confirms it has exited", async () => {
    const { pending, calls, log } = stop({ lists: [NOT_RUNNING] });

    expect(await pending).toBe(0);
    expect(calls).toEqual(["taskkill", "powershell.exe"]);
    expect(output(log)).toContain("Stopped StreamDeck.exe.");
  });

  it("waits for a killed Stream Deck that is still exiting", async () => {
    const { pending, calls, sleep } = stop({ lists: [RUNNING, RUNNING, NOT_RUNNING] });

    expect(await pending).toBe(0);
    expect(calls.filter((cmd) => cmd === "powershell.exe")).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(EXIT_WAIT_INTERVAL_MS);
  });

  it("reports a Stream Deck that was not running as success, with nothing to wait for", async () => {
    const { pending, calls, log } = stop({ kill: ABSENT });

    expect(await pending).toBe(0);
    expect(calls).toEqual(["taskkill"]);
    expect(output(log)).toContain("StreamDeck.exe was not running.");
  });

  // The bug: `taskkill ... || exit 0` turned this into success.
  it("exits 1 with taskkill's own words when the kill is refused", async () => {
    const { pending, calls, log } = stop({ kill: DENIED });

    expect(await pending).toBe(1);
    expect(calls).toEqual(["taskkill"]);
    expect(output(log)).toContain("could not stop StreamDeck.exe (taskkill exit 1)");
    expect(output(log)).toContain("Access is denied");
  });

  it("exits 1 when taskkill cannot be run at all", async () => {
    const { pending, log } = stop({ kill: { error: new Error("spawn taskkill ENOENT") } });

    expect(await pending).toBe(1);
    expect(output(log)).toContain("could not run taskkill");
  });

  it("exits 1, naming the pid, when Stream Deck is still running after the wait", async () => {
    const { pending, calls, log, sleep } = stop({ lists: [RUNNING] });

    expect(await pending).toBe(1);
    expect(calls.filter((cmd) => cmd === "powershell.exe")).toHaveLength(EXIT_WAIT_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(EXIT_WAIT_ATTEMPTS - 1);
    // The sleeps between the listings, as a floor: the listings themselves take time too.
    const slept = ((EXIT_WAIT_ATTEMPTS - 1) * EXIT_WAIT_INTERVAL_MS) / 1000;
    expect(log.error.mock.calls.join("\n")).toContain(`StreamDeck.exe is still running at least ${slept} s`);
    expect(log.error.mock.calls.join("\n")).toContain("pid 4242");
  });

  // #1523's rule: a lister that fails is "could not tell", never "not running".
  it("exits 1 when whether it exited cannot be told", async () => {
    const { pending, log } = stop({ lists: [LISTER_FAILS] });

    expect(await pending).toBe(1);
    expect(log.error.mock.calls.join("\n")).toContain("whether it has exited could not be told");
    expect(log.error.mock.calls.join("\n")).toContain("Invalid class");
  });

  it("stops nothing off Windows", async () => {
    const { pending, calls, log } = stop({ platform: "darwin" });

    expect(await pending).toBe(0);
    expect(calls).toEqual([]);
    expect(output(log)).toContain("Windows-only");
  });
});

describe("startStreamDeck", () => {
  it("starts Stream Deck from its install path, in its own folder", async () => {
    const { pending, calls, log, spawn } = start();

    expect(await pending).toBe(0);
    expect(calls).toEqual(["powershell.exe", `start ${APP}`]);
    expect(spawn.mock.calls[0][2]).toMatchObject({ cwd: "C:\\Program Files\\Elgato\\StreamDeck" });
    expect(output(log)).toContain("Started StreamDeck.exe.");
  });

  // The old `start /B` kept the launching shell attached, so the command never
  // returned and Stream Deck lived only as long as that shell.
  it("detaches Stream Deck with no pipes, so the command returns and the app outlives it", async () => {
    const { pending, spawn } = start();

    expect(await pending).toBe(0);
    expect(spawn.mock.calls[0][2]).toMatchObject({ detached: true, stdio: "ignore" });
    expect(spawn.mock.results[0].value.unref).toHaveBeenCalledTimes(1);
  });

  it("exits 1 and names the path when Stream Deck is not installed there", async () => {
    const exists = vi.fn(() => false);
    const { pending, calls, log } = start({ exists });

    expect(await pending).toBe(1);
    expect(exists).toHaveBeenCalledWith(APP);
    expect(calls).toEqual([]);
    expect(log.error.mock.calls.join("\n")).toContain(`Stream Deck is not installed at ${APP}`);
  });

  it("exits 1 when %ProgramFiles% is not set", async () => {
    const { pending, calls, log } = start({ env: {} });

    expect(await pending).toBe(1);
    expect(calls).toEqual([]);
    expect(log.error.mock.calls.join("\n")).toContain("%ProgramFiles% is not set");
  });

  it("exits 1, and never claims success, when the executable cannot be started", async () => {
    const { pending, log } = start({ spawnFail: "spawn EACCES" });

    expect(await pending).toBe(1);
    expect(output(log)).toContain(`could not start ${APP}`);
    expect(output(log)).not.toContain("Started");
  });

  // A start's job is Stream Deck on the current plugin: `integration-build --restart` reads 0 as that.
  it("exits 1 for a Stream Deck that is already running, and says it holds its old plugins", async () => {
    const { pending, calls, log } = start({ lists: [RUNNING] });

    expect(await pending).toBe(1);
    expect(calls).toEqual(["powershell.exe"]);
    expect(output(log)).toContain("already running (pid 4242)");
    expect(output(log)).toContain("pnpm stop:stream-deck");
    expect(output(log)).not.toContain("Started");
  });

  it("starts it anyway when whether it runs cannot be told", async () => {
    const { pending, calls, log } = start({ lists: [LISTER_FAILS] });

    expect(await pending).toBe(0);
    expect(calls).toEqual(["powershell.exe", `start ${APP}`]);
    expect(output(log)).toContain("Could not tell whether Stream Deck is running");
    // "Started" alone would claim a fresh plugin load that a launch over a running instance never makes.
    expect(output(log)).toContain("If it was running, this only brings it forward");
  });

  it("starts nothing off Windows", async () => {
    const { pending, calls, log } = start({ platform: "linux" });

    expect(await pending).toBe(0);
    expect(calls).toEqual([]);
    expect(output(log)).toContain("Windows-only");
  });
});
