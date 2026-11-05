import { describe, expect, it } from "vitest";

import { pickTarget } from "./package-exports.mjs";

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
