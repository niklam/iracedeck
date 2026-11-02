/**
 * Every deck adapter runs deck-core's per-context ordering contract suite (#1597).
 *
 * The lifecycle ordering — an appear settles before the disappear for the same
 * context starts, input waits for lifecycle, events for a context not on the
 * device are dropped — holds only for an adapter whose dispatch goes through
 * deck-core's ordering primitive. `@iracedeck/deck-core/testing` ships the rules
 * as `CONTEXT_EVENT_ORDER_SCENARIOS`; this guard keeps every adapter running
 * them, so a fourth deck ecosystem cannot ship an adapter that skips the
 * primitive with nothing red. Design record:
 * docs/superpowers/specs/2026-11-02-issue-1597-lifecycle-event-ordering.md, decision 6.
 *
 * An adapter package is every `packages/deck-adapter-*` package, plus every
 * package with a non-test source file that declares a class implementing
 * `IDeckPlatformAdapter` — read from the syntax tree, so a mention in a comment
 * neither adds a package nor hides one. One file is exempt by path:
 * `scenario-harness/src/mock-platform-adapter.ts`, whose `registerAction`
 * registers nothing, so no event ever reaches a handler to be ordered. The
 * exemption is that file, not its package: a second adapter in scenario-harness
 * is checked like any other.
 *
 * "Runs the suite" means one of the package's test files — selected by the root
 * `vitest.config.ts`'s own `include` / `exclude`, so only a file the suite really
 * collects counts — has both of these, also read from the syntax tree:
 *
 * - a value import of `CONTEXT_EVENT_ORDER_SCENARIOS` (aliasing allowed) from
 *   `@iracedeck/deck-core/testing`; a type-only import, a namespace import or the
 *   same name from another module does not count;
 * - a run of that binding that registers tests: `it.each(S)(…)`, `test.each(S)(…)`
 *   or `describe.each(S)(…)` — optionally through `.concurrent` / `.sequential` —
 *   or a `for (… of S)` loop or an `S.forEach(…)` whose body registers an
 *   `it` / `test` / `describe`. A run under `skip`, `todo`, `skipIf` or `runIf`,
 *   on itself or on any enclosing `describe`, does not count, and a commented-out
 *   one is not in the tree at all.
 *
 * The discovery and the check are one function, `orderContractProblems(root)`,
 * run against the real `packages/` and against fixture workspaces built in a
 * temporary directory (never under `packages/`, which is the pnpm workspace): one
 * planted adapter WITHOUT the suite that it must report and one WITH it that it
 * must pass, so neither direction is vacuous.
 */
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import rootConfig from "../vitest.config.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

const SUITE_MODULE = "@iracedeck/deck-core/testing";
const SUITE_EXPORT = "CONTEXT_EVENT_ORDER_SCENARIOS";
const ADAPTER_INTERFACE = "IDeckPlatformAdapter";
const ADAPTER_FOLDER_PREFIX = "deck-adapter-";

/** Relative to `packages/`: adapters exempt by file, each with its reason in the header above. */
const EXEMPT_ADAPTER_FILES = ["scenario-harness/src/mock-platform-adapter.ts"];

/** The three host adapters the repo ships today; discovery must find each, or a broken glob passes vacuously. */
const KNOWN_ADAPTER_FOLDERS = ["deck-adapter-elgato", "deck-adapter-mirabox", "deck-adapter-ulanzi"];

const RUNNERS = new Set(["it", "test", "describe"]);
/** Modifiers a registering `.each` may pass through. */
const RUN_MODIFIERS = new Set(["concurrent", "sequential"]);
/** Modifiers that keep a test, or everything under a `describe`, from running. */
const DISABLING_MODIFIERS = new Set(["skip", "todo", "skipIf", "runIf"]);

// The root config's own lists, read rather than copied (as package-test-scripts.test.mjs does):
// a test file counts only when `pnpm test` would collect it.
const { include, exclude } = rootConfig.test;
const PACKAGE_PREFIX = "packages/*/";
const TEST_GLOBS = include.filter((g) => g.startsWith(PACKAGE_PREFIX)).map((g) => g.slice(PACKAGE_PREFIX.length));

function toPosix(file) {
  return file.split(path.sep).join("/");
}

