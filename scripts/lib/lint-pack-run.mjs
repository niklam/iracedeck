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
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { BUNDLED_VOICE, registerCatalogEngine } from "./catalog-engine.mjs";

export const USAGE = "usage: pnpm lint:pack <packDir>  — the folder that holds voice-pack.json and voice/";

export const EXIT_CLEAN = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_USAGE = 2;

/**
 * The `base` of a `PLUGIN_PLAYED_CLIPS` entry that stands for every base of
 * its group — the builder's `PLUGIN_PLAYED_ANY_BASE`, restated here because
 * the constant below is built before the dist is loaded.
 */
export const ANY_BASE = "*";

/**
 * The clips PLUGIN CODE plays with the active voice by path, outside any
 * script or var — so no script references them, no vocabulary description
 * names them, and yet a pack that ships them is heard. One list, two
 * readers: `lintPack` takes the `group/base` keys as `pluginPlayedBases` and
 * never calls one an orphan, and `buildPackReference` takes the entries as
 * `pluginPlayed` and writes each `playedBy` onto its recording line, so the
 * website renders these words from the artifact and mirrors no list of its
 * own. The list lives HERE, on the plugin side of the seam, because the pure
 * linter and the pure builder are both ignorant of the plugin; each entry
 * names the code that plays it, and a new by-path consumer is a new entry.
 *
 * The exemption is per CLIP: the plugin plays each of these by its exact
 * name (`toggle/radio-check-01.mp3` — the `-01` take, not the pool), so a
 * misspelled sibling in the same group (`toggle/radio-chek`) is the orphan it
 * is, and `welcome/hello` — which nothing plays — is one too. `names/` is the
 * one group played whole: one clip per driver name, the name chosen at
 * runtime, so every base of it is heard. `lint-pack-run.test.mjs` holds every
 * exact entry to a clip in the bundled manifest.
 *
 * Two of these are the second step of a chain that stops at the first clip
 * it cannot start (`playVoiceSequence` in audio-toggles.ts, `if (!ok)
 * finish()`): the connect radio check and the Test button both play
 * `names/<driver>` FIRST, and the driver name resolves from the union of
 * every installed voice's names (`scanDriverNames`; `resolveActiveDriverName`
 * falls back to `driver`, then to the first name) — so a pack that records
 * `toggle/radio-check` or `welcome/greeting` without a `names/` clip for the
 * name the user is set to plays nothing at all for either. The `playedBy`
 * text says so, since it is what a pack author reads.
 *
 * @type {readonly { group: string, base: string, playedBy: string }[]}
 */
