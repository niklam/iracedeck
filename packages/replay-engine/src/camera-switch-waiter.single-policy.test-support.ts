/**
 * The scanner behind `camera-switch-waiter.single-policy.test.ts` (#1502):
 * where `iracing-actions` sends a camera switch, and whether each send runs
 * only inside a callback handed to the engine's camera-switch waiter
 * (`requestCameraSwitch`). It reads the sources with the TypeScript compiler
 * (binder only, no type check), so a comment, a string or a nested scope's
 * binding of the same name is never mistaken for one.
 *
 * **What counts as a camera send:**
 * - a method call on the camera command surface — `getCommands().camera`,
 *   `getSDK().commands.camera`, a `const` bound to either or to
 *   `getCommands()`, or `camera` destructured out of them — other than the
 *   state methods the caller names (flags on the camera, not a switch);
 * - a tap or hold of one of iRacing's camera key bindings (`tapBinding`,
 *   `holdBinding` or whatever names the caller passes), whose key is one of
 *   the camera binding names the caller passes, a `const` or a function's
 *   return worked out from one, or a parameter some caller of that function
 *   passes one in. A tap inside a function itself named like a key sender
 *   (the dial's `tapBinding: (key) => host.tapBinding(key)`) is that sender's
 *   plumbing, not a send of its own: the call that reaches it is the send;
 * - any other use of the camera surface, or of the commands or the SDK on the
 *   way to it, than a member read or a binding the scanner follows (passed as
 *   an argument, assigned, returned, destructured into its methods): an
 *   **escape**, always reported, since what happens to it next is out of
 *   sight.
 *
 * **What "through the waiter" means** — a send runs inside a waiter callback
 * when it is lexically inside one, or inside a named function every use of
 * which is, recursively:
 * - a waiter callback is the first argument of a `requestCameraSwitch` call,
 *   or the argument a **wrapper** forwards to it: a named function one of
 *   whose parameters is passed straight to the waiter (Camera Controls'
 *   `requestSwitch(ask, what, send)`, Replay Control's
 *   `requestKeyCameraSwitch`), found to any depth of wrapping;
 * - a named function is a `function` declaration or a `const` holding an
 *   arrow or function expression (a binding, resolved by symbol, and for an
 *   exported one also every import of its name in another file), or a method,
 *   class field or object-literal property holding a function (a **member**,
 *   resolved by name across every file, since `io.switchToCarNumber(…)` names
 *   no declaration the binder can see). A member name shared with an
 *   unrelated member counts that member's uses too, so a collision makes the
 *   scan stricter, never laxer;
 * - a use is any reference to the function: a call, or the function passed
 *   or stored as a value. A use in a callback that is not a waiter callback
 *   (`.then(…)`, `setTimeout(…)`) counts where that callback is written. A use
 *   at module top level, in a constructor or in a class field's initializer
 *   is outside any waiter, and a function nothing uses is never through one.
 *
 * **What it cannot see**, by design: a key that flows through an anonymous
 * callback's parameter or an object's property, and a camera surface reached
 * by anything but `getCommands()` or `getSDK()`. Every other blind spot errs
 * towards reporting a send, so the test goes red rather than green.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** The engine's camera-switch waiter, as `iracing-actions` imports it. */
export const WAITER = "requestCameraSwitch";

/** What kind of camera send a {@link CameraSend} is. */
export type CameraSendKind = "command" | "keystroke" | "escape";

/** One camera send the scan found. */
export interface CameraSend {
  /** The file, relative to the scanned root, with `/` separators. */
  readonly file: string;
  readonly line: number;
  readonly kind: CameraSendKind;
  /** The camera method called, the key-sending call's text, or what the surface escapes into. */
  readonly detail: string;
  /** The nearest named function around the send, or `(top level)`; with the file, an exception's key. */
  readonly context: string;
  /** Whether the send runs only inside a waiter callback. */
  readonly inWaiter: boolean;
  /** For a send outside the waiter, the first use that kept it out. */
  readonly why?: string;
}

/** What the scanner is told about the camera surface. */
export interface CameraScanOptions {
  /** The camera methods that set flags on the camera rather than switch it. */
  readonly stateMethods: ReadonlySet<string>;
  /** The calls that send a key binding (`tapBinding`, `holdBinding`). */
  readonly keySenders: ReadonlySet<string>;
  /** The names a camera key binding is reached by (`CAR_CYCLE_BINDING_KEYS`, `carCycleBindingKey`, …). */
  readonly cameraKeys: ReadonlySet<string>;
}

