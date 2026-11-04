/**
 * The scanner behind `state-slices.test.ts` (#1588): whether `TranslatorState`
 * keeps to the slice convention of the #1588 spec (decision 1), checked by the
 * four rules of its decision 3. It reads the sources with the TypeScript
 * compiler (parser and binder only, no type check), so a comment, a string or
 * a nested scope's binding of the same name is never mistaken for one.
 *
 * **Sections.** Each `TranslatorState` member sits in the section named by the
 * nearest `// ── <heading> ──` comment above it in the type, read from the
 * leading comments of the members in order. A member before any heading is an
 * error of its own (`heading`).
 *
 * **A slice** is a `TranslatorState` member whose annotation is a bare
 * reference to an object type alias declared in `state.ts` whose name ends in
 * `State` (`trackGaps: TrackGapsState`). Its key is a *slice key*, its alias a
 * *slice type*.
 *
 * **The rules**, each finding reported with the name it is about:
 * - **A** — a member the pin does not name must be a slice: its type literal
 *   has no optional (`?:`) member, `create<Type>` is declared in `state.ts`,
 *   and `createInitialState`'s returned object initialises it with a
 *   no-argument call to it. Reported by member name, or `<Type>.<field>` for an
 *   optional field.
 * - **B** — the pin only shrinks, and each pinned name sits under its own
 *   heading: a pinned name that is no longer a member, a name pinned under a
 *   heading other than the one it sits under, a name pinned twice, an empty
 *   entry, or an entry whose heading `state.ts` no longer has. Reported by
 *   member name, or by heading for the last two.
 * - **C** — under `diff/`, a module that imports `TranslatorState`
 *   (`import type { … }`, `import { type … }`, plain, through a namespace
 *   import used as `ns.TranslatorState`, or inline as
 *   `import("../state.js").TranslatorState`):
 *   - names no slice type;
 *   - exports no type alias or interface that is, or holds, the state (the
 *     scan reads each module alone, so a module importing such a type would
 *     reach the state unseen);
 *   - reads no slice key off a value whose type IS the state.
 *
 *   A type is the state through parentheses, unions, intersections,
 *   `Readonly` / `Pick` / `Omit` / `Partial` / `Required` / `NonNullable` and
 *   module-local aliases and interfaces, alias of an alias included. A type
 *   literal is a container whose properties have types of their own, so
 *   `ctx.state.fastestLap` on `ctx: { state: TranslatorState }` is a read
 *   while `ctx.fastestLap` is not; an indexed access selects a container's
 *   property and is never the state (`TranslatorState["gapTraces"]` is a
 *   field of it). A value has a type when it is a parameter or variable
 *   annotated with it, a variable initialised from such a value, or a
 *   property of a container value. The reads are property and element
 *   accesses, destructuring declarations and parameters, and destructuring
 *   assignments. A slice key on any other receiver is not a match:
 *   `other.fastestLap` passes. Reported by slice key, type name or exported
 *   name. The allow-list exempts a `<module>:<key>` read, and an entry that
 *   matches no read is itself a finding (`allow`).
 * - **D** — under `diff/`, in any module, no slice is replaced through its
 *   parent: no assignment (`=`, `??=`, …) to `<x>.<sliceKey>` or
 *   `<x>["<sliceKey>"]`, no such target in a destructuring assignment or a
 *   `for … of` / `for … in` head, and no `Object.assign(<x>, { <sliceKey>: … })`
 *   (shorthand included). `Object.assign(<slice>, create<Type>())`, the in-place
 *   clear, passes. Reported by slice key.
 *
 * `scan` findings are a source the scanner cannot read at all (no
 * `TranslatorState` type literal, no `createInitialState` returning an object
 * literal).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** Which rule a violation breaks; `heading`, `allow` and `scan` are the scanner's own. */
export type SliceRule = "A" | "B" | "C" | "D" | "heading" | "allow" | "scan";

/** One broken rule, by the name it is about and what to do. */
export interface SliceViolation {
  readonly rule: SliceRule;
  /** The member, slice key, slice type, `<Type>.<field>`, heading or allow-list key the finding is about. */
  readonly name: string;
  /** The diff module, relative to `diff/` (`laps.ts`), for a C or D finding. */
  readonly module?: string;
  readonly line?: number;
  /** What is wrong and what to do about it. */
  readonly message: string;
}

/** One `TranslatorState` member and the section it sits in. */
export interface StateMember {
  readonly name: string;
  /** The heading text of its section, or `null` before any heading. */
  readonly section: string | null;
  readonly line: number;
}

/** One slice of `TranslatorState`. */
export interface SliceMember {
  readonly key: string;
  readonly type: string;
}

/** One read of a slice key through a `TranslatorState` binding in a diff module (rule C). */
export interface SliceRead {
  readonly module: string;
  readonly key: string;
  readonly line: number;
  /** Whether the allow-list exempts it. */
  readonly allowed: boolean;
}

