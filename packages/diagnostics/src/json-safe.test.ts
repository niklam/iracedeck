import { describe, expect, it } from "vitest";

import { JSON_SAFE_MAX_DEPTH, type JsonValue, toJsonSafe } from "./json-safe.js";

class Foo {
  value = 1;
}

/** An array of `length` whose only assigned indexes are the given ones; the rest are holes. */
function sparse(length: number, assigned: Record<number, unknown>): unknown[] {
  const array: unknown[] = [];

  array.length = length;

  for (const [index, value] of Object.entries(assigned)) array[Number(index)] = value;

  return array;
}

/** `{ leaf: true }` sitting `levels` containers below a root object, each level wrapped by `wrap`. */
function nested(levels: number, wrap: (inner: unknown) => unknown = (inner) => ({ c: inner })): unknown {
  let node: unknown = { leaf: true };

  for (let i = 0; i < levels; i++) node = wrap(node);

  return node;
}

/** Follows `c` down `levels` times. */
function descend(value: JsonValue, levels: number): JsonValue {
  let node = value;

  for (let i = 0; i < levels; i++) node = (node as { c: JsonValue }).c;

  return node;
}

const clearedTimer = setTimeout(() => {}, 0);
clearTimeout(clearedTimer);

const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1, b: new Set(["x"]) });

const selfReferencing: Record<string, unknown> = {};
selfReferencing.self = selfReferencing;

const shared = { v: 1 };

/** One row per line of the spec's table (#1387, Decision 2), then the cases the table implies. */
const ROWS: ReadonlyArray<readonly [name: string, input: unknown, expected: JsonValue]> = [
  ["a finite number as itself", 42.5, 42.5],
  ["a string as itself", "text", "text"],
  ["a boolean as itself", false, false],
  ["null as itself", null, null],
  ["NaN as the string", { n: NaN }, { n: "NaN" }],
  ["Infinity as the string", { n: Infinity }, { n: "Infinity" }],
  ["-Infinity as the string", { n: -Infinity }, { n: "-Infinity" }],
  ["negative zero as zero, which is what JSON text holds", [-0], [0]],
  ["an undefined property by omitting it", { a: 1, b: undefined }, { a: 1 }],
  ["an undefined array element as null", [1, undefined, 3], [1, null, 3]],
  ["an array hole as null", sparse(3, { 0: 1, 2: 3 }), [1, null, 3]],
  [
    "a BigInt as its decimal string",
    { big: 2n ** 64n, negative: -7n },
    { big: "18446744073709551616", negative: "-7" },
  ],
  ["a Date as its ISO string", new Date(Date.UTC(2026, 9, 10, 14, 3, 11, 482)), "2026-10-10T14:03:11.482Z"],
  ["an invalid Date as a marker", new Date(NaN), "Invalid Date"],
  ["a Set as an array of its members", new Set([1, "a", NaN]), [1, "a", "NaN"]],
  [
    "a Map as an array of [key, value] pairs, whatever the keys are",
    new Map<unknown,
      unknown>([
      [1, "a"],
      [{ k: 1 }, "b"],
    ]),
    [
      [1, "a"],
      [{ k: 1 }, "b"],
    ],
  ],
  ["a typed array as a plain array", new Float32Array([1, 2.5]), [1, 2.5]],
  ["a typed array's non-finite members as strings", new Float64Array([1, NaN]), [1, "NaN"]],
  ["a BigInt typed array as decimal strings", new BigInt64Array([5n, -1n]), ["5", "-1"]],
  ["an Error as its name and message", new TypeError("bad input"), { name: "TypeError", message: "bad input" }],
  ["a function property by omitting it", { keep: 1, fn: () => 1 }, { keep: 1 }],
  ["a symbol property by omitting it", { keep: 1, sym: Symbol("s") }, { keep: 1 }],
  ["a function or symbol array element as null", [() => 1, Symbol("s"), 2], [null, null, 2]],
  ["a class instance as its constructor's name", { foo: new Foo() }, { foo: "[Foo]" }],
  ["a timer as its constructor's name", { timer: clearedTimer }, { timer: "[Timeout]" }],
  ["a WeakMap as its constructor's name", { cache: new WeakMap() }, { cache: "[WeakMap]" }],
  ["an instance of a nameless class as [Object]", new (class {})(), "[Object]"],
  ["a null-prototype object as a plain object", nullProto, { a: 1, b: ["x"] }],
  ["a reference to itself as [Circular]", selfReferencing, { self: "[Circular]" }],
  ["a shared, non-circular reference twice in full", { a: shared, b: shared }, { a: { v: 1 }, b: { v: 1 } }],
  ["a top-level undefined as null", undefined, null],
  ["a top-level function as null", () => 1, null],
  ["a top-level symbol as null", Symbol("s"), null],
  [
    "an undefined Set member or Map value as null",
    { s: new Set([undefined]), m: new Map([["k", undefined]]) },
    { s: [null], m: [["k", null]] },
  ],
  [
    "an own __proto__ key as a key",
    JSON.parse('{ "__proto__": { "x": 1 }, "y": 2 }'),
    JSON.parse('{ "__proto__": { "x": 1 }, "y": 2 }'),
  ],
  [
    `${JSON_SAFE_MAX_DEPTH} containers below the root in full`,
    nested(JSON_SAFE_MAX_DEPTH),
    nested(JSON_SAFE_MAX_DEPTH) as JsonValue,
  ],
];

