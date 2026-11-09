import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { exitTripwireHint } from "./lib/release-capture.mjs";
import { armReleaseTripwire, main, USAGE } from "./release-capture.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The `after:bump` hook `.release-it.json` must name, with release-it's version placeholder. */
const CAPTURE_HOOK = "node scripts/release-capture.mjs ${version}";

/**
 * The wiring assertion, as a function so its positive control can run it over
 * a config that lacks the hook and see it fail.
 *
 * @param {unknown} config - A parsed `.release-it.json`.
 */
function expectCaptureHookWired(config) {
  const hooks = /** @type {{ hooks?: Record<string, unknown> }} */ (config).hooks ?? {};
  const afterBump = hooks["after:bump"];
  const scripts = Array.isArray(afterBump) ? afterBump : [afterBump];

  expect(scripts, 'hooks["after:bump"] does not name the capture hook').toContain(CAPTURE_HOOK);
}

describe("node scripts/release-capture.mjs <version>", () => {
  it("runs the capture for the version given and returns its exit code", async () => {
    const run = vi.fn(async () => 0);
    const error = vi.fn();

    expect(await main(["3.9.0"], { run, error })).toBe(0);

    expect(run).toHaveBeenCalledWith("3.9.0");
    expect(error).not.toHaveBeenCalled();

    const refusing = vi.fn(async () => 1);
    expect(await main(["3.9.0"], { run: refusing, error })).toBe(1);
  });

  it("prints the usage and exits 1 without a version, running nothing", async () => {
    const run = vi.fn(async () => 0);
    const error = vi.fn();

    expect(await main([], { run, error })).toBe(1);
    expect(await main([""], { run, error })).toBe(1);

    expect(run).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(USAGE);
  });
});

describe("armReleaseTripwire", () => {
  it("arms the tripwire with the release's restore hint", () => {
    const timer = { unref: vi.fn() };
    const arm = vi.fn(() => timer);

    expect(armReleaseTripwire({ arm, env: {} })).toBe(timer);

    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm).toHaveBeenCalledWith({ hint: exitTripwireHint({}) });
    expect(arm).toHaveBeenCalledWith({ hint: expect.stringContaining("`git restore --staged --worktree -- :/`") });
  });

  it("hands a dry run the dry run's hint", () => {
    const arm = vi.fn(() => undefined);

    armReleaseTripwire({ arm, env: { RELEASE_IT_DRY_RUN: "1" } });

    expect(arm).toHaveBeenCalledWith({ hint: exitTripwireHint({ RELEASE_IT_DRY_RUN: "1" }) });
  });
});

describe(".release-it.json", () => {
  const config = JSON.parse(readFileSync(join(repoRoot, ".release-it.json"), "utf-8"));

  it("names the capture hook under after:bump, after the before:bump bump-and-fold hook", () => {
    expectCaptureHookWired(config);
    // The capture needs the fold and the bump before it, which before:bump does.
    expect(config.hooks["before:bump"]).toBe("node scripts/release-hooks.mjs ${version}");
  });

  it("positive control: the same assertion fails over a copy of the config without the hook", () => {
    const hooks = { ...config.hooks };
    delete hooks["after:bump"];
    const without = { ...config, hooks };

    expect(() => expectCaptureHookWired(without)).toThrow('hooks["after:bump"] does not name the capture hook');
    // And over one that names the hook under the wrong event.
    const misplaced = { ...config, hooks: { ...hooks, "before:release": CAPTURE_HOOK } };
    expect(() => expectCaptureHookWired(misplaced)).toThrow();
  });
});
