import { describe, expect, it, vi } from "vitest";

import { isDryRun, main, parseReleaseVersion, releaseItArgs, releaseVersionArgs, withCi } from "./release.mjs";

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", signal: null, output: [], pid: 1 });
const failed = (status, stdout = "") => ({ ...ok(stdout), status });

/**
 * The wrapper with release-it and both hooks faked. `releaseIt` answers by what
 * the call is: the `--release-version` probe gets `version`'s stdout, the real
 * (or dry) run gets `run`. `hook` is the `before:bump` hook's result,
 * `captureHook` the `after:bump` hook's. Every call's argv and options are kept.
 */
function fakes({ version = ok("9.9.9-rc.1\n"), run = ok(), hook = ok(), captureHook = ok(), token = "token" } = {}) {
  const env = token === null ? {} : { GITHUB_TOKEN: token };
  const deps = {
    env,
    runReleaseIt: vi.fn((args) => (args.includes("--release-version") ? version : run)),
    runHook: vi.fn(() => hook),
    runCaptureHook: vi.fn(() => captureHook),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const calls = () => deps.runReleaseIt.mock.calls.map(([args]) => args);
  const errors = () => deps.error.mock.calls.map(([line]) => line).join("\n");
  return { deps, calls, errors };
}

describe("the argument helpers", () => {
  it("strips the -- separator pnpm forwards and nothing else", () => {
    expect(releaseItArgs(["--", "minor", "--preRelease=alpha"])).toEqual(["minor", "--preRelease=alpha"]);
    expect(releaseItArgs(["minor", "--", "x"])).toEqual(["minor", "--", "x"]);
    expect(releaseItArgs([])).toEqual([]);
  });

  it("recognises every spelling of release-it's dry run", () => {
    expect(isDryRun(["--dry-run"])).toBe(true);
    expect(isDryRun(["9.9.9", "-d"])).toBe(true);
    expect(isDryRun(["--dry-run=true"])).toBe(true);
    expect(isDryRun(["9.9.9", "--ci"])).toBe(false);
    expect(isDryRun([])).toBe(false);
  });

  it("asks for the version with the same arguments minus the dry-run flag", () => {
    expect(releaseVersionArgs(["9.9.9-rc.1", "--dry-run", "--ci"])).toEqual([
      "9.9.9-rc.1",
      "--ci",
      "--release-version",
    ]);
    expect(releaseVersionArgs(["--preRelease=rc", "-d"])).toEqual(["--preRelease=rc", "--release-version"]);
  });

  it("adds --ci once", () => {
    expect(withCi(["9.9.9", "--dry-run"])).toEqual(["9.9.9", "--dry-run", "--ci"]);
    expect(withCi(["--dry-run", "--ci"])).toEqual(["--dry-run", "--ci"]);
    expect(withCi([])).toEqual(["--ci"]);
  });

  it("reads the version as the last non-empty stdout line, and only a semver one", () => {
    expect(parseReleaseVersion("9.9.9-rc.1\n")).toBe("9.9.9-rc.1");
    expect(parseReleaseVersion("WARNING something\n3.9.0\r\n\n")).toBe("3.9.0");
    expect(parseReleaseVersion("")).toBeNull();
    expect(parseReleaseVersion("v3.9.0\n")).toBeNull();
    expect(parseReleaseVersion("3.9.0\nnot a version\n")).toBeNull();
  });
});

describe("pnpm release:dry (main with a dry-run flag)", () => {
  it("resolves the version, runs both hooks with RELEASE_IT_DRY_RUN=1 in release order, then release-it's dry run", () => {
    const { deps, calls } = fakes();

    const status = main(["--", "9.9.9-rc.1", "--dry-run", "--ci"], deps);

    expect(status).toBe(0);
    expect(calls()).toEqual([
      ["9.9.9-rc.1", "--ci", "--release-version"],
      ["9.9.9-rc.1", "--dry-run", "--ci"],
    ]);
    // The probe's stdout is read, its stderr shown; the dry run inherits everything.
    expect(deps.runReleaseIt.mock.calls[0][1]).toMatchObject({
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    expect(deps.runReleaseIt.mock.calls[1][1]).toMatchObject({ stdio: "inherit" });
    expect(deps.runHook).toHaveBeenCalledTimes(1);
    expect(deps.runCaptureHook).toHaveBeenCalledTimes(1);
    for (const hook of [deps.runHook, deps.runCaptureHook]) {
      const [version, hookEnv] = hook.mock.calls[0];
      expect(version).toBe("9.9.9-rc.1");
      expect(hookEnv.RELEASE_IT_DRY_RUN).toBe("1");
      expect(hookEnv.GITHUB_TOKEN).toBe("token");
    }
    // Every child, release-it's own dry run included, carries the flag.
    for (const [, options] of deps.runReleaseIt.mock.calls) expect(options.env.RELEASE_IT_DRY_RUN).toBe("1");
    // The hooks run between the probe and the dry run: before:bump first, as in the release.
    const [probe, dryRun] = deps.runReleaseIt.mock.invocationCallOrder;
    const [bump] = deps.runHook.mock.invocationCallOrder;
    const [capture] = deps.runCaptureHook.mock.invocationCallOrder;
    expect(bump).toBeGreaterThan(probe);
    expect(capture).toBeGreaterThan(bump);
    expect(capture).toBeLessThan(dryRun);
    expect(deps.log.mock.calls.map(([line]) => line)).toEqual([
      "Previewing the before:bump hook for 9.9.9-rc.1 (release-it skips hooks in a dry run):",
      "Previewing the after:bump hook for 9.9.9-rc.1 (release-it skips hooks in a dry run):",
    ]);
  });

  it("uses the version release-it resolves when none is given, warnings on stdout aside", () => {
    const { deps } = fakes({ version: ok("WARNING no token\n3.9.0\n") });

    main(["-d"], deps);

    expect(deps.runHook.mock.calls[0][0]).toBe("3.9.0");
  });

  // Interactively, release-it's own dry run would prompt for a version and let
  // the maintainer pick one the preview did not describe; with `--ci` it
  // resolves the version exactly as the probe did, and a prompt in a dry run
  // decides nothing anyway.
  it("runs release-it's dry run with --ci, so it resolves the same version the preview described", () => {
    const { deps, calls } = fakes({ version: ok("3.9.0\n") });

    main(["--dry-run"], deps);

    expect(calls()).toEqual([["--release-version"], ["--dry-run", "--ci"]]);
    expect(deps.runHook.mock.calls[0][0]).toBe("3.9.0");
  });

  it("stops without running release-it's dry run when the before:bump hook refuses, with the hook's exit code", () => {
    const { deps, calls, errors } = fakes({ hook: failed(1) });

    const status = main(["9.9.9-rc.1", "--dry-run"], deps);

    expect(status).toBe(1);
    expect(calls()).toEqual([["9.9.9-rc.1", "--release-version"]]);
    // A refused bump is never followed by the capture that builds on it.
    expect(deps.runCaptureHook).not.toHaveBeenCalled();
    expect(errors()).toContain(
      "The before:bump hook refused 9.9.9-rc.1, so the release would stop there; the dry run stops here.",
    );
  });

  it("stops without running release-it's dry run when the after:bump capture hook refuses, naming that hook", () => {
    const { deps, calls, errors } = fakes({ version: ok("3.9.0\n"), captureHook: failed(2) });

    const status = main(["3.9.0", "--dry-run"], deps);

    expect(status).toBe(2);
    expect(calls()).toEqual([["3.9.0", "--release-version"]]);
    expect(deps.runHook).toHaveBeenCalledTimes(1);
    expect(deps.runCaptureHook).toHaveBeenCalledTimes(1);
    expect(errors()).toContain(
      "The after:bump hook refused 3.9.0, so the release would stop there; the dry run stops here.",
    );
    expect(errors()).not.toContain("before:bump hook refused");
  });

  it("stops before the hook when release-it cannot say which version it would release", () => {
    const refused = fakes({ version: failed(1, "") });
    const garbled = fakes({ version: ok("Let's release\n") });

    expect(main(["--dry-run"], refused.deps)).toBe(1);
    expect(main(["--dry-run"], garbled.deps)).toBe(1);
    for (const { deps, calls, errors } of [refused, garbled]) {
      expect(deps.runHook).not.toHaveBeenCalled();
      expect(calls()).toHaveLength(1);
      expect(errors()).toContain("Could not resolve the version the dry run would release");
    }
  });

  it("reports a release-it or hook process that could not be started", () => {
    const noNpx = fakes({ version: { ...ok(), error: new Error("spawn npx ENOENT") } });
    const noNode = fakes({ hook: { ...ok(), error: new Error("spawn node ENOENT") } });
    const noCapture = fakes({ captureHook: { ...ok(), error: new Error("spawn node EACCES") } });

    expect(main(["--dry-run"], noNpx.deps)).toBe(1);
    expect(noNpx.errors()).toContain("ENOENT");
    expect(main(["--dry-run"], noNode.deps)).toBe(1);
    expect(noNode.errors()).toContain("ENOENT");
    expect(noNode.calls()).toHaveLength(1);
    expect(noNode.deps.runCaptureHook).not.toHaveBeenCalled();
    expect(main(["--dry-run"], noCapture.deps)).toBe(1);
    expect(noCapture.errors()).toContain("EACCES");
    expect(noCapture.calls()).toHaveLength(1);
  });
});

describe("pnpm release (main without a dry-run flag)", () => {
  it("runs release-it once with the arguments as given, no probe, no hook of its own, no flag", () => {
    const { deps, calls } = fakes();

    const status = main(["--", "minor", "--preRelease=rc"], deps);

    expect(status).toBe(0);
    expect(calls()).toEqual([["minor", "--preRelease=rc"]]);
    expect(deps.runHook).not.toHaveBeenCalled();
    expect(deps.runCaptureHook).not.toHaveBeenCalled();
    expect(deps.runReleaseIt.mock.calls[0][1].env.RELEASE_IT_DRY_RUN).toBeUndefined();
    expect(deps.runReleaseIt.mock.calls[0][1]).toMatchObject({ stdio: "inherit" });
  });

  it("returns release-it's exit code, 1 when it has none", () => {
    expect(main([], fakes({ run: failed(3) }).deps)).toBe(3);
    expect(main([], fakes({ run: { ...ok(), status: null } }).deps)).toBe(1);
  });

  it("does not ask gh for a token when GITHUB_TOKEN is set", () => {
    const { deps } = fakes({ token: "set" });

    main([], deps);

    expect(deps.env.GITHUB_TOKEN).toBe("set");
    expect(deps.warn).not.toHaveBeenCalled();
  });
});
