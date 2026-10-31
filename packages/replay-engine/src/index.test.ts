import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import * as testing from "./testing.js";
import { createTsconfigProgram, createVirtualProgram, isFunctionValue, unwrap } from "./ts-source-scan.test-support.js";

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

/**
 * What the signature-type scan found: the barrel's exported names that carry a
 * signature, and each engine type a signature names that the barrel does not
 * export, with the exports whose signatures name it.
 */
interface SignatureTypeScan {
  readonly signatures: readonly string[];
  readonly missing: ReadonlyMap<string, readonly string[]>;
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
  const exported = new Set(exports.map((symbol) => resolveAlias(checker, symbol)));
  const missing = new Map<string, string[]>();
  const signatures: string[] = [];

  const note = (symbol: ts.Symbol | undefined, owner: string): void => {
    if (symbol === undefined) return;

    const target = resolveAlias(checker, symbol);

    if (target.flags & ts.SymbolFlags.TypeParameter || exported.has(target)) return;

    const declaredInEngine = (target.declarations ?? []).some((declaration) =>
      declaration.getSourceFile().fileName.startsWith(engineDir),
    );

    if (!declaredInEngine) return;

    const owners = missing.get(target.name) ?? [];

    if (!owners.includes(owner)) owners.push(owner);

    missing.set(target.name, owners);
  };

  const visit = (node: ts.Node, owner: string): void => {
    if (ts.isTypeReferenceNode(node)) {
      note(checker.getSymbolAtLocation(ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName), owner);
    } else if (ts.isExpressionWithTypeArguments(node)) {
      note(checker.getSymbolAtLocation(node.expression), owner);
    }

    ts.forEachChild(node, (child) => visit(child, owner));
  };

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

  return { signatures, missing };
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
          "export interface Box<T> { readonly value: T }",
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
      ["index.ts", 'export { arrow, type Box, generic, handler, PLAIN, type Shown, take } from "./module.js";'],
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
  });

  describe("the real barrel", () => {
    let scan: SignatureTypeScan;

    beforeAll(() => {
      const barrelPath = join(import.meta.dirname, "index.ts");
      const program = createTsconfigProgram(join(import.meta.dirname, "..", "tsconfig.json"), (fileName) =>
        fileName.endsWith("/src/index.ts"),
      );

      scan = scanSignatureTypes(program, barrelPath.split(sep).join("/"));
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
