import { describe, expect, it, vi } from "vitest";

import { describeThrownValue, isStatePartError, readStatePart } from "./state-part.js";

/** An object every read of which throws — a getter, a Proxy trap, its own conversion. */
function hostile(): unknown {
  return new Proxy(
    {},
    {
      get: () => {
        throw new Error("the trap threw");
      },
      has: () => {
        throw new Error("the trap threw");
      },
    },
  );
}

describe("describeThrownValue", () => {
  it("is an Error's message", () => {
    expect(describeThrownValue(new Error("getFrameOptions threw"))).toBe("getFrameOptions threw");
    expect(describeThrownValue(new TypeError("  padded  "))).toBe("padded");
  });

  it("is the Error's name when the message says nothing", () => {
    expect(describeThrownValue(new RangeError(""))).toBe("RangeError");
    expect(describeThrownValue(new Error("   "))).toBe("Error");
  });

  it("is a thrown primitive's own text", () => {
    expect(describeThrownValue("plain text")).toBe("plain text");
    expect(describeThrownValue(42)).toBe("42");
    expect(describeThrownValue(false)).toBe("false");
    expect(describeThrownValue(10n)).toBe("10");
    expect(describeThrownValue(Symbol("why"))).toBe("Symbol(why)");
  });

  it("reads a message off any thrown object, never its string conversion", () => {
    const toString = vi.fn(() => "converted");

    expect(describeThrownValue({ message: "from an object" })).toBe("from an object");
    expect(describeThrownValue({ name: "NamedOnly" })).toBe("NamedOnly");
    expect(describeThrownValue({ toString })).toBe("unknown error");
    expect(toString).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["a blank string", " \n\t"],
    ["an empty object", {}],
    ["a function", () => "no"],
    ["an object with a non-string message", { message: { nested: true }, name: [] }],
  ])("is the fixed text for %s", (_label, thrown) => {
    expect(describeThrownValue(thrown)).toBe("unknown error");
  });

  it("is the fixed text when reading the thrown value throws", () => {
    const getters = {
      get message(): string {
        throw new Error("the getter threw");
      },
      toString(): string {
        throw new Error("the conversion threw");
      },
    };

    expect(describeThrownValue(getters)).toBe("unknown error");
    expect(describeThrownValue(hostile())).toBe("unknown error");
  });
});

describe("readStatePart", () => {
  it("returns what the read returns, untouched", () => {
    const live = { ids: new Set([1]) };

    expect(readStatePart(() => live)).toBe(live);
    expect(readStatePart(() => null)).toBeNull();
    expect(readStatePart(() => "luca")).toBe("luca");
  });

  it("turns a throw into an error entry holding the reason", () => {
    expect(
      readStatePart(() => {
        throw new Error("boom");
      }),
    ).toStrictEqual({ error: "boom" });
  });

  it.each([
    ["a string", "plain text", "plain text"],
    ["undefined", undefined, "unknown error"],
    ["an object whose every read throws", hostile(), "unknown error"],
  ])("never throws and never gives an empty reason for %s", (_label, thrown, reason) => {
    const part = readStatePart((): number => {
      throw thrown;
    });

    expect(part).toStrictEqual({ error: reason });
  });
});

describe("isStatePartError", () => {
  it("recognises an error entry", () => {
    expect(isStatePartError({ error: "boom" })).toBe(true);
    expect(isStatePartError(readStatePart(() => JSON.parse("{")))).toBe(true);
  });

  it.each([
    ["null — no voice selected", null],
    ["a voice id", "luca"],
    ["the frame switches", { beeps: true, ambience: false }],
    ["a family's state", { lastGapCalloutAt: null }],
    ["an array", [{ error: "x" }]],
    ["an error key that is not a reason", { error: null }],
    ["an empty reason", { error: "" }],
  ])("does not take healthy state for one: %s", (_label, part) => {
    expect(isStatePartError(part)).toBe(false);
  });

  it("never throws on a value whose reads throw", () => {
    expect(isStatePartError(hostile())).toBe(false);
  });
});