describe("toJsonSafe (#1387)", () => {
  it.each(ROWS)("encodes %s", (_name, input, expected) => {
    expect(toJsonSafe(input)).toStrictEqual(expected);
  });

  // The property the encoder exists for: what it returns is what the file will hold.
  it.each(ROWS)("round-trips %s through JSON text unchanged", (_name, input) => {
    const encoded = toJsonSafe(input);

    expect(JSON.parse(JSON.stringify(encoded))).toStrictEqual(encoded);
  });

  describe("sparse arrays", () => {
    it("keeps the length and the index alignment of an array with a hole at index 40", () => {
      // The index is the car index (gap traces, opponent flag bits), so a hole must not shift anything.
      const encoded = toJsonSafe(sparse(64, { 3: "a", 41: "b" })) as JsonValue[];

      expect(encoded).toHaveLength(64);
      expect(encoded[3]).toBe("a");
      expect(encoded[40]).toBeNull();
      expect(encoded[41]).toBe("b");
      // No index is left a hole: JSON text has none, and a hole would not survive toStrictEqual.
      expect(Object.keys(encoded)).toHaveLength(64);
    });
  });

  describe("cycles", () => {
    it("marks a reference to any ancestor, not only to the parent", () => {
      const root: Record<string, unknown> = { name: "root" };
      root.child = { grandchild: { back: root } };

      expect(toJsonSafe(root)).toStrictEqual({ name: "root", child: { grandchild: { back: "[Circular]" } } });
    });

    it("marks a cycle that runs through an array, a Set and a Map", () => {
      const list: unknown[] = [];
      list.push(list);

      const set = new Set<unknown>();
      set.add(set);

      const map = new Map<unknown, unknown>();
      map.set(map, map);

      expect(toJsonSafe({ list, set, map })).toStrictEqual({
        list: ["[Circular]"],
        set: ["[Circular]"],
        map: [["[Circular]", "[Circular]"]],
      });
    });

    it("does not call a sibling that was already encoded circular", () => {
      const leaf = { v: 1 };

      // `leaf` is an ancestor of nothing here: it is reached three times by different paths.
      expect(toJsonSafe([leaf, leaf, { again: leaf }])).toStrictEqual([{ v: 1 }, { v: 1 }, { again: { v: 1 } }]);
    });
  });

  describe("depth", () => {
    it(`allows ${JSON_SAFE_MAX_DEPTH} levels, the spec's figure`, () => {
      expect(JSON_SAFE_MAX_DEPTH).toBe(32);
    });

    it("encodes the deepest allowed container in full", () => {
      const encoded = toJsonSafe(nested(JSON_SAFE_MAX_DEPTH));

      expect(descend(encoded, JSON_SAFE_MAX_DEPTH)).toStrictEqual({ leaf: true });
    });

    it("replaces a container one level deeper by [MaxDepth]", () => {
      const encoded = toJsonSafe(nested(JSON_SAFE_MAX_DEPTH + 1));

      expect(descend(encoded, JSON_SAFE_MAX_DEPTH)).toStrictEqual({ c: "[MaxDepth]" });
    });

    it("counts arrays as levels too", () => {
      const wrap = (inner: unknown): unknown => [inner];
      let allowed = toJsonSafe(nested(JSON_SAFE_MAX_DEPTH, wrap));
      let tooDeep = toJsonSafe(nested(JSON_SAFE_MAX_DEPTH + 1, wrap));

      for (let i = 0; i < JSON_SAFE_MAX_DEPTH; i++) {
        allowed = (allowed as JsonValue[])[0];
        tooDeep = (tooDeep as JsonValue[])[0];
      }

      expect(allowed).toStrictEqual({ leaf: true });
      expect(tooDeep).toStrictEqual(["[MaxDepth]"]);
    });
  });

  describe("what it does not absorb", () => {
    it("lets a throwing getter's error out, for the caller to isolate", () => {
      const state = {
        fine: 1,
        get bad(): number {
          throw new Error("boom");
        },
      };

      expect(() => toJsonSafe(state)).toThrow("boom");
    });

    it("starts clean after a throw: the next call sees no stale ancestors", () => {
      const state: Record<string, unknown> = { fine: 1 };

      Object.defineProperty(state, "bad", {
        enumerable: true,
        get: () => {
          throw new Error("boom");
        },
      });

      expect(() => toJsonSafe({ state })).toThrow("boom");
      expect(toJsonSafe({ state: { fine: 1 } })).toStrictEqual({ state: { fine: 1 } });
    });
  });

  it("never returns the input's own containers", () => {
    const inner = { v: 1 };
    const list = [inner];
    const encoded = toJsonSafe({ list }) as { list: JsonValue[] };

    expect(encoded.list).not.toBe(list);
    expect(encoded.list[0]).not.toBe(inner);
  });

  it("encodes an Error's message as a string even when something else was assigned to it", () => {
    const error = new Error("x");

    // A BigInt left in place would make JSON.stringify throw, which is what the encoder is for.
    Object.assign(error, { message: 7n });

    expect(toJsonSafe(error)).toStrictEqual({ name: "Error", message: "7" });
  });

  it("names an instance [Object] when its class shadows `name` with something that is not a string", () => {
    class Shadowed {}

    // In a template literal a symbol throws, which would cost the section this instance sits in.
    Object.defineProperty(Shadowed, "name", { value: Symbol("not a name") });

    expect(toJsonSafe(new Shadowed())).toBe("[Object]");
  });
});