function parse(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Calls `visit` on every node of the tree. */
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** The test files of `packages/<folder>` the root vitest config collects, as package-relative posix paths. */
function testFiles(packagesRoot, folder) {
  return globSync(TEST_GLOBS, { cwd: path.join(packagesRoot, folder) })
    .map(toPosix)
    .filter((f) => !exclude.some((g) => path.posix.matchesGlob(`packages/${folder}/${f}`, g)))
    .sort();
}

/** Whether the source declares a class that implements `IDeckPlatformAdapter` (also through a namespace, `core.IDeckPlatformAdapter`). */
function declaresAdapter(file, source) {
  if (!source.includes(ADAPTER_INTERFACE)) return false;
  let found = false;
  walk(parse(file, source), (node) => {
    if (found || !(ts.isClassDeclaration(node) || ts.isClassExpression(node))) return;
    for (const clause of node.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
      for (const type of clause.types) {
        const expr = type.expression;
        const name = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : null;
        if (name === ADAPTER_INTERFACE) found = true;
      }
    }
  });

  return found;
}

/** The local names a file binds `CONTEXT_EVENT_ORDER_SCENARIOS` to through a value import from the testing subpath. */
function suiteBindings(sourceFile) {
  const names = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== SUITE_MODULE) continue;
    const clause = statement.importClause;
    if (
      !clause ||
      clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    )
      continue;
    for (const element of clause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      if ((element.propertyName ?? element.name).text === SUITE_EXPORT) names.push(element.name.text);
    }
  }

  return names;
}

/** `it.concurrent.each` → ["it", "concurrent", "each"]; null when the callee is not a plain identifier chain. */
function calleeChain(expr) {
  const names = [];
  let node = expr;
  while (ts.isPropertyAccessExpression(node)) {
    names.unshift(node.name.text);
    node = node.expression;
  }
  if (!ts.isIdentifier(node)) return null;
  names.unshift(node.text);

  return names;
}

/**
 * The chain of the runner a call registers through, looking through one call
 * layer so `describe.skipIf(cond)(…)` and `it.each(rows)(…)` read as
 * ["describe", "skipIf"] and ["it", "each"]; null when the call is no runner.
 */
function runnerChain(call) {
  const callee = ts.isCallExpression(call.expression) ? call.expression.expression : call.expression;
  const chain = calleeChain(callee);

  return chain && RUNNERS.has(chain[0]) ? chain : null;
}

/** Whether the node sits under a skipped, todo or conditional runner. */
function isDisabled(node) {
  for (let up = node.parent; up; up = up.parent) {
    if (!ts.isCallExpression(up)) continue;
    const chain = runnerChain(up);
    if (chain?.some((name) => DISABLING_MODIFIERS.has(name))) return true;
  }

  return false;
}

/** Whether the subtree registers an enabled `it` / `test` / `describe`. */
function registersTests(node) {
  let found = false;
  walk(node, (inner) => {
    if (found || !ts.isCallExpression(inner)) return;
    const chain = runnerChain(inner);
    if (chain && !chain.some((name) => DISABLING_MODIFIERS.has(name)) && !isDisabled(inner)) found = true;
  });

  return found;
}

/** Whether `node` is one of the accepted runs of a suite binding (see the header). */
function isSuiteRun(node, bindings) {
  const isBinding = (expr) => expr !== undefined && ts.isIdentifier(expr) && bindings.includes(expr.text);

  // `it.each(S)(name, fn)`: the inner call names the binding, the outer one registers the tests.
  if (ts.isCallExpression(node) && isBinding(node.arguments[0])) {
    const chain = calleeChain(node.expression);
    const registered = ts.isCallExpression(node.parent) && node.parent.expression === node;
    if (
      registered &&
      chain &&
      RUNNERS.has(chain[0]) &&
      chain.at(-1) === "each" &&
      chain.slice(1, -1).every((name) => RUN_MODIFIERS.has(name))
    ) {
      return !isDisabled(node.parent);
    }
  }

  // `for (const scenario of S) { it(…) }`
  if (ts.isForOfStatement(node) && isBinding(node.expression)) {
    return registersTests(node.statement) && !isDisabled(node);
  }

  // `S.forEach((scenario) => it(…))`
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "forEach" &&
    isBinding(node.expression.expression)
  ) {
    return node.arguments.some((arg) => registersTests(arg)) && !isDisabled(node);
  }

  return false;
}

/**
 * What one test file does with the suite: whether it imports it and whether it
 * runs it. Called directly by the tests below, so each accepted and refused
 * form is pinned on its own.
 */
