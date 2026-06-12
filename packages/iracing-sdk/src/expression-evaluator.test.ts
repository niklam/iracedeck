import { beforeEach, describe, expect, it } from "vitest";

import {
  clearExpressionCache,
  evaluateAst,
  formatResult,
  parseExpression,
  resolveExpression,
  tokenize,
} from "./expression-evaluator.js";

beforeEach(() => {
  clearExpressionCache();
});

describe("tokenize", () => {
  it("should tokenize a dotted identifier path as a single token", () => {
    expect(tokenize("sessionInfo.DriverInfo.DriverCarFuelKgPerLtr")).toEqual([
      { type: "ident", path: "sessionInfo.DriverInfo.DriverCarFuelKgPerLtr" },
    ]);
  });

  it("should tokenize numbers, identifiers, and two-char operators with maximal munch", () => {
    expect(tokenize("a.b.c >= 1.5")).toEqual([
      { type: "ident", path: "a.b.c" },
      { type: "op", op: ">=" },
      { type: "number", value: 1.5 },
    ]);
  });

  it("should prefer two-char operators over single-char operators", () => {
    expect(tokenize("==")).toEqual([{ type: "op", op: "==" }]);
    expect(tokenize("!=")).toEqual([{ type: "op", op: "!=" }]);
    expect(tokenize("<=")).toEqual([{ type: "op", op: "<=" }]);
  });

  it("should skip whitespace including newlines and tabs", () => {
    expect(tokenize("1\n +\t2")).toEqual([
      { type: "number", value: 1 },
      { type: "op", op: "+" },
      { type: "number", value: 2 },
    ]);
  });

  it("should tokenize a number with leading dot", () => {
    expect(tokenize(".5")).toEqual([{ type: "number", value: 0.5 }]);
  });

  it("should tokenize string literals with both quote styles", () => {
    expect(tokenize("'a b'")).toEqual([{ type: "string", value: "a b" }]);
    expect(tokenize('"a b"')).toEqual([{ type: "string", value: "a b" }]);
  });

  it("should tokenize punctuation", () => {
    expect(tokenize("( ) , ? :")).toEqual([
      { type: "punct", punct: "(" },
      { type: "punct", punct: ")" },
      { type: "punct", punct: "," },
      { type: "punct", punct: "?" },
      { type: "punct", punct: ":" },
    ]);
  });

  it("should throw on an unknown character", () => {
    expect(() => tokenize("1 @ 2")).toThrow();
  });

  it("should throw on an unterminated string", () => {
    expect(() => tokenize("'abc")).toThrow();
    expect(() => tokenize('"abc')).toThrow();
  });

  it("should throw on a string ending with a dangling backslash", () => {
    expect(() => tokenize("'abc\\")).toThrow();
  });

  it("should throw on a trailing dot in an identifier", () => {
    expect(() => tokenize("a.")).toThrow();
  });

  it("should throw on a dot followed by a non-letter in an identifier", () => {
    expect(() => tokenize("a.5")).toThrow();
    expect(() => tokenize("a. b")).toThrow();
  });
});

