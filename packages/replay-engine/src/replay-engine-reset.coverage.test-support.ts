/**
 * The scanner behind `replay-engine-reset.coverage.test.ts` (#1502): which
 * top-level bindings of the engine's modules keep state, and which of them a
 * call of `_resetReplayEngine` can reach and write. It reads the sources with
 * the TypeScript compiler (binder only, no type check), so a comment, a string
 * or a nested scope's binding of the same name is never mistaken for one.
 *
 * **What counts as module-level state** — a top-level binding that can hold a
 * value a later test would see:
 * - every top-level `let` or `var`: it exists to be reassigned;
 * - a top-level `const` that some module mutates through its name — a
 *   mutating method (`set`, `add`, `delete`, `clear`, `push`, `splice`, …), an
 *   assignment to a property or element, `delete`, `++` / `--` on one, or
 *   `Object.assign` onto it — whether the mutation is in its own module or in
 *   one that imports it. That is how a lookup table (`const END_CLASS = {…}`,
 *   `PAUSED`, a `new Map` nobody writes) is told apart from a cache: by whether
 *   anything ever writes it, not by the shape of its initializer;
 * - a top-level `const` initialised by a call or by `new` of anything but
 *   `Map`, `Set`, `WeakMap`, `WeakSet` or `Array`: what it holds is out of
 *   sight, so it counts unless it is reset or exempted (`Object.freeze(…)` is
 *   seen through);
 * - a top-level class with a `static` field that is not `readonly`.
 *
 * Functions (`function f`, `const f = () => …`) are not state.
 *
 * **What "reset" means** — starting from the root (`_resetReplayEngine`), the
 * scanner follows every call of a top-level function by name, in its own
 * module or through a relative import (re-exports followed), as far as the
 * calls go. A stateful binding is reset when any function reached that way
 * reassigns it or mutates it as above (`x = null`, `x.clear()`). So a module's
 * `_reset*` counts only if the root calls it, directly or through any number of
 * hops the scanner can see.
 *
 * **What it cannot see**, by design: a write through an alias (`const a = x;
 * a.clear()`), through a value a function returns, or through a method of an
 * object (`claim.cancel()`); a call through a callback or a function value
 * rather than by name. Each errs towards reporting a binding as not reset, so
 * the test goes red rather than green; the answer is to reset it by name.
 */
import ts from "typescript";

import {
  createVirtualProgram,
  hasModifier,
  isFunctionValue as isFunctionNode,
  lineOf,
  readProductionSources,
  unwrap,
} from "./ts-source-scan.test-support.js";

/** Why a binding counts as module state. */
export type StateKind = "let" | "mutated const" | "opaque initializer" | "static field";

/** One top-level binding that keeps state. */
export interface StateBinding {
  /** The module's file name, e.g. `replay-cursor.ts`. */
  readonly module: string;
  readonly name: string;
  readonly line: number;
  readonly kind: StateKind;
}

/** What one scan saw. */
export interface ResetScan {
  /** Every module scanned, by file name. */
  readonly modules: readonly string[];
  /** Every stateful binding, in module and line order. */
  readonly stateful: readonly StateBinding[];
  /** The stateful bindings a function reachable from the root writes. */
  readonly reset: readonly StateBinding[];
  /** The stateful bindings nothing reachable from the root writes. */
  readonly unreset: readonly StateBinding[];
  /** Every function the root reaches, as `<module>:<name>`. */
  readonly reached: readonly string[];
}

/** The root of the reset: the function `_resetReplayEngine` in `replay-engine-reset.ts`. */
export interface ResetRoot {
  readonly module: string;
  readonly fn: string;
}

/** `<module>:<name>`, the key an exemption is written under. */
export function bindingKey(binding: Pick<StateBinding, "module" | "name">): string {
  return `${binding.module}:${binding.name}`;
}

