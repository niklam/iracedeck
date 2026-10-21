// The replay engine may not reach the deck layer, the settings or its own
// consumers (#1467): what it needs from them is injected by plugin-runtime's
// initReplay phase. The ESLint rule is the guard, and this test proves it
// fires, so deleting or narrowing the rule goes red.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "no-restricted-imports";
const TIMEOUT = 60_000;
const eslint = new ESLint({ cwd: import.meta.dirname + "/.." });

const REFUSED = [
  "@iracedeck/deck-core",
  "@iracedeck/deck-iracing",
  "@iracedeck/settings",
  "@iracedeck/icons",
  "@iracedeck/iracing-actions",
];

async function lint(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });

  return result.messages.filter((m) => m.ruleId === RULE);
}

describe("replay engine boundary", () => {
  for (const pkg of REFUSED) {
    it(
      `refuses ${pkg} in replay-engine`,
      async () => {
        const messages = await lint(
          `import { x } from "${pkg}";\nexport const y = x;\n`,
          "packages/replay-engine/src/planted.ts",
        );

        expect(messages).toHaveLength(1);
      },
      TIMEOUT,
    );

    it(
      `refuses a type-only ${pkg} import in replay-engine`,
      async () => {
        const messages = await lint(
          `import type { X } from "${pkg}";\nexport type Y = X;\n`,
          "packages/replay-engine/src/planted.ts",
        );

        expect(messages).toHaveLength(1);
      },
      TIMEOUT,
    );
  }

  it(
    "refuses an icon SVG import",
    async () => {
      const messages = await lint(
        `import svg from "@iracedeck/icons/replay-control/pause.svg";\nexport const y = svg;\n`,
        "packages/replay-engine/src/planted.ts",
      );

      expect(messages).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "allows the sim and the store",
    async () => {
      const messages = await lint(
        `import { x } from "@iracedeck/iracing-sdk";\nimport { z } from "@iracedeck/replay-store";\nexport const y = [x, z];\n`,
        "packages/replay-engine/src/planted.ts",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "allows the deck layer outside the engine",
    async () => {
      const messages = await lint(
        `import { x } from "@iracedeck/deck-core";\nexport const y = x;\n`,
        "packages/iracing-actions/src/planted.ts",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );
});