describe("parse errors", () => {
  it("should return null for an unknown character", () => {
    expect(resolveExpression("1 # 2", {})).toBeNull();
  });

  it("should return null for an unterminated string", () => {
    expect(resolveExpression("'abc", {})).toBeNull();
  });

  it("should return null for an empty expression", () => {
    expect(resolveExpression("", {})).toBeNull();
  });

  it("should return null for a whitespace-only expression", () => {
    expect(resolveExpression("  \n\t ", {})).toBeNull();
  });

  it("should return null for unbalanced parentheses", () => {
    expect(resolveExpression("(1 + 2", {})).toBeNull();
    expect(resolveExpression("1 + 2)", {})).toBeNull();
  });

  it("should return null for a dangling operator", () => {
    expect(resolveExpression("1 +", {})).toBeNull();
  });

  it("should return null for a double operator", () => {
    expect(resolveExpression("1 + * 2", {})).toBeNull();
  });

  it("should return null for a bare equals sign", () => {
    expect(resolveExpression("a = 1", {})).toBeNull();
  });

  it("should return null for a bare exclamation mark", () => {
    expect(resolveExpression("!a", {})).toBeNull();
    expect(resolveExpression("1 ! 2", {})).toBeNull();
  });

  it("should return null for chained comparisons", () => {
    expect(resolveExpression("1 < 2 < 3", {})).toBeNull();
    expect(resolveExpression("1 == 2 == 3", {})).toBeNull();
    expect(resolveExpression("(1 < 2 < 3) ? 1 : 0", {})).toBeNull();
  });

  it("should return null for a ternary missing its colon", () => {
    expect(resolveExpression("1 ? 2", {})).toBeNull();
  });

  it("should return null for wrong round arity", () => {
    expect(resolveExpression("round()", {})).toBeNull();
    expect(resolveExpression("round(1, 2, 3)", {})).toBeNull();
  });

  it("should return null for wrong floor arity", () => {
    expect(resolveExpression("floor()", {})).toBeNull();
    expect(resolveExpression("floor(1, 2)", {})).toBeNull();
  });

  it("should return null for wrong ceil arity", () => {
    expect(resolveExpression("ceil()", {})).toBeNull();
    expect(resolveExpression("ceil(1, 2)", {})).toBeNull();
  });

  it("should return null for wrong abs arity", () => {
    expect(resolveExpression("abs()", {})).toBeNull();
    expect(resolveExpression("abs(1, 2)", {})).toBeNull();
  });

  it("should return null for min with fewer than 2 arguments", () => {
    expect(resolveExpression("min(1)", {})).toBeNull();
  });

  it("should return null for max with fewer than 2 arguments", () => {
    expect(resolveExpression("max(1)", {})).toBeNull();
  });

  it("should return null for an unknown function", () => {
    expect(resolveExpression("foo(1)", {})).toBeNull();
    expect(resolveExpression("telemetry.fn(1)", {})).toBeNull();
  });

  it("should return null for round with non-integer decimals", () => {
    expect(resolveExpression("round(1.234, 1.5)", {})).toBeNull();
  });

  it("should return null for round with negative decimals", () => {
    expect(resolveExpression("round(1.234, -1)", {})).toBeNull();
  });

  it("should return null for round with decimals above 20", () => {
    expect(resolveExpression("round(1.234, 21)", {})).toBeNull();
  });

  it("should return null for round with a non-literal decimals argument", () => {
    expect(resolveExpression("round(1.234, n)", { n: 2 })).toBeNull();
    expect(resolveExpression("round(1.234, 1 + 1)", {})).toBeNull();
  });

  it("should return null for trailing tokens after the expression", () => {
    expect(resolveExpression("1 2", {})).toBeNull();
    expect(resolveExpression("(1) 2", {})).toBeNull();
    expect(resolveExpression("1 + 2 :", {})).toBeNull();
  });
});

describe("literals", () => {
  it("should evaluate integer literals", () => {
    expect(resolveExpression("42", {})).toBe("42");
  });

  it("should evaluate decimal literals", () => {
    expect(resolveExpression("3.25", {})).toBe("3.25");
  });

  it("should evaluate a leading-dot decimal literal", () => {
    expect(resolveExpression(".5", {})).toBe("0.50");
  });

  it("should evaluate single-quoted strings", () => {
    expect(resolveExpression("'hello'", {})).toBe("hello");
  });

  it("should evaluate double-quoted strings", () => {
    expect(resolveExpression('"hi"', {})).toBe("hi");
  });

  it("should unescape an escaped quote", () => {
    expect(resolveExpression("'it\\'s'", {})).toBe("it's");
    expect(resolveExpression('"say \\"hi\\""', {})).toBe('say "hi"');
  });

  it("should unescape an escaped backslash", () => {
    expect(resolveExpression("'a\\\\b'", {})).toBe("a\\b");
  });

  it("should drop the backslash for unknown escapes", () => {
    expect(resolveExpression("'a\\nb'", {})).toBe("anb");
  });
});

