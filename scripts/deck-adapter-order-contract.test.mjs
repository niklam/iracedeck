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
 * package with a non-test source file that produces an `IDeckPlatformAdapter`:
 * a class implementing it, or a factory or object literal typed as it through
 * `satisfies`, `as`, an annotated variable, class property or parameter default
 * whose value is made right there, or a return type on a function that returns
 * a value it makes (`adapterForms` lists the forms and why a bare annotation —
 * a consumer receiving an adapter — does not count). Test sources are left out:
 * test files and test support (`*.test-support.ts`, `test-support/`,
 * `__fixtures__/`, `__tests__/`), where adapter doubles live. Everything is read
 * from the syntax tree, so a mention in a comment neither adds a package nor
 * hides one. One file is exempt by path:
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
/** Directories whose sources are test code, wherever they sit under `src/`. */
const TEST_SUPPORT_DIRS = new Set(["test-support", "__fixtures__", "__tests__"]);

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

/**
 * Whether a package-relative source path is test code: a test file, or test
 * support — a `*.test-support.ts` file or anything under a `test-support/`,
 * `__fixtures__/` or `__tests__/` directory. Test support builds adapter doubles
 * (plugin-runtime's `test-support/fake-host.ts`, deck-core's reference adapters)
 * that are not adapters a host runs.
 */
function isTestSource(file) {
  return (
    file.endsWith(".test.ts") ||
    file.endsWith(".test-support.ts") ||
    file.split("/").some((segment) => TEST_SUPPORT_DIRS.has(segment))
  );
}

/** The last name of `X`, `ns.X` (an expression) or `ns.X` (a type name); null for anything else. */
function lastName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isQualifiedName(node)) return node.right.text;

  return null;
}

/**
 * Whether a type node names the adapter interface (or a same-file interface or
 * alias of it, in `names`): `X`, `ns.X`, `(X)`, a union with `X` as a member,
 * and — when `unwrapPromise` — `Promise<X>`, an async factory's return type.
 * `Pick<X, …>` and other partial views are not the interface.
 */
function namesAdapter(type, names, unwrapPromise = false) {
  if (!type) return false;
  if (ts.isParenthesizedTypeNode(type)) return namesAdapter(type.type, names, unwrapPromise);
  if (ts.isUnionTypeNode(type)) return type.types.some((member) => namesAdapter(member, names, unwrapPromise));
  if (!ts.isTypeReferenceNode(type)) return false;
  const name = lastName(type.typeName);
  if (names.has(name)) return true;

  return unwrapPromise && name === "Promise" && namesAdapter(type.typeArguments?.[0], names);
}

/**
 * Whether an expression makes a new value right there — an object literal, a
 * class expression or a `new` — rather than passing on one made elsewhere (an
 * identifier, a property read, a call). Looks through parentheses, `!`, `await`,
 * `as` / `satisfies` / `<T>`, both branches of `?:` and both sides of `??` /
 * `||` / `&&`. What a call returns is decided where the callee is declared, by
 * its own return type, so a call is never "made here".
 */
function makesValue(expr) {
  if (!expr) return false;
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isAwaitExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    return makesValue(expr.expression);
  }
  if (ts.isConditionalExpression(expr)) return makesValue(expr.whenTrue) || makesValue(expr.whenFalse);
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return makesValue(expr.left) || makesValue(expr.right);
    }
  }

  return ts.isObjectLiteralExpression(expr) || ts.isClassExpression(expr) || ts.isNewExpression(expr);
}

/** Whether a function-like with a body returns a value it makes (see `makesValue`); nested functions and classes are their own. */
function returnsMadeValue(fn) {
  if (!fn.body) return false;
  if (!ts.isBlock(fn.body)) return makesValue(fn.body);
  let found = false;
  const visit = (node) => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) && makesValue(node.expression)) found = true;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);

  return found;
}

/**
 * The names this file uses for the adapter interface: `IDeckPlatformAdapter`,
 * plus every interface in the file that extends one of them and every type
 * alias that is one of them, to a fixed point. Same-file only: an alias
 * imported from another file is not followed.
 */
function adapterTypeNames(sourceFile) {
  const names = new Set([ADAPTER_INTERFACE]);
  for (let grew = true; grew;) {
    grew = false;
    walk(sourceFile, (node) => {
      if (!(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) || names.has(node.name.text)) return;
      const isAdapter = ts.isInterfaceDeclaration(node)
        ? (node.heritageClauses ?? []).some((clause) => clause.types.some((t) => names.has(lastName(t.expression))))
        : namesAdapter(node.type, names);
      if (isAdapter) {
        names.add(node.name.text);
        grew = true;
      }
    });
  }

  return names;
}

