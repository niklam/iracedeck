import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CACHE_ENTRY_FILE,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  parseCliArgs,
  planPrune,
  pruneTurboCache,
  summaryHashes,
} from "./prune-turbo-cache.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "prune-turbo-cache.mjs");

const KEPT = "1b5598f4328a0bbe";
const STALE = "eefd00a8258ca616";
const ENTRY_SUFFIXES = [".tar.zst", "-meta.json", "-manifest.json"];

let root;
let cacheDir;
let runsDir;

function writeEntry(hash, bytes = 10) {
  for (const suffix of ENTRY_SUFFIXES) writeFileSync(join(cacheDir, `${hash}${suffix}`), "x".repeat(bytes));
}

function writeSummary(name, tasks) {
  writeFileSync(join(runsDir, name), JSON.stringify({ id: name, tasks }));
}

function task(hash, status = "MISS") {
  return { taskId: `@iracedeck/x#${hash.slice(0, 4)}`, hash, cache: { status } };
}

function silentLog() {
  return { log: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ird-prune-turbo-"));
  cacheDir = join(root, ".turbo", "cache");
  runsDir = join(root, ".turbo", "runs");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pruneTurboCache (#1492)", () => {
  it("removes every file of an entry no summary task hashed to, and keeps the rest", () => {
    writeEntry(KEPT);
    writeEntry(STALE);
    writeSummary("a.json", [task(KEPT, "HIT")]);
    const log = silentLog();

    expect(pruneTurboCache({ cacheDir, runsDir, log })).toBe(EXIT_OK);
    expect(readdirSync(cacheDir).sort()).toEqual(ENTRY_SUFFIXES.map((s) => `${KEPT}${s}`).sort());
    expect(log.log.mock.calls[0][0]).toMatch(/kept 1 entries .*removed 1 /);
  });

  it("keeps the union of every summary's hashes", () => {
    const third = "00060f18ad4c96fa";
    writeEntry(KEPT);
    writeEntry(STALE);
    writeEntry(third);
    writeSummary("a.json", [task(KEPT)]);
    writeSummary("b.json", [task(STALE, "HIT")]);

    expect(pruneTurboCache({ cacheDir, runsDir, log: silentLog() })).toBe(EXIT_OK);
    expect(existsSync(join(cacheDir, `${KEPT}.tar.zst`))).toBe(true);
    expect(existsSync(join(cacheDir, `${STALE}.tar.zst`))).toBe(true);
    expect(existsSync(join(cacheDir, `${third}.tar.zst`))).toBe(false);
  });

  it("leaves a file that is not a cache entry alone, and says so", () => {
    writeEntry(KEPT);
    writeFileSync(join(cacheDir, "README.txt"), "?");
    mkdirSync(join(cacheDir, "nested"));
    writeSummary("a.json", [task(KEPT)]);
    const log = silentLog();

    expect(pruneTurboCache({ cacheDir, runsDir, log })).toBe(EXIT_OK);
    expect(existsSync(join(cacheDir, "README.txt"))).toBe(true);
    expect(existsSync(join(cacheDir, "nested"))).toBe(true);
    expect(log.log.mock.calls[0][0]).toMatch(/left 2 unrecognised file\(s\) alone/);
  });

  describe("refuses, deleting nothing", () => {
    function expectRefused(pattern) {
      const before = readdirSync(cacheDir).sort();
      const log = silentLog();
      expect(pruneTurboCache({ cacheDir, runsDir, log })).toBe(EXIT_REFUSED);
      expect(log.error.mock.calls[0][0]).toMatch(pattern);
      expect(readdirSync(cacheDir).sort()).toEqual(before);
    }

    beforeEach(() => {
      writeEntry(KEPT);
      writeEntry(STALE);
    });

    it("with no runs directory", () => {
      rmSync(runsDir, { recursive: true });
      expectRefused(/does not exist/);
    });

    it("with no summary in the runs directory", () => {
      writeFileSync(join(runsDir, "notes.txt"), "not a summary");
      expectRefused(/no run summaries/);
    });

    it("with an unreadable summary, even beside a good one", () => {
      writeSummary("a.json", [task(KEPT)]);
      writeFileSync(join(runsDir, "b.json"), "{ truncated");
      expectRefused(/b\.json is unreadable/);
    });

    it("with a summary that lists no tasks", () => {
      writeSummary("a.json", []);
      expectRefused(/lists no tasks/);
    });

    it("with a task that has no hash", () => {
      writeSummary("a.json", [task(KEPT), { taskId: "@iracedeck/y#build" }]);
      expectRefused(/task 1 \(@iracedeck\/y#build\) has no hash/);
    });

    it("when no summary hash has an entry in the cache directory", () => {
      writeSummary("a.json", [task("0123456789abcdef")]);
      expectRefused(/none of the 1 task hashes/);
    });

    it("with no cache directory", () => {
      writeSummary("a.json", [task(KEPT)]);
      rmSync(cacheDir, { recursive: true });
      const log = silentLog();
      expect(pruneTurboCache({ cacheDir, runsDir, log })).toBe(EXIT_REFUSED);
      expect(log.error.mock.calls[0][0]).toMatch(/no turbo cache at/);
    });
  });
});

describe("planPrune", () => {
  it("groups an entry's three files under its hash and sums their sizes", () => {
    const files = [
      { name: `${KEPT}.tar.zst`, size: 100 },
      { name: `${KEPT}-meta.json`, size: 2 },
      { name: `${STALE}-manifest.json`, size: 3 },
      { name: `${KEPT}.tar.zst.tmp`, size: 7 },
    ];
    const { keep, remove, unknown } = planPrune(files, new Set([KEPT]));
    expect(keep.get(KEPT)).toEqual({ files: [`${KEPT}.tar.zst`, `${KEPT}-meta.json`], bytes: 102 });
    expect(remove.get(STALE)).toEqual({ files: [`${STALE}-manifest.json`], bytes: 3 });
    expect(unknown).toEqual([`${KEPT}.tar.zst.tmp`]);
  });

  it("matches the three file names turbo 2.11 writes, and nothing else", () => {
    for (const suffix of ENTRY_SUFFIXES) expect(CACHE_ENTRY_FILE.test(`${KEPT}${suffix}`)).toBe(true);
    for (const name of [`${KEPT}.json`, `${KEPT}-meta.json.bak`, "runs", `x${KEPT}.tar.zst`]) {
      expect(CACHE_ENTRY_FILE.test(name)).toBe(false);
    }
  });
});

describe("summaryHashes", () => {
  it("returns every task's hash, hits and misses alike", () => {
    expect(summaryHashes({ tasks: [task(KEPT, "HIT"), task(STALE, "MISS")] }, "a.json")).toEqual([KEPT, STALE]);
  });

  it("refuses a summary that is not an object", () => {
    expect(() => summaryHashes(null, "a.json")).toThrow(/lists no tasks/);
  });
});

describe("parseCliArgs", () => {
  it("defaults the cache directory to TURBO_CACHE_DIR, the variable turbo reads", () => {
    expect(parseCliArgs([], { TURBO_CACHE_DIR: "/w/.turbo/cache" })).toEqual({
      cacheDir: "/w/.turbo/cache",
      runsDir: join(".turbo", "runs"),
    });
    expect(parseCliArgs([], {}).cacheDir).toBe(join(".turbo", "cache"));
  });

  it("prefers the flags over the environment", () => {
    expect(parseCliArgs(["--cache-dir", "c", "--runs-dir", "r"], { TURBO_CACHE_DIR: "e" })).toEqual({
      cacheDir: "c",
      runsDir: "r",
    });
  });

  it("rejects an unknown flag or a positional", () => {
    expect(parseCliArgs(["--force"], {})).toBeNull();
    expect(parseCliArgs(["dir"], {})).toBeNull();
  });
});

describe("the CLI", () => {
  function run(args, env = {}) {
    const childEnv = { ...process.env, ...env };
    delete childEnv.TURBO_CACHE_DIR;
    Object.assign(childEnv, env);

    return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env: childEnv, encoding: "utf8" });
  }

  it("prunes the default directories under the working directory", () => {
    writeEntry(KEPT);
    writeEntry(STALE);
    writeSummary("a.json", [task(KEPT)]);
    const result = run([]);
    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/kept 1 entries/);
    expect(existsSync(join(cacheDir, `${STALE}.tar.zst`))).toBe(false);
  });

  it("exits non-zero when there is no summary, so the save step does not run", () => {
    writeEntry(KEPT);
    const result = run([]);
    expect(result.status).toBe(EXIT_REFUSED);
    expect(result.stderr).toMatch(/refusing to prune, nothing deleted/);
    expect(existsSync(join(cacheDir, `${KEPT}.tar.zst`))).toBe(true);
  });

  it("reads the cache directory from TURBO_CACHE_DIR", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, `${KEPT}.tar.zst`), "x");
    writeFileSync(join(elsewhere, `${STALE}.tar.zst`), "x");
    writeSummary("a.json", [task(KEPT)]);
    const result = run([], { TURBO_CACHE_DIR: elsewhere });
    expect(result.status).toBe(EXIT_OK);
    expect(readdirSync(elsewhere)).toEqual([`${KEPT}.tar.zst`]);
  });

  it("exits 2 with the usage on a bad argument", () => {
    const result = run(["--nope"]);
    expect(result.status).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(/usage:/);
  });
});
