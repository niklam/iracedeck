// A sim-neutral package may not reach a simulator package: deck-core (#1351),
// the packages split out of it (#1367), and since #1375 every package named in
// SIM_NEUTRAL_PACKAGES in eslint.config.js. The ESLint rule is the guard, and
// this test proves it fires in each — for a value import, a type-only one in a
// test file, a deep subpath and an .mjs file outside src/ — and stays silent on
// a clean file, so deleting or narrowing the rule goes red. The packages are read
// from the config itself, so a package added there is planted here too;
// scripts/sim-boundary-coverage.test.mjs checks the list against packages/.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { SIM_NEUTRAL_PACKAGES } from "../eslint.config.js";

const RULE = "no-restricted-imports";
const TIMEOUT = 60_000;
const eslint = new ESLint({ cwd: import.meta.dirname + "/.." });

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
  // The members #1375 added, named here as well as in the config, so dropping
  // one from the list is red rather than a quietly shorter loop below.
  it("guards the deck layer, the two seams and the leaves", () => {
    expect(SIM_NEUTRAL_PACKAGES).toEqual(
      expect.arrayContaining([
        "deck-core",
        "replay-store",
        "diagnostics",
        "app-updates",
        "settings-window",
        "settings",
        "voice-packs",
        "event-bus",
        "deck-adapter-elgato",
        "deck-adapter-mirabox",
        "deck-adapter-ulanzi",
      ]),
    );
  });

  for (const dir of SIM_NEUTRAL_PACKAGES) {
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

    // The block reaches past src/ for every .ts and .mjs file of the package: a
    // build script or a config written as .mjs is held too. It holds no
    // .astro or .mts file, which no lint gate here reads (see the block's
    // comment in eslint.config.js).
    it(
      `refuses a sim import in an .mjs file outside ${dir}/src`,
      async () => {
        const messages = await lint(
          `import { x } from "@iracedeck/iracing-sdk";\nexport const y = x;\n`,
          `packages/${dir}/scripts/planted.mjs`,
        );

        expect(messages).toHaveLength(1);
        expect(messages[0].message).toContain("#1375");
      },
      TIMEOUT,
    );

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
