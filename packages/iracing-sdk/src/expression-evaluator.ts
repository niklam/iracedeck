/**
 * Expression Evaluator
 *
 * Safe evaluator for {{= ... }} template expressions: tokenizer,
 * recursive-descent parser, AST interpreter, and a bounded AST cache.
 * Pure string/number processing — no SDK or telemetry dependency, and
 * no eval()/new Function().
 */

/** Value type for expression variables. */
export type ExpressionValue = string | number | boolean;

/**
 * @internal Exported for testing
 */
export type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "ident"; path: string }
  | { type: "op"; op: BinaryOperator }
  | { type: "punct"; punct: Punctuation };

type BinaryOperator = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | ">=" | "<=" | ">" | "<";

type ComparisonOperator = "==" | "!=" | ">=" | "<=" | ">" | "<";

type Punctuation = "(" | ")" | "," | "?" | ":";

type FunctionName = "round" | "floor" | "ceil" | "abs" | "min" | "max";

/**
 * @internal Exported for testing
 */
export type ExprNode =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "variable"; path: string }
  | { type: "unary"; op: "-"; operand: ExprNode }
  | { type: "binary"; op: BinaryOperator; left: ExprNode; right: ExprNode }
  | { type: "ternary"; condition: ExprNode; whenTrue: ExprNode; whenFalse: ExprNode }
  | { type: "call"; name: FunctionName; args: ExprNode[]; fixedDecimals?: number };

/**
 * @internal Exported for testing
 */
export type EvalResult = { value: ExpressionValue; fixedDecimals?: number };

class ExpressionParseError extends Error {
  override name = "ExpressionParseError";
}

class ExpressionRuntimeError extends Error {
  override name = "ExpressionRuntimeError";
}

const COMPARISON_OPERATORS: readonly ComparisonOperator[] = ["==", "!=", ">=", "<=", ">", "<"];

const FUNCTION_NAMES: readonly FunctionName[] = ["round", "floor", "ceil", "abs", "min", "max"];

const MAX_ROUND_DECIMALS = 20;

const MAX_EXPRESSION_LENGTH = 1000;

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && /[a-zA-Z_]/.test(ch);
}

function isIdentPart(ch: string | undefined): boolean {
  return ch !== undefined && /[a-zA-Z0-9_]/.test(ch);
}