describe("arithmetic operators", () => {
  it("should add", () => {
    expect(resolveExpression("1 + 2", {})).toBe("3");
  });

  it("should subtract", () => {
    expect(resolveExpression("7 - 2", {})).toBe("5");
  });

  it("should multiply", () => {
    expect(resolveExpression("3 * 4", {})).toBe("12");
  });

  it("should divide", () => {
    expect(resolveExpression("10 / 4", {})).toBe("2.50");
  });

  it("should compute modulo", () => {
    expect(resolveExpression("10 % 3", {})).toBe("1");
  });
});

describe("precedence", () => {
  it("should evaluate multiplication before addition", () => {
    expect(resolveExpression("2 + 3 * 4", {})).toBe("14");
  });

  it("should respect parentheses", () => {
    expect(resolveExpression("(2 + 3) * 4", {})).toBe("20");
  });

  it("should evaluate subtraction left-to-right", () => {
    expect(resolveExpression("10 - 4 - 3", {})).toBe("3");
  });

  it("should treat modulo at the same tier as multiplication", () => {
    expect(resolveExpression("7 % 4 * 2", {})).toBe("6");
    expect(resolveExpression("20 / 2 % 3", {})).toBe("1");
  });

  it("should evaluate modulo before addition", () => {
    expect(resolveExpression("1 + 6 % 4", {})).toBe("3");
  });
});

describe("unary minus", () => {
  it("should negate a number", () => {
    expect(resolveExpression("-5", {})).toBe("-5");
  });

  it("should allow chained unary minus after a binary minus", () => {
    expect(resolveExpression("2--3", {})).toBe("5");
  });

  it("should allow doubled unary minus", () => {
    expect(resolveExpression("--5", {})).toBe("5");
  });

  it("should negate a parenthesized expression", () => {
    expect(resolveExpression("-(2+3)", {})).toBe("-5");
  });
});

describe("comparisons", () => {
  it("should evaluate greater than", () => {
    expect(resolveExpression("3 > 2", {})).toBe("Yes");
    expect(resolveExpression("2 > 3", {})).toBe("No");
  });

  it("should evaluate less than", () => {
    expect(resolveExpression("1 < 2", {})).toBe("Yes");
    expect(resolveExpression("2 < 1", {})).toBe("No");
  });

  it("should evaluate greater than or equal", () => {
    expect(resolveExpression("2 >= 2", {})).toBe("Yes");
    expect(resolveExpression("1 >= 2", {})).toBe("No");
  });

  it("should evaluate less than or equal", () => {
    expect(resolveExpression("2 <= 2", {})).toBe("Yes");
    expect(resolveExpression("2 <= 1", {})).toBe("No");
  });

  it("should coerce strings numerically for ordering comparisons", () => {
    expect(resolveExpression("'10' > '9'", {})).toBe("Yes");
  });

  it("should compare equal numbers with ==", () => {
    expect(resolveExpression("1 == 1", {})).toBe("Yes");
    expect(resolveExpression("1 == 2", {})).toBe("No");
  });

  it("should compare numbers with !=", () => {
    expect(resolveExpression("1 != 1", {})).toBe("No");
    expect(resolveExpression("1 != 2", {})).toBe("Yes");
  });

  it("should compare same-type strings strictly", () => {
    expect(resolveExpression("'a' == 'a'", {})).toBe("Yes");
    expect(resolveExpression("'a' == 'b'", {})).toBe("No");
    expect(resolveExpression("'1' == '1.0'", {})).toBe("No");
  });

  it("should compare same-type booleans strictly", () => {
    expect(resolveExpression("a == b", { a: true, b: true })).toBe("Yes");
    expect(resolveExpression("a == b", { a: true, b: false })).toBe("No");
  });

  it("should coerce mixed types numerically for equality", () => {
    expect(resolveExpression("'5' == 5", {})).toBe("Yes");
    expect(resolveExpression("'5.0' == 5", {})).toBe("Yes");
    expect(resolveExpression("flag == 1", { flag: true })).toBe("Yes");
    expect(resolveExpression("'3.93 km' == 3.93", {})).toBe("Yes");
  });

  it("should treat non-coercible mixed types as not equal without erroring", () => {
    expect(resolveExpression("'abc' == 5", {})).toBe("No");
    expect(resolveExpression("'abc' != 5", {})).toBe("Yes");
  });
});

