import { describe, expect, it, vi } from "vitest";
import { DECK_HOSTS } from "./deck-hosts.mjs";
import { interpretTaskkill, startHost, stopHost, TASKKILL_NOT_FOUND } from "./host-control.mjs";

const HOST = DECK_HOSTS.ulanzi;
const APP = "C:\\Program Files (x86)\\Ulanzi Studio\\UlanziDeck.exe";

function fakeLog() {
  return { log: vi.fn(), error: vi.fn() };
}

function output(log) {
  return [...log.log.mock.calls, ...log.error.mock.calls].map((args) => args.join(" ")).join("\n");
}

describe("interpretTaskkill", () => {
  it("separates a refused kill from an absent process", () => {
    expect(interpretTaskkill(0)).toBe("stopped");
    expect(interpretTaskkill(TASKKILL_NOT_FOUND)).toBe("not-running");
    // Access denied — the case that must never read as "not running".
    expect(interpretTaskkill(1)).toBe("failed");
  });
});

describe("stopHost", () => {
  it("reports success when the host was killed", () => {
    const log = fakeLog();
    const spawnSync = vi.fn(() => ({ status: 0, stdout: "SUCCESS", stderr: "" }));

    expect(stopHost(HOST, { appPath: APP, spawnSync, log })).toBe(0);
    expect(output(log)).toContain("Stopped UlanziDeck.exe.");
    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/IM", "UlanziDeck.exe", "/F"], expect.anything());
  });

  it("treats an absent process as success", () => {
    const log = fakeLog();
    const spawnSync = vi.fn(() => ({ status: TASKKILL_NOT_FOUND, stdout: "", stderr: "not found" }));

    expect(stopHost(HOST, { appPath: APP, spawnSync, log })).toBe(0);
    expect(output(log)).toContain("was not running");
  });

  it("fails loudly when the kill is refused, surfacing taskkill's own words", () => {
    // The regression that motivated this module: an elevated host refuses the
    // kill, and reporting that as "was not running" lets `stop && build`
    // proceed into the EPERM failure the stop step exists to prevent.
    const log = fakeLog();
    const spawnSync = vi.fn(() => ({ status: 1, stdout: "", stderr: "ERROR: Access is denied." }));

    expect(stopHost(HOST, { appPath: APP, spawnSync, log })).toBe(1);
    expect(output(log)).toContain("Access is denied.");
    expect(output(log)).toContain("EPERM");
    expect(output(log)).not.toContain("was not running");
  });

  it("fails when taskkill cannot be run at all", () => {
    const log = fakeLog();
    const spawnSync = vi.fn(() => ({ error: new Error("spawn taskkill ENOENT") }));

    expect(stopHost(HOST, { appPath: APP, spawnSync, log })).toBe(1);
    expect(output(log)).toContain("ENOENT");
  });
});

/** Minimal EventEmitter-ish stub matching the bits of ChildProcess we use. */
function fakeChild() {
  const handlers = {};

  return {
    on(event, handler) {
      handlers[event] = handler;

      return this;
    },
    unref: vi.fn(),
    emit(event, arg) {
      handlers[event]?.(arg);
    },
  };
}

describe("startHost", () => {
  it("reports success only after the process actually spawns", async () => {
    const log = fakeLog();
    const child = fakeChild();
    const spawn = vi.fn(() => child);

    const pending = startHost(HOST, { appPath: APP, spawn, env: {}, platform: "win32", log });

    // Nothing claimed yet — the eager "Started ..." was the bug.
    expect(output(log)).not.toContain("Started");

    child.emit("spawn");
    expect(await pending).toBe(0);
    expect(output(log)).toContain("Started UlanziDeck.exe.");
    expect(child.unref).toHaveBeenCalled();
  });

  it("reports failure, and never success, when the executable is missing", async () => {
    const log = fakeLog();
    const child = fakeChild();
    const spawn = vi.fn(() => child);

    const pending = startHost(HOST, { appPath: APP, spawn, env: {}, platform: "win32", log });
    child.emit("error", new Error("spawn ENOENT"));

    expect(await pending).toBe(1);
    expect(output(log)).toContain("could not start");
    expect(output(log)).not.toContain("Started UlanziDeck.exe.");
  });

  it("does not pass windowsHide, which would hide a GUI host's own window", () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);

    startHost(HOST, { appPath: APP, spawn, env: {}, platform: "win32", log: fakeLog() });

    expect(spawn.mock.calls[0][2]).not.toHaveProperty("windowsHide");
  });
});