/**
 * @internal Exported for testing
 *
 * Splits an expression source string into tokens. Whitespace (including
 * newlines) is skipped between tokens. Throws on any lexical error.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(source[i + 1]))) {
      let j = i;

      while (isDigit(source[j])) {
        j++;
      }

      if (source[j] === "." && isDigit(source[j + 1])) {
        j++;

        while (isDigit(source[j])) {
          j++;
        }
      }

      tokens.push({ type: "number", value: Number.parseFloat(source.slice(i, j)) });
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"') {
      let value = "";
      let j = i + 1;
      let closed = false;

      while (j < source.length) {
        const c = source[j];

        if (c === "\\") {
          // \\ -> \, \' -> ', \" -> ", any other \c -> c
          if (j + 1 >= source.length) {
            break;
          }

          value += source[j + 1];
          j += 2;
        } else if (c === ch) {
          closed = true;
          j++;
          break;
        } else {
          value += c;
          j++;
        }
      }

      if (!closed) {
        throw new ExpressionParseError("Unterminated string literal");
      }

      tokens.push({ type: "string", value });
      i = j;
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i + 1;

      while (isIdentPart(source[j])) {
        j++;
      }

      while (source[j] === ".") {
        if (!isIdentStart(source[j + 1])) {
          throw new ExpressionParseError(`Invalid identifier path at "${source.slice(i, j + 1)}"`);
        }

        j += 2;

        while (isIdentPart(source[j])) {
          j++;
        }
      }

      tokens.push({ type: "ident", path: source.slice(i, j) });
      i = j;
      continue;
    }

    const twoChar = source.slice(i, i + 2);

    if (twoChar === "==" || twoChar === "!=" || twoChar === ">=" || twoChar === "<=") {
      tokens.push({ type: "op", op: twoChar });
      i += 2;
      continue;
    }

    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%" || ch === ">" || ch === "<") {
      tokens.push({ type: "op", op: ch });
      i++;
      continue;
    }

    if (ch === "(" || ch === ")" || ch === "," || ch === "?" || ch === ":") {
      tokens.push({ type: "punct", punct: ch });
      i++;
      continue;
    }

    throw new ExpressionParseError(`Unexpected character "${ch}" in expression`);
  }

  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parseExpression(): ExprNode {
    return this.parseTernary();
  }

  expectEnd(): void {
    if (this.pos < this.tokens.length) {
      throw new ExpressionParseError("Unexpected tokens after expression");
    }
  }

  private parseTernary(): ExprNode {
    const condition = this.parseComparison();

    if (this.matchPunct("?")) {
      const whenTrue = this.parseExpression();
      this.expectPunct(":");
      const whenFalse = this.parseExpression();

      return { type: "ternary", condition, whenTrue, whenFalse };
    }

    return condition;
  }

  private parseComparison(): ExprNode {
    const left = this.parseAdditive();
    const op = this.matchOp(COMPARISON_OPERATORS);

    if (op) {
      const right = this.parseAdditive();

      // Comparison is non-associative: a < b < c is a parse error.
      if (this.peekOp(COMPARISON_OPERATORS)) {
        throw new ExpressionParseError("Comparison operators cannot be chained");
      }

      return { type: "binary", op, left, right };
    }

    return left;
  }

  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();

    for (let op = this.matchOp(["+", "-"]); op; op = this.matchOp(["+", "-"])) {
      left = { type: "binary", op, left, right: this.parseMultiplicative() };
    }

    return left;
  }

  private parseMultiplicative(): ExprNode {
    let left = this.parseUnary();

    for (let op = this.matchOp(["*", "/", "%"]); op; op = this.matchOp(["*", "/", "%"])) {
      left = { type: "binary", op, left, right: this.parseUnary() };
    }

    return left;
  }

  private parseUnary(): ExprNode {
    if (this.matchOp(["-"])) {
      return { type: "unary", op: "-", operand: this.parseUnary() };
    }

    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const token = this.next();

    if (!token) {
      throw new ExpressionParseError("Unexpected end of expression");
    }

    switch (token.type) {
      case "number":
        return { type: "number", value: token.value };
      case "string":
        return { type: "string", value: token.value };
      case "ident":
        if (this.peekPunct("(")) {
          return this.parseCall(token.path);
        }

        return { type: "variable", path: token.path };
      case "punct":
        if (token.punct === "(") {
          const inner = this.parseExpression();
          this.expectPunct(")");

          return inner;
        }

        throw new ExpressionParseError(`Unexpected "${token.punct}" in expression`);
      default:
        throw new ExpressionParseError("Unexpected operator in expression");
    }
  }

  private parseCall(name: string): ExprNode {
    if (!(FUNCTION_NAMES as readonly string[]).includes(name)) {
      throw new ExpressionParseError(`Unknown function "${name}"`);
    }

    this.expectPunct("(");
    const args: ExprNode[] = [this.parseExpression()];

    while (this.matchPunct(",")) {
      args.push(this.parseExpression());
    }

    this.expectPunct(")");

    return buildCall(name as FunctionName, args);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    const token = this.tokens[this.pos];

    if (token) {
      this.pos++;
    }

    return token;
  }

  private peekOp(ops: readonly BinaryOperator[]): boolean {
    const token = this.peek();

    return token?.type === "op" && ops.includes(token.op);
  }

  private matchOp<T extends BinaryOperator>(ops: readonly T[]): T | undefined {
    const token = this.peek();

    if (token?.type === "op" && (ops as readonly BinaryOperator[]).includes(token.op)) {
      this.pos++;

      return token.op as T;
    }

    return undefined;
  }

  private peekPunct(punct: Punctuation): boolean {
    const token = this.peek();

    return token?.type === "punct" && token.punct === punct;
  }

  private matchPunct(punct: Punctuation): boolean {
    if (this.peekPunct(punct)) {
      this.pos++;

      return true;
    }

    return false;
  }

  private expectPunct(punct: Punctuation): void {
    if (!this.matchPunct(punct)) {
      throw new ExpressionParseError(`Expected "${punct}" in expression`);
    }
  }
}

function buildCall(name: FunctionName, args: ExprNode[]): ExprNode {
  switch (name) {
    case "round": {
      if (args.length === 1) {
        return { type: "call", name, args };
      }

      if (args.length !== 2) {
        throw new ExpressionParseError("round() takes 1 or 2 arguments");
      }

      const decimals = args[1];

      if (
        decimals.type !== "number" ||
        !Number.isInteger(decimals.value) ||
        decimals.value < 0 ||
        decimals.value > MAX_ROUND_DECIMALS
      ) {
        throw new ExpressionParseError(
          `round() decimals must be an integer literal between 0 and ${MAX_ROUND_DECIMALS}`,
        );
      }

      return { type: "call", name, args: [args[0]], fixedDecimals: decimals.value };
    }
    case "floor":
    case "ceil":
    case "abs":
      if (args.length !== 1) {
        throw new ExpressionParseError(`${name}() takes exactly 1 argument`);
      }

      return { type: "call", name, args };
    case "min":
    case "max":
      if (args.length < 2) {
        throw new ExpressionParseError(`${name}() takes at least 2 arguments`);
      }

      return { type: "call", name, args };
  }
}

/**
 * @internal Exported for testing
 *
 * Tokenizes and parses an expression into an AST. Throws on any parse error,
 * including empty input and trailing tokens.
 */
