import { readFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import * as testing from "./testing.js";
import {
  createTsconfigProgram,
  createVirtualProgram,
  isFunctionValue,
  lineOf,
  unwrap,
} from "./ts-source-scan.test-support.js";

/**
 * The main barrel is the production surface (#1502): what a production source
 * outside the engine imports and no more, with the types its functions take or
 * return. This file holds it to that in three sections, each with planted
 * positive controls:
 *
 * - no test hook (`_`-prefixed name) on it, since a hook there is one
 *   production code can call; the hooks live on `@iracedeck/replay-engine/testing`;
 * - every engine type an exported signature names is exported (#1502);
 * - "and no more" (#1661): every value is imported by name by a production
 *   source outside the engine, and every type is too unless a signature
 *   reaches it (a contract type); production imports the barrel by name only.
 *
 * The testing entry imports `vitest`, so a production source that imports it
 * would pull the test runner into the plugin bundle; the root guard
 * `scripts/testing-entries-test-only.test.mjs` holds every package's
 * `./testing` entry to that (#1375).
 */

/** A test hook's name: `_resetReplayCursor`, `_configureReplayEngine`, `_activeLapPress`. */
function testHooksIn(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith("_"));
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
});

/**
 * What the signature-type scan found: the barrel's exported names that carry a
 * signature, each engine type a signature names that the barrel does not
 * export, with the exports whose signatures name it, and the barrel's own
 * exported names that some signature names (its contract types).
 */
interface SignatureTypeScan {
  readonly signatures: readonly string[];
  readonly missing: ReadonlyMap<string, readonly string[]>;
  readonly named: ReadonlySet<string>;
}

/** `symbol` itself, or what it stands for when it is an import or re-export. */
function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/**
 * The type annotations of each signature an export declares: a function's
 * overloads and implementation, a const whose initializer is a function, and
 * a const's own type annotation. Type-parameter constraints and defaults count,
 * since a caller must satisfy them.
 */
function signatureAnnotations(declaration: ts.Declaration): ts.TypeNode[] | undefined {
  const ofSignature = (signature: ts.SignatureDeclaration): ts.TypeNode[] =>
    [
      ...(signature.typeParameters ?? []).flatMap((parameter) => [parameter.constraint, parameter.default]),
      ...signature.parameters.map((parameter) => parameter.type),
      signature.type,
    ].filter((node): node is ts.TypeNode => node !== undefined);

  if (ts.isFunctionDeclaration(declaration)) return ofSignature(declaration);

  if (!ts.isVariableDeclaration(declaration)) return undefined;

  if (declaration.type !== undefined) return [declaration.type];

  const initializer = declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);

  return initializer !== undefined && isFunctionValue(initializer) ? ofSignature(initializer) : undefined;
}

/**
 * The barrel's contract rule (#1502, the header of `index.ts`): it exports
 * every type a function it exports takes or returns. For each exported
 * function and typed const of `barrelPath` in `program`, every type reference
 * in its parameter, return, type-parameter or const annotations — walked
 * through unions, generics, `Promise<…>`, object members and callback types —
 * that resolves to a declaration in the barrel's own directory must be
 * exported by the barrel itself. Type parameters are skipped, and so are
 * types from other packages and the lib.
 *
 * One level deep, by design: the members of a type the signature names are
 * not followed, so a type only reachable through another exported type's
 * fields is not required here.
 *
 * It also reports the barrel's contract types (`named`, #1661): every type
 * the barrel exports that an exported signature names, and, followed through
 * the declarations of those types (an interface's members and heritage, a
 * type alias's body) for as long as they lead to another exported type, every
 * exported type they name — `ReplayEngineController` is one, as the type of
 * `ReplayEngineEnv`'s `controller`. A type the barrel exports only as a
 * contract type needs no importer of its own.
 */