/** What one scan saw. */
export interface SliceScan {
  /** Every `TranslatorState` member, in source order. */
  readonly members: readonly StateMember[];
  /** Every slice, in source order. */
  readonly slices: readonly SliceMember[];
  /** Every diff module scanned, relative to `diff/`. */
  readonly diffModules: readonly string[];
  /** The diff modules that import `TranslatorState`, in either import form. */
  readonly stateImporters: readonly string[];
  /** Every rule-C read of a slice key, allowed or not. */
  readonly sliceReads: readonly SliceRead[];
  /** Every rule broken, in the order found. */
  readonly violations: readonly SliceViolation[];
}

/** The sources a scan reads: `state.ts`'s text and every production module under `diff/`. */
export interface SliceSources {
  readonly state: string;
  /** Path relative to `diff/` with `/` separators → text. */
  readonly diff: ReadonlyMap<string, string>;
}

/** Section heading → the flat member names still under it. */
export type FlatMemberPin = Readonly<Record<string, readonly string[]>>;

/** `<module>:<sliceKey>` (module relative to `diff/`) → why that module may still read that slice through `TranslatorState`. */
export type SliceReadAllowList = Readonly<Record<string, string>>;

/** `state.ts` and every production `.ts` module under `diff/` (no tests, test support or declarations), from the package's `src`. */
export function readSliceSources(srcDir: string): SliceSources {
  const diffDir = join(srcDir, "diff");
  const diff = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);

        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;

      if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".test-support.ts")) {
        continue;
      }

      diff.set(relative(diffDir, full).split(sep).join("/"), readFileSync(full, "utf8"));
    }
  };

  walk(diffDir);

  return { state: readFileSync(join(srcDir, "state.ts"), "utf8"), diff };
}

const HEADING = /^\/\/\s*──\s*(.+?)\s*─*\s*$/;
const STATE_TYPE = "TranslatorState";
const VIRTUAL_ROOT = "/virtual/diff/";
const DECISION_1 = "#1588 spec, decision 1";

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/** `expression` without the parentheses, `as`, `satisfies`, type assertions and `!` around it. */
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

/** A property name as text, for identifier and string-literal names only. */
function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (name === undefined) return undefined;

  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;

  return undefined;
}

/** Every node under `root` (itself included), depth first. */
function eachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, walk);
  };

  walk(root);
}

// ── state.ts ────────────────────────────────────────────────────────────

interface StateFile {
  readonly file: ts.SourceFile;
  readonly members: readonly { readonly member: StateMember; readonly node: ts.TypeElement }[];
  readonly headings: ReadonlySet<string>;
  readonly aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>;
  readonly functions: ReadonlySet<string>;
  /** `createInitialState`'s returned object literal, by property name. */
  readonly initial: ReadonlyMap<string, ts.ObjectLiteralElementLike> | null;
}

function readStateFile(text: string, violations: SliceViolation[]): StateFile {
  const file = ts.createSourceFile("state.ts", text, ts.ScriptTarget.ESNext, true);
  const aliases = new Map<string, ts.TypeAliasDeclaration>();
  const functions = new Set<string>();
  let initialFn: ts.FunctionDeclaration | undefined;

  for (const statement of file.statements) {
    if (ts.isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement);

    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      functions.add(statement.name.text);

      if (statement.name.text === "createInitialState") initialFn = statement;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);

        if (ts.isIdentifier(declaration.name) && init !== undefined) {
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) functions.add(declaration.name.text);
        }
      }
    }
  }

  const members: { member: StateMember; node: ts.TypeElement }[] = [];
  const headings = new Set<string>();
  const stateAlias = aliases.get(STATE_TYPE);

  if (stateAlias === undefined || !ts.isTypeLiteralNode(stateAlias.type)) {
    violations.push({
      rule: "scan",
      name: STATE_TYPE,
      message: `state.ts declares no \`type ${STATE_TYPE} = { … }\` object type alias, so nothing can be checked.`,
    });
  } else {
    let section: string | null = null;

    for (const node of stateAlias.type.members) {
      for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
        if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;

        const heading = HEADING.exec(text.slice(range.pos, range.end));

        if (heading !== null) {
          section = heading[1];
          headings.add(section);
        }
      }

      const name = propertyNameText(node.name);

      if (name === undefined) {
        violations.push({
          rule: "scan",
          name: node.getText(file),
          message: `${STATE_TYPE} member at state.ts:${lineOf(file, node)} has no plain name; the scanner reads property signatures with identifier or string names only.`,
        });

        continue;
      }

      members.push({ member: { name, section, line: lineOf(file, node) }, node });
    }
  }

  let initial: Map<string, ts.ObjectLiteralElementLike> | null = null;

  if (initialFn?.body !== undefined) {
    eachNode(initialFn.body, (node) => {
      if (initial !== null || !ts.isReturnStatement(node) || node.expression === undefined) return;

      const returned = unwrap(node.expression);

      if (!ts.isObjectLiteralExpression(returned)) return;

      initial = new Map();

      for (const property of returned.properties) {
        const name = ts.isSpreadAssignment(property) ? undefined : propertyNameText(property.name);

        if (name !== undefined) initial.set(name, property);
      }
    });
  }

  if (initial === null) {
    violations.push({
      rule: "scan",
      name: "createInitialState",
      message:
        "state.ts has no `function createInitialState()` returning an object literal, so no slice's initialiser can be checked.",
    });
  }

  return { file, members, headings, aliases, functions, initial };
}

