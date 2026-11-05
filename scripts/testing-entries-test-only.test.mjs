// A package's `./testing` entry is for tests only (#1375).
//
// `@iracedeck/<pkg>/testing` hands a test the real implementations its mocked
// barrel hides, plus fakes such as `createFakeAudio` (`action-tests.md`). It is
// built into `dist/` like the barrel and resolves from any package, so nothing
// but this stops production code importing it — and some entries import
// `vitest`, which would pull the test runner into a plugin bundle. So no
// non-test source under `packages/` imports one, by package name in any form
// (static, type-only, side-effect, re-export, dynamic, `require`,
// `import("…")` type), nor imports an entry's own source file by a relative
// path, which is the same leak spelled from inside the package.
//
// Test sources are classified as the plugin-shell guard classifies them
// (`isTestSource`: `*.test.*`, `*.test-support.*`, `*.test-util.*`,
// `*.fixture-cases.*`, anything under `test-support/`). An entry's own source
// (`src/testing.ts`, read from the package's `exports["./testing"]`) counts as
// test support too: it re-exports its package's modules by relative path, and
// may build on another package's entry.
//
// Test support may import an entry, so it is a way round the rule: a
// production `adapter.ts` importing `./fake.test-support.js`, which imports
// `@iracedeck/audio-service/testing`, would bundle `vitest` all the same. So
// no non-test source imports a test source by relative path either, in any of
// those module forms or a triple-slash `path` reference. The specifier is
// resolved against the importing file and matched in each form the repo
// writes — `./x.test-support.js` naming `x.test-support.ts`, `.ts`,
// extensionless, a folder's `index.ts` — by name, so the file need not exist.
// A test or test support importing test support, and an entry importing its
// package's test support, stay fine.
//
// This is the rule's one owner, in every package. It replaced the
// iracing-actions ESLint pattern that refused a `*.test-support` module there
// (#1375), which read one of these names in one package. `packages/replay-engine/src/index.test.ts`
// (#1502), `packages/audio-service/src/testing.test.ts` (#1504) and
// `packages/deck-core/src/testing.test.ts` (#1597) each held it for their own
// entry, by regex over `src/` with test classifiers of their own that disagreed
// with this one; those checks were removed in #1375. A package's own test holds
// what its entry carries and what its barrel leaves out, never who imports it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isTestSource, moduleReferences, trackedPackageSources } from "./lib/source-imports.mjs";
import { trackedPackageDirs } from "./lib/workspace-packages.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const P = path.posix;

/** A specifier naming a package's testing entry or a path beneath it. */
const TESTING_ENTRY = /^@iracedeck\/[^/]+\/testing(\/|$)/;

/**
 * The source file a package's `./testing` export is built from, repo-relative,
 * or undefined when it has none. `./dist/<x>.js` maps to `src/<x>.ts`, the
 * layout every package building to `dist/` shares; a source export is taken
 * as it is.
 *
 * @param {string} dir the package's directory under `packages/`
 * @param {{ exports?: Record<string, unknown> }} manifest
 */
