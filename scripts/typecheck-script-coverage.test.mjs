import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// scripts/typecheck-script-coverage.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// `join` yields the platform separator while tsc reports forward slashes, so both
// sides of every path comparison below go through this.
const toPosix = (p) => p.split(sep).join("/");

// Packages that deliberately have no `typecheck` script, and why. An entry here
// is a decision on the record; an absence from the list is a failure. That is the
// difference between an exclusion and a hole — a new package cannot join this
// list by being forgotten.
//
// It is EMPTY, and the machinery stays anyway. #1078 closed the last four
// entries: `website` now runs `astro check` (#1077), and `iracing-actions`,
// `audio-assets` and `icons` all gained a tsconfig. Emptiness is a current fact
// about this repo, not a reason to delete the list — the assertion below is what
// makes the next package that tries to skip the gate say so out loud instead of
// being skipped in silence by `turbo run typecheck`.
const NO_TYPECHECK_SCRIPT = new Map([]);

// Packages whose `typecheck` runs but does NOT cover their own test files, with
// the size of what each is hiding. An exception that states its own magnitude and
// its own expiry condition is a debt with a maturity date; one that says "excluded,
// see docs" is where things go to be forgotten.
const TYPECHECK_EXCLUDES_TESTS = new Map([
  [
    "iracing-actions",
    'tsconfig sets "exclude": ["src/**/*.test.ts"]. Its 84 sources ARE checked (#1078); its 76 ' +
      "test files are not. Removing the exclusion surfaced 541 errors when measured on 2026-09-01 — " +
      "386 TS2345 (partial settings literals passed where the full parsed settings type is required) " +
      "and 70 TS2445 (tests reaching protected members) dominate, across 34 files. Tracked in #1078. " +
      "NOTE: that count is a dated measurement, not an invariant — the assertion below only checks " +
      "that SOME test file is still excluded, so nothing here re-verifies the number. It is recorded " +
      "to size the remaining work, and it is dated so it cannot quietly become false.",
  ],
]);

// Resolve a tsconfig the way tsc does, rather than pattern-matching its `exclude`
// array: `parseJsonConfigFileContent` applies the same include/exclude/files
// semantics the compiler will, so this reports what is genuinely in the program.
// A config this cannot resolve must THROW, never degrade to a default. An empty
// config object makes `parseJsonConfigFileContent` fall back to "every .ts under
// basePath", which would report every test file as covered — so a broken tsconfig
// would turn this check green precisely when something is wrong. Measured: a
// tsconfig with a bad `extends` gave 47 passed before this guard was added.
function filesInProgram(packageName) {
  const dir = toPosix(join(repoRoot, "packages", packageName));
  const configPath = `${dir}/tsconfig.json`;
  const { config, error } = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, "utf-8"));
  if (error || !config) {
    const detail = error ? ts.flattenDiagnosticMessageText(error.messageText, " ") : "no config object";
    throw new Error(`${configPath} could not be parsed: ${detail}`);
  }
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dir);
  if (parsed.errors.length > 0) {
    const detail = parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ");
    throw new Error(`${configPath} did not resolve cleanly: ${detail}`);
  }
  return new Set(parsed.fileNames.map(toPosix));
}

// `.tsx` is matched too. Nothing in the repo uses it today, but a package whose
// only sources were `.tsx` would otherwise be invisible to the guard — the same
// silent escape this whole file exists to prevent, one file extension along.
const isTypeScriptSource = (name) =>
  (name.endsWith(".ts") && !name.endsWith(".d.ts")) || (name.endsWith(".tsx") && !name.endsWith(".d.tsx"));
const isTestFile = (name) => name.endsWith(".test.ts") || name.endsWith(".test.tsx");

function testFilesOnDisk(absDir, found = []) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
    if (entry.isDirectory()) testFilesOnDisk(join(absDir, entry.name), found);
    else if (isTestFile(entry.name)) found.push(toPosix(join(absDir, entry.name)));
  }
  return found;
}

function readJson(relPath) {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf-8"));
}

// Discovery is keyed on "has TypeScript at all", NOT on "has a tsconfig.json".
// Keying it on the tsconfig was the obvious shortcut and it let three packages
// escape the guard entirely rather than appear as exclusions — `iracing-actions`
// most importantly, whose 76 test files nothing checks. A package with no config
// is exactly the one at risk, so it must show up here and be answered for.
function hasTypeScriptSources(absDir) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
    if (entry.isDirectory()) {
      if (hasTypeScriptSources(join(absDir, entry.name))) return true;
    } else if (isTypeScriptSource(entry.name)) {
      return true;
    }
  }
  return false;
}

const typeScriptPackages = readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    // Evaluate BOTH operands, then combine — never write this as `a || b`.
    // Short-circuiting here has produced this file's own bug twice. With
    // `existsSync` first, `hasTypeScriptSources` never ran once every package
    // had a tsconfig, so the function this guard calls "the key" was dead.
    // Swapping the operands only MOVED the dead one, because today every
    // package also has TypeScript sources — measured, zero packages lack them.
    // Eager evaluation makes operand-deadness impossible by construction
    // instead of resting on an ordering a later edit could innocently reverse.
    const hasSources = hasTypeScriptSources(join(repoRoot, "packages", name));
    const hasConfig = existsSync(join(repoRoot, "packages", name, "tsconfig.json"));
    // `hasConfig` decides nothing today, and is kept deliberately: it is what
    // would find a package carrying a tsconfig and no `.ts` at all — an
    // all-`.astro` package, or one shipping only `.d.ts`. A real future shape,
    // not dead weight.
    return hasSources || hasConfig;
  })
  .sort();