/** The slice type `node` is annotated with, or why it is not one. */
function sliceTypeOf(
  node: ts.TypeElement,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>,
): { type: string; literal: ts.TypeLiteralNode } | { reason: string } {
  const annotation = ts.isPropertySignature(node) ? node.type : undefined;

  if (annotation === undefined) return { reason: "it has no type annotation" };

  if (!ts.isTypeReferenceNode(annotation) || !ts.isIdentifier(annotation.typeName) || annotation.typeArguments) {
    return { reason: `its type \`${annotation.getText()}\` is not a bare reference to a \`<Family>State\` type` };
  }

  const type = annotation.typeName.text;

  if (!type.endsWith("State")) return { reason: `its type \`${type}\` does not end in \`State\`` };

  const alias = aliases.get(type);

  if (alias === undefined) return { reason: `its type \`${type}\` is not a type alias declared in state.ts` };

  if (!ts.isTypeLiteralNode(alias.type)) return { reason: `its type \`${type}\` is not an object type literal` };

  return { type, literal: alias.type };
}

/** Rules A and B and the heading check over `state.ts`; returns the slices found. */
function checkState(state: StateFile, pin: FlatMemberPin, violations: SliceViolation[]): SliceMember[] {
  const pinnedUnder = new Map<string, string>();

  for (const [heading, names] of Object.entries(pin)) {
    if (names.length === 0) {
      violations.push({
        rule: "B",
        name: heading,
        message: `LEGACY_FLAT_MEMBERS["${heading}"] is empty: delete the entry.`,
      });
    }

    if (!state.headings.has(heading)) {
      violations.push({
        rule: "B",
        name: heading,
        message: `LEGACY_FLAT_MEMBERS has an entry "${heading}", but ${STATE_TYPE} has no \`// ── ${heading} ──\` heading: rename the entry to the heading its members sit under in state.ts.`,
      });
    }

    for (const name of names) {
      const earlier = pinnedUnder.get(name);

      if (earlier !== undefined) {
        violations.push({
          rule: "B",
          name,
          message: `\`${name}\` is pinned under both "${earlier}" and "${heading}" in LEGACY_FLAT_MEMBERS: keep it only under the heading it sits under in state.ts.`,
        });

        continue;
      }

      pinnedUnder.set(name, heading);
    }
  }

  const memberNames = new Set(state.members.map(({ member }) => member.name));

  for (const [name, heading] of pinnedUnder) {
    if (!memberNames.has(name)) {
      violations.push({
        rule: "B",
        name,
        message: `LEGACY_FLAT_MEMBERS["${heading}"] pins \`${name}\`, which is no longer a ${STATE_TYPE} member: delete it from that entry, and the entry once it is empty. The pin only shrinks.`,
      });
    }
  }

  const slices: SliceMember[] = [];

  for (const { member, node } of state.members) {
    const where = `state.ts:${member.line}`;

    if (member.section === null) {
      violations.push({
        rule: "heading",
        name: member.name,
        message: `${STATE_TYPE}.${member.name} (${where}) sits before any \`// ── <heading> ──\` comment: put it under a heading.`,
      });
    }

    const pinned = pinnedUnder.get(member.name);

    if (pinned !== undefined) {
      if (member.section !== null && pinned !== member.section) {
        violations.push({
          rule: "B",
          name: member.name,
          message: `\`${member.name}\` is pinned under "${pinned}" in LEGACY_FLAT_MEMBERS but sits under "${member.section}" in state.ts (${where}): move it to the "${member.section}" entry of the pin.`,
        });
      }

      continue;
    }

    const slice = sliceTypeOf(node, state.aliases);

    if ("reason" in slice) {
      violations.push({
        rule: "A",
        name: member.name,
        message: `${STATE_TYPE}.${member.name} (${where}, under "${member.section ?? "no heading"}") is neither pinned flat in LEGACY_FLAT_MEMBERS nor a slice: ${slice.reason}. New state goes into a slice — one member \`<family>: <Family>State\`, the type and its \`create<Family>State()\` factory declared in state.ts, built in createInitialState by calling the factory (${DECISION_1}). Never add a name to the pin.`,
      });

      continue;
    }

    const { type, literal } = slice;
    const factory = `create${type}`;

    slices.push({ key: member.name, type });

    for (const field of literal.members) {
      if ((ts.isPropertySignature(field) || ts.isMethodSignature(field)) && field.questionToken !== undefined) {
        const fieldName = propertyNameText(field.name) ?? field.name.getText(state.file);

        violations.push({
          rule: "A",
          name: `${type}.${fieldName}`,
          message: `${type}.${fieldName} (state.ts:${lineOf(state.file, field)}) is optional: every slice field is set by ${factory}(), so make it required (\`| null\` for "not yet").`,
        });
      }
    }

    if (!state.functions.has(factory)) {
      violations.push({
        rule: "A",
        name: member.name,
        message: `The slice ${STATE_TYPE}.${member.name} has no factory: declare \`export function ${factory}(): ${type}\` in state.ts, beside ${type}.`,
      });
    }

    if (state.initial === null) continue;

    const property = state.initial.get(member.name);
    const init = property !== undefined && ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
    const callsFactory =
      init !== undefined &&
      ts.isCallExpression(init) &&
      ts.isIdentifier(init.expression) &&
      init.expression.text === factory &&
      init.arguments.length === 0;

    if (!callsFactory) {
      const found =
        property === undefined ? "does not initialise it" : `initialises it with \`${property.getText(state.file)}\``;

      violations.push({
        rule: "A",
        name: member.name,
        message: `${STATE_TYPE}.${member.name} is a ${type} slice, but createInitialState ${found}: write \`${member.name}: ${factory}()\`, with no arguments.`,
      });
    }
  }

  return slices;
}

