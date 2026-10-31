/**
 * The TypeScript-compiler plumbing the engine's scan tests share (#1502): the
 * camera-switch scanner (`camera-switch-waiter.single-policy.test-support.ts`)
 * and the reset-coverage scanner (`replay-engine-reset.coverage.test-support.ts`).
 * It reads the production sources of a directory, builds an in-memory program
 * over them (binder only: no lib, no module resolution), and holds the small
 * node helpers both scanners use. What a scanner looks for stays in the scanner.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * Every production `.ts` file under `dir` by its path relative to `dir`, with
 * `/` separators: no tests, test support or declarations. Only `dir` itself
 * unless `recursive`.
 */
export function readProductionSources(dir: string, recursive: boolean): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);

      if (entry.isDirectory()) {
        if (recursive) walk(full);

        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;

      if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".test-support.ts")) {
        continue;
      }

      sources.set(relative(dir, full).split(sep).join("/"), readFileSync(full, "utf8"));
    }
  };

  walk(dir);

  return sources;
}

/**
 * A program over `sources` (name → text) placed under `virtualRoot`, so a
 * file is `virtualRoot + name`. No lib and no resolution: the binder and
 * checker see only these files, and a scan never depends on the machine.
 */
export function createVirtualProgram(sources: ReadonlyMap<string, string>, virtualRoot: string): ts.Program {
  const byPath = new Map<string, string>();

  for (const [name, text] of sources) byPath.set(virtualRoot + name, text);

  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = byPath.get(fileName);

      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: () => `${virtualRoot}lib.d.ts`,
    writeFile: () => undefined,
    getCurrentDirectory: () => virtualRoot,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => byPath.has(fileName),
    readFile: (fileName) => byPath.get(fileName),
  };

  return ts.createProgram([...byPath.keys()], options, host);
}

/** Whether `node` only wraps an expression: parentheses, `as`, `satisfies`, a type assertion or `!`. */
function isExpressionWrapper(
  node: ts.Node,
): node is
  ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression | ts.TypeAssertion | ts.NonNullExpression {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

/** `expression` without the parentheses, `as`, `satisfies`, type assertions and `!` around it. */
export function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (isExpressionWrapper(current)) current = current.expression;

  return current;
}

/** The outermost expression `node` is wrapped in by parentheses, `as`, `satisfies` or `!`. */
export function outermost(node: ts.Node): ts.Node {
  let current = node;

  while (current.parent !== undefined && isExpressionWrapper(current.parent)) current = current.parent;

  return current;
}

/** The 1-based line `node` starts on. */
export function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/** Whether `node` carries the modifier `kind` (`export`, `static`, `readonly`). */
export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/** Whether `node` is itself an arrow function or a function expression (a wrapper around one is not). */
export function isFunctionValue(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}
