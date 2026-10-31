// A device shell may not reach a simulator package (#1500): what its host
// extension reads of the sim arrives as PluginExtensionContext.sim. The ESLint
// rule is the guard, and this test proves it fires in every shell, in a test
// file too, so deleting or narrowing the rule goes red.
import { ESLint } from "eslint";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RULE = "no-restricted-imports";
const TIMEOUT = 60_000;
const repoRoot = join(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: repoRoot });

// Discovered, so a fourth shell is guarded the day it is added.
const SHELLS = readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("iracing-plugin-"))
  .map((entry) => entry.name)
  .sort();

const BANNED = [
  "@iracedeck/deck-iracing",
  "@iracedeck/sim-events-iracing",
  "@iracedeck/iracing-sdk",
  "@iracedeck/iracing-native",
];

async function lint(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });

  return result.messages.filter((m) => m.ruleId === RULE);
}

describe("plugin shell sim boundary", () => {
  it("finds the three shells", () => {
    expect(SHELLS).toEqual(["iracing-plugin-mirabox", "iracing-plugin-stream-deck", "iracing-plugin-ulanzi"]);
  });

  for (const shell of SHELLS) {
    for (const pkg of BANNED) {
      it(
        `refuses ${pkg} in ${shell}`,
        async () => {
          const messages = await lint(
            `import { x } from "${pkg}";\nexport const y = x;\n`,
            `packages/${shell}/src/planted.ts`,
          );

          expect(messages).toHaveLength(1);
          expect(messages[0].message).toContain("PluginExtensionContext.sim");
          expect(messages[0].message).toContain("#1500");
        },
        TIMEOUT,
      );

      it(
        `refuses a type-only ${pkg} import in a ${shell} test`,
        async () => {
          const messages = await lint(
            `import type { X } from "${pkg}";\nexport type Y = X;\n`,
            `packages/${shell}/src/planted.test.ts`,
          );

          expect(messages).toHaveLength(1);
        },
        TIMEOUT,
      );

      it(
        `refuses a deep ${pkg} import in ${shell}`,
        async () => {
          const messages = await lint(
            `import { x } from "${pkg}/dist/index.js";\nexport const y = x;\n`,
            `packages/${shell}/src/nested/planted.ts`,
          );

          expect(messages).toHaveLength(1);
        },
        TIMEOUT,
      );
    }
  }

  it(
    "allows the extension contract from plugin-runtime",
    async () => {
      const messages = await lint(
        `import type { HostSim } from "@iracedeck/plugin-runtime";\nexport type Y = HostSim;\n`,
        "packages/iracing-plugin-stream-deck/src/planted.ts",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "allows the same import outside the shells",
    async () => {
      const messages = await lint(
        `import { x } from "@iracedeck/sim-events-iracing";\nexport const y = x;\n`,
        "packages/plugin-runtime/src/planted.ts",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );
});
