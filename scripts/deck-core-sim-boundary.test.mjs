// A sim-neutral package may not reach a simulator package: deck-core (#1351),
// the packages split out of it (#1367), and since #1375 every package named in
// SIM_NEUTRAL_PACKAGES in eslint.config.js. The ESLint rule is the guard, and
// this test proves it fires in each — for a value import, a type-only one in a
// test file, a deep subpath, an .mjs or .mts file outside src/ and an .astro
// component (#1616) — and stays silent on a clean file, so deleting or narrowing
// the rule goes red. The packages are read
// from the config itself, so a package added there is planted here too;
// scripts/sim-boundary-coverage.test.mjs checks the list against packages/.
//
// Since #1662 the same block refuses every other workspace package that is not
// sim-neutral (NON_NEUTRAL_PACKAGES, the complement the config derives), so a
// sim-neutral package cannot load the sim at one remove through
// `@iracedeck/iracing-actions` or the like. The tests below hold the complement
// to the workspace, plant each of its members, bare and by subpath, in every
// sim-neutral package, and keep a sim-neutral import passing.
import { ESLint } from "eslint";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { NON_NEUTRAL_PACKAGES, SIM_NEUTRAL_PACKAGES, WORKSPACE_PACKAGES } from "../eslint.config.js";
import { trackedPackageDirs } from "./lib/workspace-packages.mjs";

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

/**
 * What is wrong with the workspace inventory the ESLint config derives from
 * the disk (#1662), held to git's, over the same set of packages: every
 * tracked package must be in `workspace` under the name its package.json gives,
 * and an entry git does not track must still be a package on disk under that
 * name — a local package in progress, which the config reads as editors do, is
 * no problem, while an entry no package.json backs is a hand-written one. And
 * `nonNeutral`, restricted to the tracked packages, must name exactly the
 * tracked packages that are neither sim-neutral nor sim packages, with each
 * other entry an untracked package of `workspace` that is not sim-neutral.
 *
 * @param {object} input
 * @param {Readonly<Record<string, string>>} input.workspace directory → name, as WORKSPACE_PACKAGES
 * @param {readonly string[]} input.nonNeutral as NON_NEUTRAL_PACKAGES
 * @param {readonly string[]} input.neutral as SIM_NEUTRAL_PACKAGES
 * @param {readonly string[]} input.tracked the package directories git tracks a package.json in
 * @param {(dir: string) => string | undefined} input.nameOnDisk the `name` of `packages/<dir>/package.json`, or undefined without one
 * @returns {string[]}
 */