// First invariant (#987): every package that has TypeScript at all is in the gate —
// either by carrying a `typecheck` script, or by being a named exclusion above.
//
// Why it is worth a test. `turbo run typecheck` skips a package with no such script
// **silently** — no error, no warning, exit 0. So coverage can shrink to nothing
// while the gate still reports success, which is the same class of defect #987
// exists to close: a green signal that means less than it appears to. The natural
// way to add a package is to copy an existing one, and copying a package's shape
// without its script is exactly how one slips out of the gate.
//
// Discovery deliberately does NOT key on `tsconfig.json`. That was the first
// version and it let three packages escape entirely rather than appear as
// exclusions, `iracing-actions` among them — a package with no config is precisely
// the one at risk, so it has to show up here and be answered for.
describe("every package with TypeScript is covered by pnpm typecheck", () => {
  it("finds the packages to check", () => {
    expect(typeScriptPackages.length).toBeGreaterThan(0);
  });

  // Discovery's own smoke test. Every package currently has a tsconfig, so the
  // `||` above can no longer reach a package that `hasTypeScriptSources` alone
  // would have to find — which means a regression in it (an extra prune, an
  // inverted return) would shrink coverage back with every test still green.
  // Pin both directions against a package that has TypeScript and a tracked
  // directory that has none.
  it("discovers TypeScript by looking for it, not by trusting a tsconfig", () => {
    expect(hasTypeScriptSources(join(repoRoot, "packages", "logger"))).toBe(true);
    // The negative case is drawn from OUTSIDE `packages/`, which is honest but
    // worth stating: no package qualifies any more, so there is no in-domain
    // example to use, and this exercises the code path rather than the domain.
    // It would also go false the day anyone adds a `.ts` under `.github` — if
    // that happens, move it to a fixture rather than deleting the assertion.
    expect(hasTypeScriptSources(join(repoRoot, ".github"))).toBe(false);
  });

  it("has no stale allow-list entries", () => {
    const stale = [...NO_TYPECHECK_SCRIPT.keys()].filter((name) => !typeScriptPackages.includes(name));
    expect(
      stale,
      `NO_TYPECHECK_SCRIPT names ${stale.join(", ")}, which no longer exists as a TypeScript ` +
        `package. An entry that matches nothing is not an exclusion, it is a comment — remove it.`,
    ).toEqual([]);
  });

  it.each(typeScriptPackages)("has a typecheck script: %s", (name) => {
    const scripts = readJson(`packages/${name}/package.json`).scripts ?? {};
    const excused = NO_TYPECHECK_SCRIPT.get(name);

    if (excused) {
      // Guard the exclusion in both directions: once the package can be checked,
      // this should fail so the allow-list entry is removed rather than outliving
      // the reason it was added.
      expect(
        scripts.typecheck,
        `${name} is listed in NO_TYPECHECK_SCRIPT (${excused}) but now HAS a typecheck ` +
          `script. Remove it from the allow-list — the exclusion has outlived its reason.`,
      ).toBeUndefined();
      return;
    }

    const hasTsconfig = existsSync(join(repoRoot, "packages", name, "tsconfig.json"));
    expect(
      scripts.typecheck,
      `packages/${name} has TypeScript sources but no "typecheck" script, so \`pnpm typecheck\` ` +
        `skips it silently and it is not covered by the gate (#987). ` +
        (hasTsconfig
          ? `Add "typecheck": "tsc --noEmit -p tsconfig.json".`
          : `It has no tsconfig.json either, so it needs one before it can be checked.`) +
        ` Or add it to NO_TYPECHECK_SCRIPT with a reason if it genuinely cannot be checked.`,
    ).toBeDefined();
  });
});

// Second invariant, same concern as the first (#987): coverage that appears
// complete and is not. The first catches a package the gate never runs on; this
// catches one the gate runs on while checking none of its tests — `typecheck`
// present, reported covered, and the test files not in the program at all.
describe("a package's typecheck covers its own test files", () => {
  const checkable = typeScriptPackages.filter(
    (name) => !NO_TYPECHECK_SCRIPT.has(name) && existsSync(join(repoRoot, "packages", name, "tsconfig.json")),
  );

  it("has no stale test-exclusion entries", () => {
    const stale = [...TYPECHECK_EXCLUDES_TESTS.keys()].filter((name) => !checkable.includes(name));
    expect(stale, `TYPECHECK_EXCLUDES_TESTS names ${stale.join(", ")}, which is no longer checkable.`).toEqual([]);
  });

  it.each(checkable)("checks every test file it ships: %s", (name) => {
    const onDisk = testFilesOnDisk(join(repoRoot, "packages", name));
    if (onDisk.length === 0) return;

    const inProgram = filesInProgram(name);
    const missing = onDisk.filter((f) => !inProgram.has(f)).map((f) => f.slice(repoRoot.length + 1));
    const excused = TYPECHECK_EXCLUDES_TESTS.get(name);

    if (excused) {
      // Reverse direction: once the package stops excluding its tests, this entry
      // must fail rather than quietly outliving the reason it was added.
      expect(
        missing.length,
        `${name} is listed in TYPECHECK_EXCLUDES_TESTS (${excused}) but now checks every test ` +
          `file it ships. Remove the entry — the exception has outlived its reason.`,
      ).toBeGreaterThan(0);
      return;
    }

    expect(
      missing,
      `packages/${name} has a typecheck script, so the coverage guard above reports it covered — ` +
        `but its tsconfig leaves ${missing.length} of its own test files out of the program, so ` +
        `\`pnpm typecheck\` checks none of them: ${missing.join(", ")}. Presence of a script is not ` +
        `coverage. Remove the exclusion, or add the package to TYPECHECK_EXCLUDES_TESTS with the ` +
        `number of errors the exclusion is hiding.`,
    ).toEqual([]);
  });
});
