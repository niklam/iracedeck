import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { packageFilter, splitArgs, vitestArgs, vitestBin, WORKSPACE_ROOT } from "./test-package.mjs";

// Built through `path`, not written as Windows literals: CI runs on Linux.
const ROOT = path.resolve("/repo");
const pkg = (...parts) => path.join(ROOT, "packages", ...parts);

describe("packageFilter", () => {
  it("maps a package directory to its workspace-relative filter, forward slashes and a trailing slash", () => {
    expect(packageFilter(pkg("logger"), ROOT)).toBe("packages/logger/");
    expect(packageFilter(pkg("icon-composer"), ROOT)).toBe("packages/icon-composer/");
  });

  it("accepts a cwd given with a trailing separator", () => {
    expect(packageFilter(pkg("logger") + path.sep, ROOT)).toBe("packages/logger/");
  });

  it("ends in a slash so a package name never matches a longer sibling", () => {
    const filter = packageFilter(pkg("icon"), ROOT);
    expect("packages/icons/src/a.test.ts".includes(filter)).toBe(false);
    expect("packages/icon-composer/src/a.test.ts".includes(filter)).toBe(false);
    expect("packages/icon/src/a.test.ts".includes(filter)).toBe(true);
  });

  it.each([
    ["the workspace root", ROOT],
    ["packages/ itself", path.join(ROOT, "packages")],
    ["a directory inside a package", pkg("logger", "src")],
    ["a sibling of packages/", path.join(ROOT, "scripts")],
    ["a package of another checkout", path.resolve("/elsewhere", "packages", "logger")],
    ["the parent of the workspace", path.resolve(ROOT, "..")],
  ])("refuses %s, naming where to run it", (_label, cwd) => {
    expect(() => packageFilter(cwd, ROOT)).toThrow(/run this from a package directory directly under/);
  });
});

describe("vitestArgs", () => {
  it("returns the words after `vitest`", () => {
    expect(vitestArgs("vitest run --configLoader native", "test")).toEqual(["run", "--configLoader", "native"]);
    expect(vitestArgs("  vitest   --configLoader native ", "test:watch")).toEqual(["--configLoader", "native"]);
    expect(vitestArgs("vitest", "test:watch")).toEqual([]);
  });

  it("reads the root package.json's real scripts", () => {
    const { scripts } = JSON.parse(readFileSync(path.join(WORKSPACE_ROOT, "package.json"), "utf8"));
    expect(vitestArgs(scripts.test, "test")[0]).toBe("run");
    expect(vitestArgs(scripts.test, "test")).toContain("--configLoader");
    expect(vitestArgs(scripts["test:watch"], "test:watch")).not.toContain("run");
    expect(vitestArgs(scripts["test:watch"], "test:watch")).toContain("--configLoader");
  });

  it.each([
    ["another command", "turbo run test"],
    ["a vitest-prefixed word", "vitest-run run"],
    ["an empty script", ""],
    ["a missing script", undefined],
  ])("refuses %s, naming the script", (_label, script) => {
    expect(() => vitestArgs(script, "test")).toThrow(/root package.json "test" script must start with `vitest`/);
  });

  it.each([
    ["a chained command", "vitest run && echo done"],
    ["a quoted argument", 'vitest run -t "a b"'],
    ["a variable", "vitest run $ARGS"],
  ])("refuses %s, which would not split into an argument list", (_label, script) => {
    expect(() => vitestArgs(script, "test")).toThrow(/must be plain words/);
  });
});

describe("splitArgs", () => {
  it("defaults to the root test script and forwards nothing", () => {
    expect(splitArgs([])).toEqual({ scriptName: "test", forwarded: [] });
  });

  it("selects test:watch on a leading --watch", () => {
    expect(splitArgs(["--watch"])).toEqual({ scriptName: "test:watch", forwarded: [] });
    expect(splitArgs(["--watch", "-t", "x"])).toEqual({ scriptName: "test:watch", forwarded: ["-t", "x"] });
  });

  it("forwards everything else verbatim", () => {
    expect(splitArgs(["-t", "a name", "--reporter=verbose"])).toEqual({
      scriptName: "test",
      forwarded: ["-t", "a name", "--reporter=verbose"],
    });
  });

  it("drops pnpm's leading -- separator, in either mode", () => {
    expect(splitArgs(["--", "-t", "x"])).toEqual({ scriptName: "test", forwarded: ["-t", "x"] });
    expect(splitArgs(["--watch", "--", "-t", "x"])).toEqual({ scriptName: "test:watch", forwarded: ["-t", "x"] });
  });
});

describe("vitestBin", () => {
  it("resolves the Vitest CLI entry from the workspace root", () => {
    const bin = vitestBin(WORKSPACE_ROOT);
    expect(path.isAbsolute(bin)).toBe(true);
    expect(existsSync(bin)).toBe(true);
  });
});

// The real runner, spawned the way pnpm runs it: from a package directory.
// `packages/logger` is small, so the positive control is cheap and can count
// exactly what a correct run reports. Test workers set IRACEDECK_MOCK and it
// propagates here, which is the same native-mock run the root suite makes.
describe("scripts/test-package.mjs, run for real", () => {
  const RUNNER = path.join(import.meta.dirname, "test-package.mjs");
  const run = (cwd, args = []) =>
    spawnSync(process.execPath, [RUNNER, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });

  it("runs exactly the package's own test files and exits 0 (positive control)", () => {
    const loggerDir = path.join(WORKSPACE_ROOT, "packages", "logger");
    const expected = globSync("src/**/*.test.ts", { cwd: loggerDir }).length;
    expect(expected).toBeGreaterThan(0);
    // `--reporter=verbose` makes Vitest name every file it ran, and proves
    // arguments after the script reach Vitest. One worker, because this Vitest
    // runs inside a worker of the root suite and must not start a second
    // full-size pool beside it.
    const r = run(loggerDir, ["--reporter=verbose", "--maxWorkers=1"]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).toContain("packages/logger/src/index.test.ts");
    expect(out).toMatch(new RegExp(`Test Files\\s+${expected} passed \\(${expected}\\)`));
    expect(out.match(/packages\/(?!logger\/)[\w-]+\/src\/\S+\.test\.ts/g) ?? []).toEqual([]);
  }, 150_000);

  it.each([
    ["the workspace root", WORKSPACE_ROOT],
    ["packages/", path.join(WORKSPACE_ROOT, "packages")],
  ])(
    "refuses to run from %s, exiting non-zero with the reason (negative control)",
    (_label, cwd) => {
      const r = run(cwd);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/run this from a package directory directly under/);
    },
    30_000,
  );
});