/** Methods that change the container they are called on. */
const MUTATORS = new Set([
  "set",
  "add",
  "delete",
  "clear",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

/** Constructors whose result is a plain container: state only if something writes it. */
const TRANSPARENT_CONSTRUCTORS = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array"]);

/** The production sources of `dir`: every `.ts` file but tests, test support and declarations. */
export function readEngineSources(dir: string): Map<string, string> {
  return readProductionSources(dir, false);
}

interface Binding {
  readonly module: string;
  readonly name: string;
  readonly line: number;
  /** The kind it has whatever is done to it, or `null` for a const that is state only once mutated. */
  readonly inherent: StateKind | null;
}

interface ImportTarget {
  readonly module: string;
  /** The exported name, or `null` for a namespace import. */
  readonly name: string | null;
}

interface Module {
  readonly name: string;
  readonly file: ts.SourceFile;
  readonly bindings: Map<ts.Symbol, Binding>;
  readonly functions: Map<ts.Symbol, ts.Node>;
  readonly imports: Map<ts.Symbol, ImportTarget>;
  /** Exported name → the local symbol it exports. */
  readonly exports: Map<string, ts.Symbol>;
  /** Exported name → where a re-export takes it from. */
  readonly reExports: Map<string, ImportTarget & { readonly name: string }>;
  /** The modules an `export * from` re-exports. */
  readonly starExports: string[];
}

type Target = { readonly module: Module; readonly symbol: ts.Symbol };

const VIRTUAL_ROOT = "/replay-engine-scan/";

/** `./x.js` (or `./x`) seen from a module → `x.ts`, or undefined for a package import. */
function relativeModule(specifier: string): string | undefined {
  if (!specifier.startsWith("./")) return undefined;

  const bare = specifier.slice(2).replace(/\.js$/, "").replace(/\.ts$/, "");

  return `${bare}.ts`;
}

function isFunctionValue(expression: ts.Expression): boolean {
  return isFunctionNode(unwrap(expression));
}

/** `Object.freeze(x)` → `x`, any depth. */
function seeThroughFreeze(expression: ts.Expression): ts.Expression {
  let value = unwrap(expression);

  while (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === "Object" &&
    value.expression.name.text === "freeze" &&
    value.arguments.length === 1
  ) {
    value = unwrap(value.arguments[0]);
  }

  return value;
}

/** Whether a const's initializer hides what it holds: a call, or `new` of anything but a plain container. */
function isOpaque(initializer: ts.Expression): boolean {
  const value = seeThroughFreeze(initializer);

  if (ts.isCallExpression(value) || ts.isAwaitExpression(value)) return true;

  if (ts.isNewExpression(value)) {
    return !(ts.isIdentifier(value.expression) && TRANSPARENT_CONSTRUCTORS.has(value.expression.text));
  }

  return false;
}

function identifiersOf(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];

  const found: ts.Identifier[] = [];

  for (const element of name.elements) {
    if (ts.isBindingElement(element)) found.push(...identifiersOf(element.name));
  }

  return found;
}

function collectModule(name: string, file: ts.SourceFile, checker: ts.TypeChecker): Module {
  const module: Module = {
    name,
    file,
    bindings: new Map(),
    functions: new Map(),
    imports: new Map(),
    exports: new Map(),
    reExports: new Map(),
    starExports: [],
  };
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);
  const exportLocal = (exported: string, local: ts.Node): void => {
    const symbol = symbolOf(local);

    if (symbol !== undefined) module.exports.set(exported, symbol);
  };

  for (const statement of file.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);

    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const from = relativeModule(statement.moduleSpecifier.text);
      const clause = statement.importClause;

      if (from === undefined || clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;

      const bindings = clause.namedBindings;

      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        const symbol = symbolOf(bindings.name);

        if (symbol !== undefined) module.imports.set(symbol, { module: from, name: null });
      } else if (bindings !== undefined) {
        for (const element of bindings.elements) {
          const symbol = symbolOf(element.name);

          if (symbol === undefined || element.isTypeOnly) continue;

          module.imports.set(symbol, { module: from, name: (element.propertyName ?? element.name).text });
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;

      const from =
        statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
          ? relativeModule(statement.moduleSpecifier.text)
          : undefined;
      const clause = statement.exportClause;

      if (clause === undefined) {
        if (from !== undefined) module.starExports.push(from);
      } else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;

          const local = (element.propertyName ?? element.name) as ts.Identifier;

          if (statement.moduleSpecifier === undefined) {
            const symbol = checker.getExportSpecifierLocalTargetSymbol(element);

            if (symbol !== undefined) module.exports.set(element.name.text, symbol);
          } else if (from !== undefined) {
            module.reExports.set(element.name.text, { module: from, name: local.text });
          }
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
      const symbol = symbolOf(statement.name);

      if (symbol !== undefined) module.functions.set(symbol, statement.body);

      if (exported) exportLocal(statement.name.text, statement.name);
    } else if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags;
      const isConst = (flags & ts.NodeFlags.Const) !== 0;

      for (const declaration of statement.declarationList.declarations) {
        for (const identifier of identifiersOf(declaration.name)) {
          const symbol = symbolOf(identifier);

          if (symbol === undefined) continue;

          if (exported) exportLocal(identifier.text, identifier);

          const initializer = declaration.initializer;

          if (
            isConst &&
            ts.isIdentifier(declaration.name) &&
            initializer !== undefined &&
            isFunctionValue(initializer)
          ) {
            module.functions.set(symbol, unwrap(initializer));
            continue;
          }

          let inherent: StateKind | null;

          if (!isConst) inherent = "let";
          else if (!ts.isIdentifier(declaration.name)) inherent = "opaque initializer";
          else inherent = initializer !== undefined && isOpaque(initializer) ? "opaque initializer" : null;

          module.bindings.set(symbol, {
            module: name,
            name: identifier.text,
            line: lineOf(file, identifier),
            inherent,
          });
        }
      }
    } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      const symbol = symbolOf(statement.name);

      if (symbol === undefined) continue;

      if (exported) exportLocal(statement.name.text, statement.name);

      const mutableStatic = statement.members.some(
        (member) =>
          ts.isPropertyDeclaration(member) &&
          hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
          !hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
      );

      if (mutableStatic) {
        module.bindings.set(symbol, {
          module: name,
          name: statement.name.text,
          line: lineOf(file, statement.name),
          inherent: "static field",
        });
      }
    }
  }

  return module;
}

