// Guard for #1375: every package under packages/ is decided about the sim
// boundary, so none is left unguarded by omission.
//
// The sim-neutral block in eslint.config.js is built from SIM_NEUTRAL_PACKAGES.
// While its files were a hand list, nothing noticed a package missing from it:
// settings and voice-packs went unguarded until #1375, and event-bus and the
// three deck adapters, sim-neutral by design, until later in the same issue. A
// manifest is no backstop, since the root Vitest aliases make every
// `@iracedeck/*` package resolvable from any test.
//
// The rule, per directory under packages/: it is in exactly one of
//   * SIM_NEUTRAL_PACKAGES (eslint.config.js) — the sim-neutral block holds it;
//   * OWN_BLOCK below — a sim block of its own holds it;
//   * SIM_SIDE below — it is iRacing's, and imports a sim package by design.
// Then, by behaviour rather than by reading the config: a planted import of
// @iracedeck/iracing-native is refused in every package of the first two and
// allowed in every SIM_SIDE one, so an entry left behind by a moved boundary
// fails as surely as a new package in none of the three.
//
// And one structural check: no file is held by two blocks setting the same
// restricted-imports rule. A later flat-config block's options for a rule
// replace an earlier one's rather than merging, so a file matching two would
// silently lose the first block's restrictions.
import { ESLint } from "eslint";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import config, { SIM_NEUTRAL_PACKAGES } from "../eslint.config.js";
import { trackedPackageDirs } from "./lib/workspace-packages.mjs";

const TIMEOUT = 60_000;
const repoRoot = join(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: repoRoot });
const RULES = ["no-restricted-imports", "@typescript-eslint/no-restricted-imports"];

const PACKAGES = trackedPackageDirs(repoRoot);

/**
 * Packages a sim block of their own holds, each with the block and its proof.
 * The plugin shells are discovered by prefix, as their block's glob is, so a
 * fourth shell needs no entry here.
 */
const OWN_BLOCK = {
  ...Object.fromEntries(
    PACKAGES.filter((dir) => dir.startsWith("iracing-plugin-")).map((dir) => [
      dir,
      "A plugin shell: the plugin-shell block refuses every sim package, tests included (#1500); scripts/plugin-shell-sim-boundary.test.mjs.",
    ]),
  ),
  "audio-scenarios":
    "The Race Engineer catalog: its own block allows the translator's types and refuses the deck layer and the native addon (#1378); scripts/audio-scenarios-sim-boundary.test.mjs.",
};

/** Packages that are iRacing's and import a sim package by design, each with its reason. */
const SIM_SIDE = {
  "iracing-native":
    "iRacing's native addon: the SDK reader, keyboard input and window focus the iRacing layer is built on.",
  "iracing-sdk": "The TypeScript layer over iRacing's SDK.",
  "sim-events-iracing": "iRacing's translator, from SDK ticks to event-bus events.",
  "deck-iracing": "iRacing's side of deck-core's SimConnection seam (#1351).",
  "replay-engine":
    "iRacing's replay engine over the SDK's replay commands; its own block refuses the deck side (#1467).",
  "race-engineer-wiring": "Wires the iRacing translator and SDK into registerPitCrew's dependencies.",
  "iracing-actions": "Every action; reads iRacing through deck-iracing's SimIRacingAction and getCommands().",
  "plugin-runtime": "The composition root: builds the iRacing sim connection and hands HostSim to the shells (#1500).",
  "scenario-harness": "The QA harness: drives the iRacing translator from recorded sessions.",
};

async function simMessages(filePath) {
  const [result] = await eslint.lintText(`import { x } from "@iracedeck/iracing-native";\nexport const y = x;\n`, {
    filePath,
  });

  return result.messages.filter((m) => RULES.includes(m.ruleId));
}

function setsRule(block, rule) {
  const entry = block.rules?.[rule];
  const severity = Array.isArray(entry) ? entry[0] : entry;

  return severity !== undefined && severity !== "off" && severity !== 0;
}