/** What one scan saw. */
export interface CameraScan {
  /** Every file scanned. */
  readonly files: readonly string[];
  /** How many `requestCameraSwitch` calls the files make. */
  readonly waiterCalls: number;
  /** Every wrapper found, as `<name>(<parameter index>)`. */
  readonly wrappers: readonly string[];
  /** Every camera send, in file and line order. */
  readonly sends: readonly CameraSend[];
  /** How many state-method calls (not switches) the files make. */
  readonly stateCalls: number;
}

/** `<file>:<context>`, the key an exception is written under. */
export function sendKey(send: Pick<CameraSend, "file" | "context">): string {
  return `${send.file}:${send.context}`;
}

/** Every production `.ts` file under `dir`, recursively, by its path relative to `dir`: no tests, test support or declarations. */
export function readProductionSources(dir: string): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);

      if (entry.isDirectory()) {
        walk(full);
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

/** The public methods of the class `className` in `source` (the SDK's `CameraCommand`). */
export function publicMethodsOf(source: string, className: string): string[] {
  const file = ts.createSourceFile("class.ts", source, ts.ScriptTarget.ESNext, true);
  const methods: string[] = [];

  for (const statement of file.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue;

    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;

      const hidden = (ts.getModifiers(member) ?? []).some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
      );

      if (!hidden) methods.push(member.name.text);
    }
  }

  return methods;
}

/** Every `.camera()` call, and every `camera` destructured out of `engineEnv()`, in the engine's sources: who reaches the injected camera. */
export function engineCameraReaches(sources: ReadonlyMap<string, string>): { file: string; line: number }[] {
  const found: { file: string; line: number }[] = [];

  for (const [name, text] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    const file = ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true);
    const visit = (node: ts.Node): void => {
      const isCameraCall =
        ts.isCallExpression(node) &&
        node.arguments.length === 0 &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "camera";
      const isDestructured =
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer !== undefined &&
        ts.isCallExpression(unwrap(node.initializer)) &&
        ts.isIdentifier((unwrap(node.initializer) as ts.CallExpression).expression) &&
        ((unwrap(node.initializer) as ts.CallExpression).expression as ts.Identifier).text === "engineEnv" &&
        node.name.elements.some((element) => (element.propertyName ?? element.name).getText(file) === "camera");

      if (isCameraCall || isDestructured) found.push({ file: name, line: lineOf(file, node) });

      ts.forEachChild(node, visit);
    };

    visit(file);
  }

  return found;
}

/**
 * What is wrong with an exception list against a scan: a send outside the
 * waiter that no entry names, an entry that names no send outside it (stale),
 * and an entry with no reason.
 */
export function exceptionProblems(
  exceptions: Readonly<Record<string, string>>,
  sends: readonly CameraSend[],
): string[] {
  const problems: string[] = [];
  const outside = sends.filter((send) => !send.inWaiter);
  const named = new Set(outside.map(sendKey));

  for (const send of outside) {
    if (exceptions[sendKey(send)] === undefined) {
      problems.push(
        `${send.file}:${send.line} ${send.kind} ${send.detail} in ${send.context} is not sent through ${WAITER}: ${send.why ?? "outside any waiter callback"}`,
      );
    }
  }

  for (const [key, reason] of Object.entries(exceptions)) {
    if (!named.has(key))
      problems.push(`stale exception ${key}: the scan finds no camera send outside the waiter there`);

    if (reason.trim() === "") problems.push(`exception ${key} has no reason`);
  }

  return problems;
}

const VIRTUAL_ROOT = "/camera-switch-scan/";

/** Where the camera surface is reached from: the SDK bundle, its commands, or the camera itself. */
type Level = "sdk" | "commands" | "camera";

/** A named function: a binding (resolved by symbol) or a member (resolved by name). */
interface Def {
  readonly key: string;
  readonly name: string;
  /** True for an exported binding, whose imports elsewhere count as uses. */
  readonly exported: boolean;
}

/** Where a node runs: inside a waiter callback, inside a named function, or neither. */
type Context = { readonly kind: "root" } | { readonly kind: "def"; readonly key: string } | { readonly kind: "none" };

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

