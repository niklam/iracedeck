// The `pnpm lint:pack` plumbing (issue #1066): the argument handling, the
// exit codes and the `node:fs` port. The rules are tested where they live,
// in `packages/audio-scenarios/src/reference/lint-pack.test.ts`; here the
// linter is a stub, so nothing needs the built dist.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLintPackFileSystem,
  EXIT_CLEAN,
  EXIT_PROBLEMS,
  EXIT_USAGE,
  PLUGIN_PLAYED_GROUPS,
  runLintPack,
  USAGE,
} from "./lint-pack-run.mjs";

/** A register() whose engine reports nothing and whose linter answers with the given report. */
function stubCatalog(report) {
  const calls = [];
  const register = async () => ({
    engine: { contracts: () => [], vocabulary: () => ({ vars: [], conds: [], cases: [] }) },
    audioScenarios: {
      lintPack: (input) => {
        calls.push(input);

        return report;
      },
      formatLintReport: (r) => [`formatted ${r.problems.length}`],
    },
  });

  return { register, calls };
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

  it("hands the linter the resolved pack dir and the engine's reports, prints the formatted report, exits 0 when clean", async () => {
    const io = sinks();
    const { register, calls } = stubCatalog({ ok: true, problems: [], voices: [] });

    const code = await runLintPack([dir], { ...io, register });

    expect(code).toBe(EXIT_CLEAN);
    expect(calls).toHaveLength(1);
    expect(calls[0].packDir).toBe(path.resolve(dir));
    expect(calls[0].contracts).toEqual([]);
    expect(calls[0].vocabulary).toEqual({ vars: [], conds: [], cases: [] });
    expect(typeof calls[0].fs.listMp3Files).toBe("function");
    expect(io.out).toEqual([`Linting ${path.resolve(dir)}`, "", "formatted 0"]);
    expect(io.err).toEqual([]);
  });

  it("passes the plugin-played groups through — the plugin-side list the pure linter does not know", async () => {
    const { register, calls } = stubCatalog({ ok: true, problems: [], voices: [] });

    await runLintPack([dir], { ...sinks(), register });

    expect(calls[0].pluginPlayedGroups).toBe(PLUGIN_PLAYED_GROUPS);
    // The two groups plugin code plays by path today; each entry in the
    // constant names the file that plays it.
    expect([...PLUGIN_PLAYED_GROUPS]).toEqual(["names", "toggle"]);
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