export const PLUGIN_PLAYED_CLIPS = Object.freeze([
  {
    group: "toggle",
    base: "radio-check",
    // packages/iracing-actions/src/actions/pit-crew/pit-crew.ts (`playRadioCheck`):
    // `voice/${voice}/names/${driverName}.mp3`, then `voice/${voice}/toggle/radio-check-01.mp3`.
    playedBy:
      "Played by the plugin itself, outside the script: the radio check when the sim connects, as toggle/radio-check-01 after the driver's name. The check plays names/<driver> first and stops at the first clip it cannot find, so record a names/ clip for the name the Race Engineer is set to as well.",
  },
  {
    group: "toggle",
    base: "going-silent",
    // packages/iracing-actions/src/audio/audio-toggles.ts (`playToggleAck`):
    // `voice/${voice}/toggle/${clipName}.mp3` with clipName "going-silent-01" | "resuming-01".
    playedBy:
      "Played by the plugin itself, outside the script: the acknowledgment when the Race Engineer is switched off, as toggle/going-silent-01.",
  },
  {
    group: "toggle",
    base: "resuming",
    // audio-toggles.ts (`playToggleAck`), the other clipName.
    playedBy:
      "Played by the plugin itself, outside the script: the acknowledgment when the Race Engineer is switched back on, as toggle/resuming-01.",
  },
  {
    group: "toggle",
    base: "corner-names-on",
    // audio-toggles.ts (`toggleCornerNamesFeature`):
    // `voice/${voice}/toggle/corner-names-${next ? "on" : "off"}-01.mp3`.
    playedBy:
      "Played by the plugin itself, outside the script: the acknowledgment when corner-name callouts are switched on, as toggle/corner-names-on-01.",
  },
  {
    group: "toggle",
    base: "corner-names-off",
    // audio-toggles.ts (`toggleCornerNamesFeature`), the `off` side.
    playedBy:
      "Played by the plugin itself, outside the script: the acknowledgment when corner-name callouts are switched off, as toggle/corner-names-off-01.",
  },
  {
    group: "welcome",
    base: "greeting",
    // packages/iracing-actions/src/audio/voice-test.ts (`playRaceEngineerVoiceTest`):
    // `voice/${voice}/names/${driverName}.mp3` (when a name resolves), then `voice/${voice}/welcome/greeting-01.mp3`.
    playedBy:
      "Played by the plugin itself, outside the script: what the Race Engineer Test button in iRaceDeck Settings plays, as welcome/greeting-01 after the driver's name. The button plays names/<driver> first and stops at the first clip it cannot find, so a pack that wants the Test button voiced records a names/ clip for the name it is set to as well.",
  },
  {
    group: "names",
    base: ANY_BASE,
    // pit-crew.ts (`playRadioCheck`) and voice-test.ts (`playRaceEngineerVoiceTest`):
    // `voice/${voice}/names/${driverName}.mp3`, the name from `resolveActiveDriverName`.
    playedBy:
      "Played by the plugin itself, outside the script: the driver's name, one clip per name, spoken before the radio check and before the Test button's greeting. The names a pack ships are the names its users can be called by; the group is optional.",
  },
]);

/** The `group/base` keys of `PLUGIN_PLAYED_CLIPS`, `group/*` for a group played whole — what `lintPack` takes. */
export const PLUGIN_PLAYED_BASES = Object.freeze(PLUGIN_PLAYED_CLIPS.map((clip) => `${clip.group}/${clip.base}`));

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
 *     engine: Pick<import("@iracedeck/audio-scenarios").IScenarioEngine, "contracts" | "vocabulary" | "compileScript">,
 *     manifest: Pick<import("@iracedeck/audio-scenarios").AudioAssetsManifest, "clips">,
 *     audioScenarios: Pick<typeof import("@iracedeck/audio-scenarios"), "lintPack" | "formatLintReport">,
 *   }>,
 *   fs?: import("@iracedeck/audio-scenarios").LintPackFileSystem,
 * }} [io]
 * @returns {Promise<number>} The exit code.
 */
/**
 * Whether `resolved` is a directory we can stat — `false` for a path that is
 * missing, not a directory, or gone/unreadable between the check and the
 * stat, so every one of those exits with the usage status instead of an
 * unhandled rejection.
 */
function isDirectory(resolved) {
  try {
    return statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

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

  if (!isDirectory(resolved)) {
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

  const { engine, manifest, audioScenarios } = catalog;
  const report = audioScenarios.lintPack({
    packDir: resolved,
    packDirName: path.basename(resolved),
    fs,
    contracts: engine.contracts(),
    vocabulary: engine.vocabulary(),
    // The engine's own compile, so a pack is checked against the deps the plugin compiles it with.
    compile: engine.compileScript.bind(engine),
    // The plugin's built-ins — the runtime manifest's clips outside `voice/` (the ticks, the ambience bed, the radar tones).
    sharedClips: manifest.clips.filter((clip) => !clip.startsWith("voice/")),
    bundledVoiceIds: [BUNDLED_VOICE],
    pluginPlayedBases: PLUGIN_PLAYED_BASES,
  });

  log(`Linting ${resolved}`);
  log("");

  for (const line of audioScenarios.formatLintReport(report)) log(line);

  return report.ok ? EXIT_CLEAN : EXIT_PROBLEMS;
}