describe("sim boundary coverage", () => {
  it("decides every package exactly once", () => {
    const lists = { SIM_NEUTRAL_PACKAGES, OWN_BLOCK: Object.keys(OWN_BLOCK), SIM_SIDE: Object.keys(SIM_SIDE) };
    const undecided = PACKAGES.filter((dir) => !Object.values(lists).some((names) => names.includes(dir)));
    const twice = PACKAGES.filter((dir) => Object.values(lists).filter((names) => names.includes(dir)).length > 1);

    expect(undecided, "add each to SIM_NEUTRAL_PACKAGES in eslint.config.js, or to SIM_SIDE with its reason").toEqual(
      [],
    );
    expect(twice).toEqual([]);
  });

  it("names no package that does not exist", () => {
    const stale = [...SIM_NEUTRAL_PACKAGES, ...Object.keys(SIM_SIDE)].filter((dir) => !PACKAGES.includes(dir));

    expect(stale).toEqual([]);
  });

  it("finds the shells and the catalog it expects", () => {
    expect(Object.keys(OWN_BLOCK).sort()).toEqual([
      "audio-scenarios",
      "iracing-plugin-mirabox",
      "iracing-plugin-stream-deck",
      "iracing-plugin-ulanzi",
    ]);
  });

  for (const dir of [...SIM_NEUTRAL_PACKAGES, ...Object.keys(OWN_BLOCK)]) {
    it(
      `refuses a sim import in ${dir}`,
      async () => {
        expect(await simMessages(`packages/${dir}/src/planted.ts`)).toHaveLength(1);
      },
      TIMEOUT,
    );
  }

  for (const dir of Object.keys(SIM_SIDE)) {
    it(
      `allows a sim import in ${dir}, which is sim-side`,
      async () => {
        expect(await simMessages(`packages/${dir}/src/planted.ts`)).toEqual([]);
      },
      TIMEOUT,
    );
  }

  describe("no file is held by two blocks setting one restricted-imports rule", () => {
    // Each block on its own, so ESLint's own matching (files, ignores) decides
    // whether it reaches a path; with the config's plugins, which a typed rule
    // needs to resolve.
    const plugins = { plugins: Object.assign({}, ...config.map((block) => block.plugins ?? {})) };
    const alone = (block) => new ESLint({ cwd: repoRoot, overrideConfigFile: true, overrideConfig: [plugins, block] });
    const blocks = RULES.map((rule) => ({
      rule,
      engines: config.filter((block) => setsRule(block, rule)).map(alone),
    }));

    it("finds the blocks that set the rules", () => {
      // The sim-neutral, replay-engine, iracing-actions and plugin-shell blocks
      // set the base rule; the audio-scenarios catalog block the typed one.
      expect(blocks.map(({ engines }) => engines.length)).toEqual([4, 1]);
    });

    // Every extension a block can hold: the .mts and .astro files are linted since #1616.
    const PLANTED = [
      "src/planted.ts",
      "src/nested/planted.test.ts",
      "src/planted.test-support.ts",
      "scripts/planted.mjs",
      "scripts/planted.mts",
      "src/components/Planted.astro",
    ];

    for (const dir of PACKAGES) {
      it(
        `holds each file of ${dir} with at most one block per rule`,
        async () => {
          for (const file of PLANTED) {
            const filePath = join(repoRoot, "packages", dir, file);

            for (const { rule, engines } of blocks) {
              const matches = [];

              for (const engine of engines) {
                const resolved = await engine.calculateConfigForFile(filePath);

                if (resolved && setsRule(resolved, rule)) matches.push(engine);
              }

              expect(matches.length, `${rule} in packages/${dir}/${file}`).toBeLessThanOrEqual(1);
            }
          }
        },
        TIMEOUT,
      );
    }

    // The positive control: two blocks that both reach a file are counted as two,
    // so the check above can fail.
    it(
      "counts a planted overlap",
      async () => {
        const block = config.find(
          (b) =>
            setsRule(b, "no-restricted-imports") &&
            b.files?.some((glob) => typeof glob === "string" && glob.startsWith("packages/deck-core/")),
        );
        const engines = [block, { ...block }].map(alone);
        const filePath = join(repoRoot, "packages/deck-core/src/planted.ts");
        const resolved = await Promise.all(engines.map((engine) => engine.calculateConfigForFile(filePath)));

        expect(resolved.filter((r) => r && setsRule(r, "no-restricted-imports"))).toHaveLength(2);
      },
      TIMEOUT,
    );
  });
});