describe("ternary", () => {
  it("should pick the true branch when the condition holds", () => {
    expect(resolveExpression("1 > 0 ? 'yes' : 'no'", {})).toBe("yes");
  });

  it("should pick the false branch when the condition fails", () => {
    expect(resolveExpression("0 > 1 ? 'yes' : 'no'", {})).toBe("no");
  });

  it("should evaluate only the chosen branch", () => {
    expect(resolveExpression("x != 0 ? 10 / x : 'N/A'", { x: 0 })).toBe("N/A");
    expect(resolveExpression("x != 0 ? 10 / x : 'N/A'", { x: 4 })).toBe("2.50");
  });

  it("should nest right-associatively in the else branch", () => {
    expect(resolveExpression("1 ? 2 : 0 ? 3 : 4", {})).toBe("2");
    expect(resolveExpression("0 ? 2 : 0 ? 3 : 4", {})).toBe("4");
    expect(resolveExpression("0 ? 2 : 1 ? 3 : 4", {})).toBe("3");
  });

  it("should forward the chosen branch's fixedDecimals envelope", () => {
    expect(resolveExpression("1 > 0 ? round(1/3, 3) : round(1/3, 1)", {})).toBe("0.333");
    expect(resolveExpression("0 > 1 ? round(1/3, 3) : round(1/3, 1)", {})).toBe("0.3");
  });

  it("should treat numbers as truthy when non-zero", () => {
    expect(resolveExpression("5 ? 1 : 2", {})).toBe("1");
    expect(resolveExpression("0 ? 1 : 2", {})).toBe("2");
  });

  it("should treat strings as truthy when non-empty", () => {
    expect(resolveExpression("'x' ? 1 : 2", {})).toBe("1");
    expect(resolveExpression("'' ? 1 : 2", {})).toBe("2");
  });

  it("should use boolean conditions directly", () => {
    expect(resolveExpression("on ? 'a' : 'b'", { on: true })).toBe("a");
    expect(resolveExpression("on ? 'a' : 'b'", { on: false })).toBe("b");
  });
});

describe("functions", () => {
  it("should round to the nearest integer with one argument", () => {
    expect(resolveExpression("round(2.5)", {})).toBe("3");
    expect(resolveExpression("round(2.4)", {})).toBe("2");
  });

  it("should round to n decimals and format with fixed decimals", () => {
    expect(resolveExpression("round(1/3, 4)", {})).toBe("0.3333");
    expect(resolveExpression("round(10/2, 1)", {})).toBe("5.0");
    expect(resolveExpression("round(2.345, 0)", {})).toBe("2");
  });

  it("should floor", () => {
    expect(resolveExpression("floor(2.9)", {})).toBe("2");
    expect(resolveExpression("floor(-2.1)", {})).toBe("-3");
  });

  it("should ceil", () => {
    expect(resolveExpression("ceil(2.1)", {})).toBe("3");
  });

  it("should compute absolute value", () => {
    expect(resolveExpression("abs(-3)", {})).toBe("3");
    expect(resolveExpression("abs(3)", {})).toBe("3");
  });

  it("should compute min with two or more arguments", () => {
    expect(resolveExpression("min(2, 1)", {})).toBe("1");
    expect(resolveExpression("min(3, 1, 2)", {})).toBe("1");
  });

  it("should compute max with two or more arguments", () => {
    expect(resolveExpression("max(1, 2)", {})).toBe("2");
    expect(resolveExpression("max(3, 1, 2)", {})).toBe("3");
  });

  it("should coerce string arguments numerically", () => {
    expect(resolveExpression("round('2.6 s')", {})).toBe("3");
  });

  it("should allow nested calls", () => {
    expect(resolveExpression("max(min(5, 3), 1)", {})).toBe("3");
  });
});