/**
 * The forms by which a source file produces an adapter, sorted and unique; empty
 * when it produces none. Producing, not consuming: a parameter or an interface
 * property typed as the adapter receives one made elsewhere, so a bare
 * annotation does not count — only one whose value is made right there.
 *
 * - `implements` — a class whose `implements` clause names the interface;
 * - `satisfies` — `expr satisfies IDeckPlatformAdapter`;
 * - `as` — `expr as IDeckPlatformAdapter` or `<IDeckPlatformAdapter>expr`. A cast
 *   is never checked structurally, so it is how a value becomes an adapter
 *   without `implements`; code holding a real one never needs it;
 * - `variable`, `property`, `parameter default` — an annotation of the interface
 *   on a variable, a class property or a parameter whose initializer makes a
 *   value (`makesValue`);
 * - `return type` — a function, method or arrow annotated to return the
 *   interface (or a `Promise` of it) that returns a value it makes. A getter, or
 *   a method handing back a stored field, returns one made elsewhere.
 */
function adapterForms(file, source) {
  if (!source.includes(ADAPTER_INTERFACE)) return [];
  const sourceFile = parse(file, source);
  const names = adapterTypeNames(sourceFile);
  const forms = new Set();
  walk(sourceFile, (node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const implementsAdapter = (node.heritageClauses ?? []).some(
        (clause) =>
          clause.token === ts.SyntaxKind.ImplementsKeyword &&
          clause.types.some((t) => names.has(lastName(t.expression))),
      );
      if (implementsAdapter) forms.add("implements");
    } else if (ts.isSatisfiesExpression(node) && namesAdapter(node.type, names)) {
      forms.add("satisfies");
    } else if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && namesAdapter(node.type, names)) {
      forms.add("as");
    } else if (ts.isVariableDeclaration(node) && namesAdapter(node.type, names) && makesValue(node.initializer)) {
      forms.add("variable");
    } else if (ts.isPropertyDeclaration(node) && namesAdapter(node.type, names) && makesValue(node.initializer)) {
      forms.add("property");
    } else if (ts.isParameter(node) && namesAdapter(node.type, names) && makesValue(node.initializer)) {
      forms.add("parameter default");
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)) &&
      namesAdapter(node.type, names, true) &&
      returnsMadeValue(node)
    ) {
      forms.add("return type");
    }
  });

  return [...forms].sort();
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
      if (file.endsWith(".d.ts") || isTestSource(file) || tests.has(file)) continue;
      if (adapterForms(file, readFileSync(path.join(dir, file), "utf8")).length === 0) continue;
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

const ADAPTER_IMPORT = `import type { ${ADAPTER_INTERFACE} } from "@iracedeck/deck-core";`;
const LITERAL = `{ registerAction() {} }`;

