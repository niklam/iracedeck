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
 *   (`import type { … }`, `import { type … }`, plain, or through a namespace
 *   import used as `ns.TranslatorState`) names no slice type, and reads no
 *   slice key off an identifier bound to a parameter or variable whose
 *   annotation mentions `TranslatorState` (`state.fastestLap`,
 *   `state["fastestLap"]`, `const { fastestLap } = state`, a destructured
 *   parameter, a destructuring assignment). A slice key on any other receiver
 *   is not a match: `other.fastestLap` passes. Reported by slice key, or by
 *   type name. The allow-list exempts a `<module>:<key>` read, and an entry
 *   that matches no read is itself a finding (`allow`).
 * - **D** — under `diff/`, in any module, no assignment (`=`, `??=`, …) has a
 *   target `<x>.<sliceKey>` or `<x>["<sliceKey>"]`: a slice is cleared in
 *   place, never replaced through its parent. Reported by slice key.
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

/** Rules C and D over one diff module; pushes D and slice-type C findings, returns the slice reads. */
function scanModule(
  module: string,
  file: ts.SourceFile,
  checker: ts.TypeChecker,
  slices: readonly SliceMember[],
  violations: SliceViolation[],
): ModuleScan {
  const sliceKeys = new Map(slices.map((slice) => [slice.key, slice.type]));
  const sliceTypes = new Set(slices.map((slice) => slice.type));
  /** Local aliases of `TranslatorState`, and namespace imports of `state.ts`. */
  const stateAliases = new Set<ts.Symbol>();
  const stateNamespaces = new Set<ts.Symbol>();
  /** Local names of slice types imported from `state.ts`, by alias symbol. */
  const sliceTypeAliases = new Map<ts.Symbol, string>();
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);

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

      if (imported === STATE_TYPE) stateAliases.add(symbol);

      if (sliceTypes.has(imported)) sliceTypeAliases.set(symbol, imported);
    }
  }

  /** The `state.ts` export a type name refers to (`X` through an import, `ns.X` through a namespace), if any. */
  const stateExportOf = (typeName: ts.EntityName): string | undefined => {
    if (ts.isIdentifier(typeName)) {
      const symbol = symbolOf(typeName);

      if (symbol === undefined) return undefined;

      if (stateAliases.has(symbol)) return STATE_TYPE;

      return sliceTypeAliases.get(symbol);
    }

    const left = ts.isIdentifier(typeName.left) ? symbolOf(typeName.left) : undefined;

    return left !== undefined && stateNamespaces.has(left) ? typeName.right.text : undefined;
  };

  const mentionsState = (type: ts.TypeNode): boolean => {
    let found = false;

    eachNode(type, (node) => {
      if (ts.isTypeReferenceNode(node) && stateExportOf(node.typeName) === STATE_TYPE) found = true;
    });

    return found;
  };

  let importsState = stateAliases.size > 0;

  eachNode(file, (node) => {
    if (ts.isTypeReferenceNode(node) && stateExportOf(node.typeName) === STATE_TYPE) importsState = true;
  });

  const reads: { key: string; line: number; receiver: string }[] = [];

  if (importsState) {
    const namedTypes = new Set<string>();

    eachNode(file, (node) => {
      let typeName: string | undefined;

      if (ts.isImportSpecifier(node) && isStateModule(node.parent.parent.parent.moduleSpecifier)) {
        const imported = (node.propertyName ?? node.name).text;

        if (sliceTypes.has(imported)) typeName = imported;
      } else if (ts.isTypeReferenceNode(node)) {
        const exported = stateExportOf(node.typeName);

        if (exported !== undefined && sliceTypes.has(exported)) typeName = exported;
      }

      if (typeName === undefined) return;

      const line = lineOf(file, node);
      const id = `${typeName}:${line}`;

      if (namedTypes.has(id)) return;

      namedTypes.add(id);
      violations.push({
        rule: "C",
        name: typeName,
        module,
        line,
        message: `diff/${module}:${line} imports ${STATE_TYPE} and names the slice type ${typeName}: a diff that owns a slice takes the slice as its first parameter and never ${STATE_TYPE} (${DECISION_1}); take the slice and drop the ${STATE_TYPE} import.`,
      });
    });

    /** Parameters and variables annotated with a type that mentions `TranslatorState`. */
    const stateBindings = new Set<ts.Symbol>();
    const readBindingPattern = (pattern: ts.ObjectBindingPattern, receiver: string): void => {
      for (const element of pattern.elements) {
        const key = propertyNameText(element.propertyName ?? element.name);

        if (key !== undefined && sliceKeys.has(key)) reads.push({ key, line: lineOf(file, element), receiver });
      }
    };

    eachNode(file, (node) => {
      if (!(ts.isParameter(node) || ts.isVariableDeclaration(node)) || node.type === undefined) return;

      if (!mentionsState(node.type)) return;

      if (ts.isIdentifier(node.name)) {
        const symbol = symbolOf(node.name);

        if (symbol !== undefined) stateBindings.add(symbol);
      } else if (ts.isObjectBindingPattern(node.name)) {
        readBindingPattern(node.name, `a destructured ${STATE_TYPE}`);
      }
    });

    const isStateBinding = (expression: ts.Expression): expression is ts.Identifier => {
      const target = unwrap(expression);
      const symbol = ts.isIdentifier(target) ? symbolOf(target) : undefined;

      return symbol !== undefined && stateBindings.has(symbol);
    };

    eachNode(file, (node) => {
      if (ts.isPropertyAccessExpression(node) && isStateBinding(node.expression)) {
        const key = node.name.text;

        if (sliceKeys.has(key))
          reads.push({ key, line: lineOf(file, node), receiver: unwrap(node.expression).getText(file) });
      } else if (ts.isElementAccessExpression(node) && isStateBinding(node.expression)) {
        const argument = unwrap(node.argumentExpression);
        const key = ts.isStringLiteralLike(argument) ? argument.text : undefined;

        if (key !== undefined && sliceKeys.has(key)) {
          reads.push({ key, line: lineOf(file, node), receiver: unwrap(node.expression).getText(file) });
        }
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer !== undefined &&
        isStateBinding(node.initializer)
      ) {
        readBindingPattern(node.name, unwrap(node.initializer).getText(file));
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isObjectLiteralExpression(unwrap(node.left)) &&
        isStateBinding(node.right)
      ) {
        for (const property of (unwrap(node.left) as ts.ObjectLiteralExpression).properties) {
          const key = ts.isSpreadAssignment(property) ? undefined : propertyNameText(property.name);

          if (key !== undefined && sliceKeys.has(key)) {
            reads.push({ key, line: lineOf(file, property), receiver: unwrap(node.right).getText(file) });
          }
        }
      }
    });
  }

  eachNode(file, (node) => {
    if (!ts.isBinaryExpression(node)) return;

    const operator = node.operatorToken.kind;

    if (operator < ts.SyntaxKind.FirstAssignment || operator > ts.SyntaxKind.LastAssignment) return;

    const target = unwrap(node.left);
    let key: string | undefined;

    if (ts.isPropertyAccessExpression(target)) {
      key = target.name.text;
    } else if (ts.isElementAccessExpression(target)) {
      const argument = unwrap(target.argumentExpression);

      if (ts.isStringLiteralLike(argument)) key = argument.text;
    }

    const type = key === undefined ? undefined : sliceKeys.get(key);

    if (key === undefined || type === undefined) return;

    const line = lineOf(file, node);

    violations.push({
      rule: "D",
      name: key,
      module,
      line,
      message: `diff/${module}:${line} replaces the slice \`${key}\` through its parent (\`${target.getText(file)} ${node.operatorToken.getText(file)} …\`): clear it in place with \`Object.assign(<slice>, create${type}())\`, so a reference taken earlier in the tick stays valid (${DECISION_1}).`,
    });
  });

  return { importsState, reads };
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
