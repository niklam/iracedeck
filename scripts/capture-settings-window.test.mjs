import { spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { main } from "./capture-settings-window.mjs";
import {
  CapturePreconditionError,
  committedCaptureDir,
  localCaptureDir,
  REPO_ROOT,
} from "./lib/settings-window-capture/run-capture.mjs";

/**
 * Whether git ignores `path` (relative to the repository root): `check-ignore`
 * exits 0 for an ignored path and 1 for one it does not ignore. A tracked file
 * is reported as not ignored, which is the answer wanted for the committed
 * folder.
 */
function gitIgnores(path) {
  const result = spawnSync("git", ["-C", REPO_ROOT, "check-ignore", "-q", path], { encoding: "utf-8" });

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed (${result.status}): ${result.stderr}`);
  }

  return result.status === 0;
}

/** The repository-relative path git expects, with forward slashes. */
function repoPath(absolute) {
  return relative(REPO_ROOT, absolute).split(sep).join("/");
}

function createDeps(overrides = {}) {
  return {
    runCapture: vi.fn(async ({ outDir }) => ({ written: [join(outDir, "general.png")], skipped: [] })),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe("pnpm capture:settings", () => {
  it("captures under local/, never into the committed folder", async () => {
    const deps = createDeps();

    expect(await main([], deps)).toBe(0);

    expect(deps.runCapture).toHaveBeenCalledTimes(1);

    const [{ outDir }] = deps.runCapture.mock.calls[0];

    expect(outDir).toBe(localCaptureDir(REPO_ROOT));
    expect(outDir.startsWith(join(REPO_ROOT, "local") + sep)).toBe(true);
    expect(outDir).not.toBe(committedCaptureDir(REPO_ROOT));
    expect(outDir.startsWith(committedCaptureDir(REPO_ROOT))).toBe(false);
  });

  it("writes where git ignores it, unlike the committed folder", () => {
    // The local folder's files never reach a commit…
    expect(gitIgnores(`${repoPath(localCaptureDir(REPO_ROOT))}/general.png`)).toBe(true);
    // …and the positive control: the check can answer "not ignored", and does
    // for the folder the website renders, so the line above means something.
    expect(gitIgnores(`${repoPath(committedCaptureDir(REPO_ROOT))}/general.png`)).toBe(false);
  });

  it("asks for no header check and no manifest: it hands the runner the folder, scale and loggers only", async () => {
    const deps = createDeps();

    await main(["--scale=2"], deps);

    const [options] = deps.runCapture.mock.calls[0];

    expect(Object.keys(options).sort()).toEqual(["log", "outDir", "scale", "warn"]);
    expect(options.scale).toBe(2);
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain("capture.json");
  });

  it("reports how many screenshots it wrote and where", async () => {
    const deps = createDeps();

    await main([], deps);

    expect(deps.log).toHaveBeenCalledWith(`\nWrote 1 screenshots to ${localCaptureDir(REPO_ROOT)}`);
    expect(deps.error).not.toHaveBeenCalled();
  });

  it.each([["--scale=abc"], ["--scale=0"], ["--scale=-2"], ["--scale="]])(
    "refuses %s without capturing",
    async (arg) => {
      const deps = createDeps();

      expect(await main([arg], deps)).toBe(1);

      expect(deps.runCapture).not.toHaveBeenCalled();
      expect(deps.error).toHaveBeenCalledWith(expect.stringContaining("--scale must be a positive number"));
    },
  );

  it("fails the run on a skipped tab, naming it after the count", async () => {
    const file = join(localCaptureDir(REPO_ROOT), "support.png");
    const deps = createDeps({
      runCapture: vi.fn(async () => ({
        written: [],
        skipped: [{ file, label: "Support iRaceDeck", reason: "an image failed to load" }],
      })),
    });

    expect(await main([], deps)).toBe(1);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("Wrote 0 screenshots"));
    expect(deps.error).toHaveBeenCalledWith(
      `Skipped ${file} (the Support iRaceDeck tab): an image failed to load. The existing file was left unchanged.`,
    );
  });

  it("prints a missing build or browser as its sentence and exits 1", async () => {
    const deps = createDeps({
      runCapture: vi.fn(async () => {
        throw new CapturePreconditionError('The Stream Deck plugin has not been built. Run "pnpm build" first.');
      }),
    });

    expect(await main([], deps)).toBe(1);

    expect(deps.error).toHaveBeenCalledWith('The Stream Deck plugin has not been built. Run "pnpm build" first.');
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("keeps the stack of any other failure and exits 1", async () => {
    const deps = createDeps({
      runCapture: vi.fn(async () => {
        throw new Error('The settings page has no nav button for "simhub".');
      }),
    });

    expect(await main([], deps)).toBe(1);

    const [printed] = deps.error.mock.calls[0];

    expect(printed).toContain('no nav button for "simhub"');
    expect(printed).toContain("capture-settings-window.test.mjs");
  });
});
