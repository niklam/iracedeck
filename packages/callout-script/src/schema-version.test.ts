import { describe, expect, it } from "vitest";

import { declaresNewerSchema } from "./schema-version.js";

describe("declaresNewerSchema", () => {
  it("holds for a schema number above the current version", () => {
    expect(declaresNewerSchema({ schema: 2 }, 1)).toBe(true);
    expect(declaresNewerSchema({ schema: 1.5 }, 1)).toBe(true);
  });

  it("does not hold for the current version or one below it", () => {
    expect(declaresNewerSchema({ schema: 1 }, 1)).toBe(false);
    expect(declaresNewerSchema({ schema: 0 }, 1)).toBe(false);
  });

  it.each([
    ["a missing schema", {}],
    ["a schema given as a string", { schema: "2" }],
    ["a schema of null", { schema: null }],
    ["a document that is not an object", "schema: 2"],
    ["a null document", null],
  ])("does not hold for %s — an author's mistake, not a newer toolchain", (_label, json) => {
    expect(declaresNewerSchema(json, 1)).toBe(false);
  });
});
