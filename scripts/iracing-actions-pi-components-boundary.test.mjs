// iracing-actions is bundled into every plugin, and @iracedeck/pi-components is
// only its PI-template tests' devDependency (#1375): ./testing renders the pages
// through ejs and node:fs, ./build is the Rollup tooling. The ESLint block is
// the guard, and this test proves it refuses the package and its subpaths in a
// non-test source, value and type-only, and lets the tests and their support
// files through, so deleting or narrowing the block goes red. Since a support
// file may import it, a non-test source is refused a *.test-support module too.
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

  // A *.test-support.ts file may import pi-components, so a non-test source
  // importing one by relative path would bundle it: refused in each specifier
  // shape, the .js one being what the repo writes.
  const SUPPORT_SPECIFIERS = [
    "./planted.test-support.js",
    "../../shared/press-shape.test-support.js",
    "./planted.test-support.ts",
    "./planted.test-support",
  ];

  for (const specifier of SUPPORT_SPECIFIERS) {
    it(
      `refuses ${specifier} in a source file`,
      async () => {
        const messages = await lint(
          `import { x } from "${specifier}";\nexport const y = x;\n`,
          "packages/iracing-actions/src/actions/planted/planted.ts",
        );

        expect(messages).toHaveLength(1);
        expect(messages[0].message).toContain("test-support");
        expect(messages[0].message).toContain("#1375");
      },
      TIMEOUT,
    );
  }

  it(
    "refuses a type-only or re-exported test-support module in a source file",
    async () => {
      const messages = await lint(
        `import type { X } from "./planted.test-support.js";\nexport type Y = X;\nexport { z } from "./other.test-support.js";\n`,
        "packages/iracing-actions/src/shared/planted.ts",
      );

      expect(messages).toHaveLength(2);
    },
    TIMEOUT,
  );

  // Both patterns live in one options object, so the second did not replace
  // the first: one file draws both refusals.
  it(
    "refuses pi-components and a test-support module side by side",
    async () => {
      const messages = await lint(
        `import { a } from "@iracedeck/pi-components/testing";\nimport { b } from "./planted.test-support.js";\nexport const y = [a, b];\n`,
        "packages/iracing-actions/src/shared/planted.ts",
      );

      expect(messages).toHaveLength(2);
      expect(messages[0].message).toContain("devDependency");
      expect(messages[1].message).toContain("test-support");
    },
    TIMEOUT,
  );

  // The negative controls: the tests and their support files import them.
  for (const file of ["src/shared/planted.test.ts", "src/shared/planted.test-support.ts"]) {
    it(
      `allows a test-support module in ${file}`,
      async () => {
        const messages = await lint(
          `import { x } from "./press-shape.test-support.js";\nexport const y = x;\n`,
          `packages/iracing-actions/${file}`,
        );

        expect(messages).toHaveLength(0);
      },
      TIMEOUT,
    );
  }

  it(
    "allows a module whose name only resembles test-support",
    async () => {
      const messages = await lint(
        `import { a } from "./test-supported.js";\nimport { b } from "./planted.test-supports.js";\nimport { c } from "./test-support-free.js";\nexport const y = [a, b, c];\n`,
        "packages/iracing-actions/src/shared/planted.ts",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );

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