/** The outermost expression `node` is wrapped in by parentheses, `as`, `satisfies` or `!`. */
function outermost(node: ts.Node): ts.Node {
  let current = node;

  while (
    current.parent !== undefined &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent))
  ) {
    current = current.parent;
  }

  return current;
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (name === undefined) return undefined;

  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function isFunctionValue(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** Whether `node` sits in a type: a type annotation, an interface, a type alias, `typeof x`. */
function inType(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return true;

    if (ts.isStatement(current) || ts.isClassElement(current) || ts.isSourceFile(current)) return false;
  }

  return false;
}

/** Whether `id` is a reference to a value, not a declaration's name, a member name or an import / export specifier. */
function isReference(id: ts.Identifier): boolean {
  const parent = id.parent;

  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;

  if (ts.isQualifiedName(parent)) return false;

  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;

  if (ts.isShorthandPropertyAssignment(parent)) return true;

  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return false;

  if (ts.isNamespaceImport(parent) || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) {
    return false;
  }

  // Any other node whose `name` is the identifier declares it: a variable, a
  // parameter, a function, a class member, an object-literal property.
  if ((parent as { readonly name?: ts.Node }).name === id) return false;

  return !inType(id);
}

/** The value an identifier refers to: for `{ x }` in an object literal, the binding `x`, not the property. */
function valueSymbolOf(checker: ts.TypeChecker, id: ts.Identifier): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(id.parent)
    ? checker.getShorthandAssignmentValueSymbol(id.parent)
    : checker.getSymbolAtLocation(id);
}

function createProgram(sources: ReadonlyMap<string, string>): ts.Program {
  const byPath = new Map<string, string>();

  for (const [name, text] of sources) byPath.set(VIRTUAL_ROOT + name, text);

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
    getDefaultLibFileName: () => `${VIRTUAL_ROOT}lib.d.ts`,
    writeFile: () => undefined,
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => byPath.has(fileName),
    readFile: (fileName) => byPath.get(fileName),
  };

  return ts.createProgram([...byPath.keys()], options, host);
}

/**
 * Scans `sources` (path → text) for camera sends and judges each against the
 * waiter. Throws when a source does not load, so a broken glob can never scan
 * as "nothing found, nothing wrong".
 */