describe("string concatenation", () => {
  it("should concatenate when either operand is a string", () => {
    expect(resolveExpression("'P' + 5", {})).toBe("P5");
    expect(resolveExpression("5 + 'th'", {})).toBe("5th");
    expect(resolveExpression("'a' + 'b'", {})).toBe("ab");
  });

  it("should format non-integer numbers with two decimals inside concatenation", () => {
    expect(resolveExpression("'x: ' + 1/3", {})).toBe("x: 0.33");
    expect(resolveExpression("'v' + 2.5", {})).toBe("v2.50");
  });

  it("should chain concatenations left-to-right", () => {
    expect(resolveExpression("'Lap ' + 5 + '/' + 10", {})).toBe("Lap 5/10");
  });

  it("should stringify booleans as Yes/No", () => {
    expect(resolveExpression("'DRS: ' + on", { on: true })).toBe("DRS: Yes");
    expect(resolveExpression("'DRS: ' + on", { on: false })).toBe("DRS: No");
  });
});

describe("variables", () => {
  it("should look up a flat variable", () => {
    expect(resolveExpression("speed", { speed: 120 })).toBe("120");
  });

  it("should look up a string variable", () => {
    expect(resolveExpression("name", { name: "Dale" })).toBe("Dale");
  });

  it("should format a boolean variable as Yes/No", () => {
    expect(resolveExpression("flag", { flag: true })).toBe("Yes");
    expect(resolveExpression("flag", { flag: false })).toBe("No");
  });

  it("should look up dotted paths as flat keys", () => {
    expect(resolveExpression("telemetry.Speed", { "telemetry.Speed": 51.4 })).toBe("51.40");
  });

  it("should return empty string for an unknown variable", () => {
    expect(resolveExpression("missing", {})).toBe("");
    expect(resolveExpression("1 + missing", {})).toBe("");
  });
});

describe("coercion", () => {
  it("should parse a leading number out of a string", () => {
    expect(resolveExpression("'3.93 km' * 2", {})).toBe("7.86");
  });

  it("should fail at runtime on a whitespace-only string used numerically", () => {
    expect(resolveExpression("'  ' * 2", {})).toBe("");
  });

  it("should fail at runtime on a non-numeric string used numerically", () => {
    expect(resolveExpression("'abc' * 2", {})).toBe("");
  });

  it("should coerce booleans to 1 and 0", () => {
    expect(resolveExpression("t + 1", { t: true })).toBe("2");
    expect(resolveExpression("f + 1", { f: false })).toBe("1");
    expect(resolveExpression("t * 5", { t: true })).toBe("5");
  });

  it("should fail at runtime on a NaN variable used numerically", () => {
    expect(resolveExpression("n + 1", { n: Number.NaN })).toBe("");
  });

  it("should fail at runtime on a non-finite variable result", () => {
    expect(resolveExpression("n", { n: Number.POSITIVE_INFINITY })).toBe("");
  });

  it("should coerce strings for unary minus and division", () => {
    expect(resolveExpression("-'2'", {})).toBe("-2");
    expect(resolveExpression("'10' / '4'", {})).toBe("2.50");
  });
});

describe("division by zero", () => {
  it("should return empty string for division by zero", () => {
    expect(resolveExpression("1/0", {})).toBe("");
    expect(resolveExpression("-1/0", {})).toBe("");
    expect(resolveExpression("1/(2-2)", {})).toBe("");
  });

  it("should return empty string for zero divided by zero", () => {
    expect(resolveExpression("0/0", {})).toBe("");
  });

  it("should return empty string for modulo by zero", () => {
    expect(resolveExpression("5 % 0", {})).toBe("");
  });

  it("should return empty string when a non-finite intermediate is used further", () => {
    expect(resolveExpression("1/0 + 1", {})).toBe("");
  });
});

