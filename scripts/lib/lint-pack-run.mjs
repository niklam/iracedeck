// `pnpm lint:pack <packDir>` (issue #1066): tells a voice-pack author loudly
// what the plugin would only skip quietly — grammar problems in a voice's
// `callouts.json`, every compile skip the pack did not mean with its reason,
// frames and fragments that fail, clips the pack ships that nothing
// references, references to clips it does not ship — and a per-voice
// coverage summary.
//
// Composition only: `registerCatalogEngine` (catalog-engine.mjs) provides the
// registered engine off the BUILT `@iracedeck/audio-scenarios` dist, whose
// `lintPack` owns every rule and `formatLintReport` every printed line; this
// module binds the linter's filesystem port to `node:fs`, checks the argument
// and turns the report into an exit code. Exit 0 with the summary when the
// pack is clean, 1 when it has problems, 2 when the tool could not run — no
// argument, a path that is not a directory, or a missing dist (`pnpm build`
// first; the loader names the fix).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { registerCatalogEngine } from "./catalog-engine.mjs";

export const USAGE = "usage: pnpm lint:pack <packDir>  — the folder that holds voice-pack.json and voice/";

export const EXIT_CLEAN = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_USAGE = 2;

/**
 * Clip groups PLUGIN CODE plays with the active voice by path, outside any
 * script or var — so no script references them, no vocabulary description
 * names them, and yet a pack that ships them is heard. `lintPack` takes them
 * as `pluginPlayedGroups` and never calls a base in one an orphan. The list
 * lives HERE, on the plugin side of the seam, because the pure linter is as
 * ignorant of the plugin as the reference builder is; each entry names the
 * code that plays it, and a new by-path consumer is a new entry.
 */
export const PLUGIN_PLAYED_GROUPS = Object.freeze([
  // `voice/<voice>/names/<driver>.mp3` — the driver-name clip the connect
  // radio check opens with (packages/iracing-actions/src/actions/pit-crew/pit-crew.ts).
  "names",
  // `voice/<voice>/toggle/<clip>.mp3` — the radio check and the
  // going-silent / resuming / corner-names acknowledgments
  // (packages/iracing-actions/src/audio/audio-toggles.ts, pit-crew.ts).
  "toggle",
]);

/**
 * The linter's three disk operations over `node:fs` — the same shape as
 * deck-core's pack scanner, so a pack reads here exactly as it installs:
 * `.mp3` is matched case-insensitively and the name recorded verbatim (the
 * linter then reports an upper-case extension as unplayable, as the plugin
 * would), and a symlinked directory is never descended into.
 *
 * @returns {import("@iracedeck/audio-scenarios").LintPackFileSystem}
 */
export function createLintPackFileSystem() {
  return {
    listDirectories(dir) {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },

    readTextFile(file) {
      try {
        return { ok: true, text: readFileSync(file, "utf-8") };
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? String(err.code) : "unknown error";

        return { ok: false, missing: code === "ENOENT", reason: code };
      }
    },

    listMp3Files(dir) {
      const found = [];
      const walk = (current, relative) => {
        let entries;

        try {
          entries = readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;

          if (entry.isDirectory()) walk(path.join(current, entry.name), childRelative);
          else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp3")) found.push(childRelative);
        }
      };

      walk(dir, "");

      return found.sort();
    },
  };
}

/**
 * Run the linter for a command line and report through the injected sinks.
 *
 * @param {readonly string[]} argv - Arguments after the script name.
 * @param {{
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 *   register?: () => Promise<{
 *     engine: Pick<import("@iracedeck/audio-scenarios").IScenarioEngine, "contracts" | "vocabulary">,
 *     audioScenarios: Pick<typeof import("@iracedeck/audio-scenarios"), "lintPack" | "formatLintReport">,
 *   }>,
 *   fs?: import("@iracedeck/audio-scenarios").LintPackFileSystem,
 * }} [io]
 * @returns {Promise<number>} The exit code.
 */
export async function runLintPack(argv, io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const error = io.error ?? ((line) => console.error(line));
  const register = io.register ?? registerCatalogEngine;
  const fs = io.fs ?? createLintPackFileSystem();
  const [packDir, ...rest] = argv;

  if (!packDir || rest.length > 0 || packDir === "-h" || packDir === "--help") {
    error(USAGE);

    return EXIT_USAGE;
  }

  const resolved = path.resolve(packDir);

  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    error(`${resolved} is not a directory`);
    error(USAGE);

    return EXIT_USAGE;
  }

  let catalog;

  try {
    catalog = await register();
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));

    return EXIT_USAGE;
  }

  const { engine, audioScenarios } = catalog;
  const report = audioScenarios.lintPack({
    packDir: resolved,
    fs,
    contracts: engine.contracts(),
    vocabulary: engine.vocabulary(),
    pluginPlayedGroups: PLUGIN_PLAYED_GROUPS,
  });

  log(`Linting ${resolved}`);
  log("");

  for (const line of audioScenarios.formatLintReport(report)) log(line);

  return report.ok ? EXIT_CLEAN : EXIT_PROBLEMS;
}