function scanSignatureTypes(program: ts.Program, barrelPath: string): SignatureTypeScan {
  const checker = program.getTypeChecker();
  const barrelFile = program.getSourceFile(barrelPath);

  if (barrelFile === undefined) throw new Error(`the program has no ${barrelPath}`);

  const moduleSymbol = checker.getSymbolAtLocation(barrelFile);

  if (moduleSymbol === undefined) throw new Error(`${barrelPath} is not a module`);

  // The barrel's own file name as the program spells it, so the prefix matches its siblings'.
  const engineDir = barrelFile.fileName.slice(0, barrelFile.fileName.lastIndexOf("/") + 1);
  const exports = checker.getExportsOfModule(moduleSymbol);
  // Each declaration the barrel exports, with the names it is exported under.
  const exported = new Map<ts.Symbol, string[]>();

  for (const symbol of exports) {
    const target = resolveAlias(checker, symbol);

    exported.set(target, [...(exported.get(target) ?? []), symbol.name]);
  }

  const missing = new Map<string, string[]>();
  // The exported declarations a signature names, directly or through another one's declaration.
  const contract = new Set<ts.Symbol>();
  const signatures: string[] = [];

  const note = (symbol: ts.Symbol | undefined, owner: string): void => {
    if (symbol === undefined) return;

    const target = resolveAlias(checker, symbol);

    if (target.flags & ts.SymbolFlags.TypeParameter) return;

    if (exported.has(target)) {
      contract.add(target);

      return;
    }

    const declaredInEngine = (target.declarations ?? []).some((declaration) =>
      declaration.getSourceFile().fileName.startsWith(engineDir),
    );

    if (!declaredInEngine) return;

    const owners = missing.get(target.name) ?? [];

    if (!owners.includes(owner)) owners.push(owner);

    missing.set(target.name, owners);
  };

  /** Each symbol a type reference or heritage clause in `node` names. */
  const referencesIn = (node: ts.Node, found: (symbol: ts.Symbol | undefined) => void): void => {
    if (ts.isTypeReferenceNode(node)) {
      found(checker.getSymbolAtLocation(ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName));
    } else if (ts.isExpressionWithTypeArguments(node)) {
      found(checker.getSymbolAtLocation(node.expression));
    }

    ts.forEachChild(node, (child) => referencesIn(child, found));
  };
  const visit = (node: ts.Node, owner: string): void => referencesIn(node, (symbol) => note(symbol, owner));

  for (const symbol of exports) {
    const annotations = (resolveAlias(checker, symbol).declarations ?? []).flatMap(
      (declaration) => signatureAnnotations(declaration) ?? [],
    );
    const hasSignature = (resolveAlias(checker, symbol).declarations ?? []).some(
      (declaration) => signatureAnnotations(declaration) !== undefined,
    );

    if (!hasSignature) continue;

    signatures.push(symbol.name);

    for (const annotation of annotations) visit(annotation, symbol.name);
  }

  // Follow each contract type's own declaration to the exported types it names, once each.
  const pending = [...contract];

  for (let target = pending.pop(); target !== undefined; target = pending.pop()) {
    for (const declaration of target.declarations ?? []) {
      if (!ts.isInterfaceDeclaration(declaration) && !ts.isTypeAliasDeclaration(declaration)) continue;

      referencesIn(declaration, (symbol) => {
        if (symbol === undefined) return;

        const reached = resolveAlias(checker, symbol);

        if (!exported.has(reached) || contract.has(reached)) return;

        contract.add(reached);
        pending.push(reached);
      });
    }
  }

  const named = new Set([...contract].flatMap((target) => exported.get(target) ?? []));

  return { signatures, missing, named };
}

/** The real barrel as the program spells it, with `/` separators. */
const REAL_BARREL_PATH = join(import.meta.dirname, "index.ts")
  .split(sep)
  .join("/");

let realProgram: ts.Program | undefined;

/** The package's real program over the barrel, built once for both scans. */
function realBarrelProgram(): ts.Program {
  realProgram ??= createTsconfigProgram(join(import.meta.dirname, "..", "tsconfig.json"), (fileName) =>
    fileName.endsWith("/src/index.ts"),
  );

  return realProgram;
}