describe("result formatting", () => {
  it("should render integers without decimals", () => {
    expect(resolveExpression("4+1", {})).toBe("5");
    expect(resolveExpression("10/2", {})).toBe("5");
    expect(resolveExpression("2.5 + 2.5", {})).toBe("5");
  });

  it("should render non-integers with two decimals by default", () => {
    expect(resolveExpression("1/3", {})).toBe("0.33");
  });

  it("should render with fixed decimals from round(x, n)", () => {
    expect(resolveExpression("round(1/3, 4)", {})).toBe("0.3333");
    expect(resolveExpression("round(10/2, 1)", {})).toBe("5.0");
  });

  it("should format plain values directly via formatResult", () => {
    expect(formatResult({ value: 5 })).toBe("5");
    expect(formatResult({ value: 5, fixedDecimals: 1 })).toBe("5.0");
    expect(formatResult({ value: true })).toBe("Yes");
    expect(formatResult({ value: false })).toBe("No");
    expect(formatResult({ value: "abc" })).toBe("abc");
    expect(formatResult({ value: "abc", fixedDecimals: 2 })).toBe("abc");
  });

  it("should throw on non-finite numbers in formatResult", () => {
    expect(() => formatResult({ value: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => formatResult({ value: Number.NaN })).toThrow();
  });
});

describe("parseExpression and evaluateAst internals", () => {
  it("should produce a binary AST node for addition", () => {
    expect(parseExpression("1 + 2")).toEqual({
      type: "binary",
      op: "+",
      left: { type: "number", value: 1 },
      right: { type: "number", value: 2 },
    });
  });

  it("should store round decimals on the call node, not as an argument", () => {
    expect(parseExpression("round(1, 2)")).toEqual({
      type: "call",
      name: "round",
      args: [{ type: "number", value: 1 }],
      fixedDecimals: 2,
    });
  });

  it("should attach fixedDecimals to the evaluation envelope", () => {
    expect(evaluateAst(parseExpression("round(1/3, 2)"), {})).toEqual({ value: 0.33, fixedDecimals: 2 });
  });

  it("should forward the envelope through a ternary", () => {
    expect(evaluateAst(parseExpression("1 > 0 ? round(1/3, 3) : 0"), {})).toEqual({
      value: 0.333,
      fixedDecimals: 3,
    });
  });

  it("should emit hint-free envelopes from other operators", () => {
    expect(evaluateAst(parseExpression("round(1/3, 2) + 0"), {})).toEqual({ value: 0.33 });
  });
});

describe("end-to-end examples", () => {
  it("should resolve the fuel-add conversion example", () => {
    const vars = {
      "telemetry.dpFuelAddKg": 20.4,
      "sessionInfo.DriverInfo.DriverCarFuelKgPerLtr": 0.743,
    };

    expect(
      resolveExpression(
        "round(telemetry.dpFuelAddKg / (sessionInfo.DriverInfo.DriverCarFuelKgPerLtr * 0.264172), 1)",
        vars,
      ),
    ).toBe("103.9");
  });
});

describe("expression cache", () => {
  it("should reuse the cached AST while applying fresh variables", () => {
    expect(resolveExpression("x + 1", { x: 1 })).toBe("2");
    expect(resolveExpression("x + 1", { x: 5 })).toBe("6");
  });

  it("should cache parse errors", () => {
    expect(resolveExpression("1 +", {})).toBeNull();
    expect(resolveExpression("1 +", {})).toBeNull();
    expect(resolveExpression("1 + 1", {})).toBe("2");
  });

  it("should keep returning correct results after clearing the cache", () => {
    expect(resolveExpression("2 * 3", {})).toBe("6");
    clearExpressionCache();

    expect(resolveExpression("2 * 3", {})).toBe("6");
  });

  it("should stay correct past the eviction cap", () => {
    for (let i = 0; i < 205; i++) {
      expect(resolveExpression(`${i} + 1`, {})).toBe(String(i + 1));
    }

    for (let i = 0; i < 205; i++) {
      expect(resolveExpression(`${i} + 1`, {})).toBe(String(i + 1));
    }
  });

  it("should re-parse an evicted parse error correctly", () => {
    expect(resolveExpression("1 +", {})).toBeNull();

    for (let i = 0; i < 205; i++) {
      resolveExpression(`${i} + 1`, {});
    }

    expect(resolveExpression("1 +", {})).toBeNull();
  });
});
