// The Race Engineer catalog reads the sim only through the deps registerPitCrew is
// handed (#1378): it may name the translator's types, never import its getters, and
// never reach the deck or native layers. The ESLint rule is the guard, and this test
// proves it fires, so deleting or narrowing the rule goes red.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "@typescript-eslint/no-restricted-imports";
const TIMEOUT = 60_000;
const eslint = new ESLint({ cwd: import.meta.dirname + "/.." });
const CATALOG_FILE = "packages/audio-scenarios/src/planted.ts";
const TRANSLATOR = "@iracedeck/sim-events-iracing";

async function lint(code, filePath = CATALOG_FILE) {
  const [result] = await eslint.lintText(code, { filePath });

  return result.messages.filter((m) => m.ruleId === RULE);
}

describe("audio-scenarios sim boundary", () => {
  it(
    "refuses a value import of a translator getter",
    async () => {
      const messages = await lint(
        `import { getSessionType } from "${TRANSLATOR}";\nexport const y = getSessionType;\n`,
      );

      expect(messages).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "refuses a mixed import of a type and a getter",
    async () => {
      const messages = await lint(
        `import { type LiveGaps, getSessionType } from "${TRANSLATOR}";\nexport const y: LiveGaps | undefined = getSessionType();\n`,
      );

      expect(messages).toHaveLength(1);
    },
    TIMEOUT,
  );

  for (const pkg of ["@iracedeck/deck-iracing", "@iracedeck/iracing-native"]) {
    it(
      `refuses ${pkg}`,
      async () => {
        const messages = await lint(`import { x } from "${pkg}";\nexport const y = x;\n`);

        expect(messages).toHaveLength(1);
      },
      TIMEOUT,
    );

    it(
      `refuses a type-only ${pkg} import`,
      async () => {
        const messages = await lint(`import type { X } from "${pkg}";\nexport type Y = X;\n`);

        expect(messages).toHaveLength(1);
      },
      TIMEOUT,
    );
  }

  it(
    "allows a type-only translator import",
    async () => {
      const messages = await lint(`import type { LiveGaps } from "${TRANSLATOR}";\nexport type Y = LiveGaps;\n`);

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "allows an inline type translator import",
    async () => {
      const messages = await lint(`import { type LiveGaps } from "${TRANSLATOR}";\nexport type Y = LiveGaps;\n`);

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "allows the value import in a test file",
    async () => {
      const messages = await lint(
        `import { getSessionType } from "${TRANSLATOR}";\nexport const y = getSessionType;\n`,
        "packages/audio-scenarios/src/planted.test.ts",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );
});
