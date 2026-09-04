import { describe, expect, it, vi } from "vitest";

import { skipUnchanged } from "./settings-change-filter.js";

describe("skipUnchanged", () => {
  it("delivers the first value", () => {
    const spy = vi.fn();

    skipUnchanged(spy)("a");

    expect(spy).toHaveBeenCalledWith("a");
  });

  it("drops a repeat of the value it last delivered", () => {
    const spy = vi.fn();
    const wrapped = skipUnchanged(spy);

    wrapped("a");
    wrapped("a");
    wrapped("a");

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("delivers again once the value changes, and again when it changes back", () => {
    const spy = vi.fn();
    const wrapped = skipUnchanged(spy);

    wrapped("a");
    wrapped("b");
    wrapped("a");

    expect(spy.mock.calls.map(([v]) => v)).toEqual(["a", "b", "a"]);
  });

  // The case that would have broken `ird-key-binding`'s default settling: it
  // acts on being TOLD the setting is empty, so an empty first value has to
  // arrive. A memo initialised to "" or to undefined would have eaten it.
  it.each([
    ["an empty string", ""],
    ["the string 'undefined'", "undefined"],
    ["the string 'null'", "null"],
  ])("delivers %s as a first value", (_label, value) => {
    const spy = vi.fn();

    skipUnchanged(spy)(value);

    expect(spy).toHaveBeenCalledWith(value);
  });

  // Per subscription, not per key. Two components watching one key each need
  // their own first delivery; one having rendered says nothing about the other.
  it("keeps separate memos per wrapped callback", () => {
    const first = vi.fn();
    const second = vi.fn();
    const wrappedFirst = skipUnchanged(first);
    const wrappedSecond = skipUnchanged(second);

    wrappedFirst("a");
    wrappedFirst("a");
    wrappedSecond("a");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
