// deck-core may not reach a simulator SDK (#1351), and neither may the packages
// split out of it (#1367) or settings beneath it and voice-packs (#1375): the
// ESLint rule below is the guard, and this test proves it fires in each — for a
// value import, a type-only one in a test file and a deep subpath — and stays
// silent on a clean file, so deleting or narrowing the rule goes red.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "no-restricted-imports";
const TIMEOUT = 60_000;
const eslint = new ESLint({ cwd: import.meta.dirname + "/.." });

const GUARDED = [
  "deck-core",
  "replay-store",
  "diagnostics",
  "app-updates",
  "settings-window",
  "settings",
  "voice-packs",
];

const BANNED = [
  "@iracedeck/iracing-sdk",
  "@iracedeck/iracing-native",
  "@iracedeck/sim-events-iracing",
  "@iracedeck/deck-iracing",
];

async function lint(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });

  return result.messages.filter((m) => m.ruleId === RULE);
}

describe("deck-core sim boundary", () => {
  for (const dir of GUARDED) {
    for (const pkg of BANNED) {
      it(
        `refuses ${pkg} in ${dir}`,
        async () => {
          const messages = await lint(
            `import { x } from "${pkg}";\nexport const y = x;\n`,
            `packages/${dir}/src/planted.ts`,
          );

          expect(messages).toHaveLength(1);
          expect(messages[0].message).toContain("SimConnection");
          expect(messages[0].message).toContain("#1375");
        },
        TIMEOUT,
      );

      it(
        `refuses a type-only ${pkg} import in a ${dir} test`,
        async () => {
          const messages = await lint(
            `import type { X } from "${pkg}";\nexport type Y = X;\n`,
            `packages/${dir}/src/planted.test.ts`,
          );

          expect(messages).toHaveLength(1);
        },
        TIMEOUT,
      );

      it(
        `refuses a deep ${pkg} import in ${dir}`,
        async () => {
          const messages = await lint(
            `import { x } from "${pkg}/dist/index.js";\nexport const y = x;\n`,
            `packages/${dir}/src/nested/planted.ts`,
          );

          expect(messages).toHaveLength(1);
          expect(messages[0].message).toContain("#1375");
        },
        TIMEOUT,
      );
    }

    // The negative control: a clean file, including a name that only shares a
    // banned package's prefix, draws nothing, so the subpath pattern is no
    // wider than the packages it names.
    it(
      `allows a sim-neutral import in ${dir}`,
      async () => {
        const messages = await lint(
          `import { x } from "@iracedeck/logger";\nimport { z } from "@iracedeck/iracing-sdk-neutral";\nexport const y = [x, z];\n`,
          `packages/${dir}/src/planted.ts`,
        );

        expect(messages).toHaveLength(0);
      },
      TIMEOUT,
    );
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
