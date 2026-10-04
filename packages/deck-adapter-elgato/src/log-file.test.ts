import { FileTarget } from "@elgato/utils/logging/file-target.js";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { elgatoPluginLogFile, elgatoPluginUuid } from "./log-file.js";

/** The SDK's own `getPluginUUID`, which its package does not export, loaded from the installed file. */
async function sdkGetPluginUuid(): Promise<() => string> {
  const entry = createRequire(import.meta.url).resolve("@elgato/streamdeck");
  const utils = join(dirname(entry), "common", "utils.js");
  const module = (await import(pathToFileURL(utils).href)) as { getPluginUUID: () => string };

  return module.getPluginUUID;
}

describe("elgatoPluginUuid", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "C:/Plugins/com.iracedeck.sd.core.sdPlugin",
    "C:/Plugins/com.iracedeck.sd.core",
    "C:/Plugins/odd.sdPlugin.sdPlugin",
    "C:/Plugins/com.example.sdPluginExtra",
  ])("derives the UUID from %s exactly as @elgato/streamdeck does", async (cwd) => {
    const getPluginUUID = await sdkGetPluginUuid();
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    expect(elgatoPluginUuid(cwd)).toBe(getPluginUUID());
  });
});

describe("elgatoPluginLogFile", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(mkdtempSync(join(tmpdir(), "elgato-log-")), "com.example.plugin.sdPlugin");
    mkdirSync(cwd);
  });

  afterEach(() => {
    rmSync(dirname(cwd), { recursive: true, force: true });
  });

  /** A FileTarget configured the way `@elgato/streamdeck` configures its own. */
  const sdkTarget = (): FileTarget =>
    new FileTarget({
      dest: join(cwd, "logs"),
      fileName: elgatoPluginUuid(cwd),
      format: () => "line",
      maxFileCount: 10,
      maxSize: 50 * 1024 * 1024,
    });

  it("is the file the SDK's FileTarget writes", () => {
    sdkTarget().write({ level: "info", data: ["x"], scope: "" });

    expect(readdirSync(join(cwd, "logs")).map((name) => join(cwd, "logs", name))).toEqual([elgatoPluginLogFile(cwd)]);
  });

  it("stays the file the SDK writes after it re-indexes an earlier run's log", () => {
    mkdirSync(join(cwd, "logs"));
    writeFileSync(elgatoPluginLogFile(cwd), "previous run\n");

    sdkTarget().write({ level: "info", data: ["x"], scope: "" });

    expect(readFileSync(elgatoPluginLogFile(cwd), "utf-8")).toBe("line\n");
    expect(readdirSync(join(cwd, "logs")).sort()).toEqual(["com.example.plugin.0.log", "com.example.plugin.1.log"]);
  });

  it("defaults to the process's working directory", () => {
    expect(elgatoPluginLogFile()).toBe(elgatoPluginLogFile(process.cwd()));
  });
});
