import { describe, expect, it, vi } from "vitest";

import { isProcessAlive, KILL_TREE_TIMEOUT_MS, killProcessTree } from "./process-tree.mjs";

/** An error shaped like the one `process.kill` throws. */
function errno(code) {
  return Object.assign(new Error(code), { code });
}

describe("isProcessAlive", () => {
  it("checks with signal 0, which signals nothing", () => {
    const kill = vi.fn();

    expect(isProcessAlive(42, { kill })).toBe(true);
    expect(kill).toHaveBeenCalledWith(42, 0);
  });

  it("is false only when there is no such process", () => {
    const kill = vi.fn(() => {
      throw errno("ESRCH");
    });

    expect(isProcessAlive(42, { kill })).toBe(false);
  });

  it.each(["EPERM", "EINVAL", undefined])("counts any other answer (%s) as still running", (code) => {
    const kill = vi.fn(() => {
      throw errno(code);
    });

    expect(isProcessAlive(42, { kill })).toBe(true);
  });

  it("answers for this very process through the real process.kill", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

describe("killProcessTree", () => {
  it("runs taskkill on the tree, forced and bounded, on Windows", async () => {
    const execFileImpl = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const kill = vi.fn();

    await killProcessTree(4242, { platform: "win32", execFileImpl, kill });

    expect(execFileImpl).toHaveBeenCalledWith("taskkill", ["/PID", "4242", "/T", "/F"], {
      windowsHide: true,
      timeout: KILL_TREE_TIMEOUT_MS,
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("rejects when taskkill fails, leaving the verdict to the caller's wait", async () => {
    const execFileImpl = vi.fn(async () => {
      throw new Error("Command failed: taskkill");
    });

    await expect(killProcessTree(4242, { platform: "win32", execFileImpl })).rejects.toThrow(/taskkill/);
  });

  it("sends SIGKILL to the process elsewhere", async () => {
    const execFileImpl = vi.fn();
    const kill = vi.fn();

    await killProcessTree(4242, { platform: "linux", execFileImpl, kill });

    expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
    expect(execFileImpl).not.toHaveBeenCalled();
  });
});