/** How a reference to a binding uses it: reassigns it, mutates what it holds, or neither. */
function accessOf(reference: ts.Expression): "reassign" | "mutate" | null {
  const parent = reference.parent;

  if (ts.isBinaryExpression(parent) && parent.left === reference && isAssignment(parent.operatorToken.kind)) {
    return "reassign";
  }

  if (isIncrement(parent, reference)) return "reassign";

  if (inDestructuringTarget(reference)) return "reassign";

  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === reference) {
    return "reassign";
  }

  // `x.a.b`, `x[k]`, `x!.a`: climb to the outermost access rooted at the reference.
  let top: ts.Expression = reference;

  for (;;) {
    const up: ts.Node = top.parent;

    if ((ts.isPropertyAccessExpression(up) || ts.isElementAccessExpression(up)) && up.expression === top) top = up;
    else if ((ts.isNonNullExpression(up) || ts.isParenthesizedExpression(up)) && up.expression === top) top = up;
    else break;
  }

  const above = top.parent;

  if (
    ts.isCallExpression(above) &&
    ts.isPropertyAccessExpression(above.expression) &&
    ts.isIdentifier(above.expression.expression) &&
    above.expression.expression.text === "Object" &&
    above.expression.name.text === "assign" &&
    above.arguments[0] === reference
  ) {
    return "mutate";
  }

  if (top === reference) return null;

  if (ts.isBinaryExpression(above) && above.left === top && isAssignment(above.operatorToken.kind)) return "mutate";

  if (isIncrement(above, top) || (ts.isDeleteExpression(above) && above.expression === top)) return "mutate";

  if (inDestructuringTarget(top)) return "mutate";

  // `x.clear()`, `x.a.push(…)`: a mutating method called on what the reference holds.
  if (ts.isCallExpression(above) && above.expression === top) {
    const method = ts.isPropertyAccessExpression(top)
      ? top.name.text
      : ts.isElementAccessExpression(top) && ts.isStringLiteralLike(top.argumentExpression)
        ? top.argumentExpression.text
        : undefined;

    if (method !== undefined && MUTATORS.has(method)) return "mutate";
  }

  return null;
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isIncrement(node: ts.Node, operand: ts.Node): boolean {
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    node.operand === operand &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

/** Whether `node` sits in the target of a destructuring assignment (`[a, b] = …`, `({ a } = …)`). */
function inDestructuringTarget(node: ts.Node): boolean {
  let current: ts.Node = node;

  for (;;) {
    const up: ts.Node = current.parent;

    if (ts.isArrayLiteralExpression(up) || ts.isObjectLiteralExpression(up) || ts.isSpreadElement(up)) current = up;
    else if (ts.isSpreadAssignment(up) || ts.isShorthandPropertyAssignment(up)) current = up;
    else if (ts.isPropertyAssignment(up) && up.initializer === current) current = up;
    else if (ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.EqualsToken && up.left === current) {
      return current !== node;
    } else return false;
  }
}

/**
 * Scans `sources` (file name → text) for module state and for what the root
 * reaches. Throws when the root function is not found, so a renamed root can
 * never scan as "nothing reached, nothing to check".
 */
export function scanResetCoverage(sources: ReadonlyMap<string, string>, root: ResetRoot): ResetScan {
  const program = createVirtualProgram(sources, VIRTUAL_ROOT);
  const checker = program.getTypeChecker();
  const modules = new Map<string, Module>();

  for (const name of [...sources.keys()].sort()) {
    const file = program.getSourceFile(VIRTUAL_ROOT + name);

    if (file === undefined) throw new Error(`reset scan: ${name} did not load`);

    modules.set(name, collectModule(name, file, checker));
  }

  const resolveExport = (moduleName: string, exported: string, seen = new Set<string>()): Target | undefined => {
    const key = `${moduleName}:${exported}`;
    const module = modules.get(moduleName);

    if (module === undefined || seen.has(key)) return undefined;

    seen.add(key);

    const local = module.exports.get(exported);

    if (local !== undefined) return resolveLocal(module, local, seen);

    const re = module.reExports.get(exported);

    if (re !== undefined) return resolveExport(re.module, re.name, seen);

    for (const star of module.starExports) {
      const found = resolveExport(star, exported, seen);

      if (found !== undefined) return found;
    }

    return undefined;
  };

  /** A symbol seen in `module` → the binding or function it stands for, through imports. */
  const resolveLocal = (module: Module, symbol: ts.Symbol, seen = new Set<string>()): Target | undefined => {
    if (module.bindings.has(symbol) || module.functions.has(symbol)) return { module, symbol };

    const imported = module.imports.get(symbol);

    if (imported !== undefined && imported.name !== null) return resolveExport(imported.module, imported.name, seen);

    // `export { x }` of a local resolves through the local's own symbol, which is the one above.
    return undefined;
  };

  /** What an identifier or `ns.member` reference stands for, if anything the scan tracks. */
  const resolveReference = (
    module: Module,
    node: ts.Identifier,
  ): { target: Target; reference: ts.Expression } | undefined => {
    const parent = node.parent;

    // `ns.member`: the member of a namespace import.
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
      if (!ts.isIdentifier(parent.expression)) return undefined;

      const namespace = checker.getSymbolAtLocation(parent.expression);
      const imported = namespace === undefined ? undefined : module.imports.get(namespace);

      if (imported === undefined || imported.name !== null) return undefined;

      const target = resolveExport(imported.module, node.text);

      return target === undefined ? undefined : { target, reference: parent };
    }

    const symbol = ts.isShorthandPropertyAssignment(parent)
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(node);

    if (symbol === undefined) return undefined;

    const target = resolveLocal(module, symbol);

    return target === undefined ? undefined : { target, reference: node };
  };

  const visit = (node: ts.Node, each: (identifier: ts.Identifier) => void): void => {
    if (ts.isIdentifier(node)) each(node);

    ts.forEachChild(node, (child) => visit(child, each));
  };

  // Every write of a binding anywhere: what turns a const into state.
  const mutated = new Set<ts.Symbol>();

  for (const module of modules.values()) {
    visit(module.file, (identifier) => {
      const resolved = resolveReference(module, identifier);

      if (resolved === undefined || !resolved.target.module.bindings.has(resolved.target.symbol)) return;

      if (accessOf(resolved.reference) !== null) mutated.add(resolved.target.symbol);
    });
  }

  const rootModule = modules.get(root.module);
  const rootTarget = rootModule === undefined ? undefined : resolveExport(root.module, root.fn);

  if (rootTarget === undefined || !rootTarget.module.functions.has(rootTarget.symbol)) {
    throw new Error(`reset scan: the root ${root.module}:${root.fn} was not found`);
  }

  // Every function the root reaches by name, and every binding one of them writes.
  const reached = new Map<ts.Symbol, string>();
  const written = new Set<ts.Symbol>();
  const queue: Target[] = [rootTarget];

  while (queue.length > 0) {
    const fn = queue.shift() as Target;

    if (reached.has(fn.symbol)) continue;

    reached.set(fn.symbol, `${fn.module.name}:${fn.symbol.name}`);

    visit(fn.module.functions.get(fn.symbol) as ts.Node, (identifier) => {
      const resolved = resolveReference(fn.module, identifier);

      if (resolved === undefined) return;

      const { target, reference } = resolved;

      if (target.module.functions.has(target.symbol)) {
        const call = reference.parent;

        if (ts.isCallExpression(call) && call.expression === reference) queue.push(target);
      } else if (accessOf(reference) !== null) {
        written.add(target.symbol);
      }
    });
  }

  const stateful: StateBinding[] = [];
  const reset: StateBinding[] = [];
  const unreset: StateBinding[] = [];

  for (const module of modules.values()) {
    const found = [...module.bindings.entries()]
      .map(([symbol, binding]) => {
        const kind = binding.inherent ?? (mutated.has(symbol) ? "mutated const" : null);

        if (kind === null) return undefined;

        const state: StateBinding = { module: binding.module, name: binding.name, line: binding.line, kind };

        return { symbol, binding: state };
      })
      .filter((entry) => entry !== undefined)
      .sort((a, b) => a.binding.line - b.binding.line);

    for (const { symbol, binding } of found) {
      stateful.push(binding);
      (written.has(symbol) ? reset : unreset).push(binding);
    }
  }

  return { modules: [...modules.keys()], stateful, reset, unreset, reached: [...reached.values()].sort() };
}

/**
 * What is wrong with an exemption list against a scan: an entry with no reason
 * (fewer than 20 characters is not one), and an entry that names no binding
 * the scan reports as not reset — reset since, renamed, or never state — which
 * must be removed so the list stays the list of real exceptions.
 */
export function exemptionProblems(
  unreset: readonly StateBinding[],
  exemptions: Readonly<Record<string, string>>,
): string[] {
  const keys = new Set(unreset.map(bindingKey));
  const problems: string[] = [];

  for (const [key, reason] of Object.entries(exemptions)) {
    if (reason.trim().length < 20) problems.push(`${key}: an exemption needs its reason`);

    if (!keys.has(key)) problems.push(`${key}: exempted, but the scan reports no unreset state by that name`);
  }

  return problems;
}
