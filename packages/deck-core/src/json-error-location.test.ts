import { describe, expect, it } from "vitest";

import { locateJsonError } from "./json-error-location.js";

describe("locateJsonError", () => {
  it.each([
    ["{}"],
    ["[]"],
    ['{ "a": [1, -2.5e+3, true, false, null, "x\\n\\u00e9"], "b": {} }'],
    ['\r\n  { "a": 0 }  \n'],
    ["42"],
  ])("is undefined for valid JSON: %s", (text) => {
    expect(() => JSON.parse(text)).not.toThrow();
    expect(locateJsonError(text)).toBeUndefined();
  });

  it("points a trailing comma at the token after it, the way the store writes files", () => {
    expect(locateJsonError('{\n  "a": 1,\n}\n')).toEqual({ line: 3, column: 1 });
  });

  it("finds an unquoted value, which V8 reports with no position at all", () => {
    expect(locateJsonError('{\n  "debugLogging": True\n}')).toEqual({ line: 2, column: 19 });
  });

  it("finds a single-quoted key and a missing comma", () => {
    expect(locateJsonError("{\n  'a': 1\n}")).toEqual({ line: 2, column: 3 });
    expect(locateJsonError('{\n  "a": 1\n  "b": 2\n}')).toEqual({ line: 3, column: 3 });
  });

  it("reports the end of the text for a truncated file, and line 1 column 1 for an empty one", () => {
    expect(locateJsonError('{\n  "a": [1, 2')).toEqual({ line: 2, column: 13 });
    expect(locateJsonError("")).toEqual({ line: 1, column: 1 });
  });

  it("rejects what JSON.parse rejects: raw control characters, bad escapes, leading zeros, trailing junk", () => {
    for (const text of ['"a\tb"', '"\\x"', "01", "{} x", "1.", "-"]) {
      expect(() => JSON.parse(text)).toThrow();
      expect(locateJsonError(text)).toBeDefined();
    }
  });
});