function suiteUse(file, source) {
  const sourceFile = parse(file, source);
  const bindings = suiteBindings(sourceFile);
  if (bindings.length === 0) return { imports: false, runs: false };
  let runs = false;
  walk(sourceFile, (node) => {
    if (!runs && isSuiteRun(node, bindings)) runs = true;
  });

  return { imports: true, runs };
}

/**
 * Every adapter package under `<root>/packages` and what it is missing.
 *
 * @returns {{ adapters: { folder: string, name: string, adapterFiles: string[] }[], exemptFound: string[], problems: string[] }}
 */
function orderContractProblems(root) {
  const packagesRoot = path.join(root, "packages");
  const adapters = [];
  const exemptFound = [];

  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    const folder = entry.name;
    const dir = path.join(packagesRoot, folder);
    if (!entry.isDirectory() || !existsSync(path.join(dir, "package.json"))) continue;

    const adapterFiles = [];
    const tests = new Set(testFiles(packagesRoot, folder));
    for (const file of globSync("src/**/*.ts", { cwd: dir }).map(toPosix).sort()) {
      if (file.endsWith(".d.ts") || file.endsWith(".test.ts") || tests.has(file)) continue;
      if (!declaresAdapter(file, readFileSync(path.join(dir, file), "utf8"))) continue;
      if (EXEMPT_ADAPTER_FILES.includes(`${folder}/${file}`)) exemptFound.push(`${folder}/${file}`);
      else adapterFiles.push(file);
    }
    if (!folder.startsWith(ADAPTER_FOLDER_PREFIX) && adapterFiles.length === 0) continue;

    const { name } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    adapters.push({ folder, name: name ?? folder, adapterFiles });
  }

  const problems = [];
  for (const { folder, name } of adapters) {
    const uses = testFiles(packagesRoot, folder).map((file) => ({
      file,
      ...suiteUse(file, readFileSync(path.join(packagesRoot, folder, file), "utf8")),
    }));
    if (uses.some((use) => use.imports && use.runs)) continue;
    const importing = uses.filter((use) => use.imports).map((use) => use.file);
    problems.push(
      importing.length === 0
        ? `${name} (packages/${folder}): no test file imports ${SUITE_EXPORT} from ${SUITE_MODULE}`
        : `${name} (packages/${folder}): ${importing.join(", ")} imports ${SUITE_EXPORT} but never runs it ` +
            "(it/test/describe.each(…)(…), or a for…of / forEach that registers it/test/describe, none of it skipped)",
    );
  }

  return { adapters, exemptFound, problems };
}

// ---------------------------------------------------------------------------
// Fixtures

const ADAPTER_SOURCE = [
  `import type { IDeckPlatformAdapter } from "@iracedeck/deck-core";`,
  ``,
  `export class FixtureAdapter implements ${ADAPTER_INTERFACE} {}`,
  ``,
].join("\n");

const RUNS_SUITE = [
  `import { ${SUITE_EXPORT} } from "${SUITE_MODULE}";`,
  `import { describe, it } from "vitest";`,
  ``,
  `describe("ordering contract", () => {`,
  `  it.each(${SUITE_EXPORT})("$name", async (scenario) => {`,
  `    await scenario.run(harness);`,
  `  });`,
  `});`,
  ``,
].join("\n");

const NO_SUITE = [
  `import { describe, expect, it } from "vitest";`,
  ``,
  `describe("adapter", () => {`,
  `  it("constructs", () => {`,
  `    expect(true).toBe(true);`,
  `  });`,
  `});`,
  ``,
].join("\n");

const tempRoots = [];

