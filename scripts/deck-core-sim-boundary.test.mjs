// deck-core may not reach a simulator SDK (#1351), and neither may the packages
// split out of it (#1367): the ESLint rule below is the guard, and this test
// proves it fires in each, so deleting or narrowing the rule goes red.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "no-restricted-imports";
const TIMEOUT = 60_000;
const eslint = new ESLint({ cwd: import.meta.dirname + "/.." });

const GUARDED = ["deck-core", "replay-store", "diagnostics", "app-updates", "settings-window"];

async function lint(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });

  return result.messages.filter((m) => m.ruleId === RULE);
}

describe("deck-core sim boundary", () => {
  for (const dir of GUARDED) {
    for (const pkg of [
      "@iracedeck/iracing-sdk",
      "@iracedeck/iracing-native",
      "@iracedeck/sim-events-iracing",
      "@iracedeck/deck-iracing",
    ]) {
      it(
        `refuses ${pkg} in ${dir}`,
        async () => {
          const messages = await lint(
            `import { x } from "${pkg}";\nexport const y = x;\n`,
            `packages/${dir}/src/planted.ts`,
          );

          expect(messages).toHaveLength(1);
        },
        TIMEOUT,
      );

      it(
        `refuses a type-only ${pkg} import in ${dir}`,
        async () => {
          const messages = await lint(
            `import type { X } from "${pkg}";\nexport type Y = X;\n`,
            `packages/${dir}/src/planted.ts`,
          );

          expect(messages).toHaveLength(1);
        },
        TIMEOUT,
      );
    }
  }

  it(
    "allows the same import outside the guarded packages",
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
