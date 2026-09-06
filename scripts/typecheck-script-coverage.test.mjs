import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
//
// It is EMPTY too, and for the same reason the list above stays. #1078 closed its
// last entry: `iracing-actions` had excluded its 76 test files, hiding 541 errors
// across 34 of them (measured 2026-09-01, and again unchanged on 2026-09-06 before
// the fix) — 386 of them partial settings literals handed to functions typed with
// the full parsed settings, 70 of them tests reaching protected members through
// the real class type. Every one was in test code; the fix touched no production
// signature. Two assertions below share the work: the forward one fails a
// `tsc -p` package the moment its program leaves a test file out, naming this
// Map as the place to declare what the exclusion hides, and the reverse one is
// what retired this entry the moment the exclusion went. With both Maps empty
// the reverse branch is dormant, and the whole guarantee rests on
// `testFilesOnDisk` finding the files — an empty walk returns early instead of
// failing — which is why the walker has a smoke test of its own further down.
// Nothing here re-verifies the 541; it is a dated measurement, kept because it
// sizes what the gate was missing.
const TYPECHECK_EXCLUDES_TESTS = new Map([]);

// Resolve a tsconfig the way tsc does, rather than pattern-matching its `exclude`
// array: `parseJsonConfigFileContent` applies the same include/exclude/files
// semantics the compiler will, so this reports what is genuinely in the program.
// A config this cannot resolve must THROW, never degrade to a default. An empty
// config object makes `parseJsonConfigFileContent` fall back to "every .ts under
// basePath", which would report every test file as covered — so a broken tsconfig
// would turn this check green precisely when something is wrong. Measured: a
// tsconfig with a bad `extends` gave 47 passed before this guard was added.
function filesInProgram(packageName, configRelPath) {
  const dir = toPosix(join(repoRoot, "packages", packageName));
  const configPath = `${dir}/${configRelPath}`;
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

// The script this guard vouches for, PARSED rather than assumed (#1086).
//
// The guard's claim is about `pnpm typecheck`; what it could previously verify
// was a `tsconfig.json` it picked by hardcoded filename. Those are different
// claims and nothing connected them: a package adopting `tsconfig.typecheck.json`
// would be reported fully covered while its script checked a different file set,
// and a script running a tool that is not `tsc` at all would be reported covered
// on the strength of a config it never names.
//
// Worth recording what was true when this was written, because it explains why
// the defect was invisible: every `typecheck` script in the repo was byte-identical
// `tsc --noEmit -p tsconfig.json`, so the old inference could not be wrong
// anywhere. The premise was unfalsifiable rather than verified, and #1077 created
// the first counter-example by giving the website `pnpm generate:gallery && astro check`.
//
// Returns the config to verify against, or the reason it cannot be derived — in
// which case the caller must MEASURE rather than infer (see the probe below).
// Deliberately conservative: only a single-command `tsc` invocation is derivable.
// A chained script is not, even when one segment is `tsc`, because an earlier
// segment can generate source files that the compiler includes at runtime and a
// static parse of the config cannot see.
// `tsc` flags that consume the NEXT token as their value. Anything absent from
// this set is treated as boolean, so its value would look like a positional file
// and force a refusal — an unrecognised shape falls to tier 2 and gets MEASURED
// rather than guessed at. Omissions here therefore cost a slow check, never a
// wrong claim, which is the direction this list has to be wrong in.
const TSC_VALUE_FLAGS = new Set([
  "-p",
  "--project",
  "-o",
  "--outFile",
  "--outDir",
  "--rootDir",
  "--rootDirs",
  "--declarationDir",
  "--tsBuildInfoFile",
  "-t",
  "--target",
  "-m",
  "--module",
  "--moduleResolution",
  "--lib",
  "--types",
  "--typeRoots",
  "--baseUrl",
  "--jsxFactory",
  "--jsxFragmentFactory",
  "--jsxImportSource",
  "--newLine",
  "--locale",
  "--plugins",
]);

// Flags that make `tsc` report success WITHOUT type-checking, or that change the
// invocation into something other than a check. Deriving a config for one of
// these would report a package covered on the strength of a run that checks
// nothing — the defect this whole file is about, wearing a compiler flag.
//
// Measured on 5.9.3 with a real type error present in the program:
//   tsc --noEmit -p tsconfig.json                 -> exit 2, 1 error
//   tsc --noEmit --noCheck -p tsconfig.json       -> exit 0, 0 errors
//   tsc --noEmit --listFilesOnly -p tsconfig.json -> exit 0, 0 errors
//
// These refuse to derive rather than throwing, so they fall to tier 2 and get
// MEASURED — where the probe correctly fails to be caught and the guard reports
// the coverage as genuinely absent. Refusing here diagnoses itself; a hard error
// would only say the parser was unhappy.
const TSC_SUPPRESSING_FLAGS = new Set([
  "--noCheck",
  "--listFilesOnly",
  "--showConfig",
  "--init",
  "--help",
  "-h",
  "--version",
  "-v",
  "--build",
  "-b",
]);

// Boolean `tsc` flags this parser will vouch for: each one leaves type-checking
// of the program intact, so a config parsed alongside it still describes what
// the run checks. Kept deliberately short. An unlisted flag is REFUSED, not
// assumed harmless — see the allow-list reasoning at the refusal below.
const TSC_SAFE_BOOLEAN_FLAGS = new Set([
  "--noEmit",
  "--noEmitOnError",
  "--pretty",
  "--noErrorTruncation",
  "--skipLibCheck",
  "--strict",
  "--incremental",
  "--composite",
  "--declaration",
  "--emitDeclarationOnly",
  "--sourceMap",
  "--declarationMap",
  "--listEmittedFiles",
  "--explainFiles",
  "--diagnostics",
  "--extendedDiagnostics",
  "--traceResolution",
]);

export function deriveTypecheckConfig(script) {
  const segments = script
    .split("&&")
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length !== 1) {
    return { derivable: false, reason: `it chains ${segments.length} commands, so a static parse cannot stand in` };
  }

  const tokens = segments[0].split(/\s+/).filter(Boolean);
  if (tokens[0] !== "tsc") {
    return { derivable: false, reason: `it runs \`${tokens[0]}\`, whose file set is not this config's to state` };
  }

  let configPath = null;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.startsWith("--project=")) {
      const value = token.slice("--project=".length);
      if (!value) return { derivable: false, reason: "`--project=` carries no config path" };
      configPath = value;
      continue;
    }

    if (TSC_SUPPRESSING_FLAGS.has(token)) {
      return {
        derivable: false,
        reason: `it passes \`${token}\`, so the run does not type-check what the config contains`,
      };
    }

    if (token.startsWith("-")) {
      if (TSC_VALUE_FLAGS.has(token)) {
        const value = tokens[i + 1];
        if (value === undefined || value.startsWith("-")) {
          return { derivable: false, reason: `\`${token}\` is not followed by a value` };
        }
        if (token === "-p" || token === "--project") configPath = value;
        i++; // the value belongs to this flag, not to the file list
        continue;
      }

      if (TSC_SAFE_BOOLEAN_FLAGS.has(token)) continue;

      // Everything else is refused, and this being an ALLOW-list is the point.
      // The previous version accepted any unrecognised `-flag` as a harmless
      // boolean, which is why `--noCheck` was caught only because somebody named
      // it — a suppressing flag nobody has thought of yet would have passed the
      // same way. The parser was blocklist-shaped in exactly the half where
      // nothing downstream trips: an unknown VALUE flag was already refused, but
      // only by accident, because its value then read as a positional file. A
      // boolean has no value to trip that, so it has to be refused deliberately.
      //
      // An unlisted flag now costs a tier-2 measurement, never a wrong claim.
      // Adding one to TSC_SAFE_BOOLEAN_FLAGS is a claim that it does not
      // suppress checking — establish that the way the suppressing ones were
      // established, by injecting a type error and confirming the run still
      // fails, rather than from the flag's name.
      return {
        derivable: false,
        reason: `it passes \`${token}\`, which this parser cannot vouch for as leaving type-checking intact`,
      };
    }

    // A positional argument, and it is disqualifying: when input files are given
    // on the command line, tsc IGNORES tsconfig.json entirely. Measured on 5.9.3
    // — `tsc --noEmit src/index.ts --listFiles` compiles `src/index.ts` alone and
    // leaves `src/index.test.ts` out of the program, while `-p tsconfig.json`
    // includes it. Returning `tsconfig.json` here would verify a config the
    // script never loads, which is this file's own defect committed by its fix.
    return {
      derivable: false,
      reason: `it passes \`${token}\` positionally, and tsc ignores tsconfig.json when given input files`,
    };
  }

  // `tsc` with no project flag resolves `tsconfig.json` from the working
  // directory. That is documented, stable compiler behaviour, so naming it here
  // is a derivation rather than the assumption this change exists to remove.
  return { derivable: true, configPath: configPath ?? "tsconfig.json" };
}

