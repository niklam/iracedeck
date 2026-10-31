import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import * as testing from "./testing.js";

/**
 * The main barrel is the production surface (#1502): a test hook on it is one
 * production code can call, and `@iracedeck/replay-engine/testing` imports
 * `vitest`, so a production source that imports it would pull the test runner
 * into the plugin bundle.
 */

const PACKAGES_ROOT = join(import.meta.dirname, "..", "..");

/** A test hook's name: `_resetReplayCursor`, `_configureReplayEngine`, `_activeLapPress`. */
function testHooksIn(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith("_"));
}

/** An import of the testing entry, static, dynamic or re-exported. */
const TESTING_IMPORT = /["']@iracedeck\/replay-engine\/testing["']/;

/** True for a test, a test-support module or anything under a `test-support` directory. */
function isTestSource(path: string): boolean {
  return /\.test\.ts$|\.test-support\.ts$/.test(path) || path.split(sep).includes("test-support");
}

/** Every `.ts` file under each package's `src/`, absolute. */
function packageSources(): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);

        continue;
      }

      if (entry.name.endsWith(".ts")) found.push(full);
    }
  };

  for (const pkg of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;

    const src = join(PACKAGES_ROOT, pkg.name, "src");

    try {
      walk(src);
    } catch {
      // A package without a src/ directory has nothing to scan.
    }
  }

  return found;
}

/** The files among `files` that import the testing entry, relative to the packages directory. */
function testingImportersOf(files: string[]): string[] {
  return files
    .filter((file) => TESTING_IMPORT.test(readFileSync(file, "utf8")))
    .map((file) => relative(PACKAGES_ROOT, file).split(sep).join("/"));
}

describe("the replay engine's production surface (#1502)", () => {
  it("flags a test hook's name (positive control)", () => {
    expect(testHooksIn(["pressReplayCommand", "_resetReplayCursor", "_configureReplayEngine"])).toEqual([
      "_resetReplayCursor",
      "_configureReplayEngine",
    ]);
    // The hooks the tests share are on the testing entry, so the check finds them there.
    expect(testHooksIn(Object.keys(testing))).toContain("_configureReplayEngine");
  });

  it("the main barrel exports no test hook", () => {
    expect(Object.keys(barrel).length).toBeGreaterThan(0);
    expect(testHooksIn(Object.keys(barrel))).toEqual([]);
  });

  it("flags an import of the testing entry (positive control)", () => {
    expect(TESTING_IMPORT.test(`import { resetEngine } from "@iracedeck/replay-engine/testing";`)).toBe(true);
    expect(TESTING_IMPORT.test(`await import('@iracedeck/replay-engine/testing')`)).toBe(true);
    expect(TESTING_IMPORT.test(`import { pressReplayCommand } from "@iracedeck/replay-engine";`)).toBe(false);
    // The scan reaches the real tests that import it, so an empty production result means something.
    expect(testingImportersOf(packageSources().filter(isTestSource)).length).toBeGreaterThan(10);
  });

  it("no production source imports the testing entry", () => {
    const production = packageSources().filter((file) => !isTestSource(file));

    expect(production.length).toBeGreaterThan(500);
    expect(testingImportersOf(production)).toEqual([]);
  });
});
