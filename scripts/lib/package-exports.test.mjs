import { describe, expect, it } from "vitest";

import { pickTarget, testingEntrySource, testingEntrySources } from "./package-exports.mjs";

describe("pickTarget", () => {
  it("takes a string, and the first array element that yields one", () => {
    expect(pickTarget("./dist/index.js")).toBe("./dist/index.js");
    expect(pickTarget([{ types: "./dist/x.d.ts" }, "./dist/x.js"])).toBe("./dist/x.js");
    expect(pickTarget(null)).toBeNull();
    expect(pickTarget(undefined)).toBeNull();
  });

  it("resolves a conditions object by its own key order", () => {
    // The reverse order is source, so it needs no alias.
    expect(pickTarget({ import: "./src/index.ts", node: "./dist/index.js" })).toBe("./src/index.ts");
    // `types` and `require` are skipped wherever they stand; `default` is taken in place.
    expect(pickTarget({ types: "./dist/index.d.ts", require: "./dist/index.cjs", import: "./src/index.ts" })).toBe(
      "./src/index.ts",
    );
    expect(pickTarget({ default: "./dist/index.js", import: "./src/index.ts" })).toBe("./dist/index.js");
    expect(pickTarget({ development: "./dist/dev.js", import: "./src/index.ts" })).toBe("./dist/dev.js");
    // Nested: the first active outer key wins, and its inner object resolves by its own order.
    expect(pickTarget({ node: { require: "./dist/x.cjs", default: "./dist/x.js" }, import: "./src/x.ts" })).toBe(
      "./dist/x.js",
    );
    // A nested object with no active key yields nothing, so resolution falls through to the next key.
    expect(pickTarget({ node: { require: "./dist/x.cjs" }, import: "./src/x.ts" })).toBe("./src/x.ts");
    expect(pickTarget({ types: "./dist/x.d.ts", require: "./dist/x.cjs" })).toBeNull();
  });
});

describe("a package's testing entry source (#1375)", () => {
  it("maps a dist export to its source and takes a source export as it is", () => {
    expect(
      testingEntrySource("deck-core", {
        exports: { "./testing": { import: "./dist/testing.js", types: "./dist/testing.d.ts" } },
      }),
    ).toBe("packages/deck-core/src/testing.ts");
    expect(testingEntrySource("pi-components", { exports: { "./testing": "./src/build/testing.ts" } })).toBe(
      "packages/pi-components/src/build/testing.ts",
    );
    expect(testingEntrySource("logger", { exports: { ".": "./dist/index.js" } })).toBeUndefined();
    expect(testingEntrySource("logger", { exports: "./dist/index.js" })).toBeUndefined();
    expect(testingEntrySource("logger", { exports: { ".": "./dist/index.js", "./testing": null } })).toBeUndefined();
    expect(testingEntrySource("logger", {})).toBeUndefined();
  });

  it("resolves a testing export through nested conditions", () => {
    for (const target of [
      { import: { types: "./dist/testing.d.ts", default: "./dist/testing.js" } },
      { types: "./dist/testing.d.ts", node: "./dist/testing.js" },
      { types: "./dist/testing.d.ts", default: "./dist/testing.js" },
      { node: { import: { types: "./dist/testing.d.ts", default: "./dist/testing.js" } } },
      { require: "./dist/testing.cjs", import: "./dist/testing.js" },
      [{ types: "./dist/testing.d.ts" }, "./dist/testing.js"],
    ]) {
      expect(testingEntrySource("deck-core", { exports: { "./testing": target } }), JSON.stringify(target)).toBe(
        "packages/deck-core/src/testing.ts",
      );
    }
    expect(testingEntrySource("deck-core", { exports: { "./testing": "./dist/testing.mjs" } })).toBe(
      "packages/deck-core/src/testing.mts",
    );
  });

  it("fails, rather than skips, a testing export it cannot derive a source from", () => {
    for (const target of [
      { types: "./dist/testing.d.ts" },
      { types: "./dist/testing.d.ts", require: "./dist/testing.cjs" },
      { import: { types: "./dist/testing.d.ts" } },
      {},
      [],
    ]) {
      expect(
        () => testingEntrySource("deck-core", { exports: { "./testing": target } }),
        JSON.stringify(target),
      ).toThrow("packages/deck-core/package.json declares a ./testing export");
    }
    expect(() => testingEntrySource("deck-core", { exports: { "./testing": "./dist/testing.json" } })).toThrow(
      "is a dist/ file whose source cannot be derived",
    );
  });

  it("collects every entry, and a problem for an underivable or untracked one", () => {
    const manifests = {
      ok: { exports: { "./testing": { import: { default: "./dist/testing.js" } } } },
      none: { exports: { ".": "./dist/index.js" } },
      underivable: { exports: { "./testing": { types: "./dist/testing.d.ts" } } },
      untracked: { exports: { "./testing": "./dist/testing.js" } },
    };
    const { sources, problems } = testingEntrySources(
      Object.keys(manifests),
      (dir) => manifests[dir],
      new Set(["packages/ok/src/testing.ts"]),
    );

    expect([...sources]).toEqual(["packages/ok/src/testing.ts"]);
    expect(problems).toEqual([
      expect.stringContaining("packages/underivable/package.json declares a ./testing export"),
      expect.stringContaining(
        "packages/untracked/package.json's ./testing export is built from packages/untracked/src/testing.ts, which git does not track",
      ),
    ]);
  });
});