export function inventoryProblems({ workspace, nonNeutral, neutral, tracked, nameOnDisk }) {
  const problems = [];
  const trackedNames = new Map(tracked.map((dir) => [nameOnDisk(dir), dir]));

  for (const dir of tracked) {
    if (!Object.hasOwn(workspace, dir)) {
      problems.push(`WORKSPACE_PACKAGES leaves out packages/${dir}/ (${nameOnDisk(dir)})`);
    } else if (workspace[dir] !== nameOnDisk(dir)) {
      problems.push(`WORKSPACE_PACKAGES names packages/${dir}/ ${workspace[dir]}, not ${nameOnDisk(dir)}`);
    }
  }
  for (const [dir, name] of Object.entries(workspace)) {
    if (!tracked.includes(dir) && nameOnDisk(dir) !== name) {
      problems.push(`WORKSPACE_PACKAGES names packages/${dir}/ ${name}, but no package.json there says so`);
    }
  }

  const expected = tracked
    .filter((dir) => !neutral.includes(dir))
    .map(nameOnDisk)
    .filter((name) => !BANNED.includes(name));

  for (const name of expected) {
    if (!nonNeutral.includes(name)) problems.push(`NON_NEUTRAL_PACKAGES leaves out ${name}`);
  }
  for (const name of nonNeutral) {
    const dir = trackedNames.get(name);
    const untracked = Object.entries(workspace).find(([at, named]) => named === name && !tracked.includes(at));

    if (dir !== undefined ? !expected.includes(name) : untracked === undefined || neutral.includes(untracked[0])) {
      problems.push(
        `NON_NEUTRAL_PACKAGES names ${name}, which is no package that is neither sim-neutral nor a sim package`,
      );
    }
  }

  return problems;
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

    // The block reaches past src/ for every .ts, .mts and .mjs file of the
    // package: a build script or a config written as .mjs or .mts is held too.
    // So is an .astro component, its frontmatter and its <script> both (#1616).
    for (const [where, filePath, code] of [
      [
        "an .mjs file outside src",
        `packages/${dir}/scripts/planted.mjs`,
        `import { x } from "@iracedeck/iracing-sdk";\nexport const y = x;\n`,
      ],
      [
        "an .mts file outside src",
        `packages/${dir}/scripts/planted.mts`,
        `import { x } from "@iracedeck/iracing-sdk";\nexport const y = x;\n`,
      ],
      [
        "an .astro frontmatter",
        `packages/${dir}/src/components/Planted.astro`,
        `---\nimport { x } from "@iracedeck/iracing-sdk";\n---\n\n<p>{x}</p>\n`,
      ],
    ]) {
      it(
        `refuses a sim import in ${where} of ${dir}`,
        async () => {
          const messages = await lint(code, filePath);

          expect(messages).toHaveLength(1);
          expect(messages[0].message).toContain("#1375");
        },
        TIMEOUT,
      );
    }

    // Every other package that is not sim-neutral, by its bare name and by a
    // subpath, value and type-only alike (#1662). One planted file per
    // package, each import reported on its own line.
    it(
      `refuses every non-neutral workspace package in ${dir}, bare and by subpath`,
      async () => {
        const specifiers = NON_NEUTRAL_PACKAGES.flatMap((name) => [name, `${name}/sub/path.js`]);
        const code = specifiers
          .map((specifier, i) =>
            i % 2 === 0 ? `import { x${i} } from "${specifier}";` : `import type { X${i} } from "${specifier}";`,
          )
          .join("\n");
        const messages = await lint(`${code}\n`, `packages/${dir}/src/planted.ts`);

        expect(messages.map((m) => m.message.split(" import ")[0])).toEqual(specifiers.map((s) => `'${s}'`));
        for (const m of messages) {
          expect(m.message).toContain("depends only on sim-neutral packages");
          expect(m.message).toContain("#1662");
        }
      },
      TIMEOUT,
    );

    // The negative control: a clean file, including a name that only shares a
    // banned package's prefix, draws nothing, so the subpath pattern is no
    // wider than the packages it names. Sim-neutral packages, a subpath of
    // one among them, pass by design (#1662).
    it(
      `allows a sim-neutral import in ${dir}`,
      async () => {
        const messages = await lint(
          [
            `import { x } from "@iracedeck/logger";`,
            `import { e } from "@iracedeck/event-bus";`,
            `import { f } from "@iracedeck/audio-service/testing";`,
            `import { z } from "@iracedeck/iracing-sdk-neutral";`,
            `import { a } from "@iracedeck/iracing-actions-neutral";`,
            `export const y = [x, e, f, z, a];`,
            "",
          ].join("\n"),
          `packages/${dir}/src/planted.ts`,
        );

        expect(messages).toHaveLength(0);
      },
      TIMEOUT,
    );
  }

  // The complement the rule refuses is derived from the workspace, not
  // written out (#1662): every tracked package that is neither sim-neutral
  // nor one of the four sim packages, so a package added later is refused
  // until it is listed sim-neutral.
  describe("the complement of SIM_NEUTRAL_PACKAGES", () => {
    const ROOT = path.resolve(import.meta.dirname, "..");
    const dirs = trackedPackageDirs(ROOT);
    const nameOnDisk = (dir) => {
      const manifest = path.join(ROOT, "packages", dir, "package.json");

      return existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf-8")).name : undefined;
    };

    // The config reads the disk, git the index: compared over the tracked packages, so a
    // local untracked package passes here as it does in CI's clean checkout (#1662).
    it("reads every tracked workspace package by directory and name, and names nothing that is not a package", () => {
      expect(dirs.length).toBeGreaterThan(30);
      expect(
        inventoryProblems({
          workspace: WORKSPACE_PACKAGES,
          nonNeutral: NON_NEUTRAL_PACKAGES,
          neutral: SIM_NEUTRAL_PACKAGES,
          tracked: dirs,
          nameOnDisk,
        }),
      ).toEqual([]);
    });

    it("names every package that is neither sim-neutral nor a sim package, and nothing else", () => {
      // The ones that motivated it, named so a shortened derivation is red.
      expect(NON_NEUTRAL_PACKAGES).toEqual(
        expect.arrayContaining([
          "@iracedeck/iracing-actions",
          "@iracedeck/audio-scenarios",
          "@iracedeck/race-engineer-wiring",
          "@iracedeck/replay-engine",
          "@iracedeck/plugin-runtime",
          "@iracedeck/scenario-harness",
          "@iracedeck/iracing-plugin-stream-deck",
        ]),
      );
    });

    describe("inventoryProblems (positive controls)", () => {
      const disk = { a: "@x/a", b: "@x/b", sim: "@iracedeck/iracing-sdk", wip: "@x/wip", "wip-neutral": "@x/wn" };
      const clean = {
        workspace: { a: "@x/a", b: "@x/b", sim: "@iracedeck/iracing-sdk", wip: "@x/wip", "wip-neutral": "@x/wn" },
        nonNeutral: ["@x/b", "@x/wip"],
        neutral: ["a", "wip-neutral"],
        tracked: ["a", "b", "sim"],
        nameOnDisk: (dir) => disk[dir],
      };
      const problems = (change) => inventoryProblems({ ...clean, ...change });

      it("passes a derived inventory, an untracked package on disk included or not", () => {
        expect(problems({})).toEqual([]);
        expect(
          problems({ workspace: { a: "@x/a", b: "@x/b", sim: "@iracedeck/iracing-sdk" }, nonNeutral: ["@x/b"] }),
        ).toEqual([]);
      });

      it.each([
        [
          "a tracked package left out",
          { workspace: { a: "@x/a", sim: "@iracedeck/iracing-sdk" }, nonNeutral: ["@x/b"] },
          "WORKSPACE_PACKAGES leaves out packages/b/ (@x/b)",
        ],
        [
          "a tracked package under another name",
          { workspace: { ...clean.workspace, b: "@x/old-b" } },
          "WORKSPACE_PACKAGES names packages/b/ @x/old-b, not @x/b",
        ],
        [
          "an entry no package.json backs",
          { workspace: { ...clean.workspace, ghost: "@x/ghost" } },
          "WORKSPACE_PACKAGES names packages/ghost/ @x/ghost, but no package.json there says so",
        ],
        [
          "an untracked entry under another name",
          { workspace: { ...clean.workspace, wip: "@x/other" }, nonNeutral: ["@x/b", "@x/other"] },
          "WORKSPACE_PACKAGES names packages/wip/ @x/other, but no package.json there says so",
        ],
        ["a tracked non-neutral package left out", { nonNeutral: ["@x/wip"] }, "NON_NEUTRAL_PACKAGES leaves out @x/b"],
        [
          "a sim-neutral package named",
          { nonNeutral: ["@x/a", "@x/b"] },
          "NON_NEUTRAL_PACKAGES names @x/a, which is no package that is neither sim-neutral nor a sim package",
        ],
        [
          "a sim package named",
          { nonNeutral: ["@x/b", "@iracedeck/iracing-sdk"] },
          "NON_NEUTRAL_PACKAGES names @iracedeck/iracing-sdk, which is no package that is neither sim-neutral nor a sim package",
        ],
        [
          "a name no package has",
          { nonNeutral: ["@x/b", "@x/nope"] },
          "NON_NEUTRAL_PACKAGES names @x/nope, which is no package that is neither sim-neutral nor a sim package",
        ],
        [
          "an untracked sim-neutral package named",
          { nonNeutral: ["@x/b", "@x/wn"] },
          "NON_NEUTRAL_PACKAGES names @x/wn, which is no package that is neither sim-neutral nor a sim package",
        ],
      ])("fails %s", (_name, change, problem) => {
        expect(problems(change)).toEqual([problem]);
      });
    });
  });

  // The shape #1662 found open: the website declares @iracedeck/iracing-actions
  // (for build ordering, #1458), so an import of it resolves from any website
  // file. Refused in a component's frontmatter and <script>, a .ts module and
  // the .mts generator, as is the catalog's ./pit-crew subpath.
  describe("a non-neutral package in the website", () => {
    const CASES = [
      [
        "an .astro frontmatter",
        "packages/website/src/components/Planted.astro",
        `---\nimport { x } from "@iracedeck/iracing-actions";\nimport { z } from "@iracedeck/audio-scenarios/pit-crew";\n---\n\n<p>{x}{z}</p>\n`,
      ],
      [
        "an .astro <script>",
        "packages/website/src/pages/planted.astro",
        `<p>planted</p>\n\n<script>\n  import { x } from "@iracedeck/iracing-actions";\n  import { z } from "@iracedeck/audio-scenarios/pit-crew";\n\n  console.log(x, z);\n</script>\n`,
      ],
      [
        "a .ts module",
        "packages/website/src/planted.ts",
        `import { x } from "@iracedeck/iracing-actions";\nimport { z } from "@iracedeck/audio-scenarios/pit-crew";\n\nexport const y = [x, z];\n`,
      ],
      [
        "an .mts script",
        "packages/website/scripts/planted.mts",
        `import { x } from "@iracedeck/iracing-actions";\nimport { z } from "@iracedeck/audio-scenarios/pit-crew";\n\nexport const y = [x, z];\n`,
      ],
    ];

    for (const [where, filePath, code] of CASES) {
      it(
        `refuses @iracedeck/iracing-actions and @iracedeck/audio-scenarios/pit-crew in ${where}`,
        async () => {
          const messages = await lint(code, filePath);

          expect(messages.map((m) => m.message.split(" import ")[0])).toEqual([
            "'@iracedeck/iracing-actions'",
            "'@iracedeck/audio-scenarios/pit-crew'",
          ]);
          for (const m of messages) expect(m.message).toContain("#1662");
        },
        TIMEOUT,
      );
    }
  });

  // The website's own .astro components and .mts generator were linted by
  // nothing until #1616. A value import of the deck layer and a deep import of
  // the SDK are refused in each, and in the client code of a <script>, which
  // the Astro processor hands to ESLint as a virtual .ts file.
  describe("in the website's .astro and .mts files", () => {
    const CASES = [
      [
        "an .astro frontmatter",
        "packages/website/src/components/Planted.astro",
        `---\nimport { x } from "@iracedeck/deck-iracing";\nimport { z } from "@iracedeck/iracing-sdk/dist/index.js";\n---\n\n<p>{x}{z}</p>\n`,
      ],
      [
        "an .astro <script>",
        "packages/website/src/pages/planted.astro",
        `<p>planted</p>\n\n<script>\n  import { x } from "@iracedeck/deck-iracing";\n  import { z } from "@iracedeck/iracing-sdk/dist/index.js";\n\n  console.log(x, z);\n</script>\n`,
      ],
      [
        "an .mts script",
        "packages/website/scripts/planted.mts",
        `import { x } from "@iracedeck/deck-iracing";\nimport { z } from "@iracedeck/iracing-sdk/dist/index.js";\n\nexport const y = [x, z];\n`,
      ],
    ];

    for (const [where, filePath, code] of CASES) {
      it(
        `refuses @iracedeck/deck-iracing and an @iracedeck/iracing-sdk subpath in ${where}`,
        async () => {
          const messages = await lint(code, filePath);

          expect(messages.map((m) => m.message.split(" import ")[0])).toEqual([
            "'@iracedeck/deck-iracing'",
            "'@iracedeck/iracing-sdk/dist/index.js'",
          ]);

          for (const m of messages) {
            expect(m.message).toContain("SimConnection");
            expect(m.message).toContain("#1375");
          }
        },
        TIMEOUT,
      );
    }
  });

  it(
    "allows the same imports outside the guarded packages",
    async () => {
      const messages = await lint(
        `import { x } from "@iracedeck/iracing-sdk";\nimport { a } from "@iracedeck/race-engineer-wiring";\nexport const y = [x, a];\n`,
        "packages/deck-iracing/src/planted.ts",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );
});