// ── diff/ ───────────────────────────────────────────────────────────────

function createDiffProgram(sources: ReadonlyMap<string, string>): ts.Program {
  const byPath = new Map<string, string>();

  for (const [name, text] of sources) byPath.set(VIRTUAL_ROOT + name, text);

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

  return ts.createProgram(
    [...byPath.keys()],
    { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    host,
  );
}

/** Whether `specifier` is a relative import of the package's `state.ts`. */
function isStateModule(specifier: ts.Expression): boolean {
  return (
    ts.isStringLiteral(specifier) && specifier.text.startsWith(".") && /(^|\/)state(\.js|\.ts)?$/.test(specifier.text)
  );
}

interface ModuleScan {
  readonly importsState: boolean;
  readonly reads: readonly { readonly key: string; readonly line: number; readonly receiver: string }[];
}

/**
 * What a type is, for rule C: the state itself, a container whose named
 * properties have shapes of their own (`{ state: TranslatorState }`), or
 * neither (`null`). A container resolves its properties lazily, so a
 * recursive type is cut by the depth limit rather than walked forever.
 */
type Shape = { readonly kind: "state" } | Container | null;

interface Container {
  readonly kind: "container";
  readonly keys: readonly string[];
  property(key: string): Shape;
}

const STATE: Shape = { kind: "state" };

/** How deep a type is followed through aliases and container properties. */
const MAX_SHAPE_DEPTH = 12;

/** Generic types whose result is still the state when their first argument is: `Readonly<TranslatorState>`, `Pick<…>`. */
const STATE_PRESERVING = new Set(["Readonly", "Pick", "Omit", "Partial", "Required", "NonNullable"]);

/** One shape for several: the state if any is, else the containers merged, else `null`. */
function combineShapes(shapes: readonly Shape[]): Shape {
  if (shapes.some((shape) => shape?.kind === "state")) return STATE;

  const containers = shapes.filter((shape): shape is Container => shape?.kind === "container");

  if (containers.length === 0) return null;

  if (containers.length === 1) return containers[0];

  return {
    kind: "container",
    keys: [...new Set(containers.flatMap((container) => container.keys))],
    property: (key) => combineShapes(containers.map((container) => container.property(key))),
  };
}

/** Whether `shape` is the state or holds it in a property, at any depth up to the limit. */
function reachesState(shape: Shape, depth = 0): boolean {
  if (shape === null || depth > MAX_SHAPE_DEPTH) return false;

  if (shape.kind === "state") return true;

  return shape.keys.some((key) => reachesState(shape.property(key), depth + 1));
}

/** The single module specifier of an `import("…")` type, if it is a string. */
function importTypeSpecifier(node: ts.ImportTypeNode): ts.StringLiteral | undefined {
  const argument = node.argument;

  return ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal) ? argument.literal : undefined;
}

/** The rightmost name of an entity name (`X`, `ns.X`). */
function rightmostName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