export function parseExpression(source: string): ExprNode {
  // The length cap bounds both paren nesting depth and AST recursion depth
  // (parser and evaluator are recursive) — verified safe well past 1000 chars.
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionParseError(`Expression exceeds ${MAX_EXPRESSION_LENGTH} characters`);
  }

  const tokens = tokenize(source);

  if (tokens.length === 0) {
    throw new ExpressionParseError("Empty expression");
  }

  const parser = new Parser(tokens);
  const node = parser.parseExpression();
  parser.expectEnd();

  return node;
}

function toNumber(value: ExpressionValue): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ExpressionRuntimeError("Value is not a finite number");
    }

    return value;
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new ExpressionRuntimeError("Cannot convert an empty string to a number");
  }

  const parsed = Number.parseFloat(trimmed);

  if (!Number.isFinite(parsed)) {
    throw new ExpressionRuntimeError(`Cannot convert "${value}" to a number`);
  }

  return parsed;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ExpressionRuntimeError("Result is not a finite number");
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function stringifyValue(value: ExpressionValue): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return formatNumber(value);
}

function isTruthy(value: ExpressionValue): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      throw new ExpressionRuntimeError("Condition is not a number");
    }

    return value !== 0;
  }

  return value.length > 0;
}

function looseEquals(left: ExpressionValue, right: ExpressionValue): boolean {
  if (typeof left === typeof right) {
    return left === right;
  }

  try {
    return toNumber(left) === toNumber(right);
  } catch (error) {
    if (error instanceof ExpressionRuntimeError) {
      return false;
    }

    throw error;
  }
}

function evaluateBinary(
  node: Extract<ExprNode, { type: "binary" }>,
  vars: Record<string, ExpressionValue>,
): EvalResult {
  const left = evaluateAst(node.left, vars).value;
  const right = evaluateAst(node.right, vars).value;

  switch (node.op) {
    case "+":
      if (typeof left === "string" || typeof right === "string") {
        return { value: stringifyValue(left) + stringifyValue(right) };
      }

      return { value: toNumber(left) + toNumber(right) };
    case "-":
      return { value: toNumber(left) - toNumber(right) };
    case "*":
      return { value: toNumber(left) * toNumber(right) };
    case "/":
      return { value: toNumber(left) / toNumber(right) };
    case "%":
      return { value: toNumber(left) % toNumber(right) };
    case ">":
      return { value: toNumber(left) > toNumber(right) };
    case "<":
      return { value: toNumber(left) < toNumber(right) };
    case ">=":
      return { value: toNumber(left) >= toNumber(right) };
    case "<=":
      return { value: toNumber(left) <= toNumber(right) };
    case "==":
      return { value: looseEquals(left, right) };
    case "!=":
      return { value: !looseEquals(left, right) };
  }
}