function typecheckScriptOf(name) {
  return readJson(`packages/${name}/package.json`).scripts?.typecheck;
}

// How long a single real typecheck script may take. This is enforced by
// `spawnSync`, NOT by the Vitest test timeout below: Vitest cannot interrupt a
// synchronous `spawnSync`, so a hung script would block the worker until the CI
// job limit and the test-level timeout would be decorative. Generous against the
// ~8.5s a real `astro check` run takes.
const SCRIPT_TIMEOUT_MS = 120_000;

// Run a package's REAL typecheck script — directly through pnpm, deliberately
// NOT through turbo. `turbo run typecheck --filter=…` is cached: measured, a
// second invocation returns exit 0 in 599ms with `cache hit, replaying logs`
// without running `astro check` at all. The clean run is the exposure, since
// nothing about it is novel, and a replayed exit 0 is not evidence that the
// script passes. A cached green would be this guard's own failure mode arriving
// through the back door, so the invocation must stay direct.
//
// `shell: true` because pnpm is a `.cmd` shim on Windows; the arguments are
// fixed literals, so nothing user-supplied reaches the shell.
function runTypecheck(cwd) {
  const result = spawnSync("pnpm", ["run", "typecheck"], {
    cwd,
    encoding: "utf-8",
    shell: true,
    timeout: SCRIPT_TIMEOUT_MS,
    // Default is 1 MiB. A truncated capture would fail the marker assertions for
    // a reason other than the one they report — the exact confusion this file is
    // about, one layer down.
    maxBuffer: 32 * 1024 * 1024,
  });

  // A spawn failure (or a timeout kill) leaves `status` null and both streams
  // empty, which would otherwise be reported as "the workspace is not built".
  // Surface the cause so the message names what actually happened.
  const failure = result.error ? `\n[spawn failed] ${result.error.message}` : "";
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}${failure}` };
}

// Named so its purpose is unmistakable in a `git status` listing: an orphaned
// probe means a run crashed between writing and deleting it. It is untracked, so
// it can never modify existing content — `git status --porcelain` stays a
// trustworthy contamination signal, which is what it is used for around here.
// `vitest.config.ts` excludes this exact filename so an orphan is never collected.
const PROBE_BASENAME = "__typecheck_coverage_probe__.test.ts";

// The probe's types are string literals carrying distinctive markers, so a
// checker that rejects it must quote them in its own diagnostic:
//
//   error ts(2322): Type '"__ird_probe_actual__"' is not assignable to
//                   type '"__ird_probe_expected__"'.
//
// That is what lets the assertion below require evidence the checker PARSED AND
// UNDERSTOOD the file rather than merely listed its path — a tool echoing its
// input file list produces the filename and cannot produce the markers.
//
// It binds to no tool's output format: not error codes, not `line:col`, not a
// file count. It relies only on a checker having to DESCRIBE a mismatch to be
// useful, and with literal types the literal values ARE the types. A checker
// that reported errors without naming types would turn this red rather than
// green, which is the direction a wrong assumption here has to fail in.
const PROBE_EXPECTED_MARKER = "__ird_probe_expected__";
const PROBE_ACTUAL_MARKER = "__ird_probe_actual__";

const PROBE_SOURCE = `// TEMPORARY file written by scripts/typecheck-script-coverage.test.mjs.
// It is deleted in a \`finally\`. If you are reading this in your working tree,
// that run crashed — delete it. It is untracked and means nothing on its own.
const probe: "${PROBE_EXPECTED_MARKER}" = "${PROBE_ACTUAL_MARKER}";
export default probe;
`;

// Two runs of a real typecheck, so this has to clear BOTH `SCRIPT_TIMEOUT_MS`
// budgets plus pnpm's start-up, or the outer timeout could fire while an inner
// one was still doing its job and report the wrong failure. Measured
// 2026-09-01: ~8.5s per `astro check` run on a built tree.
const PROBE_TIMEOUT_MS = 2 * SCRIPT_TIMEOUT_MS + 60_000;

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

// Discovery takes a package that has TypeScript sources OR a `tsconfig.json` —
// a union, so neither alone is required. Precision matters here because the
// earlier wording ("keyed on has-TypeScript-at-all, NOT on has-a-tsconfig")
// described an exclusion the code never implemented. What is true is the point
// it was reaching for: lacking a tsconfig is not an escape route. Keying
// discovery on the config ALONE was the obvious shortcut and it let three
// packages escape entirely rather than appear as exclusions — `iracing-actions`
// most importantly, whose 76 test files nothing checked. A package with no
// config is exactly the one at risk, so it must show up here and be answered
// for; the config arm then catches the opposite shape, a package configured but
// carrying no `.ts` of its own.
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

  // The walker's own smoke test (#1078). Once every package checks every test
  // file, `testFilesOnDisk` is the only thing the per-package assertion still
  // depends on: its callers return early on an empty result, so a regression
  // that made it find nothing — a prune name too many, a filter inverted — would
  // let a test exclusion come back with the suite green. Two plugin packages
  // legitimately take that early return today, so an empty result raises no
  // eyebrow on its own. Pin the positive against a package whose tests it must
  // find, and the pruning against the one directory that would otherwise flood
  // the result.
  it("finds a package's test files without descending into what it must skip", () => {
    const found = testFilesOnDisk(join(repoRoot, "packages", "iracing-actions"));
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain(toPosix(join(repoRoot, "packages", "iracing-actions", "src", "actions", "comms-catalog.test.ts")));
    expect(found.filter((f) => f.includes("/node_modules/") || f.includes("/dist/") || f.includes("/build/"))).toEqual([]);
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
// Since #1086 the claim is bound to the SCRIPT rather than to a hardcoded
// filename, and it is established one of exactly two ways.
//
// Where the script is a plain `tsc -p <config>`, that config is parsed. Cheap,
// and faithful: measured against `tsc --listFiles` on 2026-09-01,
// `parseJsonConfigFileContent` reports exactly the in-package file set the
// compiler really loads, so running the compiler here would buy no fidelity.
//
// Where the script is anything else, nothing about its file set can be inferred
// from a config it never names — so the guard MEASURES, by running the real
// script and proving by effect that a test-shaped file is checked.
//
// There is deliberately no third way. A "checked by something else" allow-list
// was considered and rejected: it would have asserted that `astro check` covers
// the website's test files on nobody's authority, which is verification-shaped
// while still inferring — the exact defect this file exists to remove.
describe("a package's typecheck covers its own test files", () => {
  const checkable = typeScriptPackages.filter(
    (name) => !NO_TYPECHECK_SCRIPT.has(name) && typecheckScriptOf(name) !== undefined,
  );

  const derivable = checkable.filter((name) => deriveTypecheckConfig(typecheckScriptOf(name)).derivable);
  const measured = checkable.filter((name) => !deriveTypecheckConfig(typecheckScriptOf(name)).derivable);

  it("has no stale test-exclusion entries", () => {
    const stale = [...TYPECHECK_EXCLUDES_TESTS.keys()].filter((name) => !checkable.includes(name));
    expect(stale, `TYPECHECK_EXCLUDES_TESTS names ${stale.join(", ")}, which is no longer checkable.`).toEqual([]);
  });

  it("splits every checkable package into exactly one of the two ways", () => {
    expect(
      [...derivable, ...measured].sort(),
      "a package must be either statically derivable or measured — neither silently dropped nor counted twice",
    ).toEqual([...checkable].sort());
  });

  it.each(derivable)("checks every test file it ships: %s", (name) => {
    const onDisk = testFilesOnDisk(join(repoRoot, "packages", name));
    if (onDisk.length === 0) return;

    const script = typecheckScriptOf(name);
    const { configPath } = deriveTypecheckConfig(script);
    const inProgram = filesInProgram(name, configPath);
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
        `but the config that script actually names (${configPath}, from \`${script}\`) leaves ` +
        `${missing.length} of its own test files out of the program, so \`pnpm typecheck\` checks ` +
        `none of them: ${missing.join(", ")}. Presence of a script is not coverage. Remove the ` +
        `exclusion, or add the package to TYPECHECK_EXCLUDES_TESTS with the number of errors the ` +
        `exclusion is hiding.`,
    ).toEqual([]);
  });

  // Registered only when something needs it, because `it.each([])` is an error
  // rather than a no-op. On a repo where every script is a plain `tsc -p`, this
  // block correctly disappears.
  if (measured.length > 0) {
    // The case list carries the refusal reason so the test's own NAME says why
    // this package took the expensive path. `TSC_VALUE_FLAGS` is deliberately
    // incomplete (see above), so a package can move from derived to measured by
    // someone adding a flag it does not list — and the only other symptom would
    // be `pnpm test` getting ~8.5s slower with nothing saying why. Naming the
    // reason cannot rot the way a pinned list of expected-measured packages
    // would when a second legitimately non-`tsc` package arrives.
    it.each(measured.map((name) => ({ name, why: deriveTypecheckConfig(typecheckScriptOf(name)).reason })))(
      "proves coverage by running its own typecheck: $name (not statically derivable: $why)",
      ({ name }) => {
        const pkgDir = join(repoRoot, "packages", name);
        const onDisk = testFilesOnDisk(pkgDir);
        if (onDisk.length === 0) return;

        const script = typecheckScriptOf(name);
        const { reason } = deriveTypecheckConfig(script);

        // Side one. The script must pass on an unmodified tree. Without this,
        // "the tool ignores test files" and "the workspace is not built" are the
        // same non-zero exit, and the guard would confidently report the wrong
        // one — this issue's own defect reappearing inside its fix.
        const clean = runTypecheck(pkgDir);
        expect(
          clean.status,
          `packages/${name}'s typecheck (\`${script}\`) does not pass on an unmodified tree, so its ` +
            `coverage is UNPROVEN rather than absent — this is not a coverage failure. The usual ` +
            `cause is an unbuilt workspace: run \`pnpm build\`, then \`pnpm test\` again. Output:\n` +
            clean.output,
        ).toBe(0);

        // Side two. With a test-shaped file that cannot possibly typecheck, it
        // must fail — AND the output must name the probe. An exit code alone
        // cannot tell "the probe was checked and failed" from "something else
        // failed", and a guard that cannot tell those apart is the thing being
        // fixed here rather than the fix.
        //
        // The probe goes beside a real test file so it is picked up exactly the
        // way a test file is. Placed anywhere else it would prove a weaker claim
        // than the one this block makes.
        //
        // Known limit, stated rather than papered over: this proves a test-shaped
        // file in that directory is checked. It does not enumerate every test
        // file the way the derivable branch does, so a config excluding
        // individual tests by name could still pass here.
        const probePath = onDisk[0].replace(/\/[^/]+$/, `/${PROBE_BASENAME}`);

        // This test writes a file into the repository and deletes it again, so
        // prove the target is inside the package BEFORE either happens. Today
        // `testFilesOnDisk` only ever returns paths under `pkgDir`, so this
        // cannot fire — which is the point: if that stops being true, the failure
        // should be a loud assertion rather than a write, and a delete, somewhere
        // else in the tree.
        const pkgPrefix = `${toPosix(pkgDir)}/`;
        expect(
          probePath.startsWith(pkgPrefix),
          `refusing to write the probe: ${probePath} is not inside ${pkgPrefix}`,
        ).toBe(true);

        try {
          writeFileSync(probePath, PROBE_SOURCE);
          const probed = runTypecheck(pkgDir);

          expect(
            probed.status,
            `packages/${name} runs \`${script}\`, which cannot be statically derived (${reason}), so ` +
              `coverage has to be proven by effect. A file that cannot typecheck was placed beside ` +
              `its own tests at ${probePath.slice(repoRoot.length + 1)} and the script still passed — ` +
              `so whatever it runs is NOT checking files shaped like this package's tests, and a ` +
              `green \`pnpm typecheck\` says nothing about them.`,
          ).not.toBe(0);

          expect(
            probed.output,
            `packages/${name}'s typecheck failed with the probe in place, but its output never names ` +
              `${PROBE_BASENAME} — so the failure cannot be attributed to the probe and proves ` +
              `nothing about coverage. Output:\n${probed.output}`,
          ).toContain(PROBE_BASENAME);

          // Naming the file is not enough on its own: a tool that echoed its
          // input file list would satisfy it while having checked nothing. The
          // markers only appear if the checker read the probe's types and
          // described the mismatch, so requiring them is the difference between
          // "the probe was listed" and "the probe was understood".
          for (const marker of [PROBE_EXPECTED_MARKER, PROBE_ACTUAL_MARKER]) {
            expect(
              probed.output,
              `packages/${name}'s typecheck named ${PROBE_BASENAME} but its output never quotes ` +
                `${marker}, which a checker rejecting the probe's type mismatch would have to. ` +
                `So the run saw the file without demonstrably checking it — that is not proof of ` +
                `coverage. Output:\n${probed.output}`,
            ).toContain(marker);
          }
        } finally {
          rmSync(probePath, { force: true });
        }
      },
      PROBE_TIMEOUT_MS,
    );
  }
});