export function testingEntrySource(dir, manifest) {
  const target = manifest.exports?.["./testing"];
  const file = typeof target === "string" ? target : (target?.import ?? target?.default);

  if (typeof file !== "string") return undefined;
  const relative = P.normalize(file);

  return P.join(
    "packages",
    dir,
    relative.startsWith("dist/") ? relative.replace(/^dist\//, "src/").replace(/\.js$/, ".ts") : relative,
  );
}

/** The `.ts` sources a relative `.js` / extensionless specifier may name. */
function candidates(resolved) {
  return [resolved, resolved.replace(/\.[cm]?js$/, ".ts"), `${resolved}.ts`, `${resolved}/index.ts`];
}

/** A specifier that is a path relative to the importing file. */
const RELATIVE = /^\.\.?(\/|$)/;

/**
 * Every import of a testing entry, or of test-only support, by a non-test
 * source, one line each; empty when there is none. Pure, so the positive
 * controls can feed it.
 *
 * @param {object} input
 * @param {{ file: string, source: string }[]} input.files repo-relative, `/`-separated
 * @param {Set<string>} input.entrySources each package's testing entry source
 * @returns {string[]}
 */
export function productionTestingImports({ files, entrySources }) {
  const problems = [];

  for (const { file, source } of files) {
    if (isTestSource(file) || entrySources.has(file)) continue;

    for (const { specifier, kind } of moduleReferences(source)) {
      if (kind === "import" && TESTING_ENTRY.test(specifier)) {
        problems.push(
          `${file} imports ${specifier}, a testing entry, from production code: import the package's main entry, ` +
            `or name the file as test support (*.test-support.ts or a test-support/ folder) if only tests load it`,
        );
        continue;
      }

      // A triple-slash `path` reference is relative to the file whatever it
      // starts with; an import is relative only when it says so.
      if (kind === "import" && !RELATIVE.test(specifier)) continue;
      const forms = candidates(P.join(P.dirname(file), specifier));
      const entry = forms.find((candidate) => entrySources.has(candidate));

      if (entry !== undefined) {
        problems.push(
          `${file} imports ${entry}, a package's testing entry, by relative path from production code: import the ` +
            `module it re-exports instead`,
        );
        continue;
      }

      const support = forms.find((candidate) => isTestSource(candidate));

      if (support !== undefined) {
        problems.push(
          `${file} imports ${specifier} (${support}), test-only support, from production code: it may load a ` +
            `testing entry or vitest into the bundle, so move what production needs into a non-test module, or ` +
            `name the importing file as test support too if only tests load it`,
        );
      }
    }
  }

  return problems;
}

const PACKAGES = trackedPackageDirs(ROOT);
const FILES = trackedPackageSources(ROOT);
const ENTRY_SOURCES = new Set(
  PACKAGES.map((dir) =>
    testingEntrySource(dir, JSON.parse(readFileSync(path.join(ROOT, "packages", dir, "package.json"), "utf-8"))),
  ).filter((file) => file !== undefined),
);
const read = (file) => ({ file, source: readFileSync(path.join(ROOT, file), "utf-8") });

describe("no production source imports a ./testing entry (#1375)", () => {
  const scanned = FILES.map(read);

  it("finds every package's testing entry source among the tracked files", () => {
    // audio-service, deck-core, deck-iracing, pi-components, replay-engine, replay-store, sim-events-iracing on 2026-11-05.
    expect(ENTRY_SOURCES.size).toBeGreaterThanOrEqual(7);
    for (const entry of ENTRY_SOURCES) expect(FILES, entry).toContain(entry);
  });

  it("reads the tests that import the entries, so an empty result is not vacuous", () => {
    const importers = scanned.filter(({ source }) =>
      moduleReferences(source).some(({ kind, specifier }) => kind === "import" && TESTING_ENTRY.test(specifier)),
    );

    expect(scanned.filter(({ file }) => !isTestSource(file)).length).toBeGreaterThan(500);
    expect(importers.length).toBeGreaterThan(20);
    expect(importers.every(({ file }) => isTestSource(file) || ENTRY_SOURCES.has(file))).toBe(true);
  });

  it("reads the relative imports of test support, so an empty result is not vacuous", () => {
    const importers = scanned.filter(({ file, source }) =>
      moduleReferences(source).some(
        ({ kind, specifier }) =>
          kind === "import" && RELATIVE.test(specifier) && isTestSource(P.join(P.dirname(file), specifier)),
      ),
    );

    // Tests, test support and, on 2026-11-05, replay-engine's entry, which re-exports its test support.
    expect(importers.length).toBeGreaterThan(50);
    expect(importers.every(({ file }) => isTestSource(file) || ENTRY_SOURCES.has(file))).toBe(true);
    expect(importers.some(({ file }) => ENTRY_SOURCES.has(file))).toBe(true);
  });

  it("no non-test source imports one, or test support", () => {
    expect(productionTestingImports({ files: scanned, entrySources: ENTRY_SOURCES })).toEqual([]);
  });
});

describe("the check itself (positive controls)", () => {
  const entrySources = new Set(["packages/deck-core/src/testing.ts", "packages/pi-components/src/build/testing.ts"]);
  const check = (file, source) => productionTestingImports({ files: [{ file, source }], entrySources });

  it("refuses a production import of a testing entry in every module form", () => {
    for (const source of [
      'import { createHoldPreview } from "@iracedeck/deck-core/testing";',
      'import type { FakeAudio } from "@iracedeck/audio-service/testing";',
      'import "@iracedeck/deck-core/testing";',
      'export { createHoldPreview } from "@iracedeck/deck-core/testing";',
      'export * from "@iracedeck/deck-core/testing";',
      'const t = await import("@iracedeck/replay-engine/testing");',
      'const t = require("@iracedeck/replay-store/testing");',
      'type T = typeof import("@iracedeck/deck-iracing/testing");',
      'import { x } from "@iracedeck/deck-core/testing/sub";',
    ]) {
      expect(check("packages/iracing-actions/src/actions/fuel-service/fuel-service.ts", source), source).toEqual([
        expect.stringContaining("a testing entry, from production code"),
      ]);
    }
  });

  it("refuses a production import of a package's own entry by relative path", () => {
    expect(check("packages/deck-core/src/index.ts", 'export * from "./testing.js";')).toEqual([
      expect.stringContaining("imports packages/deck-core/src/testing.ts, a package's testing entry, by relative path"),
    ]);
    expect(check("packages/pi-components/src/build/index.mjs", 'import { x } from "./testing.ts";')).toEqual([
      expect.stringContaining("packages/pi-components/src/build/testing.ts"),
    ]);
  });

  it("passes a test, test support and an entry building on another entry", () => {
    const source = 'import { createHoldPreview } from "@iracedeck/deck-core/testing";';

    for (const file of [
      "packages/iracing-actions/src/actions/fuel-service/fuel-dial-surface.test.ts",
      "packages/iracing-actions/src/shared/press-shape.test-support.ts",
      "packages/plugin-runtime/src/test-support/fake-host.ts",
      "packages/audio-scenarios/src/catalog/pit-crew/timed-audio.test-util.ts",
      "packages/iracing-actions/src/shared/dial-box-baseline.fixture-cases.ts",
      "packages/deck-core/src/testing.ts",
    ]) {
      expect(check(file, source), file).toEqual([]);
    }
  });

  it("passes the main entry, a lookalike name and a mention in a comment or a string", () => {
    const source = [
      'import { classifyDialRelease } from "@iracedeck/deck-core";',
      'import { x } from "@iracedeck/deck-core/testing-utils";',
      'import { y } from "./testing-helpers.js";',
      '// import { z } from "@iracedeck/deck-core/testing";',
      'const s = "@iracedeck/deck-core/testing";',
    ].join("\n");

    expect(check("packages/deck-core/src/a.ts", source)).toEqual([]);
  });

  // Test support may import an entry, so a production source must not reach
  // one through it: `adapter.ts` → `./fake.test-support.js` →
  // `@iracedeck/audio-service/testing` → `vitest`.
  const PRODUCTION = "packages/deck-adapter-mirabox/src/adapter.ts";
  const SUPPORT = "test-only support, from production code";

  it("refuses a production import of test support in every specifier form", () => {
    for (const [specifier, support] of [
      ["./fake.test-support.js", "packages/deck-adapter-mirabox/src/fake.test-support.js"],
      ["./fake.test-support.ts", "packages/deck-adapter-mirabox/src/fake.test-support.ts"],
      ["./fake.test-support", "packages/deck-adapter-mirabox/src/fake.test-support.ts"],
      ["../test-support/foo.js", "packages/deck-adapter-mirabox/test-support/foo.js"],
      ["./test-support/fake-host.js", "packages/deck-adapter-mirabox/src/test-support/fake-host.js"],
      ["./test-support", "packages/deck-adapter-mirabox/src/test-support/index.ts"],
      ["./timed-audio.test-util.js", "packages/deck-adapter-mirabox/src/timed-audio.test-util.js"],
      ["../shared/cases.fixture-cases.js", "packages/deck-adapter-mirabox/shared/cases.fixture-cases.js"],
      ["./adapter.test.js", "packages/deck-adapter-mirabox/src/adapter.test.js"],
    ]) {
      expect(check(PRODUCTION, `import { fake } from "${specifier}";`), specifier).toEqual([
        `${PRODUCTION} imports ${specifier} (${support}), ${SUPPORT}: it may load a testing entry or vitest into ` +
          `the bundle, so move what production needs into a non-test module, or name the importing file as test ` +
          `support too if only tests load it`,
      ]);
    }
  });

  it("refuses a production import of test support in every module form", () => {
    for (const source of [
      'import type { Fake } from "./fake.test-support.js";',
      'import "./fake.test-support.js";',
      'export { fake } from "./fake.test-support.js";',
      'export * from "./fake.test-support.js";',
      'const t = await import("./fake.test-support.js");',
      'const t = require("./fake.test-support.js");',
      'type T = typeof import("./fake.test-support.js");',
      '/// <reference path="fake.test-support.ts" />',
    ]) {
      expect(check(PRODUCTION, source), source).toEqual([expect.stringContaining(SUPPORT)]);
    }
  });

  it("passes test support imported by a test, by test support and by an entry", () => {
    for (const [file, specifier] of [
      ["packages/deck-adapter-mirabox/src/adapter.test.ts", "./fake.test-support.js"],
      ["packages/deck-adapter-mirabox/src/adapter.test.ts", "../test-support/foo.js"],
      ["packages/deck-adapter-mirabox/src/fake.test-support.ts", "./other.test-support.js"],
      ["packages/deck-adapter-mirabox/src/test-support/fake-host.ts", "./clock.js"],
      ["packages/deck-core/src/testing.ts", "./hold-preview.test-support.js"],
    ]) {
      expect(check(file, `import { fake } from "${specifier}";`), `${file} → ${specifier}`).toEqual([]);
    }
  });

  it("passes a production import whose name only resembles test support", () => {
    const source = [
      'import { a } from "./test-supported.js";',
      'import { b } from "./fake.test-supports.js";',
      'import { c } from "./test-support-free.js";',
      'import { d } from "./testing-helpers.js";',
      'import { e } from "../latest.js";',
      'import { f } from "@iracedeck/audio-service";',
      '// import { g } from "./fake.test-support.js";',
      'const s = "./fake.test-support.js";',
    ].join("\n");

    expect(check(PRODUCTION, source)).toEqual([]);
  });

  it("refuses a test-support import planted in a real production source", () => {
    const { file, source } = read("packages/iracing-actions/src/actions/fuel-service/fuel-service.ts");
    const planted = `import { pressShape } from "../../shared/press-shape.test-support.js";\n${source}`;

    expect(productionTestingImports({ files: [{ file, source: planted }], entrySources: ENTRY_SOURCES })).toEqual([
      expect.stringContaining(
        `${file} imports ../../shared/press-shape.test-support.js (packages/iracing-actions/src/shared/press-shape.test-support.js)`,
      ),
    ]);
  });

  it("refuses an entry import planted in a real production source", () => {
    const { file, source } = read("packages/iracing-actions/src/actions/fuel-service/fuel-service.ts");
    const planted = `import { IconUpdateThrottle } from "@iracedeck/deck-core/testing";\n${source}`;

    expect(productionTestingImports({ files: [{ file, source }], entrySources: ENTRY_SOURCES })).toEqual([]);
    expect(productionTestingImports({ files: [{ file, source: planted }], entrySources: ENTRY_SOURCES })).toEqual([
      expect.stringContaining(`${file} imports @iracedeck/deck-core/testing`),
    ]);
  });

  it("maps a dist export to its source and takes a source export as it is", () => {
    expect(
      testingEntrySource("deck-core", {
        exports: { "./testing": { import: "./dist/testing.js", types: "./dist/testing.d.ts" } },
      }),
    ).toBe("packages/deck-core/src/testing.ts");
    expect(testingEntrySource("pi-components", { exports: { "./testing": "./src/build/testing.ts" } })).toBe(
      "packages/pi-components/src/build/testing.ts",
    );
    expect(testingEntrySource("logger", { exports: { ".": "./dist/index.js" } })).toBeUndefined();
  });
});