function evaluateCall(node: Extract<ExprNode, { type: "call" }>, vars: Record<string, ExpressionValue>): EvalResult {
  const args = node.args.map((arg) => toNumber(evaluateAst(arg, vars).value));

  switch (node.name) {
    case "round": {
      if (node.fixedDecimals === undefined) {
        return { value: Math.round(args[0]) };
      }

      const factor = 10 ** node.fixedDecimals;

      return { value: Math.round(args[0] * factor) / factor, fixedDecimals: node.fixedDecimals };
    }
    case "floor":
      return { value: Math.floor(args[0]) };
    case "ceil":
      return { value: Math.ceil(args[0]) };
    case "abs":
      return { value: Math.abs(args[0]) };
    case "min":
      return { value: Math.min(...args) };
    case "max":
      return { value: Math.max(...args) };
  }
}

/**
 * @internal Exported for testing
 *
 * Evaluates a parsed expression against raw template values. Only the ternary
 * forwards its chosen branch's envelope (preserving the fixedDecimals hint
 * from round(x, n)); all other constructs emit hint-free envelopes.
 */
export function evaluateAst(node: ExprNode, vars: Record<string, ExpressionValue>): EvalResult {
  switch (node.type) {
    case "number":
      return { value: node.value };
    case "string":
      return { value: node.value };
    case "variable":
      // Object.hasOwn (not `in`) so prototype-chain properties like
      // "constructor" or "toString" never resolve as variables.
      if (!Object.hasOwn(vars, node.path)) {
        throw new ExpressionRuntimeError(`Unknown variable "${node.path}"`);
      }

      return { value: vars[node.path] };
    case "unary":
      return { value: -toNumber(evaluateAst(node.operand, vars).value) };
    case "binary":
      return evaluateBinary(node, vars);
    case "ternary":
      return evaluateAst(isTruthy(evaluateAst(node.condition, vars).value) ? node.whenTrue : node.whenFalse, vars);
    case "call":
      return evaluateCall(node, vars);
  }
}

/**
 * @internal Exported for testing
 *
 * Formats an evaluation result for display: strings as-is, booleans as
 * Yes/No, numbers per the fixedDecimals hint or default number formatting
 * (integers bare, otherwise two decimals). Throws on non-finite numbers.
 */
export function formatResult(result: EvalResult): string {
  const { value } = result;

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (!Number.isFinite(value)) {
    throw new ExpressionRuntimeError("Result is not a finite number");
  }

  return result.fixedDecimals !== undefined ? value.toFixed(result.fixedDecimals) : formatNumber(value);
}

type CacheEntry = { kind: "ast"; node: ExprNode } | { kind: "parse-error" };

// Parse errors are cached too: templates re-resolve at 60 Hz and a typo must
// not re-parse on every tick.
const expressionCache = new Map<string, CacheEntry>();

const EXPRESSION_CACHE_MAX_ENTRIES = 200;

/**
 * @internal Exported for testing
 */
export function clearExpressionCache(): void {
  expressionCache.clear();
}

/**
 * Evaluates a {{= ... }} expression against raw template values.
 * Returns the formatted result string, "" on runtime error, or null on parse
 * error (the caller renders the original source verbatim on parse error).
 */
export function resolveExpression(source: string, vars: Record<string, ExpressionValue>): string | null {
  // Reject over-limit sources before touching the cache so huge strings are
  // never stored as cache keys.
  if (source.length > MAX_EXPRESSION_LENGTH) {
    return null;
  }

  let entry = expressionCache.get(source);

  if (!entry) {
    try {
      entry = { kind: "ast", node: parseExpression(source) };
    } catch (error) {
      if (!(error instanceof ExpressionParseError)) {
        throw error;
      }

      entry = { kind: "parse-error" };
    }

    if (expressionCache.size >= EXPRESSION_CACHE_MAX_ENTRIES) {
      expressionCache.delete(expressionCache.keys().next().value as string);
    }

    expressionCache.set(source, entry);
  }

  if (entry.kind === "parse-error") {
    return null;
  }

  try {
    return formatResult(evaluateAst(entry.node, vars));
  } catch (error) {
    if (error instanceof ExpressionRuntimeError) {
      return "";
    }

    throw error;
  }
}