/** Rules C and D over one diff module; pushes D and the type-level C findings, returns the slice reads. */
function scanModule(
  module: string,
  file: ts.SourceFile,
  checker: ts.TypeChecker,
  slices: readonly SliceMember[],
  violations: SliceViolation[],
): ModuleScan {
  const sliceKeys = new Map(slices.map((slice) => [slice.key, slice.type]));
  const sliceTypes = new Set(slices.map((slice) => slice.type));
  /** The local names `TranslatorState` is imported under. */
  const stateImports = new Set<ts.Symbol>();
  /** Namespace imports of `state.ts`. */
  const stateNamespaces = new Set<ts.Symbol>();
  /** Local names of slice types imported from `state.ts`, by alias symbol. */
  const sliceTypeAliases = new Map<ts.Symbol, string>();
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);
  const pushC = (name: string, node: ts.Node, message: (where: string) => string): void => {
    const line = lineOf(file, node);

    violations.push({ rule: "C", name, module, line, message: message(`diff/${module}:${line}`) });
  };

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !isStateModule(statement.moduleSpecifier)) continue;

    const bindings = statement.importClause?.namedBindings;

    if (bindings === undefined) continue;

    if (ts.isNamespaceImport(bindings)) {
      const symbol = symbolOf(bindings.name);

      if (symbol !== undefined) stateNamespaces.add(symbol);

      continue;
    }

    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      const symbol = symbolOf(element.name);

      if (symbol === undefined) continue;

      if (imported === STATE_TYPE) stateImports.add(symbol);

      if (sliceTypes.has(imported)) sliceTypeAliases.set(symbol, imported);
    }
  }

  /**
   * The `state.ts` export a type names, if any: `X` through a named import,
   * `ns.X` through a namespace import, or `import("../state.js").X` inline.
   */
  const stateExportOf = (node: ts.TypeReferenceNode | ts.ImportTypeNode): string | undefined => {
    if (ts.isImportTypeNode(node)) {
      const specifier = importTypeSpecifier(node);

      return specifier !== undefined && isStateModule(specifier) && node.qualifier !== undefined
        ? rightmostName(node.qualifier)
        : undefined;
    }

    const typeName = node.typeName;

    if (ts.isIdentifier(typeName)) {
      const symbol = symbolOf(typeName);

      if (symbol === undefined) return undefined;

      if (stateImports.has(symbol)) return STATE_TYPE;

      return sliceTypeAliases.get(symbol);
    }

    const left = ts.isIdentifier(typeName.left) ? symbolOf(typeName.left) : undefined;

    return left !== undefined && stateNamespaces.has(left) ? typeName.right.text : undefined;
  };

  /** The module-local type alias or interface `symbol` names, if it is one. */
  const localDeclarationsOf = (symbol: ts.Symbol | undefined): (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[] =>
    (symbol?.declarations ?? []).filter(
      (declaration): declaration is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
        (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) &&
        declaration.getSourceFile() === file,
    );

  const containerOf = (members: readonly ts.TypeElement[], depth: number): Shape => {
    const byKey = new Map<string, ts.TypeNode[]>();

    for (const member of members) {
      if (!ts.isPropertySignature(member) || member.type === undefined) continue;

      const key = propertyNameText(member.name);

      if (key === undefined) continue;

      byKey.set(key, [...(byKey.get(key) ?? []), member.type]);
    }

    if (byKey.size === 0) return null;

    return {
      kind: "container",
      keys: [...byKey.keys()],
      property: (key) => combineShapes((byKey.get(key) ?? []).map((type) => shapeOf(type, depth + 1))),
    };
  };

  /** The shape of a module-local alias or interface, through its declarations. */
  const declaredShape = (symbol: ts.Symbol | undefined, depth: number): Shape | undefined => {
    const declarations = localDeclarationsOf(symbol);

    if (declarations.length === 0) return undefined;

    return combineShapes(
      declarations.map((declaration) => {
        if (ts.isTypeAliasDeclaration(declaration)) return shapeOf(declaration.type, depth + 1);

        const heritage = (declaration.heritageClauses ?? []).flatMap((clause) =>
          clause.types.map((type) => heritageShape(type, depth + 1)),
        );

        return combineShapes([...heritage, containerOf(declaration.members, depth + 1)]);
      }),
    );
  };

  /** The shape a generic or plain name gives: the state import, a local declaration, or a state-preserving wrapper. */
  const namedShape = (
    name: ts.EntityName | ts.Expression,
    typeArguments: readonly ts.TypeNode[] | undefined,
    depth: number,
  ): Shape => {
    if (ts.isIdentifier(name)) {
      const symbol = symbolOf(name);

      if (symbol !== undefined && stateImports.has(symbol)) return STATE;

      const declared = declaredShape(symbol, depth);

      if (declared !== undefined) return declared;

      if (STATE_PRESERVING.has(name.text) && typeArguments !== undefined && typeArguments.length > 0) {
        return shapeOf(typeArguments[0], depth + 1);
      }

      return null;
    }

    const left = ts.isQualifiedName(name)
      ? name.left
      : ts.isPropertyAccessExpression(name)
        ? name.expression
        : undefined;
    const right = ts.isQualifiedName(name) ? name.right : ts.isPropertyAccessExpression(name) ? name.name : undefined;
    const namespace = left !== undefined && ts.isIdentifier(left) ? symbolOf(left) : undefined;

    return namespace !== undefined && stateNamespaces.has(namespace) && right?.text === STATE_TYPE ? STATE : null;
  };

  const heritageShape = (heritage: ts.ExpressionWithTypeArguments, depth: number): Shape =>
    namedShape(heritage.expression, heritage.typeArguments, depth);

  /**
   * What `type` is. The state is the state through parentheses, unions,
   * intersections, `Readonly` / `Pick` / `Omit` / `Partial` / `Required` /
   * `NonNullable` and module-local aliases and interfaces; a type literal is a
   * container; an indexed access is the property it selects of a container,
   * and never the state (`TranslatorState["gapTraces"]` is a field of it).
   */
  function shapeOf(type: ts.TypeNode, depth = 0): Shape {
    if (depth > MAX_SHAPE_DEPTH) return null;

    if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
      // `readonly X` only applies to arrays and tuples, which are never the state.
      return ts.isParenthesizedTypeNode(type) ? shapeOf(type.type, depth + 1) : null;
    }

    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
      return combineShapes(type.types.map((member) => shapeOf(member, depth + 1)));
    }

    if (ts.isImportTypeNode(type)) return stateExportOf(type) === STATE_TYPE ? STATE : null;

    if (ts.isTypeReferenceNode(type)) return namedShape(type.typeName, type.typeArguments, depth);

    if (ts.isTypeLiteralNode(type)) return containerOf(type.members, depth);

    if (ts.isIndexedAccessTypeNode(type)) {
      const index = type.indexType;
      const key = ts.isLiteralTypeNode(index) && ts.isStringLiteral(index.literal) ? index.literal.text : undefined;
      const object = shapeOf(type.objectType, depth + 1);

      return key !== undefined && object?.kind === "container" ? object.property(key) : null;
    }

    return null;
  }

  let importsState = stateImports.size > 0;

  // `export type { TranslatorState } from "../state.js"` brings the state in
  // as surely as an import does.
  for (const statement of file.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      isStateModule(statement.moduleSpecifier) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((element) => (element.propertyName ?? element.name).text === STATE_TYPE)
    ) {
      importsState = true;
    }
  }

  eachNode(file, (node) => {
    if ((ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node)) && stateExportOf(node) === STATE_TYPE) {
      importsState = true;
    }
  });

  const reads: { key: string; line: number; receiver: string }[] = [];

  if (importsState) {
    const namedTypes = new Set<string>();

    eachNode(file, (node) => {
      let typeName: string | undefined;

      if (ts.isImportSpecifier(node) && isStateModule(node.parent.parent.parent.moduleSpecifier)) {
        const imported = (node.propertyName ?? node.name).text;

        if (sliceTypes.has(imported)) typeName = imported;
      } else if (ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node)) {
        const exported = stateExportOf(node);

        if (exported !== undefined && sliceTypes.has(exported)) typeName = exported;
      }

      if (typeName === undefined) return;

      const id = `${typeName}:${lineOf(file, node)}`;

      if (namedTypes.has(id)) return;

      namedTypes.add(id);
      pushC(
        typeName,
        node,
        (where) =>
          `${where} imports ${STATE_TYPE} and names the slice type ${typeName}: a diff that owns a slice takes the slice as its first parameter and never ${STATE_TYPE} (${DECISION_1}); take the slice and drop the ${STATE_TYPE} import.`,
      );
    });

    // An exported stand-in for the state would carry it into a module this
    // scan reads alone (no module resolution), where it is invisible.
    const exportedStandIn = (name: string, node: ts.Node): void =>
      pushC(
        name,
        node,
        (where) =>
          `${where} exports \`${name}\`, which stands for or holds ${STATE_TYPE}: a module importing it would reach the state unseen by this guard. Keep such a type module-local, and import ${STATE_TYPE} from state.ts where it is needed.`,
      );

    for (const statement of file.statements) {
      if (
        (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
        hasExportModifier(statement) &&
        reachesState(declaredShape(symbolOf(statement.name), 0) ?? null)
      ) {
        exportedStandIn(statement.name.text, statement.name);
      }

      if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined) continue;

      if (!ts.isNamedExports(statement.exportClause)) continue;

      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text;

        if (statement.moduleSpecifier !== undefined) {
          if (isStateModule(statement.moduleSpecifier) && local === STATE_TYPE)
            exportedStandIn(element.name.text, element);

          continue;
        }

        const target = checker.getExportSpecifierLocalTargetSymbol(element);
        const isStandIn =
          (target !== undefined && stateImports.has(target)) || reachesState(declaredShape(target, 0) ?? null);

        if (isStandIn) exportedStandIn(element.name.text, element);
      }
    }

    /** Every parameter or variable whose shape is the state or a container of it. */
    const bindings = new Map<ts.Symbol, Shape>();

    /** The shape of an expression: a bound name, or a property of a container's shape. */
    const expressionShape = (expression: ts.Expression): Shape => {
      const target = unwrap(expression);

      if (ts.isIdentifier(target)) {
        const symbol = symbolOf(target);

        return symbol === undefined ? null : (bindings.get(symbol) ?? null);
      }

      const key = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isElementAccessExpression(target) && ts.isStringLiteralLike(unwrap(target.argumentExpression))
          ? (unwrap(target.argumentExpression) as ts.StringLiteralLike).text
          : undefined;

      if (key === undefined) return null;

      const owner = expressionShape((target as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression);

      return owner?.kind === "container" ? owner.property(key) : null;
    };

    /** A slice key taken out of the state: recorded as a read. */
    const readKey = (key: string | undefined, node: ts.Node, receiver: string): void => {
      if (key !== undefined && sliceKeys.has(key)) reads.push({ key, line: lineOf(file, node), receiver });
    };

    /** Binds a declared name or destructuring pattern to `shape`, recording a slice key destructured from the state. */
    const bindName = (name: ts.BindingName, shape: Shape, receiver: string): void => {
      if (shape === null) return;

      if (ts.isIdentifier(name)) {
        const symbol = symbolOf(name);

        if (symbol !== undefined) bindings.set(symbol, shape);

        return;
      }

      if (!ts.isObjectBindingPattern(name)) return;

      for (const element of name.elements) {
        if (element.dotDotDotToken !== undefined) continue;

        const key = propertyNameText(element.propertyName ?? element.name);

        if (key === undefined) continue;

        if (shape.kind === "state") {
          readKey(key, element, receiver);
        } else {
          bindName(element.name, shape.property(key), `${receiver}.${key}`);
        }
      }
    };

    /** Reads the slice keys a destructuring assignment target takes out of a value of `shape`. */
    const readAssignmentPattern = (pattern: ts.ObjectLiteralExpression, shape: Shape, receiver: string): void => {
      if (shape === null) return;

      for (const property of pattern.properties) {
        if (ts.isSpreadAssignment(property)) continue;

        const key = propertyNameText(property.name);

        if (key === undefined) continue;

        if (shape.kind === "state") {
          readKey(key, property, receiver);
        } else if (ts.isPropertyAssignment(property)) {
          const inner = unwrap(
            ts.isBinaryExpression(property.initializer) ? property.initializer.left : property.initializer,
          );

          if (ts.isObjectLiteralExpression(inner))
            readAssignmentPattern(inner, shape.property(key), `${receiver}.${key}`);
        }
      }
    };

    // Bindings in source order, so a variable initialised from an earlier
    // binding (`const s = ctx.state`) takes its shape.
    eachNode(file, (node) => {
      if (ts.isParameter(node) && node.type !== undefined) {
        bindName(node.name, shapeOf(node.type), `a destructured parameter`);
      } else if (ts.isVariableDeclaration(node)) {
        if (node.type !== undefined) {
          bindName(node.name, shapeOf(node.type), `a destructured ${STATE_TYPE}`);
        } else if (node.initializer !== undefined) {
          bindName(node.name, expressionShape(node.initializer), unwrap(node.initializer).getText(file));
        }
      }
    });

    eachNode(file, (node) => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        if (expressionShape(node.expression)?.kind !== "state") return;

        const argument = ts.isElementAccessExpression(node) ? unwrap(node.argumentExpression) : undefined;
        const key = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : argument !== undefined && ts.isStringLiteralLike(argument)
            ? argument.text
            : undefined;

        readKey(key, node, unwrap(node.expression).getText(file));
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isObjectLiteralExpression(unwrap(node.left))
      ) {
        readAssignmentPattern(
          unwrap(node.left) as ts.ObjectLiteralExpression,
          expressionShape(node.right),
          unwrap(node.right).getText(file),
        );
      }
    });
  }

  const pushD = (key: string, node: ts.Node, how: string): void => {
    const line = lineOf(file, node);

    violations.push({
      rule: "D",
      name: key,
      module,
      line,
      message: `diff/${module}:${line} replaces the slice \`${key}\` through its parent (${how}): clear it in place with \`Object.assign(<slice>, create${sliceKeys.get(key)}())\`, so a reference taken earlier in the tick stays valid (${DECISION_1}).`,
    });
  };

  /** The slice key an assignment target names (`x.key`, `x["key"]`), if any. */
  const targetKey = (target: ts.Expression): string | undefined => {
    const unwrapped = unwrap(target);
    let key: string | undefined;

    if (ts.isPropertyAccessExpression(unwrapped)) {
      key = unwrapped.name.text;
    } else if (ts.isElementAccessExpression(unwrapped)) {
      const argument = unwrap(unwrapped.argumentExpression);

      if (ts.isStringLiteralLike(argument)) key = argument.text;
    }

    return key !== undefined && sliceKeys.has(key) ? key : undefined;
  };

  /** Every slice-key target inside a destructuring assignment pattern, defaults and rests included. */
  const patternTargets = (pattern: ts.Expression, found: ts.Expression[]): void => {
    const target = unwrap(pattern);

    // A target with a default (`{ a: x.key = d }`) is an assignment of its
    // own, which the walk below visits and reports by itself.
    if (ts.isBinaryExpression(target)) return;

    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isPropertyAssignment(property)) patternTargets(property.initializer, found);
        else if (ts.isSpreadAssignment(property)) patternTargets(property.expression, found);
      }
    } else if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        patternTargets(ts.isSpreadElement(element) ? element.expression : element, found);
      }
    } else if (targetKey(target) !== undefined) {
      found.push(target);
    }
  };

  eachNode(file, (node) => {
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;

      if (operator < ts.SyntaxKind.FirstAssignment || operator > ts.SyntaxKind.LastAssignment) return;

      const left = unwrap(node.left);

      if (
        operator === ts.SyntaxKind.EqualsToken &&
        (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left))
      ) {
        const found: ts.Expression[] = [];

        patternTargets(left, found);

        for (const target of found) {
          pushD(
            targetKey(target) as string,
            target,
            `\`${target.getText(file)}\` as a destructuring assignment target`,
          );
        }

        return;
      }

      const key = targetKey(left);

      if (key !== undefined) pushD(key, node, `\`${left.getText(file)} ${node.operatorToken.getText(file)} …\``);
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      const found: ts.Expression[] = [];

      patternTargets(node.initializer, found);

      for (const target of found) {
        pushD(targetKey(target) as string, target, `\`${target.getText(file)}\` as a loop variable`);
      }
    } else if (ts.isCallExpression(node) && isObjectAssign(node.expression)) {
      for (const source of node.arguments.slice(1)) {
        const literal = unwrap(source);

        if (!ts.isObjectLiteralExpression(literal)) continue;

        for (const property of literal.properties) {
          const key =
            ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
              ? propertyNameText(property.name)
              : undefined;

          if (key !== undefined && sliceKeys.has(key)) {
            pushD(key, property, `\`Object.assign\` copies a new \`${key}\` from an object literal onto its target`);
          }
        }
      }
    }
  });

  return { importsState, reads };
}