describe("the barrel exports the types its functions take and return (#1502)", () => {
  it("reports an engine type a signature names but the barrel leaves out (positive control)", () => {
    const sources = new Map([
      [
        "module.ts",
        [
          "export interface Hidden { readonly n: number }",
          "export interface Nested { readonly n: number }",
          "export interface Member { readonly n: number }",
          "export interface Constraint { readonly n: number }",
          "export interface ViaConst { readonly n: number }",
          "export interface Shown { readonly n: number }",
          "export interface Box<T> { readonly value: T; readonly deep: Deep; readonly hiddenDeep: HiddenDeep }",
          "export interface Deep { readonly deeper: Deeper }",
          "export type Deeper = { readonly n: number };",
          "export interface HiddenDeep { readonly n: number }",
          "export interface Unnamed { readonly n: number }",
          "export function take(value: Hidden, boxed: Box<Nested | Shown>): { readonly inner: Member | undefined } {",
          "  return { inner: undefined };",
          "}",
          "export function generic<T extends Constraint>(value: T): T {",
          "  return value;",
          "}",
          "export const handler: (value: ViaConst) => void = () => undefined;",
          "export const arrow = (value: Shown): Shown => value;",
          "export const PLAIN = 1;",
        ].join("\n"),
      ],
      [
        "index.ts",
        [
          'export { arrow, type Box, type Deep, type Deeper, generic, handler, PLAIN, type Shown } from "./module.js";',
          'export { take, type Unnamed } from "./module.js";',
        ].join("\n"),
      ],
    ]);
    const program = createVirtualProgram(sources, "/barrel-scan/", { resolveImports: true });
    const scan = scanSignatureTypes(program, "/barrel-scan/index.ts");

    expect([...scan.signatures].sort()).toEqual(["arrow", "generic", "handler", "take"]);
    expect(Object.fromEntries(scan.missing)).toEqual({
      Constraint: ["generic"],
      Hidden: ["take"],
      Member: ["take"],
      Nested: ["take"],
      ViaConst: ["handler"],
    });
    // `HiddenDeep` is a field of `Box`, which the check does not follow (one level deep, above).
    expect(scan.missing.has("HiddenDeep")).toBe(false);
    // The barrel's own types a signature names are its contract types, followed through their declarations
    // (`Box` → `Deep` → `Deeper`); `PLAIN` is a value and `Unnamed` a type no signature reaches.
    expect([...scan.named].sort()).toEqual(["Box", "Deep", "Deeper", "Shown"]);
  });

  describe("the real barrel", () => {
    let scan: SignatureTypeScan;

    beforeAll(() => {
      scan = scanSignatureTypes(realBarrelProgram(), REAL_BARREL_PATH);
    }, 60_000);

    it("sees every exported function, so an empty program cannot pass", () => {
      const functions = Object.entries(barrel)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => name);

      // 47 functions and the typed consts (`PAUSED`, `RECORD_STEPS`) on 2026-10-31.
      expect(functions.length).toBeGreaterThanOrEqual(40);
      expect(scan.signatures.length).toBeGreaterThan(functions.length);
      expect(functions.filter((name) => !scan.signatures.includes(name))).toEqual([]);
    });

    it("leaves out no engine type an exported signature names", () => {
      expect(Object.fromEntries(scan.missing)).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// "And no more": every export has a production consumer outside the engine (#1661)
// ---------------------------------------------------------------------------

/*
 * The barrel carries what a production source outside the engine imports and
 * no more (`CLAUDE.md`, *One import path*). So every value it exports must be
 * imported by name from `@iracedeck/replay-engine` by at least one production
 * source outside the engine, and every type either by such a source or by an
 * exported signature (the contract types the scan above finds, one level
 * deep). A name that fails goes where the placement rule puts it.
 *
 * Production sources are the repo's own definition, the one the root guard
 * `scripts/testing-entries-test-only.test.mjs` holds every package to (#1375):
 * every git-tracked JavaScript or TypeScript source under `packages/` outside
 * `dist/`, `node_modules/` and the plugin bundles (`trackedPackageSources`),
 * less tests and test-only support (`isTestSource`: `*.test.*`,
 * `*.test-support.*`, `*.test-util.*`, `*.fixture-cases.*`, a `test-support/`
 * folder) and each package's `./testing` entry. Both helpers are imported from
 * `scripts/lib/`; the entry derivation lives in that guard's test file, so it
 * is mirrored here (`testingEntrySourceOf`). Two more exclusions are this
 * check's own: the engine's sources, which are not consumers of their own
 * barrel, and anything under a `__fixtures__/` folder (recorded sessions,
 * every one of them a test today).
 *
 * The imports are read from each file's syntax tree, so a comment or a string
 * cannot add one. A name counts in every form that names it: a named import
 * (aliased or not, `import type` or an inline `type`), a named re-export
 * (`export { x } from`, `export type { X } from`) and an `import("…").X` type,
 * `typeof` or not. A form that does not name what it uses is refused instead,
 * so no import can slip past by its spelling: a namespace import, `export *`,
 * `export * as`, a default import, `import x = require(…)`, a dynamic
 * `import(…)` or `require(…)` call, and a whole-module `import("…")` type.
 * Resolving `re.x` off a namespace would read the same names, but a namespace
 * can also be passed whole, where nothing can say what it uses; production
 * code imports the barrel by name. The walk must read at least as many
 * references to the barrel as TypeScript's own scanner (`ts.preProcessFile`,
 * what the root guards read imports with) finds, so a form neither list knows
 * is refused rather than skipped; the walk may read more, since that scanner
 * misses `export * as x from`.
 */

/** The specifier production code imports the barrel by. */
const BARREL_SPECIFIER = "@iracedeck/replay-engine";

/** The engine's own directory, repo-relative: its sources are not consumers of its barrel. */
const ENGINE_DIR = "packages/replay-engine/";

/** Where a name with no production consumer goes, by the placement rule (`CLAUDE.md`, *One import path*). */
const PLACEMENT =
  "move it to @iracedeck/replay-engine/testing if another package's tests import it, onto neither entry if " +
  "only the engine's own tests do (they import its module by relative path), or delete it if nothing does";

/** One name the barrel exports, and whether it is a value (anything that exists at runtime) or only a type. */
interface BarrelExport {
  readonly name: string;
  readonly kind: "value" | "type";
}

/** Whether `symbol` is exported by a type-only specifier (`export { type X }`, `export type { X }`). */
function isTypeOnlyExport(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some(
    (declaration) =>
      ts.isExportSpecifier(declaration) && (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly),
  );
}

/** Every name `barrelPath` in `program` exports, each as a value or a type. Throws on a name it cannot resolve. */
function barrelExports(program: ts.Program, barrelPath: string): BarrelExport[] {
  const checker = program.getTypeChecker();
  const barrelFile = program.getSourceFile(barrelPath);

  if (barrelFile === undefined) throw new Error(`the program has no ${barrelPath}`);

  const moduleSymbol = checker.getSymbolAtLocation(barrelFile);

  if (moduleSymbol === undefined) throw new Error(`${barrelPath} is not a module`);

  return checker.getExportsOfModule(moduleSymbol).map((symbol) => {
    const target = resolveAlias(checker, symbol);

    // An unresolved re-export reads as a type with no declaration; a value must never pass as one.
    if (target.declarations === undefined || target.declarations.length === 0) {
      throw new Error(`${barrelPath} exports ${symbol.name}, which the program cannot resolve`);
    }

    const value = (target.flags & ts.SymbolFlags.Value) !== 0 && !isTypeOnlyExport(symbol);

    return { name: symbol.name, kind: value ? "value" : "type" };
  });
}

/** What the import scan found over a set of sources. */
interface BarrelImportScan {
  /** Each barrel name a source imports, with the sources that import it. */
  readonly consumed: ReadonlyMap<string, readonly string[]>;
  /** The sources that reference the barrel at all, in any form. */
  readonly importers: readonly string[];
  /** Each reference to the barrel that names nothing the scan can attribute, one line each. */
  readonly refused: readonly string[];
}

/** The first name of `a.b.c`: the barrel export an `import("…").a.b.c` type reaches. */
function leftmost(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : leftmost(name.left);
}

/** Whether `node` is a dynamic `import(…)` or a `require(…)` call. */
function isModuleCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  );
}

/** Every name each of `files` (name → text) imports from `specifier`, by the forms the section header lists. */
function scanBarrelImports(files: ReadonlyMap<string, string>, specifier: string): BarrelImportScan {
  const consumed = new Map<string, string[]>();
  const importers: string[] = [];
  const refused: string[] = [];

  for (const [file, text] of files) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let read = 0;

    const isBarrel = (node: ts.Node | undefined): boolean =>
      node !== undefined && ts.isStringLiteralLike(node) && node.text === specifier;
    const consume = (name: string): void => {
      const by = consumed.get(name) ?? [];

      if (!by.includes(file)) by.push(file);

      consumed.set(name, by);
    };
    const refuse = (node: ts.Node, form: string): void => {
      refused.push(
        `${file}:${lineOf(source, node)} reaches ${specifier} through ${form}, which names nothing the barrel ` +
          `check can count: import each name it uses by name`,
      );
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && isBarrel(node.moduleSpecifier)) {
        read++;

        const clause = node.importClause;
        const bindings = clause?.namedBindings;

        if (clause?.name !== undefined) refuse(node, "a default import");

        if (bindings !== undefined && ts.isNamespaceImport(bindings)) refuse(node, "a namespace import");
        else if (bindings !== undefined) {
          for (const element of bindings.elements) consume((element.propertyName ?? element.name).text);
        }
      } else if (ts.isExportDeclaration(node) && isBarrel(node.moduleSpecifier)) {
        read++;

        if (node.exportClause === undefined) refuse(node, "`export *`");
        else if (ts.isNamespaceExport(node.exportClause)) refuse(node, "`export * as`");
        else for (const element of node.exportClause.elements) consume((element.propertyName ?? element.name).text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        isBarrel(node.moduleReference.expression)
      ) {
        read++;
        refuse(node, "`import … = require(…)`");
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isBarrel(node.argument.literal)) {
        read++;

        if (node.qualifier === undefined) refuse(node, "a whole-module `import(…)` type");
        else consume(leftmost(node.qualifier));
      } else if (isModuleCall(node) && isBarrel(node.arguments[0])) {
        read++;
        refuse(node, "a dynamic `import(…)` or `require(…)` call");
      }

      ts.forEachChild(node, visit);
    };

    visit(source);

    const references = ts
      .preProcessFile(text, true, true)
      .importedFiles.filter(({ fileName }) => fileName === specifier).length;

    // Only a shortfall counts: the scanner itself misses `export * as x from`, which the walk reads.
    if (references > read) {
      refused.push(
        `${file} references ${specifier} ${references} time(s) by TypeScript's scanner, but the barrel check read ` +
          `${read}: teach scanBarrelImports the form it missed`,
      );
    }

    if (read > 0 || references > 0) importers.push(file);
  }

  return { consumed, importers, refused };
}

/**
 * Whether `file` (repo-relative, `/`-separated) is a production source outside
 * the engine: not the engine's own, not a test or test-only support, not a
 * package's `./testing` entry, not under a `__fixtures__/` folder.
 */
function isProductionConsumer(
  file: string,
  testingEntries: ReadonlySet<string>,
  isTest: (file: string) => boolean,
): boolean {
  return (
    !file.startsWith(ENGINE_DIR) &&
    !isTest(file) &&
    !testingEntries.has(file) &&
    !file.split("/").includes("__fixtures__")
  );
}

/** Each barrel export with no production consumer, one line each naming where it goes instead. */
function unconsumedBarrelExports(
  exports: readonly BarrelExport[],
  consumed: ReadonlyMap<string, unknown>,
  contractTypes: ReadonlySet<string>,
): string[] {
  return exports
    .filter(({ name, kind }) => !consumed.has(name) && !(kind === "type" && contractTypes.has(name)))
    .map(({ name, kind }) =>
      kind === "value"
        ? `${name}: a value no production source outside the engine imports: ${PLACEMENT}`
        : `${name}: a type no production source outside the engine imports and no exported signature names: ${PLACEMENT}`,
    );
}

/** The whole check: the production consumers among `files`, what they import, and what the barrel exports unconsumed. */
interface BarrelConsumerCheck {
  readonly scan: BarrelImportScan;
  readonly unconsumed: readonly string[];
}

function checkBarrelConsumers(input: {
  readonly exports: readonly BarrelExport[];
  readonly contractTypes: ReadonlySet<string>;
  readonly files: ReadonlyMap<string, string>;
  readonly testingEntries: ReadonlySet<string>;
  readonly isTest: (file: string) => boolean;
}): BarrelConsumerCheck {
  const production = new Map(
    [...input.files].filter(([file]) => isProductionConsumer(file, input.testingEntries, input.isTest)),
  );
  const scan = scanBarrelImports(production, BARREL_SPECIFIER);

  return { scan, unconsumed: unconsumedBarrelExports(input.exports, scan.consumed, input.contractTypes) };
}

// The root scripts are untyped `.mjs` outside this package's `rootDir`, so they
// are imported by computed URL, which keeps them out of the `tsc` program, as
// `app-updates`' changelog tests do.
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const scriptsLib = (name: string): string => pathToFileURL(join(REPO_ROOT, "scripts", "lib", name)).href;
const {
  isTestSource,
  trackedPackageSources,
}: { isTestSource: (file: string) => boolean; trackedPackageSources: (root: string) => string[] } = await import(
  scriptsLib("source-imports.mjs")
);
const { trackedPackageDirs }: { trackedPackageDirs: (root: string) => string[] } = await import(
  scriptsLib("workspace-packages.mjs")
);
const { pickTarget }: { pickTarget: (value: unknown) => string | null } = await import(
  scriptsLib("package-exports.mjs")
);

/** The source extension each compiled `dist/` extension is built from. */
const SOURCE_EXTENSION: Readonly<Record<string, string>> = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts" };

/**
 * The source a package's `./testing` export is built from, repo-relative, or
 * undefined when it declares none. A mirror of `testingEntrySource` in
 * `scripts/testing-entries-test-only.test.mjs`, which a test cannot import
 * without registering that file's tests: the target resolved as a test's
 * `import` resolves it (`pickTarget`), `./dist/<x>.js` mapped to
 * `src/<x>.ts`, a source export taken as it is. Throws where that one does.
 */
function testingEntrySourceOf(dir: string, manifest: { readonly exports?: unknown }): string | undefined {
  const { exports } = manifest;
  const target =
    exports !== null && typeof exports === "object" && !Array.isArray(exports)
      ? (exports as Record<string, unknown>)["./testing"]
      : undefined;

  if (target === undefined || target === null) return undefined;

  const file = pickTarget(target);

  if (file === null) {
    throw new Error(
      `packages/${dir}/package.json declares a ./testing export with no import, node, development or default target`,
    );
  }

  const relative = posix.normalize(file.replaceAll("\\", "/"));

  if (!relative.startsWith("dist/")) return posix.join("packages", dir, relative);

  const extension = posix.extname(relative);
  const sourceExtension = SOURCE_EXTENSION[extension];

  if (sourceExtension === undefined) {
    throw new Error(
      `packages/${dir}/package.json's ./testing export ${file} is a dist/ file whose source cannot be derived`,
    );
  }

  return posix.join("packages", dir, `src/${relative.slice("dist/".length, -extension.length)}${sourceExtension}`);
}

describe("every name on the barrel has a production consumer outside the engine (#1661)", () => {
  /** A virtual engine: values and types, one of them named by a signature, re-exported by a barrel. */
  const ENGINE_ROOT = "/consumer-scan/";
  const engineSources = new Map([
    [
      "module.ts",
      [
        "export const USED = 1;",
        "export const UNUSED = 2;",
        "export const ONLY_TESTS = 3;",
        "export interface UsedType { readonly n: number }",
        "export interface Contract { readonly n: number }",
        "export interface Orphan { readonly n: number }",
        "export function take(value: Contract): void {}",
      ].join("\n"),
    ],
    [
      "index.ts",
      'export { ONLY_TESTS, take, UNUSED, USED, type Contract, type Orphan, type UsedType } from "./module.js";',
    ],
  ]);
  const engine = createVirtualProgram(engineSources, ENGINE_ROOT, { resolveImports: true });
  const exports = barrelExports(engine, `${ENGINE_ROOT}index.ts`);
  const contractTypes = scanSignatureTypes(engine, `${ENGINE_ROOT}index.ts`).named;
  const PRODUCTION = "packages/iracing-actions/src/actions/replay-control/replay-control.ts";
  const check = (files: Record<string, string>, testingEntries: readonly string[] = []): BarrelConsumerCheck =>
    checkBarrelConsumers({
      exports,
      contractTypes,
      files: new Map(Object.entries(files)),
      testingEntries: new Set(testingEntries),
      isTest: isTestSource,
    });
  const unconsumedNames = (result: BarrelConsumerCheck): string[] =>
    result.unconsumed.map((line) => line.slice(0, line.indexOf(":")));
  /** Every export but the contract type imported by one production source, so a control isolates the one it leaves out. */
  const ALL = 'import { ONLY_TESTS, take, UNUSED, USED, type Orphan, type UsedType } from "@iracedeck/replay-engine";';

  it("classes the virtual barrel's exports as values and types", () => {
    expect(exports).toEqual([
      { name: "ONLY_TESTS", kind: "value" },
      { name: "take", kind: "value" },
      { name: "UNUSED", kind: "value" },
      { name: "USED", kind: "value" },
      { name: "Contract", kind: "type" },
      { name: "Orphan", kind: "type" },
      { name: "UsedType", kind: "type" },
    ]);
    expect([...contractTypes]).toEqual(["Contract"]);
    expect(check({ [PRODUCTION]: ALL }).unconsumed).toEqual([]);
  });

  it("reports a value no source imports, or only the engine's own (positive control)", () => {
    const result = check({
      [PRODUCTION]: 'import { ONLY_TESTS, take, USED, type Orphan, type UsedType } from "@iracedeck/replay-engine";',
      "packages/replay-engine/src/replay-control.ts": 'import { UNUSED } from "@iracedeck/replay-engine";',
    });

    expect(result.unconsumed).toEqual([
      `UNUSED: a value no production source outside the engine imports: ${PLACEMENT}`,
    ]);
  });

  it("reports a value only tests, test support, a testing entry or a fixture import (positive control)", () => {
    const onlyTests = 'import { ONLY_TESTS } from "@iracedeck/replay-engine";';
    const result = check(
      {
        [PRODUCTION]: 'import { take, UNUSED, USED, type Orphan, type UsedType } from "@iracedeck/replay-engine";',
        "packages/iracing-actions/src/actions/replay-control/replay-control.test.ts": onlyTests,
        "packages/iracing-actions/src/shared/replay-engine-deck.test-support.ts": onlyTests,
        "packages/plugin-runtime/src/test-support/module-mocks.ts": onlyTests,
        "packages/audio-scenarios/src/catalog/timed-audio.test-util.ts": onlyTests,
        "packages/iracing-actions/src/shared/dial-box-baseline.fixture-cases.ts": onlyTests,
        "packages/deck-iracing/src/testing.ts": onlyTests,
        "packages/sim-events-iracing/src/diff/__fixtures__/recorded-session.ts": onlyTests,
      },
      ["packages/deck-iracing/src/testing.ts"],
    );

    expect(unconsumedNames(result)).toEqual(["ONLY_TESTS"]);
    expect(result.scan.importers).toEqual([PRODUCTION]);
  });

  it("reports a type nobody imports and no signature names, and passes a contract type (positive control)", () => {
    const result = check({
      [PRODUCTION]: 'import { ONLY_TESTS, take, UNUSED, USED, type UsedType } from "@iracedeck/replay-engine";',
    });

    expect(result.unconsumed).toEqual([
      `Orphan: a type no production source outside the engine imports and no exported signature names: ${PLACEMENT}`,
    ]);
  });

  it("counts a name in every form that names it", () => {
    for (const [source, name] of [
      ['import { USED } from "@iracedeck/replay-engine";', "USED"],
      ['import { USED as used } from "@iracedeck/replay-engine";', "USED"],
      ['import { "USED" as used } from "@iracedeck/replay-engine";', "USED"],
      ['import type { UsedType } from "@iracedeck/replay-engine";', "UsedType"],
      ['import { type UsedType } from "@iracedeck/replay-engine";', "UsedType"],
      ['import type { USED } from "@iracedeck/replay-engine";\ntype T = typeof USED;', "USED"],
      ['export { USED } from "@iracedeck/replay-engine";', "USED"],
      ['export { USED as used } from "@iracedeck/replay-engine";', "USED"],
      ['export type { UsedType } from "@iracedeck/replay-engine";', "UsedType"],
      ['export { type UsedType } from "@iracedeck/replay-engine";', "UsedType"],
      ['type T = import("@iracedeck/replay-engine").UsedType;', "UsedType"],
      ['type T = typeof import("@iracedeck/replay-engine").USED;', "USED"],
      ['type T = import("@iracedeck/replay-engine").UsedType.Member;', "UsedType"],
      ['function f(): void {\n  type T = import("@iracedeck/replay-engine").UsedType;\n}', "UsedType"],
    ] as const) {
      const { scan } = check({ [PRODUCTION]: source });

      expect([...scan.consumed.keys()], source).toEqual([name]);
      expect(scan.importers, source).toEqual([PRODUCTION]);
      expect(scan.refused, source).toEqual([]);
    }
  });

  it("refuses every form that does not name what it uses (positive control)", () => {
    for (const [source, form] of [
      ['import * as re from "@iracedeck/replay-engine";', "a namespace import"],
      ['import engine from "@iracedeck/replay-engine";', "a default import"],
      ['import engine, { USED } from "@iracedeck/replay-engine";', "a default import"],
      ['export * from "@iracedeck/replay-engine";', "`export *`"],
      ['export * as re from "@iracedeck/replay-engine";', "`export * as`"],
      ['import re = require("@iracedeck/replay-engine");', "`import … = require(…)`"],
      ['const re = await import("@iracedeck/replay-engine");', "a dynamic `import(…)` or `require(…)` call"],
      ['const re = require("@iracedeck/replay-engine");', "a dynamic `import(…)` or `require(…)` call"],
      ['type T = typeof import("@iracedeck/replay-engine");', "a whole-module `import(…)` type"],
    ] as const) {
      const { scan } = check({ [PRODUCTION]: source });

      expect(scan.refused, source).toEqual([
        `${PRODUCTION}:1 reaches @iracedeck/replay-engine through ${form}, which names nothing the barrel check ` +
          `can count: import each name it uses by name`,
      ]);
      expect(scan.importers, source).toEqual([PRODUCTION]);
    }
  });

  it("reads no import from a lookalike specifier, a comment or a string", () => {
    const { scan } = check({
      [PRODUCTION]: [
        'import { USED } from "@iracedeck/replay-engine/testing";',
        'import { UNUSED } from "@iracedeck/replay-engine-extra";',
        '// import { take } from "@iracedeck/replay-engine";',
        'const s = "@iracedeck/replay-engine";',
        "import { ONLY_TESTS } from './replay-engine.js';",
      ].join("\n"),
    });

    expect(scan).toEqual({ consumed: new Map(), importers: [], refused: [] });
  });

  it("classes production sources as the repo does", () => {
    const entries = new Set(["packages/deck-iracing/src/testing.ts"]);

    for (const file of [
      "packages/iracing-actions/src/actions/replay-control/replay-control.ts",
      "packages/plugin-runtime/src/phases/replay.ts",
      "packages/iracing-actions/src/shared/replay-busy-indicator.ts",
      "packages/deck-iracing/src/testing-helpers.ts",
      "packages/plugin-runtime/src/fixtures.ts",
    ]) {
      expect(isProductionConsumer(file, entries, isTestSource), file).toBe(true);
    }

    for (const file of [
      "packages/replay-engine/src/replay-cursor.ts",
      "packages/replay-engine/src/index.ts",
      "packages/iracing-actions/src/actions/replay-control/replay-control.test.ts",
      "packages/iracing-actions/src/shared/replay-engine-deck.test-support.ts",
      "packages/plugin-runtime/src/test-support/module-mocks.ts",
      "packages/deck-iracing/src/testing.ts",
      "packages/sim-events-iracing/src/diff/__fixtures__/recorded-session.ts",
    ]) {
      expect(isProductionConsumer(file, entries, isTestSource), file).toBe(false);
    }
  });

  it("derives a package's testing entry source as the root guard does", () => {
    expect(
      testingEntrySourceOf("replay-engine", {
        exports: { "./testing": { import: "./dist/testing.js", types: "./dist/testing.d.ts" } },
      }),
    ).toBe("packages/replay-engine/src/testing.ts");
    expect(testingEntrySourceOf("pi-components", { exports: { "./testing": "./src/build/testing.ts" } })).toBe(
      "packages/pi-components/src/build/testing.ts",
    );
    expect(testingEntrySourceOf("deck-core", { exports: { "./testing": "./dist/testing.mjs" } })).toBe(
      "packages/deck-core/src/testing.mts",
    );
    expect(testingEntrySourceOf("logger", { exports: { ".": "./dist/index.js" } })).toBeUndefined();
    expect(testingEntrySourceOf("logger", { exports: { ".": "./dist/index.js", "./testing": null } })).toBeUndefined();
    expect(testingEntrySourceOf("logger", {})).toBeUndefined();
    expect(() => testingEntrySourceOf("deck-core", { exports: { "./testing": { types: "./dist/x.d.ts" } } })).toThrow(
      "declares a ./testing export",
    );
    expect(() => testingEntrySourceOf("deck-core", { exports: { "./testing": "./dist/testing.json" } })).toThrow(
      "is a dist/ file whose source cannot be derived",
    );
  });

  describe("the real barrel and the repo's production sources", () => {
    let realExports: BarrelExport[];
    let realContractTypes: ReadonlySet<string>;
    let realFiles: Map<string, string>;
    let testingEntries: Set<string>;
    let result: BarrelConsumerCheck;

    beforeAll(() => {
      realExports = barrelExports(realBarrelProgram(), REAL_BARREL_PATH);
      realContractTypes = scanSignatureTypes(realBarrelProgram(), REAL_BARREL_PATH).named;
      realFiles = new Map(
        trackedPackageSources(REPO_ROOT).map((file) => [file, readFileSync(join(REPO_ROOT, file), "utf8")]),
      );
      testingEntries = new Set(
        trackedPackageDirs(REPO_ROOT).flatMap((dir) => {
          const manifest: { exports?: unknown } = JSON.parse(
            readFileSync(join(REPO_ROOT, "packages", dir, "package.json"), "utf8"),
          );
          const entry = testingEntrySourceOf(dir, manifest);

          return entry === undefined ? [] : [entry];
        }),
      );
      result = checkBarrelConsumers({
        exports: realExports,
        contractTypes: realContractTypes,
        files: realFiles,
        testingEntries,
        isTest: isTestSource,
      });
    }, 60_000);

    it("reads the repo's sources and every testing entry, so an empty read cannot pass", () => {
      expect(realFiles.size).toBeGreaterThan(1_000);
      expect([...realFiles.keys()].some((file) => file.split("/").includes("dist"))).toBe(false);
      // audio-service, deck-core, deck-iracing, pi-components, replay-engine, replay-store, sim-events-iracing on 2026-11-23.
      expect(testingEntries.size).toBeGreaterThanOrEqual(7);
      expect(testingEntries).toContain(`${ENGINE_DIR}src/testing.ts`);

      for (const entry of testingEntries) expect(realFiles.has(entry), entry).toBe(true);
    });

    it("sees the barrel's production importers and both kinds of export, so an empty scan cannot pass", () => {
      // 21 importers in iracing-actions and plugin-runtime naming 66 of the barrel's 87 names (49 values), and 38
      // contract types, on 2026-11-23.
      expect(result.scan.importers.length).toBeGreaterThanOrEqual(15);
      expect(result.scan.importers.every((file) => isProductionConsumer(file, testingEntries, isTestSource))).toBe(
        true,
      );
      expect(result.scan.importers).toContain("packages/plugin-runtime/src/phases/replay.ts");
      expect(result.scan.consumed.size).toBeGreaterThanOrEqual(50);
      expect(realExports.filter(({ kind }) => kind === "value").length).toBeGreaterThanOrEqual(40);
      expect(realExports.filter(({ kind }) => kind === "type").length).toBeGreaterThanOrEqual(30);
      expect(realContractTypes.size).toBeGreaterThan(0);

      // Each name classed as a value is one the runtime barrel really exports, and each type one it does not.
      for (const { name, kind } of realExports) expect(Object.hasOwn(barrel, name), name).toBe(kind === "value");
    });

    it("no production source reaches the barrel in a form the check cannot count", () => {
      expect(result.scan.refused).toEqual([]);
    });

    it("exports nothing no production source outside the engine imports (contract types aside)", () => {
      expect(result.unconsumed).toEqual([]);
    });

    it("reports a name once its only production importer is gone (positive control)", () => {
      const without = new Map(realFiles);

      without.delete("packages/plugin-runtime/src/phases/replay.ts");

      const planted = checkBarrelConsumers({
        exports: realExports,
        contractTypes: realContractTypes,
        files: without,
        testingEntries,
        isTest: isTestSource,
      });

      expect(planted.unconsumed).toContain(
        `configureReplayEngine: a value no production source outside the engine imports: ${PLACEMENT}`,
      );
    });
  });
});
