/**
 * Runs against a real temp directory. The one thing a test cannot produce
 * portably is the lock itself — that takes a loaded image on Windows — so the
 * locked cases wrap the real `fs` with an `rmSync` that refuses the named
 * paths the way Windows refuses a loaded `.node`, and everything else (the
 * move, the folder, what is left on disk) is the real filesystem.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASIDE_DIR_NAME,
  asideName,
  clearAddon,
  isLockError,
  releaseNativeAddon,
  releasePackageAddon,
  sweepAside,
} from "./native-addon-build.mjs";

let pkg;
let addonPath;
let asideDir;

/** An `fs` whose `rmSync` fails with `code` for the given paths, like a loaded image. */
function lockedFs(lockedPaths, code = "EPERM") {
  return {
    ...fs,
    rmSync: (path, options) => {
      if (lockedPaths.includes(path)) {
        throw Object.assign(new Error(`${code}: operation not permitted, unlink '${path}'`), { code });
      }
      return fs.rmSync(path, options);
    },
  };
}

function fakeLog() {
  return { log: vi.fn(), warn: vi.fn() };
}

beforeEach(() => {
  pkg = fs.mkdtempSync(join(tmpdir(), "native-addon-build-"));
  fs.mkdirSync(join(pkg, "build", "Release"), { recursive: true });
  addonPath = join(pkg, "build", "Release", "audio_native.node");
  asideDir = join(pkg, ".locked-native");
});

afterEach(() => {
  fs.rmSync(pkg, { recursive: true, force: true });
});

describe("isLockError", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])("treats %s as a lock", (code) => {
    expect(isLockError(Object.assign(new Error(code), { code }))).toBe(true);
  });

  it.each(["ENOENT", "EISDIR", "ENOTDIR", undefined])("does not treat %s as a lock", (code) => {
    expect(isLockError(Object.assign(new Error("x"), { code }))).toBe(false);
  });

  it("does not treat a non-error as a lock", () => {
    expect(isLockError(undefined)).toBe(false);
    expect(isLockError("EPERM")).toBe(false);
  });

  // The pre-#1258 scripts tested exactly this shape, which execSync throws when
  // a child fails: the child's EPERM never reaches the parent's error.
  it("does not see a lock in execSync's own failure", () => {
    const error = Object.assign(new Error("Command failed: node-gyp rebuild"), { status: 1 });
    expect(isLockError(error)).toBe(false);
  });
});

describe("asideName", () => {
  it("puts the timestamp before the extension", () => {
    expect(asideName(addonPath, 1759500000000)).toBe("audio_native.1759500000000.node");
  });
});

describe("clearAddon", () => {
  it("deletes an unlocked binary and moves nothing", () => {
    fs.writeFileSync(addonPath, "old");

    expect(clearAddon({ addonPath, asideDir })).toEqual({ result: "removed" });
    expect(fs.existsSync(addonPath)).toBe(false);
    expect(fs.existsSync(asideDir)).toBe(false);
  });

  it("is a no-op when there is no binary yet", () => {
    expect(clearAddon({ addonPath, asideDir })).toEqual({ result: "absent" });
    expect(fs.existsSync(asideDir)).toBe(false);
  });

  it.each(["EPERM", "EBUSY", "EACCES"])("moves a binary whose delete fails with %s aside", (code) => {
    fs.writeFileSync(addonPath, "old");

    const cleared = clearAddon({ addonPath, asideDir, fs: lockedFs([addonPath], code), now: () => 42 });

    const asidePath = join(asideDir, "audio_native.42.node");
    expect(cleared).toEqual({ result: "moved", asidePath });
    expect(fs.existsSync(addonPath)).toBe(false);
    expect(fs.readFileSync(asidePath, "utf8")).toBe("old");
  });

  it("names the lock when the move aside fails too", () => {
    fs.writeFileSync(addonPath, "old");
    const unmovable = {
      ...lockedFs([addonPath]),
      renameSync: () => {
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      },
    };

    expect(() => clearAddon({ addonPath, asideDir, fs: unmovable })).toThrow(
      /audio_native\.node is held by another process and could not be moved aside .*\(EPERM\)\. Stop the deck host/,
    );
    expect(fs.readFileSync(addonPath, "utf8")).toBe("old");
  });

  it("rethrows a failure that is not a lock, leaving the binary where it was", () => {
    fs.writeFileSync(addonPath, "old");

    expect(() => clearAddon({ addonPath, asideDir, fs: lockedFs([addonPath], "EIO") })).toThrow(/EIO/);
    expect(fs.readFileSync(addonPath, "utf8")).toBe("old");
    expect(fs.existsSync(asideDir)).toBe(false);
  });
});

