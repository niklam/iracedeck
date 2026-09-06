// The `pnpm lint:pack` plumbing (issue #1066): the argument handling, the
// exit codes and the `node:fs` port. The rules are tested where they live,
// in `packages/audio-scenarios/src/reference/lint-pack.test.ts`; here the
// linter is a stub, so nothing needs the built dist.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUDIO_MANIFEST_PATH, BUNDLED_VOICE } from "./catalog-engine.mjs";
import {
  ANY_BASE,
  createLintPackFileSystem,
  EXIT_CLEAN,
  EXIT_PROBLEMS,
  EXIT_USAGE,
  PLUGIN_PLAYED_BASES,
  PLUGIN_PLAYED_CLIPS,
  runLintPack,
  USAGE,
} from "./lint-pack-run.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

/** A stub manifest's clips in the runtime shape — a voice's plus a shared sfx — so the runner's split can be seen. */
const MANIFEST_CLIPS = [
  "sfx/IRD-tick-open.mp3",
  "voice/default/flags/green-01.mp3",
  "voice/default/toggle/radio-check-01.mp3",
];

/** A register() whose engine reports nothing and whose linter answers with the given report. */
function stubCatalog(report) {
  const calls = [];
  const compiled = {
    scenarios: new Map(),
    frames: new Map(),
    failedFrames: new Map(),
    pools: new Map(),
    skipped: [],
    fragmentProblems: new Map(),
  };
  const engine = {
    contracts: () => [],
    vocabulary: () => ({ vars: [], conds: [], cases: [] }),
    compileScript() {
      // Bound by the runner: `this` is the engine, as the real method needs.
      return this === engine ? compiled : undefined;
    },
  };
  const register = async () => ({
    engine,
    manifest: { clips: MANIFEST_CLIPS },
    audioScenarios: {
      lintPack: (input) => {
        calls.push(input);

        return report;
      },
      formatLintReport: (r) => [`formatted ${r.problems.length}`],
    },
  });

  return { register, calls, compiled };
}

function sinks() {
  const out = [];
  const err = [];

  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

describe("runLintPack", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lint-pack-run-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints the usage to stderr and exits 2 with no argument, a help flag, or a second argument", async () => {
    for (const argv of [[], ["--help"], ["-h"], [dir, "extra"]]) {
      const io = sinks();

      expect(await runLintPack(argv, io)).toBe(EXIT_USAGE);
      expect(io.err).toEqual([USAGE]);
      expect(io.out).toEqual([]);
    }
  });

  it("refuses a path that is not a directory, exit 2, without loading the catalog", async () => {
    const io = sinks();
    let registered = false;
    const file = path.join(dir, "voice-pack.json");
    writeFileSync(file, "{}");

    const code = await runLintPack([file], {
      ...io,
      register: async () => {
        registered = true;
        throw new Error("must not be called");
      },
    });

    expect(code).toBe(EXIT_USAGE);
    expect(registered).toBe(false);
    expect(io.err[0]).toMatch(/is not a directory$/);
    expect(io.err[1]).toBe(USAGE);
  });

  it("reports a catalog that cannot load — the missing dist — on stderr, exit 2", async () => {
    const io = sinks();

    const code = await runLintPack([dir], {
      ...io,
      register: async () => {
        throw new Error("dist is missing — run `pnpm build` first");
      },
    });

    expect(code).toBe(EXIT_USAGE);
    expect(io.err).toEqual(["dist is missing — run `pnpm build` first"]);
  });

  it("hands the linter the resolved pack dir and its name, the engine's reports, prints the formatted report, exits 0 when clean", async () => {
    const io = sinks();
    const { register, calls } = stubCatalog({ ok: true, problems: [], voices: [] });

    const code = await runLintPack([dir], { ...io, register });

    expect(code).toBe(EXIT_CLEAN);
    expect(calls).toHaveLength(1);
    expect(calls[0].packDir).toBe(path.resolve(dir));
    expect(calls[0].packDirName).toBe(path.basename(dir));
    expect(calls[0].contracts).toEqual([]);
    expect(calls[0].vocabulary).toEqual({ vars: [], conds: [], cases: [] });
    expect(typeof calls[0].fs.listMp3Files).toBe("function");
    expect(io.out).toEqual([`Linting ${path.resolve(dir)}`, "", "formatted 0"]);
    expect(io.err).toEqual([]);
  });

  it("hands the linter the engine's own compile, bound, the manifest's shared clips and the bundled voice id", async () => {
    const { register, calls, compiled } = stubCatalog({ ok: true, problems: [], voices: [] });

    await runLintPack([dir], { ...sinks(), register });

    // `engine.compileScript.bind(engine)`: the method reads the engine's registries through `this`.
    expect(calls[0].compile({ schema: 1, scenarios: {}, frames: {}, pools: {} })).toBe(compiled);
    // Only what the plugin ships outside any voice — a voice's own clips are the pack's business.
    expect(calls[0].sharedClips).toEqual(["sfx/IRD-tick-open.mp3"]);
    expect(calls[0].bundledVoiceIds).toEqual([BUNDLED_VOICE]);
  });

  it("passes the plugin-played clips through as group/base keys — the plugin-side list the pure linter does not know", async () => {
    const { register, calls } = stubCatalog({ ok: true, problems: [], voices: [] });

    await runLintPack([dir], { ...sinks(), register });

    expect(calls[0].pluginPlayedBases).toBe(PLUGIN_PLAYED_BASES);
    expect([...PLUGIN_PLAYED_BASES]).toEqual([
      "toggle/radio-check",
      "toggle/going-silent",
      "toggle/resuming",
      "toggle/corner-names-on",
      "toggle/corner-names-off",
      "welcome/greeting",
      `names/${ANY_BASE}`,
    ]);
  });

  // The list is the plugin's word for what it plays by path; an entry naming
  // a clip the bundled voice does not ship is a path that went away (or a
  // typo here), and the exemption it grants is then a hole.
  it("names only clips the bundled manifest ships, exactly, and a group wildcard only for a group with clips", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, AUDIO_MANIFEST_PATH), "utf-8"));
    const prefix = `voice/${BUNDLED_VOICE}/`;
    const bundled = new Set(
      manifest.clips
        .filter((clip) => clip.startsWith(prefix))
        .map((clip) => clip.slice(prefix.length, -".mp3".length).replace(/-\d{2}$/, "")),
    );

    for (const { group, base, playedBy } of PLUGIN_PLAYED_CLIPS) {
      expect(playedBy.length, `${group}/${base}`).toBeGreaterThan(0);

      if (base === ANY_BASE) {
        expect(
          [...bundled].some((key) => key.startsWith(`${group}/`)),
          `${group}/*`,
        ).toBe(true);
      } else {
        expect(bundled.has(`${group}/${base}`), `${group}/${base}`).toBe(true);
      }
    }

    // One group is played whole today — the driver names. A second wildcard
    // is a deliberate widening, not a convenience: it excuses every base of
    // its group from the orphan rule.
    expect(PLUGIN_PLAYED_CLIPS.filter((clip) => clip.base === ANY_BASE).map((clip) => clip.group)).toEqual(["names"]);
  });

  it("exits 1 when the report has problems", async () => {
    const io = sinks();
    const { register } = stubCatalog({
      ok: false,
      problems: [{ voice: null, kind: "manifest", message: "x" }],
      voices: [],
    });

    expect(await runLintPack([dir], { ...io, register })).toBe(EXIT_PROBLEMS);
    expect(io.out.at(-1)).toBe("formatted 1");
  });
});

