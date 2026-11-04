import { describe, expect, it, vi } from "vitest";

import { TASKKILL_NOT_FOUND } from "../host-control.mjs";
import {
  commandLineNamesDir,
  isProcessAlive,
  KILL_TREE_TIMEOUT_MS,
  killProcessTree,
  listProcessesNamingDir,
  parsePidLines,
  parsePsOutput,
  powerShellLiteral,
  profileProcessListArgs,
  profileProcessListScript,
} from "./process-tree.mjs";

/** An error shaped like the one `process.kill` throws. */
function errno(code) {
  return Object.assign(new Error(code), { code });
}

/** An error shaped like the one promisified `execFile` rejects with on a non-zero exit. */
function exited(code, stderr = "") {
  return Object.assign(new Error(`Command failed with exit code ${code}`), { code, stderr, stdout: "" });
}

/** The script an `-EncodedCommand` argument list carries. */
function decode(args) {
  return Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
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

    await expect(killProcessTree(4242, { platform: "win32", execFileImpl, kill })).resolves.toBe("stopped");

    expect(execFileImpl).toHaveBeenCalledWith("taskkill", ["/PID", "4242", "/T", "/F"], {
      windowsHide: true,
      timeout: KILL_TREE_TIMEOUT_MS,
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("reads taskkill's 'not found' as a process already gone, not as a kill or a failure", async () => {
    const execFileImpl = vi.fn(async () => {
      throw exited(TASKKILL_NOT_FOUND, 'ERROR: The process "4242" not found.');
    });

    await expect(killProcessTree(4242, { platform: "win32", execFileImpl })).resolves.toBe("not-running");
  });

  it("rejects, with taskkill's own words, when the kill was refused", async () => {
    const execFileImpl = vi.fn(async () => {
      throw exited(1, "ERROR: Access is denied.\r\n");
    });

    await expect(killProcessTree(4242, { platform: "win32", execFileImpl })).rejects.toThrow(
      "taskkill exited 1: ERROR: Access is denied.",
    );
  });

  it("keeps taskkill's report on one line, as it wraps its reason onto a second", async () => {
    const execFileImpl = vi.fn(async () => {
      throw exited(255, "ERROR: The process with PID 5588 could not be terminated.\r\nReason: Access is denied.\r\n");
    });

    await expect(killProcessTree(4242, { platform: "win32", execFileImpl })).rejects.toThrow(
      "taskkill exited 255: ERROR: The process with PID 5588 could not be terminated. Reason: Access is denied.",
    );
  });

  it("rejects when taskkill could not be run at all", async () => {
    const execFileImpl = vi.fn(async () => {
      throw Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" });
    });

    await expect(killProcessTree(4242, { platform: "win32", execFileImpl })).rejects.toThrow(/ENOENT/);
  });

  it("sends SIGKILL to the process elsewhere", async () => {
    const execFileImpl = vi.fn();
    const kill = vi.fn();

    await expect(killProcessTree(4242, { platform: "linux", execFileImpl, kill })).resolves.toBe("stopped");

    expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("reads ESRCH elsewhere as already gone, and rethrows anything else", async () => {
    const gone = vi.fn(() => {
      throw errno("ESRCH");
    });
    const refused = vi.fn(() => {
      throw errno("EPERM");
    });

    await expect(killProcessTree(4242, { platform: "linux", kill: gone })).resolves.toBe("not-running");
    await expect(killProcessTree(4242, { platform: "linux", kill: refused })).rejects.toThrow("EPERM");
  });
});

describe("powerShellLiteral", () => {
  it("doubles a single quote, the one character a single-quoted literal reads", () => {
    expect(powerShellLiteral("C:\\Temp\\it's")).toBe("'C:\\Temp\\it''s'");
  });

  it("leaves $ and backticks alone, since nothing inside the literal is expanded", () => {
    expect(powerShellLiteral("a $b `c")).toBe("'a $b `c'");
  });
});

describe("profileProcessListScript", () => {
  const dir = "C:\\Temp\\it's $env:x iracedeck-capture-123";

  it("embeds the folder as one single-quoted literal, its quote doubled", () => {
    const script = profileProcessListScript(dir);

    expect(script).toContain("[regex]::Escape('C:\\Temp\\it''s $env:x iracedeck-capture-123')");
    // Outside the literal the folder never appears, so nothing in it can run.
    expect(script.split("iracedeck-capture-123")).toHaveLength(2);
  });

  it("matches the folder itself, not a longer name it prefixes", () => {
    expect(profileProcessListScript(dir)).toContain(`+ '(?![^\\\\/"\\s])'`);
  });

  it("lists every process, fails loudly rather than empty, and never names its own shell", () => {
    const script = profileProcessListScript(dir);

    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("$_.ProcessId -ne $PID");
    expect(script).toContain("catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }");
    expect(script).toContain("UTF8Encoding");
  });

  // The lister's own powershell.exe is running while it lists, and Windows
  // reports its command line too. Encoded, that command line carries the
  // folder only as base64, so the shell cannot match itself.
  it("is passed encoded, so the shell's own command line does not name the folder", () => {
    const args = profileProcessListArgs(dir);

    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(args.join(" ")).not.toContain("iracedeck-capture-123");
    expect(decode(args)).toBe(profileProcessListScript(dir));
  });
});

describe("commandLineNamesDir", () => {
  const dir = "/tmp/iracedeck-capture-123";

  it.each([
    [`chrome --user-data-dir=${dir}`, true],
    [`chrome --user-data-dir=${dir} --headless`, true],
    [`crashpad --database=${dir}/Crashpad`, true],
    [`chrome "--user-data-dir=${dir}"`, true],
    [`chrome --user-data-dir=${dir}4`, false],
    [`chrome --user-data-dir=${dir}-old`, false],
    ["bash", false],
  ])("%s → %s", (commandLine, expected) => {
    expect(commandLineNamesDir(commandLine, dir)).toBe(expected);
  });

  it("finds a later mention after an earlier one that is only a prefix", () => {
    expect(commandLineNamesDir(`x ${dir}4 ${dir}/Default`, dir)).toBe(true);
  });
});

describe("parsePidLines", () => {
  it("reads a pid per line, ignoring blank lines and CRLF", () => {
    expect(parsePidLines("4242\r\n5150\r\n\r\n")).toEqual([4242, 5150]);
  });

  it("is empty for no output", () => {
    expect(parsePidLines("")).toEqual([]);
  });

  it("refuses the whole listing on a line that is not a pid", () => {
    expect(parsePidLines("4242\nWARNING: something\n")).toBeUndefined();
  });
});

describe("parsePsOutput", () => {
  const dir = "/tmp/iracedeck-capture-123";

  it("keeps the processes naming the folder", () => {
    const stdout = [
      `  101 /opt/chrome --headless --user-data-dir=${dir}`,
      `  102 /opt/chrome --type=renderer --user-data-dir=${dir}`,
      `  103 /opt/chrome --user-data-dir=${dir}4`,
      "  104 bash",
      "",
    ].join("\n");

    expect(parsePsOutput(stdout, dir)).toEqual([101, 102]);
  });

  it("refuses the whole listing on a line it cannot read", () => {
    expect(parsePsOutput("garbage\n", dir)).toBeUndefined();
  });
});

describe("listProcessesNamingDir", () => {
  const dir = "C:\\Temp\\iracedeck-capture-123";

  it("runs the encoded lister in Windows PowerShell, bounded and hidden", async () => {
    const execFileImpl = vi.fn(async () => ({ stdout: "4242\r\n5150\r\n" }));

    await expect(listProcessesNamingDir(dir, { platform: "win32", execFileImpl })).resolves.toEqual({
      state: "listed",
      pids: [4242, 5150],
    });

    const [file, args, options] = execFileImpl.mock.calls[0];
    expect(file).toBe("powershell.exe");
    expect(decode(args)).toBe(profileProcessListScript(dir));
    expect(options).toMatchObject({ windowsHide: true, encoding: "utf8" });
    expect(options.timeout).toBeGreaterThan(0);
  });

  it("lists none as an empty list, not as could-not-tell", async () => {
    const execFileImpl = vi.fn(async () => ({ stdout: "" }));

    await expect(listProcessesNamingDir(dir, { platform: "win32", execFileImpl })).resolves.toEqual({
      state: "listed",
      pids: [],
    });
  });

  it("is could-not-tell, with the error as plain text, when PowerShell fails", async () => {
    const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">Access denied _x000D__x000A_</S></Objs>';
    const execFileImpl = vi.fn(async () => {
      throw exited(1, clixml);
    });

    await expect(listProcessesNamingDir(dir, { platform: "win32", execFileImpl })).resolves.toEqual({
      state: "unknown",
      reason: "powershell.exe exited 1: Access denied",
    });
  });

  it("is could-not-tell when PowerShell cannot be started", async () => {
    const execFileImpl = vi.fn(async () => {
      throw Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
    });

    await expect(listProcessesNamingDir(dir, { platform: "win32", execFileImpl })).resolves.toEqual({
      state: "unknown",
      reason: "could not run powershell.exe: spawn powershell.exe ENOENT",
    });
  });

  it("is could-not-tell on output it cannot read, never a partial list", async () => {
    const execFileImpl = vi.fn(async () => ({ stdout: "4242\nsomething else\n" }));

    const result = await listProcessesNamingDir(dir, { platform: "win32", execFileImpl });

    expect(result.state).toBe("unknown");
    expect(result.reason).toMatch(/unexpected output from powershell\.exe/);
  });

  it("reads ps elsewhere", async () => {
    const posixDir = "/tmp/iracedeck-capture-123";
    const execFileImpl = vi.fn(async () => ({ stdout: `  101 chrome --user-data-dir=${posixDir}\n  102 bash\n` }));

    await expect(listProcessesNamingDir(posixDir, { platform: "linux", execFileImpl })).resolves.toEqual({
      state: "listed",
      pids: [101],
    });
    expect(execFileImpl.mock.calls[0].slice(0, 2)).toEqual(["ps", ["-Ao", "pid=,args="]]);
  });
});