// The derivation is the load-bearing half of #1086 and it runs against real
// scripts only for the shapes this repo happens to use today — every one of them
// a plain `tsc -p`. These pin the shapes it must keep getting right, including
// the two that must FAIL to derive, since a derivation that never refuses would
// silently return to inferring.
describe("deriveTypecheckConfig", () => {
  it("derives the config a plain tsc invocation names", () => {
    expect(deriveTypecheckConfig("tsc --noEmit -p tsconfig.json")).toEqual({
      derivable: true,
      configPath: "tsconfig.json",
    });
  });

  it("derives a non-default config filename", () => {
    expect(deriveTypecheckConfig("tsc --noEmit -p tsconfig.typecheck.json")).toEqual({
      derivable: true,
      configPath: "tsconfig.typecheck.json",
    });
  });

  it("accepts both spellings of the project flag", () => {
    expect(deriveTypecheckConfig("tsc --project build.json").configPath).toBe("build.json");
    expect(deriveTypecheckConfig("tsc --project=build.json").configPath).toBe("build.json");
  });

  it("resolves bare tsc to the config the compiler itself would load", () => {
    expect(deriveTypecheckConfig("tsc --noEmit")).toEqual({ derivable: true, configPath: "tsconfig.json" });
  });

  it("refuses a tool it cannot reason about", () => {
    const result = deriveTypecheckConfig("astro check");
    expect(result.derivable).toBe(false);
    expect(result.reason).toContain("astro");
  });

  it("refuses a chained script even when one segment is tsc", () => {
    // An earlier segment can generate sources the compiler will include at
    // runtime, which a static parse of the config cannot see.
    expect(deriveTypecheckConfig("pnpm generate:gallery && tsc -p tsconfig.json").derivable).toBe(false);
  });

  it("refuses a project flag with no path rather than guessing one", () => {
    expect(deriveTypecheckConfig("tsc --noEmit -p").derivable).toBe(false);
    expect(deriveTypecheckConfig("tsc --noEmit -p --pretty").derivable).toBe(false);
  });

  // Measured on TypeScript 5.9.3: `tsc --noEmit src/index.ts --listFiles`
  // compiles that file alone and leaves `src/index.test.ts` out of the program,
  // while `-p tsconfig.json` includes it. So defaulting to `tsconfig.json` for a
  // script with positional inputs would verify a config the script never loads.
  // Measured on 5.9.3 with a real type error in the program: `-p tsconfig.json`
  // exits 2 with 1 error, while `--noCheck` and `--listFilesOnly` both exit 0
  // with 0 errors. Deriving a config for either would report a package covered
  // on the strength of a run that checks nothing.
  it.each(["--noCheck", "--listFilesOnly", "--showConfig", "--build"])(
    "refuses %s, which makes tsc report success without type-checking",
    (flag) => {
      const result = deriveTypecheckConfig(`tsc --noEmit ${flag} -p tsconfig.json`);
      expect(result.derivable).toBe(false);
      expect(result.reason).toContain(flag);
    },
  );

  it("refuses positional file arguments, which make tsc ignore tsconfig.json", () => {
    const result = deriveTypecheckConfig("tsc --noEmit src/index.ts");
    expect(result.derivable).toBe(false);
    expect(result.reason).toContain("positionally");
  });

  it("does not mistake a value-taking flag's value for a positional file", () => {
    expect(deriveTypecheckConfig("tsc --noEmit --outDir dist -p tsconfig.json")).toEqual({
      derivable: true,
      configPath: "tsconfig.json",
    });
  });

  // An unrecognised flag is treated as boolean, so its value reads as positional
  // and the script is refused. That is the safe direction: an omission from
  // TSC_VALUE_FLAGS costs a slow tier-2 measurement, never a wrong claim.
  it("refuses rather than guesses when a flag it does not know takes a value", () => {
    expect(deriveTypecheckConfig("tsc --noEmit --someFutureFlag value -p tsconfig.json").derivable).toBe(false);
  });

  // The parser is allow-list shaped for BOOLEANS too, which is the structural
  // half. An unknown value-flag was already refused, but only incidentally —
  // its value read as a positional file. A boolean has no value to trip that, so
  // an unrecognised one used to pass silently, which is why `--noCheck` was
  // caught only because a reviewer named it rather than by the design.
  it("refuses an unknown boolean flag rather than assuming it is harmless", () => {
    const result = deriveTypecheckConfig("tsc --noEmit --someFutureBooleanFlag -p tsconfig.json");
    expect(result.derivable).toBe(false);
    expect(result.reason).toContain("--someFutureBooleanFlag");
  });

  it("still derives the shape every package in this repo actually uses", () => {
    expect(deriveTypecheckConfig("tsc --noEmit -p tsconfig.json")).toEqual({
      derivable: true,
      configPath: "tsconfig.json",
    });
  });
});