describe("sweepAside", () => {
  it("is a no-op when nothing was ever moved aside", () => {
    expect(sweepAside(asideDir)).toEqual({ removed: 0, kept: 0 });
  });

  it("deletes released copies and the folder once it is empty", () => {
    fs.mkdirSync(asideDir);
    fs.writeFileSync(join(asideDir, "audio_native.1.node"), "a");
    fs.writeFileSync(join(asideDir, "audio_native.2.node"), "b");

    expect(sweepAside(asideDir)).toEqual({ removed: 2, kept: 0 });
    expect(fs.existsSync(asideDir)).toBe(false);
  });

  it("keeps a copy that is still loaded, and the folder with it", () => {
    fs.mkdirSync(asideDir);
    const held = join(asideDir, "audio_native.1.node");
    fs.writeFileSync(held, "a");
    fs.writeFileSync(join(asideDir, "audio_native.2.node"), "b");

    expect(sweepAside(asideDir, lockedFs([held]))).toEqual({ removed: 1, kept: 1 });
    expect(fs.readdirSync(asideDir)).toEqual(["audio_native.1.node"]);
  });

  // Housekeeping must never fail the build it runs in front of (#1258 review).
  it("reports a failure that is not a lock instead of throwing, keeping the copy", () => {
    fs.mkdirSync(asideDir);
    const broken = join(asideDir, "audio_native.1.node");
    fs.writeFileSync(broken, "a");

    const swept = sweepAside(asideDir, lockedFs([broken], "EIO"));

    expect(swept).toMatchObject({ removed: 0, kept: 1 });
    expect(swept.problem).toMatch(/EIO/);
    expect(fs.existsSync(broken)).toBe(true);
  });

  it("removes a stray folder in the aside folder too", () => {
    fs.mkdirSync(join(asideDir, "stray"), { recursive: true });
    fs.writeFileSync(join(asideDir, "stray", "x"), "x");

    expect(sweepAside(asideDir)).toEqual({ removed: 1, kept: 0 });
    expect(fs.existsSync(asideDir)).toBe(false);
  });

  it("tolerates an empty folder that will not delete", () => {
    fs.mkdirSync(asideDir);
    const stuck = {
      ...fs,
      rmdirSync: () => {
        throw Object.assign(new Error("EBUSY: resource busy or locked, rmdir"), { code: "EBUSY" });
      },
    };

    expect(sweepAside(asideDir, stuck)).toEqual({ removed: 0, kept: 0 });
  });

  it("reports an unreadable folder instead of throwing", () => {
    fs.writeFileSync(asideDir, "not a folder");

    const swept = sweepAside(asideDir);

    expect(swept).toMatchObject({ removed: 0, kept: 0 });
    expect(swept.problem).toBeDefined();
  });
});

describe("releaseNativeAddon", () => {
  it("says nothing when the binary was simply deleted", () => {
    fs.writeFileSync(addonPath, "old");
    const log = fakeLog();

    releaseNativeAddon({ addonPath, asideDir, log });

    expect(log.log).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns, naming the aside path, when the binary was locked", () => {
    fs.writeFileSync(addonPath, "old");
    const log = fakeLog();

    releaseNativeAddon({ addonPath, asideDir, log, fs: lockedFs([addonPath]), now: () => 7 });

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain(join(asideDir, "audio_native.7.node"));
    expect(log.warn.mock.calls[0][0]).toContain("keeps the old code until it restarts");
  });

  // The cycle the feature exists for: build under a lock, the host restarts,
  // build again. The second run must leave nothing behind.
  it("sweeps the copy a locked build left once the host has released it", () => {
    fs.writeFileSync(addonPath, "v1");
    releaseNativeAddon({ addonPath, asideDir, log: fakeLog(), fs: lockedFs([addonPath]), now: () => 1 });
    fs.writeFileSync(addonPath, "v2");

    const log = fakeLog();
    const { swept, cleared } = releaseNativeAddon({ addonPath, asideDir, log });

    expect(swept).toEqual({ removed: 1, kept: 0 });
    expect(cleared).toEqual({ result: "removed" });
    expect(fs.existsSync(asideDir)).toBe(false);
    expect(log.log.mock.calls[0][0]).toMatch(/^Removed 1 released addon copy /);
  });

  it("reports a copy still held, and still clears the current binary", () => {
    fs.mkdirSync(asideDir);
    const held = join(asideDir, "audio_native.1.node");
    fs.writeFileSync(held, "v1");
    fs.writeFileSync(addonPath, "v2");
    const log = fakeLog();

    const { swept, cleared } = releaseNativeAddon({ addonPath, asideDir, log, fs: lockedFs([held]) });

    expect(swept).toEqual({ removed: 0, kept: 1 });
    expect(cleared).toEqual({ result: "removed" });
    expect(log.log.mock.calls[0][0]).toContain("still loaded by a running process");
  });
});

describe("releaseNativeAddon problems", () => {
  it("warns about a sweep problem and still clears the binary", () => {
    fs.mkdirSync(asideDir);
    const broken = join(asideDir, "audio_native.1.node");
    fs.writeFileSync(broken, "a");
    fs.writeFileSync(addonPath, "v2");
    const log = fakeLog();

    const { cleared } = releaseNativeAddon({ addonPath, asideDir, log, fs: lockedFs([broken], "EIO") });

    expect(cleared).toEqual({ result: "removed" });
    expect(log.warn.mock.calls[0][0]).toMatch(/^Could not clean up .*EIO.*carrying on with the build\.$/);
  });
});

describe("releasePackageAddon", () => {
  it("clears build/Release/<addon> and sweeps <package>/.locked-native", () => {
    fs.writeFileSync(addonPath, "old");
    fs.mkdirSync(join(pkg, ASIDE_DIR_NAME));
    fs.writeFileSync(join(pkg, ASIDE_DIR_NAME, "audio_native.1.node"), "older");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const { swept, cleared } = releasePackageAddon(pkg, "audio_native.node");

    expect(cleared).toEqual({ result: "removed" });
    expect(swept).toEqual({ removed: 1, kept: 0 });
    expect(fs.existsSync(addonPath)).toBe(false);
    expect(fs.existsSync(join(pkg, ".locked-native"))).toBe(false);
    log.mockRestore();
  });
});
