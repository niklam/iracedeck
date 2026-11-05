import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import * as testing from "./testing.js";

/**
 * The testing entry is for tests (#1597): the main barrel is the production
 * surface, and `@iracedeck/deck-core/testing` carries the ordering contract
 * suite and its harness types, which no production source may import — an
 * adapter imports `ContextEventOrder` from the barrel and runs the suite from
 * its tests. It also re-exports the real dial-gesture helpers and icon
 * throttle, for tests that mock the barrel (#1375). Shaped like
 * replay-engine's `index.test.ts` (#1502).
 */

const PACKAGES_ROOT = join(import.meta.dirname, "..", "..");

/** The real implementations the entry re-exports for tests that mock the barrel (#1375). */
const REAL_IMPLEMENTATIONS = [
  "IconUpdateThrottle",
  "NOOP_HOLD_PREVIEW",
  "classifyDialRelease",
  "createHoldPreview",
] as const;

/** An import of the testing entry, static, dynamic or re-exported. */
const TESTING_IMPORT = /["']@iracedeck\/deck-core\/testing["']/;

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

    try {
      walk(join(PACKAGES_ROOT, pkg.name, "src"));
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

describe("deck-core's testing entry (#1597)", () => {
  it("carries the suite and its harness types, and the barrel carries none of them", () => {
    const suite = Object.keys(testing).filter((name) => !(REAL_IMPLEMENTATIONS as readonly string[]).includes(name));

    expect(suite.sort()).toEqual([
      "CONTEXT_EVENT_ORDER_ACTION_UUID",
      "CONTEXT_EVENT_ORDER_HOST_EVENTS",
      "CONTEXT_EVENT_ORDER_INPUT_EVENTS",
      "CONTEXT_EVENT_ORDER_SCENARIOS",
    ]);
    expect(testing.CONTEXT_EVENT_ORDER_SCENARIOS.length).toBeGreaterThanOrEqual(11);

    for (const name of suite) expect(barrel, name).not.toHaveProperty(name);

    // The references beside the suite are test support, reachable from neither entry.
    for (const name of [
      "UnorderedReferenceAdapter",
      "SerialReferenceAdapter",
      "InTaskBroadcastReferenceAdapter",
      "InTaskLivenessReferenceAdapter",
      "LateAppearDropReferenceAdapter",
      "OrderedReferenceAdapter",
    ]) {
      expect(barrel).not.toHaveProperty(name);
      expect(testing).not.toHaveProperty(name);
    }
  });

  it("re-exports the very implementations the barrel ships, for tests that mock the barrel (#1375)", () => {
    for (const name of REAL_IMPLEMENTATIONS) {
      expect(testing, name).toHaveProperty(name);
      expect(testing[name], name).toBe(barrel[name]);
    }
  });

  it("the barrel exports the primitive the adapters build on", () => {
    expect(typeof barrel.ContextEventOrder).toBe("function");
    expect(barrel.CONTEXT_EVENT_WAIT_LIMIT_MS).toBe(10_000);
  });

  it("flags an import of the testing entry (positive control)", () => {
    expect(TESTING_IMPORT.test(`import { CONTEXT_EVENT_ORDER_SCENARIOS } from "@iracedeck/deck-core/testing";`)).toBe(
      true,
    );
    expect(TESTING_IMPORT.test(`await import('@iracedeck/deck-core/testing')`)).toBe(true);
    expect(TESTING_IMPORT.test(`import { ContextEventOrder } from "@iracedeck/deck-core";`)).toBe(false);
    // The scan reaches this file, whose control strings above match, so an empty production result means something.
    expect(testingImportersOf(packageSources().filter(isTestSource))).toContain("deck-core/src/testing.test.ts");
  });

  it("no production source imports the testing entry", () => {
    const production = packageSources().filter((file) => !isTestSource(file));

    expect(production.length).toBeGreaterThan(500);
    expect(testingImportersOf(production)).toEqual([]);
  });
});
