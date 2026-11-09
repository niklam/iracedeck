import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COMMITTED_CAPTURE_DIR_REL } from "./capture-manifest.mjs";
import {
  CapturePreconditionError,
  committedCaptureDir,
  localCaptureDir,
  REPO_ROOT,
  runCapture,
} from "./run-capture.mjs";

const ROOT = join("/repo");
const HTML = join(
  ROOT,
  "packages",
  "iracing-plugin-stream-deck",
  "com.iracedeck.sd.core.sdPlugin",
  "ui",
  "settings-window.html",
);
const ENTRY = join(ROOT, "packages", "settings-window", "dist", "index.js");
const SIZE = { width: 1172, height: 788 };

/**
 * Deps with every build present and a browser found; `capture` resolves with
 * one shot written. Nothing real is touched but the root `package.json`,
 * which the runner reads for the fixture's version — so `repoRoot` stays the
 * real one in the tests that reach it.
 */
function createDeps(overrides = {}) {
  return {
    fileExists: vi.fn(() => true),
    loadSettingsWindow: vi.fn(async () => ({
      findChromiumBrowserOnThisMachine: () => "C:/Edge/msedge.exe",
      SETTINGS_WINDOW_SIZE: SIZE,
      startSettingsWindowServer: vi.fn(),
    })),
    capture: vi.fn(async (options) => ({ written: [join(options.outDir, "general.png")], skipped: [] })),
    makeDir: vi.fn(async () => {}),
    removeProfile: vi.fn(async () => ({ removed: true })),
    profileDir: join("/tmp", "iracedeck-capture-test"),
    ...overrides,
  };
}

describe("the capture folders", () => {
  it("puts the local capture under local/ and the committed one in the website's assets", () => {
    expect(localCaptureDir(ROOT)).toBe(join(ROOT, "local", "settings-window-capture"));
    expect(committedCaptureDir(ROOT)).toBe(join(ROOT, "packages", "website", "src", "assets", "settings-window"));
  });

  it("builds the committed folder from the one constant the manifest's fixes name", () => {
    expect(committedCaptureDir(ROOT)).toBe(join(ROOT, ...COMMITTED_CAPTURE_DIR_REL.split("/")));
    expect(committedCaptureDir(REPO_ROOT)).toBe(join(REPO_ROOT, ...COMMITTED_CAPTURE_DIR_REL.split("/")));
  });

  it("resolves the repository root this file sits in", () => {
    expect(REPO_ROOT).toBe(join(import.meta.dirname, "..", "..", ".."));
  });
});

describe("runCapture", () => {
  /** @type {string[]} */
  const temps = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("refuses when the Stream Deck plugin is not built, before loading or starting anything", async () => {
    const deps = createDeps({ fileExists: vi.fn((file) => file !== HTML) });

    const run = runCapture({ outDir: "/out", repoRoot: ROOT }, deps);

    await expect(run).rejects.toThrow(CapturePreconditionError);
    await expect(run).rejects.toThrow(/The Stream Deck plugin has not been built/);
    expect(deps.loadSettingsWindow).not.toHaveBeenCalled();
    expect(deps.makeDir).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("refuses when the settings window is not built", async () => {
    const deps = createDeps({ fileExists: vi.fn((file) => file !== ENTRY) });

    await expect(runCapture({ outDir: "/out", repoRoot: ROOT }, deps)).rejects.toThrow(
      /@iracedeck\/settings-window has not been built/,
    );
    expect(deps.loadSettingsWindow).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("refuses when no Chromium browser is found, and creates no folder", async () => {
    const deps = createDeps({
      loadSettingsWindow: vi.fn(async () => ({
        findChromiumBrowserOnThisMachine: () => undefined,
        SETTINGS_WINDOW_SIZE: SIZE,
        startSettingsWindowServer: vi.fn(),
      })),
    });

    const run = runCapture({ outDir: "/out", repoRoot: ROOT }, deps);

    await expect(run).rejects.toThrow(CapturePreconditionError);
    await expect(run).rejects.toThrow(/No Chromium-based browser/);
    expect(deps.makeDir).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("captures into the folder it was given, with the version and scale it was given", async () => {
    const deps = createDeps();

    const result = await runCapture({ outDir: "/out", expectVersion: "3.9.0", scale: 2 }, deps);

    expect(deps.makeDir).toHaveBeenCalledWith("/out");
    expect(deps.capture).toHaveBeenCalledTimes(1);

    const [options, captureDeps] = deps.capture.mock.calls[0];

    expect(options).toMatchObject({
      assetsDir: join(REPO_ROOT, "packages", "iracing-plugin-stream-deck", "com.iracedeck.sd.core.sdPlugin", "ui"),
      pageFile: "settings-window.html",
      outDir: "/out",
      size: SIZE,
      deviceScaleFactor: 2,
      expectVersion: "3.9.0",
    });
    // The real collaborators, each one the capture needs.
    for (const name of [
      "startServer",
      "launchBrowser",
      "debuggerUrl",
      "connect",
      "writeFile",
      "listProfileProcesses",
    ]) {
      expect(typeof captureDeps[name]).toBe("function");
    }
    expect(result).toEqual({ written: [join("/out", "general.png")], skipped: [] });
  });

  it("leaves expectVersion unset when the caller does, so the header is not checked", async () => {
    const deps = createDeps();

    await runCapture({ outDir: "/out" }, deps);

    expect(deps.capture.mock.calls[0][0].expectVersion).toBeUndefined();
    expect(deps.capture.mock.calls[0][0].deviceScaleFactor).toBe(1);
  });

  it("removes the browser profile after a capture, and after one that throws", async () => {
    const deps = createDeps({ capture: vi.fn(async () => Promise.reject(new Error("no nav button"))) });

    await expect(runCapture({ outDir: "/out" }, deps)).rejects.toThrow("no nav button");

    expect(deps.removeProfile).toHaveBeenCalledWith(join("/tmp", "iracedeck-capture-test"));
  });

  it("warns, naming the folder, when the profile cannot be removed, and still returns the result", async () => {
    const warn = vi.fn();
    const deps = createDeps({ removeProfile: vi.fn(async () => ({ removed: false, error: new Error("EBUSY") })) });

    const result = await runCapture({ outDir: "/out", warn }, deps);

    expect(result.written).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(join("/tmp", "iracedeck-capture-test")));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EBUSY"));
  });

  it.each([[0], [-1], [Number.NaN]])("refuses a scale of %j before checking anything", async (scale) => {
    const deps = createDeps();

    await expect(runCapture({ outDir: "/out", scale }, deps)).rejects.toThrow(/scale must be a positive number/);
    expect(deps.fileExists).not.toHaveBeenCalled();
  });

  it("refuses a missing outDir", async () => {
    const deps = createDeps();

    await expect(runCapture({}, deps)).rejects.toThrow(/outDir must be a folder path/);
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("creates the folder and writes nothing in it of its own, a manifest least of all", async () => {
    const root = await mkdtemp(join(tmpdir(), "iracedeck-run-capture-"));
    temps.push(root);
    const outDir = join(root, "nested", "capture");
    const deps = createDeps({ capture: vi.fn(async () => ({ written: [], skipped: [] })) });
    delete deps.makeDir;

    await runCapture({ outDir }, deps);

    // The real makeDir made the folder; only the capture's own shots would
    // ever be in it, and this capture wrote none.
    expect(await readdir(outDir)).toEqual([]);
  });
});