export function scanCameraSends(sources: ReadonlyMap<string, string>, options: CameraScanOptions): CameraScan {
  const program = createProgram(sources);
  const checker = program.getTypeChecker();
  const files: { name: string; file: ts.SourceFile }[] = [];

  for (const name of [...sources.keys()].sort()) {
    const file = program.getSourceFile(VIRTUAL_ROOT + name);

    if (file === undefined) throw new Error(`camera scan: ${name} did not load`);

    files.push({ name, file });
  }

  const fileOf = new Map<ts.SourceFile, string>(files.map(({ name, file }) => [file, name]));

  // --- Pass 1: named functions, imports, calls, identifiers.
  const defOf = new Map<ts.Node, Def>();
  const defsByKey = new Map<string, ts.SignatureDeclaration[]>();
  const bindingKeyOf = new Map<ts.Symbol, string>();
  const exportedKeysByName = new Map<string, string[]>();
  const importedNameOf = new Map<ts.Symbol, string>();
  const calls: ts.CallExpression[] = [];
  const identifiers: ts.Identifier[] = [];
  const memberUses: { name: string; node: ts.Node }[] = [];
  const variableDeclarations: ts.VariableDeclaration[] = [];
  const exportedLocals = new Set<ts.Symbol>();

  const addDef = (node: ts.SignatureDeclaration, def: Def): void => {
    defOf.set(node, def);
    defsByKey.set(def.key, [...(defsByKey.get(def.key) ?? []), node]);
  };

  for (const { name: fileName, file } of files) {
    // Names exported by `export { a, b }`, so their bindings count as exported.
    for (const statement of file.statements) {
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined && statement.exportClause) {
        if (!ts.isNamedExports(statement.exportClause)) continue;

        for (const element of statement.exportClause.elements) {
          const symbol = checker.getExportSpecifierLocalTargetSymbol(element);

          if (symbol !== undefined) exportedLocals.add(symbol);
        }
      }
    }

    const visit = (node: ts.Node): void => {
      if (ts.isImportSpecifier(node)) {
        const symbol = checker.getSymbolAtLocation(node.name);

        if (symbol !== undefined) importedNameOf.set(symbol, (node.propertyName ?? node.name).text);
      } else if (ts.isCallExpression(node)) {
        calls.push(node);
      } else if (ts.isIdentifier(node)) {
        identifiers.push(node);
      } else if (ts.isPropertyAccessExpression(node)) {
        memberUses.push({ name: node.name.text, node });
      } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        memberUses.push({ name: node.argumentExpression.text, node });
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const member = propertyNameText(node.propertyName ?? node.name);

        if (member !== undefined) memberUses.push({ name: member, node });
      }

      if (ts.isVariableDeclaration(node)) variableDeclarations.push(node);

      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
        const symbol = checker.getSymbolAtLocation(node.name);

        if (symbol !== undefined) {
          const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword) || exportedLocals.has(symbol);
          const key = `${fileName}#${node.name.text}@${node.pos}`;

          bindingKeyOf.set(symbol, key);
          addDef(node, { key, name: node.name.text, exported });
        }
      } else if (isFunctionValue(node)) {
        const holder = outermost(node).parent;

        if (holder !== undefined && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
          const symbol = checker.getSymbolAtLocation(holder.name);
          const statement = holder.parent.parent;

          if (symbol !== undefined) {
            const exported =
              (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) ||
              exportedLocals.has(symbol);
            const key = `${fileName}#${holder.name.text}@${holder.pos}`;

            bindingKeyOf.set(symbol, key);
            addDef(node, { key, name: holder.name.text, exported });
          }
        } else if (holder !== undefined && (ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder))) {
          const member = propertyNameText(holder.name);

          if (member !== undefined) addDef(node, { key: `.${member}`, name: member, exported: false });
        }
      } else if (
        (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
        node.body !== undefined
      ) {
        const member = propertyNameText(node.name);

        if (member !== undefined) addDef(node, { key: `.${member}`, name: member, exported: false });
      }

      ts.forEachChild(node, visit);
    };

    visit(file);
  }

  for (const def of defOf.values()) {
    if (def.exported) exportedKeysByName.set(def.name, [...(exportedKeysByName.get(def.name) ?? []), def.key]);
  }

  /** The named functions an identifier refers to: its own binding, or every exported one of the name it imports. */
  const keysOfIdentifier = (id: ts.Identifier): string[] => {
    const symbol = valueSymbolOf(checker, id);

    if (symbol === undefined) return [];

    const own = bindingKeyOf.get(symbol);

    if (own !== undefined) return [own];

    const imported = importedNameOf.get(symbol);

    return imported === undefined ? [] : (exportedKeysByName.get(imported) ?? []);
  };

  /** The named functions a call's callee can be. */
  const calleeKeys = (call: ts.CallExpression): string[] => {
    const callee = unwrap(call.expression);

    if (ts.isIdentifier(callee)) return keysOfIdentifier(callee);

    if (ts.isPropertyAccessExpression(callee)) return [`.${callee.name.text}`];

    return [];
  };

  /** The name a call's callee is written with: `f(…)` or `x.f(…)`. */
  const calleeName = (call: ts.CallExpression): string | undefined => {
    const callee = unwrap(call.expression);

    if (ts.isIdentifier(callee)) {
      const symbol = checker.getSymbolAtLocation(callee);
      const imported = symbol === undefined ? undefined : importedNameOf.get(symbol);

      return imported ?? callee.text;
    }

    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;

    return undefined;
  };

  const waiterCalls = calls.filter((call) => calleeName(call) === WAITER);

  // --- Pass 2: wrappers and the waiter callbacks, to a fixpoint.
  const wrapperIndexes = new Map<ts.SignatureDeclaration, Set<number>>();
  let rootArgs = new Set<ts.Node>();

  const keyWrapsAt = (key: string, index: number): boolean => {
    const nodes = defsByKey.get(key) ?? [];

    return nodes.length > 0 && nodes.every((node) => wrapperIndexes.get(node)?.has(index) === true);
  };

  for (;;) {
    rootArgs = new Set<ts.Node>();

    for (const call of waiterCalls) {
      if (call.arguments[0] !== undefined) rootArgs.add(call.arguments[0]);
    }

    for (const call of calls) {
      const keys = calleeKeys(call);

      if (keys.length === 0) continue;

      call.arguments.forEach((argument, index) => {
        if (keys.every((key) => keyWrapsAt(key, index))) rootArgs.add(argument);
      });
    }

    let grew = false;

    for (const argument of rootArgs) {
      const value = unwrap(argument as ts.Expression);

      if (!ts.isIdentifier(value)) continue;

      const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;

      if (declaration === undefined || !ts.isParameter(declaration)) continue;

      const owner = declaration.parent;

      if (!defOf.has(owner)) continue;

      const index = owner.parameters.indexOf(declaration);
      const indexes = wrapperIndexes.get(owner) ?? new Set<number>();

      if (!indexes.has(index)) {
        indexes.add(index);
        wrapperIndexes.set(owner, indexes);
        grew = true;
      }
    }

    if (!grew) break;
  }

  // --- Pass 3: where each node runs, and which named functions run only inside a waiter callback.
  const contextCache = new Map<ts.Node, Context>();
  const contextOf = (node: ts.Node): Context => {
    const cached = contextCache.get(node);

    if (cached !== undefined) return cached;

    let context: Context = { kind: "none" };

    for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
      if (rootArgs.has(current)) {
        context = { kind: "root" };
        break;
      }

      const def = defOf.get(current);

      if (def !== undefined && current !== node) {
        context = { kind: "def", key: def.key };
        break;
      }

      if (ts.isConstructorDeclaration(current) || ts.isClassStaticBlockDeclaration(current)) break;

      if (ts.isPropertyDeclaration(current) && current !== node) break;
    }

    contextCache.set(node, context);

    return context;
  };

  /** The nearest named function around `node`, for the report. */
  const nearestDefName = (node: ts.Node): string => {
    for (let current = node.parent; current !== undefined; current = current.parent) {
      const def = defOf.get(current);

      if (def !== undefined) return def.name;
    }

    return "(top level)";
  };

  const usesByKey = new Map<string, ts.Node[]>();
  const addUse = (key: string, node: ts.Node): void => {
    if (!defsByKey.has(key)) return;

    usesByKey.set(key, [...(usesByKey.get(key) ?? []), node]);
  };

  for (const id of identifiers) {
    if (!isReference(id)) continue;

    for (const key of keysOfIdentifier(id)) addUse(key, id);
  }

  for (const { name, node } of memberUses) {
    if (!inType(node)) addUse(`.${name}`, node);
  }

  const describe = (node: ts.Node): string => {
    const file = node.getSourceFile();

    return `${fileOf.get(file) ?? file.fileName}:${lineOf(file, node)} (${node.getText(file).split("\n")[0].slice(0, 60)})`;
  };

  const blockedBy = new Map<string, string>();
  const onlyInWaiter = new Map<string, boolean>();

  for (const key of defsByKey.keys()) {
    const uses = usesByKey.get(key) ?? [];

    onlyInWaiter.set(key, uses.length > 0);

    if (uses.length === 0) blockedBy.set(key, `nothing uses ${key}`);
  }

  for (let changed = true; changed;) {
    changed = false;

    for (const [key, ok] of onlyInWaiter) {
      if (!ok) continue;

      for (const use of usesByKey.get(key) ?? []) {
        const context = contextOf(use);

        if (context.kind === "root") continue;

        if (context.kind === "def" && onlyInWaiter.get(context.key) === true) continue;

        onlyInWaiter.set(key, false);
        // One hop only: the chain behind it runs through name-merged members
        // of unrelated files and says more than it helps.
        blockedBy.set(
          key,
          context.kind === "def"
            ? `${key} is used at ${describe(use)}, in ${context.key}, which runs outside the waiter too`
            : `${key} is used outside any function at ${describe(use)}`,
        );
        changed = true;
        break;
      }
    }
  }

  const judge = (node: ts.Node): { inWaiter: boolean; why?: string } => {
    const context = contextOf(node);

    if (context.kind === "root") return { inWaiter: true };

    if (context.kind === "def") {
      return onlyInWaiter.get(context.key) === true
        ? { inWaiter: true }
        : { inWaiter: false, why: blockedBy.get(context.key) ?? "outside the waiter" };
    }

    return { inWaiter: false, why: "at module top level, in a constructor or in a class field" };
  };

  const sends: CameraSend[] = [];
  let stateCalls = 0;
  const record = (node: ts.Node, kind: CameraSendKind, detail: string): void => {
    const file = node.getSourceFile();

    sends.push({
      file: fileOf.get(file) ?? file.fileName,
      line: lineOf(file, node),
      kind,
      detail,
      context: nearestDefName(node),
      ...judge(node),
    });
  };

  // --- Pass 4: the camera command surface.
  const levelSymbols = new Map<ts.Symbol, Level>();
  const levelOf = (expression: ts.Expression): Level | undefined => {
    const value = unwrap(expression);

    if (ts.isCallExpression(value) && value.arguments.length === 0) {
      const name = calleeName(value);

      if (ts.isIdentifier(unwrap(value.expression)) && name === "getCommands") return "commands";

      if (ts.isIdentifier(unwrap(value.expression)) && name === "getSDK") return "sdk";

      return undefined;
    }

    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const member = ts.isPropertyAccessExpression(value)
        ? value.name.text
        : ts.isStringLiteralLike(value.argumentExpression)
          ? value.argumentExpression.text
          : undefined;
      const from = levelOf(value.expression);

      if (from === "sdk" && member === "commands") return "commands";

      if (from === "commands" && member === "camera") return "camera";

      return undefined;
    }

    if (ts.isIdentifier(value)) {
      const symbol = valueSymbolOf(checker, value);

      return symbol === undefined ? undefined : levelSymbols.get(symbol);
    }

    return undefined;
  };
  const nextLevel = (from: Level, member: string | undefined): Level | undefined => {
    if (from === "sdk" && member === "commands") return "commands";

    if (from === "commands" && member === "camera") return "camera";

    return undefined;
  };
  const bindPattern = (pattern: ts.BindingName, from: Level): boolean => {
    let grew = false;

    if (ts.isIdentifier(pattern)) {
      const symbol = checker.getSymbolAtLocation(pattern);

      if (symbol !== undefined && levelSymbols.get(symbol) !== from) {
        levelSymbols.set(symbol, from);
        grew = true;
      }

      return grew;
    }

    if (!ts.isObjectBindingPattern(pattern)) return false;

    for (const element of pattern.elements) {
      const to = nextLevel(from, propertyNameText(element.propertyName ?? element.name));

      if (to !== undefined && bindPattern(element.name, to)) grew = true;
    }

    return grew;
  };

  for (let grew = true; grew;) {
    grew = false;

    for (const declaration of variableDeclarations) {
      if (declaration.initializer === undefined) continue;

      const level = levelOf(declaration.initializer);

      if (level !== undefined && bindPattern(declaration.name, level)) grew = true;
    }
  }

  const seen = new Set<ts.Node>();
  const judgeSurface = (expression: ts.Expression, level: Level): void => {
    const top = outermost(expression);

    if (seen.has(top)) return;

    seen.add(top);

    const parent = top.parent;

    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === top) {
      if (level !== "camera") return;

      const method = ts.isPropertyAccessExpression(parent)
        ? parent.name.text
        : ts.isStringLiteralLike(parent.argumentExpression)
          ? parent.argumentExpression.text
          : "[computed]";
      const call = outermost(parent).parent;

      if (call !== undefined && ts.isCallExpression(call) && outermost(parent) === call.expression) {
        if (options.stateMethods.has(method)) stateCalls++;
        else record(call, "command", method);

        return;
      }

      record(parent, "escape", `camera.${method} read without a call`);

      return;
    }

    if (ts.isVariableDeclaration(parent) && parent.initializer === top) {
      if (ts.isIdentifier(parent.name)) return;

      if (ts.isObjectBindingPattern(parent.name)) {
        if (level === "camera") {
          record(parent, "escape", "the camera's methods destructured");

          return;
        }

        for (const element of parent.name.elements) {
          const to = nextLevel(level, propertyNameText(element.propertyName ?? element.name));

          if (to === "camera" && ts.isObjectBindingPattern(element.name)) {
            record(element, "escape", "the camera's methods destructured");
          }
        }

        return;
      }
    }

    record(
      top,
      "escape",
      `the ${level === "camera" ? "camera" : level === "commands" ? "commands" : "SDK"} ${ts.SyntaxKind[parent.kind]}`,
    );
  };

  for (const { file } of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isExpression(node) && !(ts.isIdentifier(node) && !isReference(node))) {
        const level = levelOf(node);

        if (level !== undefined) judgeSurface(node, level);
      }

      ts.forEachChild(node, visit);
    };

    visit(file);
  }

  // --- Pass 5: camera key bindings tapped or held.
  const taintedSymbols = new Set<ts.Symbol>();
  const taintedExportedNames = new Set<string>();
  const taintedKeys = new Set<string>();

  const isTaintedIdentifier = (id: ts.Identifier): boolean => {
    if (!isReference(id)) return false;

    if (options.cameraKeys.has(id.text)) return true;

    const symbol = valueSymbolOf(checker, id);

    if (symbol === undefined) return false;

    if (taintedSymbols.has(symbol)) return true;

    const imported = importedNameOf.get(symbol);

    return imported !== undefined && (options.cameraKeys.has(imported) || taintedExportedNames.has(imported));
  };
  const containsTaint = (root: ts.Node): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;

      if (ts.isIdentifier(node) && isTaintedIdentifier(node)) {
        found = true;

        return;
      }

      if (ts.isCallExpression(node) && calleeKeys(node).some((key) => taintedKeys.has(key))) {
        found = true;

        return;
      }

      ts.forEachChild(node, visit);
    };

    visit(root);

    return found;
  };
  const returnsOf = (fn: ts.Node): ts.Node[] => {
    const body = (fn as ts.FunctionLikeDeclaration).body;

    if (body === undefined) return [];

    if (!ts.isBlock(body)) return [body];

    const found: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (node !== body && ts.isFunctionLike(node)) return;

      if (ts.isReturnStatement(node) && node.expression !== undefined) found.push(node.expression);

      ts.forEachChild(node, visit);
    };

    visit(body);

    return found;
  };

  for (let grew = true; grew;) {
    grew = false;

    for (const declaration of variableDeclarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;

      const symbol = checker.getSymbolAtLocation(declaration.name);

      if (symbol === undefined || taintedSymbols.has(symbol) || !containsTaint(declaration.initializer)) continue;

      taintedSymbols.add(symbol);

      const statement = declaration.parent.parent;

      if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        taintedExportedNames.add(declaration.name.text);
      }

      grew = true;
    }

    for (const [node, def] of defOf) {
      if (taintedKeys.has(def.key) || !returnsOf(node).some(containsTaint)) continue;

      taintedKeys.add(def.key);
      grew = true;
    }
  }

  const callsByKey = new Map<string, ts.CallExpression[]>();

  for (const call of calls) {
    for (const key of calleeKeys(call)) callsByKey.set(key, [...(callsByKey.get(key) ?? []), call]);
  }

  const isCameraKey = (expression: ts.Expression, visiting: Set<string>): boolean => {
    if (containsTaint(expression)) return true;

    const value = unwrap(expression);

    if (!ts.isIdentifier(value)) return false;

    const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;

    if (declaration === undefined || !ts.isParameter(declaration)) return false;

    const def = defOf.get(declaration.parent);

    if (def === undefined) return false;

    const index = declaration.parent.parameters.indexOf(declaration);
    const mark = `${def.key}(${index})`;

    if (visiting.has(mark)) return false;

    visiting.add(mark);

    return (callsByKey.get(def.key) ?? []).some((call) => {
      const argument = call.arguments[index];

      return argument !== undefined && isCameraKey(argument, visiting);
    });
  };

  for (const call of calls) {
    const name = calleeName(call);

    if (name === undefined || !options.keySenders.has(name) || call.arguments[0] === undefined) continue;

    if (options.keySenders.has(nearestDefName(call))) continue;

    if (isCameraKey(call.arguments[0], new Set())) {
      record(call, "keystroke", call.getText(call.getSourceFile()).split("\n")[0].slice(0, 80));
    }
  }

  sends.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const wrappers: string[] = [];

  for (const [node, indexes] of wrapperIndexes) {
    const def = defOf.get(node);

    if (def !== undefined) wrappers.push(...[...indexes].map((index) => `${def.name}(${index})`));
  }

  return {
    files: files.map(({ name }) => name),
    waiterCalls: waiterCalls.length,
    wrappers: wrappers.sort(),
    sends,
    stateCalls,
  };
}