/** [label, a source producing an adapter in exactly one form, that form] — one row per form `adapterForms` accepts. */
const PRODUCER_FORMS = [
  ["a class implementing it", ADAPTER_SOURCE, "implements"],
  ["satisfies", `${ADAPTER_IMPORT}\nexport const adapter = ${LITERAL} satisfies ${ADAPTER_INTERFACE};\n`, "satisfies"],
  ["a cast", `${ADAPTER_IMPORT}\nexport const adapter = ${LITERAL} as ${ADAPTER_INTERFACE};\n`, "as"],
  [
    "a double cast",
    `${ADAPTER_IMPORT}\nexport const adapter = sdk as unknown as ${ADAPTER_INTERFACE};\ndeclare const sdk: object;\n`,
    "as",
  ],
  ["an angle-bracket cast", `${ADAPTER_IMPORT}\nexport const adapter = <${ADAPTER_INTERFACE}>${LITERAL};\n`, "as"],
  [
    "an annotated variable",
    `${ADAPTER_IMPORT}\nexport const adapter: ${ADAPTER_INTERFACE} = ${LITERAL};\n`,
    "variable",
  ],
  [
    "an annotated variable through a same-file interface extending it",
    `${ADAPTER_IMPORT}\ninterface HostAdapter extends ${ADAPTER_INTERFACE} { readonly kind: "x" }\nexport const adapter: HostAdapter = { kind: "x", registerAction() {} };\n`,
    "variable",
  ],
  [
    "an annotated variable through a same-file alias",
    `${ADAPTER_IMPORT}\ntype Host = ${ADAPTER_INTERFACE};\nexport const adapter: Host = new HostImpl();\ndeclare class HostImpl {}\n`,
    "variable",
  ],
  [
    "an annotated class property",
    `${ADAPTER_IMPORT}\nexport class Plugin {\n  readonly adapter: ${ADAPTER_INTERFACE} = ${LITERAL};\n}\n`,
    "property",
  ],
  [
    "a parameter default",
    `${ADAPTER_IMPORT}\nexport function start(adapter: ${ADAPTER_INTERFACE} = ${LITERAL}): void {\n  void adapter;\n}\n`,
    "parameter default",
  ],
  [
    "a factory's return type",
    `${ADAPTER_IMPORT}\nexport function createAdapter(): ${ADAPTER_INTERFACE} {\n  return ${LITERAL};\n}\n`,
    "return type",
  ],
  [
    "an arrow factory's return type",
    `${ADAPTER_IMPORT}\nexport const createAdapter = (): ${ADAPTER_INTERFACE} => (${LITERAL});\n`,
    "return type",
  ],
  [
    "an async factory's Promise return type",
    `${ADAPTER_IMPORT}\nexport async function createAdapter(): Promise<${ADAPTER_INTERFACE}> {\n  return ${LITERAL};\n}\n`,
    "return type",
  ],
  [
    "a method's return type, built conditionally",
    `${ADAPTER_IMPORT}\nexport class Factory {\n  create(flag: boolean): ${ADAPTER_INTERFACE} | undefined {\n    return flag ? ${LITERAL} : undefined;\n  }\n}\n`,
    "return type",
  ],
];

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
  });

  describe("what counts as producing an adapter", () => {
    it.each(PRODUCER_FORMS)("finds %s", (_label, source, form) => {
      expect(adapterForms("host.ts", source)).toEqual([form]);
    });

    it.each([
      ["an implements list with another interface", `class A implements Other, ${ADAPTER_INTERFACE} {}`],
      ["a namespaced interface", `class A implements core.${ADAPTER_INTERFACE} {}`],
      ["a class expression", `export const A = class implements ${ADAPTER_INTERFACE} {};`],
    ])("finds implements through %s", (_label, source) => {
      expect(adapterForms("host.ts", source)).toEqual(["implements"]);
    });

    it.each([
      ["a parameter (a consumer)", `export function init(adapter: ${ADAPTER_INTERFACE}): void { void adapter; }`],
      ["an interface property", `export interface Deps { readonly adapter: ${ADAPTER_INTERFACE}; }`],
      [
        "a constructor parameter property and a getter handing it back",
        `export class Holder {\n  constructor(private readonly adapter: ${ADAPTER_INTERFACE}) {}\n  get current(): ${ADAPTER_INTERFACE} { return this.adapter; }\n}`,
      ],
      ["a variable holding a call's result", `export const adapter: ${ADAPTER_INTERFACE} = createAdapter();`],
      [
        "a function handing back a field",
        `export function pick(deps: Deps): ${ADAPTER_INTERFACE} { return deps.adapter; }`,
      ],
      ["a method signature with no body", `export interface Factory { create(): ${ADAPTER_INTERFACE}; }`],
      [
        "a partial view through Pick",
        `type Narrow = Pick<${ADAPTER_INTERFACE}, "registerAction">;\nexport const n: Narrow = { registerAction() {} };`,
      ],
      ["a commented-out class", `// class A implements ${ADAPTER_INTERFACE} {}\nclass A {}`],
      ["a class extending the name", `class A extends ${ADAPTER_INTERFACE} {}`],
    ])("does not count %s", (_label, source) => {
      expect(adapterForms("host.ts", source)).toEqual([]);
    });

    it.each([
      ["src/adapter.test.ts", true],
      ["src/fake-host.test-support.ts", true],
      ["src/replay-engine-reset.coverage.test-support.ts", true],
      ["src/test-support/fake-host.ts", true],
      ["src/nested/test-support/fake.ts", true],
      ["src/__fixtures__/adapter.ts", true],
      ["src/__tests__/adapter.ts", true],
      ["src/adapter.ts", false],
      ["src/test-supportive.ts", false],
      ["src/support/adapter.ts", false],
    ])("treats %s as test source: %s", (file, expected) => {
      expect(isTestSource(file)).toBe(expected);
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

    it.each(PRODUCER_FORMS)(
      "reports a package whose only adapter is %s, when it has no suite run",
      (_label, source) => {
        const root = fixtureWorkspace({
          "host-shell": { "src/host.ts": source, "src/host.test.ts": NO_SUITE },
        });

        expect(orderContractProblems(root)).toMatchObject({
          adapters: [{ folder: "host-shell", adapterFiles: ["src/host.ts"] }],
          problems: [
            `@fixture/host-shell (packages/host-shell): no test file imports ${SUITE_EXPORT} from ${SUITE_MODULE}`,
          ],
        });
      },
    );

    it("passes a factory-built adapter whose package runs the suite", () => {
      const factory = PRODUCER_FORMS.find(([label]) => label === "a factory's return type")[1];
      const root = fixtureWorkspace({
        "host-shell": { "src/host.ts": factory, "src/host.test.ts": RUNS_SUITE },
      });

      expect(orderContractProblems(root)).toMatchObject({ adapters: [{ folder: "host-shell" }], problems: [] });
    });

    it("never discovers an adapter double in test support, in any producing form", () => {
      const [, variable] = PRODUCER_FORMS.find(([label]) => label === "an annotated variable");
      const [, cast] = PRODUCER_FORMS.find(([label]) => label === "a cast");
      const root = fixtureWorkspace({
        "plugin-host": {
          "src/index.ts": `export const x = 1;\n`,
          "src/test-support/fake-host.ts": variable,
          "src/fake-host.test-support.ts": cast,
          "src/__fixtures__/adapter.ts": ADAPTER_SOURCE,
          "src/index.test.ts": NO_SUITE,
        },
      });

      expect(orderContractProblems(root)).toEqual({ adapters: [], exemptFound: [], problems: [] });
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