/** Whether `node` carries an `export` modifier. */
function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** Whether a callee is `Object.assign`. */
function isObjectAssign(callee: ts.Expression): boolean {
  const target = unwrap(callee);

  return (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "Object" &&
    target.name.text === "assign"
  );
}

/**
 * Scans `state.ts` and the diff modules against the pin and the allow-list.
 * Pure: reads nothing but `sources`.
 */
export function scanStateSlices(sources: SliceSources, pin: FlatMemberPin, allowed: SliceReadAllowList): SliceScan {
  const violations: SliceViolation[] = [];
  const state = readStateFile(sources.state, violations);
  const slices = checkState(state, pin, violations);
  const program = createDiffProgram(sources.diff);
  const checker = program.getTypeChecker();
  const diffModules = [...sources.diff.keys()].sort();
  const stateImporters: string[] = [];
  const sliceReads: SliceRead[] = [];
  const types = new Map(slices.map((slice) => [slice.key, slice.type]));

  for (const module of diffModules) {
    const file = program.getSourceFile(VIRTUAL_ROOT + module);

    if (file === undefined) continue;

    const { importsState, reads } = scanModule(module, file, checker, slices, violations);

    if (importsState) stateImporters.push(module);

    for (const read of reads) {
      const allowKey = `${module}:${read.key}`;
      const isAllowed = Object.hasOwn(allowed, allowKey);

      sliceReads.push({ module, key: read.key, line: read.line, allowed: isAllowed });

      if (isAllowed) continue;

      violations.push({
        rule: "C",
        name: read.key,
        module,
        line: read.line,
        message: `diff/${module}:${read.line} reads the slice \`${read.key}\` through \`${read.receiver}\`, a ${STATE_TYPE}: take the ${types.get(read.key)} slice as a parameter instead (handleTick passes \`self.state.${read.key}\`) and hand other families' facts in as values (${DECISION_1}).`,
      });
    }
  }

  for (const [key, reason] of Object.entries(allowed)) {
    if (reason.trim() === "") {
      violations.push({
        rule: "allow",
        name: key,
        message: `SLICE_READS_ALLOWED["${key}"] gives no reason: say why that module may still read the slice through ${STATE_TYPE}.`,
      });
    }

    if (!sliceReads.some((read) => read.allowed && `${read.module}:${read.key}` === key)) {
      violations.push({
        rule: "allow",
        name: key,
        message: `SLICE_READS_ALLOWED["${key}"] matches no read of a slice through ${STATE_TYPE}: the exception is stale, delete the entry.`,
      });
    }
  }

  return {
    members: state.members.map(({ member }) => member),
    slices,
    diffModules,
    stateImporters,
    sliceReads,
    violations,
  };
}