describe("createLintPackFileSystem", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lint-pack-fs-"));
    mkdirSync(path.join(dir, "voice", "demo", "flags"), { recursive: true });
    mkdirSync(path.join(dir, "voice", "other"), { recursive: true });
    writeFileSync(path.join(dir, "voice", "demo", "flags", "green-01.mp3"), "");
    writeFileSync(path.join(dir, "voice", "demo", "flags", "yellow-01.MP3"), "");
    writeFileSync(path.join(dir, "voice", "demo", "callouts.json"), "{}");
    writeFileSync(path.join(dir, "voice", "demo", "notes.txt"), "");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists every .mp3 under a folder, any case, as sorted POSIX paths relative to it", () => {
    const fs = createLintPackFileSystem();

    expect(fs.listMp3Files(dir)).toEqual(["voice/demo/flags/green-01.mp3", "voice/demo/flags/yellow-01.MP3"]);
    expect(fs.listMp3Files(path.join(dir, "missing"))).toEqual([]);
  });

  it("lists the immediate subdirectories, and none for a folder that does not exist", () => {
    const fs = createLintPackFileSystem();

    expect(fs.listDirectories(path.join(dir, "voice")).sort()).toEqual(["demo", "other"]);
    expect(fs.listDirectories(path.join(dir, "nope"))).toEqual([]);
  });

  it("reads a file, and tells a missing one apart from an unreadable one", () => {
    const fs = createLintPackFileSystem();

    expect(fs.readTextFile(path.join(dir, "voice", "demo", "callouts.json"))).toEqual({ ok: true, text: "{}" });
    expect(fs.readTextFile(path.join(dir, "voice", "demo", "absent.json"))).toEqual({
      ok: false,
      missing: true,
      reason: "ENOENT",
    });

    // A directory where a file was expected is a read that fails for another reason.
    const asDirectory = fs.readTextFile(path.join(dir, "voice", "demo"));

    expect(asDirectory.ok).toBe(false);
    expect(asDirectory.missing).toBe(false);
  });
});
