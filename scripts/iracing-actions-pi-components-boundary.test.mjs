// iracing-actions is bundled into every plugin, and @iracedeck/pi-components is
// only its PI-template tests' devDependency (#1375): ./testing renders the pages
// through ejs and node:fs, ./build is the Rollup tooling. The ESLint block is
// the guard, and this test proves it refuses the package and its subpaths in a
// non-test source, value and type-only, and lets the tests and their support
// files through, so deleting or narrowing the block goes red.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "no-restricted-imports";
const TIMEOUT = 60_000;
const eslint = new ESLint({ cwd: import.meta.dirname + "/.." });

const SPECIFIERS = ["@iracedeck/pi-components", "@iracedeck/pi-components/testing", "@iracedeck/pi-components/build"];

async function lint(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });

  return result.messages.filter((m) => m.ruleId === RULE);
}

describe("iracing-actions keeps pi-components test-only", () => {
  for (const specifier of SPECIFIERS) {
    it(
      `refuses ${specifier} in a source file`,
      async () => {
        const messages = await lint(
          `import { x } from "${specifier}";\nexport const y = x;\n`,
          "packages/iracing-actions/src/actions/planted/planted.ts",
        );

        expect(messages).toHaveLength(1);
        expect(messages[0].message).toContain("devDependency");
        expect(messages[0].message).toContain("#1375");
      },
      TIMEOUT,
    );

    it(
      `refuses a type-only ${specifier} import in a source file`,
      async () => {
        const messages = await lint(
          `import type { X } from "${specifier}";\nexport type Y = X;\n`,
          "packages/iracing-actions/src/shared/planted.ts",
        );

        expect(messages).toHaveLength(1);
      },
      TIMEOUT,
    );

    // The negative controls: the files the edge exists for.
    for (const file of ["src/pi-templates/planted.test.ts", "src/pi-templates/planted.test-support.ts"]) {
      it(
        `allows ${specifier} in ${file}`,
        async () => {
          const messages = await lint(
            `import { x } from "${specifier}";\nexport const y = x;\n`,
            `packages/iracing-actions/${file}`,
          );

          expect(messages).toHaveLength(0);
        },
        TIMEOUT,
      );
    }
  }

  it(
    "refuses no other import, nor a name that only shares the prefix",
    async () => {
      const messages = await lint(
        `import { a } from "@iracedeck/iracing-sdk";\nimport { b } from "@iracedeck/deck-iracing";\nimport { c } from "@iracedeck/pi-components-extra";\nexport const y = [a, b, c];\n`,
        "packages/iracing-actions/src/shared/planted.ts",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "leaves pi-components' other consumers alone",
    async () => {
      const messages = await lint(
        `import { x } from "@iracedeck/pi-components/build";\nexport const y = x;\n`,
        "packages/plugin-build/src/planted.mjs",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );
});
