// deck-core may not reach a simulator SDK (#1351): the ESLint rule below is the
// guard, and this test proves it fires, so deleting or narrowing the rule goes red.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "no-restricted-imports";
const TIMEOUT = 60_000;
const eslint = new ESLint({ cwd: import.meta.dirname + "/.." });

async function lint(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });

  return result.messages.filter((m) => m.ruleId === RULE);
}

describe("deck-core sim boundary", () => {
  for (const pkg of [
    "@iracedeck/iracing-sdk",
    "@iracedeck/iracing-native",
    "@iracedeck/sim-events-iracing",
    "@iracedeck/deck-iracing",
  ]) {
    it(
      `refuses ${pkg} in deck-core`,
      async () => {
        const messages = await lint(
          `import { x } from "${pkg}";\nexport const y = x;\n`,
          "packages/deck-core/src/planted.ts",
        );

        expect(messages).toHaveLength(1);
      },
      TIMEOUT,
    );

    it(
      `refuses a type-only ${pkg} import in deck-core`,
      async () => {
        const messages = await lint(
          `import type { X } from "${pkg}";\nexport type Y = X;\n`,
          "packages/deck-core/src/planted.ts",
        );

        expect(messages).toHaveLength(1);
      },
      TIMEOUT,
    );
  }

  it(
    "allows the same import outside deck-core",
    async () => {
      const messages = await lint(
        `import { x } from "@iracedeck/iracing-sdk";\nexport const y = x;\n`,
        "packages/deck-iracing/src/planted.ts",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );
});
