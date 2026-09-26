import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The dial primitives and the dash-box renderers must stay liftable into a
 * sim-neutral package when a second action package exists (#1013): they may
 * import deck-core and zod, never the iRacing SDK or its translator. A
 * source-text guard, because the thing forbidden is an import edge, not a
 * behaviour.
 */
const SHARED = join(process.cwd(), "packages/iracing-actions/src/shared");
const FORBIDDEN = ["@iracedeck/iracing-sdk", "@iracedeck/sim-events-iracing"];
const dialModules = readdirSync(SHARED).filter(
  (f) => f.startsWith("dial-") && f.endsWith(".ts") && !f.endsWith(".test.ts"),
);

describe("shared/dial-* stays free of sim imports", () => {
  it("finds the dial modules", () => {
    expect(dialModules).toEqual(
      expect.arrayContaining([
        "dial-box.ts",
        "dial-strip-box.ts",
        "dial-knob-box.ts",
        "dial-name-icon.ts",
        "dial-preview.ts",
      ]),
    );
  });

  it.each(dialModules)("%s", (file) => {
    const source = readFileSync(join(SHARED, file), "utf-8");

    for (const pkg of FORBIDDEN) expect(source, `${file} imports ${pkg}`).not.toContain(pkg);
  });
});