/** A fixture workspace: `{ "<folder>": { "src/x.ts": "…" } }` → `<tmp>/packages/<folder>/…`, each with a package.json. */
function fixtureWorkspace(packages) {
  const root = mkdtempSync(path.join(tmpdir(), "deck-adapter-order-contract-"));
  tempRoots.push(root);
  for (const [folder, files] of Object.entries(packages)) {
    const all = { "package.json": JSON.stringify({ name: `@fixture/${folder}` }), ...files };
    for (const [file, content] of Object.entries(all)) {
      const target = path.join(root, "packages", folder, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }

  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** A test file around one statement, with the suite imported (optionally under another import line). */
function testFile(body, importLine = `import { ${SUITE_EXPORT} } from "${SUITE_MODULE}";`) {
  return [importLine, `import { describe, it, test } from "vitest";`, ``, body, ``].join("\n");
}

// ---------------------------------------------------------------------------

describe("every deck adapter runs the ordering contract suite (#1597)", () => {
  it("understands the root vitest config's package test globs", () => {
    expect(TEST_GLOBS.length).toBeGreaterThan(0);
  });

  describe("what counts as running the suite", () => {
    const S = SUITE_EXPORT;

    it.each([
      ["it.each", `it.each(${S})("$name", (s) => s.run(h));`],
      ["test.each", `test.each(${S})("$name", (s) => s.run(h));`],
      ["describe.each", `describe.each(${S})("$name", (s) => { it("holds", () => s.run(h)); });`],
      ["it.concurrent.each", `it.concurrent.each(${S})("$name", (s) => s.run(h));`],
      ["inside a describe", `describe("order", () => { it.each(${S})("$name", (s) => s.run(h)); });`],
      ["a for…of loop registering it", `for (const s of ${S}) { it(s.name, () => s.run(h)); }`],
      ["a forEach registering test", `${S}.forEach((s) => test(s.name, () => s.run(h)));`],
      [
        "an aliased import",
        `it.each(SCENARIOS)("$name", (s) => s.run(h));`,
        `import { ${S} as SCENARIOS } from "${SUITE_MODULE}";`,
      ],
    ])("accepts %s", (_label, body, importLine) => {
      expect(suiteUse("x.test.ts", testFile(body, importLine))).toEqual({ imports: true, runs: true });
    });

    it.each([
      ["a commented-out run", `// it.each(${S})("$name", (s) => s.run(h));`],
      ["a run inside a string", `const text = "it.each(${S})('$name', (s) => s.run(h))";`],
      ["it.each never invoked", `it.each(${S});`],
      ["it.skip.each", `it.skip.each(${S})("$name", (s) => s.run(h));`],
      ["it.todo", `it.todo("${S}");`],
      ["a run under describe.skip", `describe.skip("order", () => { it.each(${S})("$name", (s) => s.run(h)); });`],
      [
        "a run under describe.skipIf",
        `describe.skipIf(true)("order", () => { it.each(${S})("$name", (s) => s.run(h)); });`,
      ],
      ["a for…of loop registering nothing", `for (const s of ${S}) { void s; }`],
      ["a for…of loop registering only it.skip", `for (const s of ${S}) { it.skip(s.name, () => s.run(h)); }`],
      ["a mere reference", `const count = ${S}.length;`],
    ])("refuses %s", (_label, body) => {
      expect(suiteUse("x.test.ts", testFile(body))).toEqual({ imports: true, runs: false });
    });

    it.each([
      ["a type-only import", `import type { ${S} } from "${SUITE_MODULE}";`],
      ["a type-only specifier", `import { type ${S} } from "${SUITE_MODULE}";`],
      ["the name from the deck-core barrel", `import { ${S} } from "@iracedeck/deck-core";`],
      ["a namespace import", `import * as ordering from "${SUITE_MODULE}";`],
      ["another export of the subpath", `import { OTHER } from "${SUITE_MODULE}";`],
    ])("does not count %s as importing the suite", (_label, importLine) => {
      const body = `it.each(${S})("$name", (s) => s.run(h));`;

      expect(suiteUse("x.test.ts", testFile(body, importLine))).toEqual({ imports: false, runs: false });
    });

    it("finds the interface in an implements list, through a namespace, and not in a comment", () => {
      expect(declaresAdapter("a.ts", `class A implements Other, ${ADAPTER_INTERFACE} {}`)).toBe(true);
      expect(declaresAdapter("a.ts", `class A implements core.${ADAPTER_INTERFACE} {}`)).toBe(true);
      expect(declaresAdapter("a.ts", `// class A implements ${ADAPTER_INTERFACE} {}\nclass A {}`)).toBe(false);
      expect(declaresAdapter("a.ts", `class A extends ${ADAPTER_INTERFACE} {}`)).toBe(false);
    });
  });

  describe("planted controls", () => {
    it("reports an adapter package without the suite and passes one that runs it", () => {
      const root = fixtureWorkspace({
        "deck-adapter-without": { "src/adapter.ts": ADAPTER_SOURCE, "src/adapter.test.ts": NO_SUITE },
        "deck-adapter-with": { "src/adapter.ts": ADAPTER_SOURCE, "src/adapter.test.ts": RUNS_SUITE },
        "not-an-adapter": { "src/index.ts": `export const x = 1;\n`, "src/index.test.ts": NO_SUITE },
      });
      const { adapters, problems } = orderContractProblems(root);

      expect(adapters.map((a) => a.folder).sort()).toEqual(["deck-adapter-with", "deck-adapter-without"]);
      expect(problems).toEqual([
        `@fixture/deck-adapter-without (packages/deck-adapter-without): no test file imports ${SUITE_EXPORT} from ${SUITE_MODULE}`,
      ]);
    });

    it("reports a deck-adapter-* package by its folder even when no source declares the interface", () => {
      const root = fixtureWorkspace({ "deck-adapter-bare": { "src/index.ts": `export const x = 1;\n` } });

      expect(orderContractProblems(root).problems).toEqual([
        `@fixture/deck-adapter-bare (packages/deck-adapter-bare): no test file imports ${SUITE_EXPORT} from ${SUITE_MODULE}`,
      ]);
    });

    it("finds an adapter outside deck-adapter-* by its implements clause", () => {
      const root = fixtureWorkspace({
        "host-shell": { "src/host.ts": ADAPTER_SOURCE, "src/host.test.ts": NO_SUITE },
      });
      const { adapters, problems } = orderContractProblems(root);

      expect(adapters).toEqual([{ folder: "host-shell", name: "@fixture/host-shell", adapterFiles: ["src/host.ts"] }]);
      expect(problems).toHaveLength(1);
    });

    it("names a file that imports the suite but never runs it", () => {
      const root = fixtureWorkspace({
        "deck-adapter-half": {
          "src/adapter.ts": ADAPTER_SOURCE,
          "src/adapter.test.ts": testFile(`it.skip.each(${SUITE_EXPORT})("$name", (s) => s.run(h));`),
        },
      });

      expect(orderContractProblems(root).problems).toEqual([
        expect.stringMatching(
          new RegExp(`^@fixture/deck-adapter-half \\(packages/deck-adapter-half\\): src/adapter\\.test\\.ts imports`),
        ),
      ]);
    });

    it("does not count a run outside a file the root vitest config collects", () => {
      const root = fixtureWorkspace({
        "deck-adapter-stray": { "src/adapter.ts": ADAPTER_SOURCE, "test/adapter.test.ts": RUNS_SUITE },
      });

      expect(orderContractProblems(root).problems).toHaveLength(1);
    });

    it("exempts the scenario harness's mock adapter by file, not its whole package", () => {
      const exemptOnly = fixtureWorkspace({
        "scenario-harness": { "src/mock-platform-adapter.ts": ADAPTER_SOURCE },
      });
      const withSecond = fixtureWorkspace({
        "scenario-harness": {
          "src/mock-platform-adapter.ts": ADAPTER_SOURCE,
          "src/second-adapter.ts": ADAPTER_SOURCE,
        },
      });

      expect(orderContractProblems(exemptOnly)).toMatchObject({
        adapters: [],
        exemptFound: ["scenario-harness/src/mock-platform-adapter.ts"],
        problems: [],
      });
      expect(orderContractProblems(withSecond)).toMatchObject({
        adapters: [{ folder: "scenario-harness", adapterFiles: ["src/second-adapter.ts"] }],
        problems: [expect.stringContaining("@fixture/scenario-harness (packages/scenario-harness)")],
      });
    });
  });

  describe("the real workspace", () => {
    const real = orderContractProblems(ROOT);

    it("discovers every shipped host adapter (an empty list would pass every check vacuously)", () => {
      expect(real.adapters.map((a) => a.folder)).toEqual(expect.arrayContaining(KNOWN_ADAPTER_FOLDERS));
      for (const folder of KNOWN_ADAPTER_FOLDERS) {
        expect(real.adapters.find((a) => a.folder === folder)?.adapterFiles).toEqual(["src/adapter.ts"]);
      }
    });

    it("still finds each exempt file declaring the interface, so no exemption outlives its file", () => {
      expect(real.exemptFound).toEqual(EXEMPT_ADAPTER_FILES);
    });

    it("every adapter package runs CONTEXT_EVENT_ORDER_SCENARIOS", () => {
      expect(real.problems).toEqual([]);
    });
  });
});
