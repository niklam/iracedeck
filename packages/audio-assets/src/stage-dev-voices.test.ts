import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DEV_VOICE_PACKS_ROOT } from "../../../scripts/lib/dev-local.mjs";
import { OUTPUT_DIR } from "../scripts/pack-voice.mjs";
import { REPO_ROOT, stageDevVoices } from "../scripts/stage-dev-voices.mjs";
import type { VoicePackDefinition } from "./build/voice-packs.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "..", "scripts", "stage-dev-voices.mjs");

const PACKS: readonly VoicePackDefinition[] = [
  { id: "alpha", label: "Alpha", version: "1.0.0", voices: ["alpha"], bundled: false },
  { id: "beta", label: "Beta", version: "2.1.0", voices: ["beta"], bundled: false },
];

/** A packer double that records its calls and reports a fixed stage. */
function fakePacker() {
  return vi.fn(async (options: { pack: VoicePackDefinition; writeArchive: false }) => ({
    clips: 3,
    scripts: 1,
    stageDir: path.join(OUTPUT_DIR, options.pack.id),
  }));
}

function run(
  resolved: { voicePacksRoot: string | undefined; source: string | undefined; isDefaultRoot: boolean },
  existing: string[] = [],
) {
  const packVoice = fakePacker();
  const lines: string[] = [];
  const resolve = vi.fn(() => resolved);
  // The real default root is never listed or touched by these tests.
  const listDirectories = vi.fn((_dir: string) => existing);
  const removeDirectory = vi.fn((_dir: string) => {});
  let clock = 0;
  const promise = stageDevVoices({
    repoRoot: REPO_ROOT,
    resolve,
    packVoice,
    packs: PACKS,
    log: (message) => lines.push(message),
    // 1.5 s between the two readings, so the wall-time line is deterministic.
    now: () => (clock += 1500),
    listDirectories,
    removeDirectory,
  });

  return { promise, packVoice, lines, resolve, listDirectories, removeDirectory };
}

describe("stage-dev-voices", () => {
  it("the default development root IS the packer's output directory", () => {
    // The whole task rests on this: the plugin scans DEFAULT_DEV_VOICE_PACKS_ROOT,
    // the packer stages into OUTPUT_DIR. Two constants in two packages — if one
    // moves, the build stages where nothing looks.
    expect(path.resolve(REPO_ROOT, DEFAULT_DEV_VOICE_PACKS_ROOT)).toBe(OUTPUT_DIR);
    // And REPO_ROOT really is the repo root, not a guess that happens to agree.
    expect(path.resolve(REPO_ROOT, "packages", "audio-assets", "scripts", "stage-dev-voices.mjs")).toBe(SCRIPT);
  });

  it("when off, resolves against the repo root, stages nothing and says so in one line", async () => {
    const { promise, packVoice, lines, resolve } = run({
      voicePacksRoot: undefined,
      source: undefined,
      isDefaultRoot: false,
    });

    expect(await promise).toEqual({ outcome: "off", staged: [] });
    expect(resolve).toHaveBeenCalledWith(REPO_ROOT);
    expect(packVoice).not.toHaveBeenCalled();
    expect(lines).toEqual(["Development voices: off — nothing staged"]);
  });

  it("when switched off by the worktree marker, names the marker", async () => {
    const { promise, packVoice, lines } = run({
      voicePacksRoot: undefined,
      source: "dev.local.json",
      isDefaultRoot: false,
    });

    expect((await promise).outcome).toBe("off");
    expect(packVoice).not.toHaveBeenCalled();
    expect(lines).toEqual(["Development voices: off (dev.local.json) — nothing staged"]);
  });

  it("when on at a hand-picked root, stages nothing — the root belongs to whoever picked it", async () => {
    const picked = path.join(REPO_ROOT, "..", "my-voices");
    const { promise, packVoice, lines } = run({
      voicePacksRoot: picked,
      source: "dev.local.json",
      isDefaultRoot: false,
    });

    expect(await promise).toEqual({ outcome: "hand-picked", staged: [] });
    expect(packVoice).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(picked);
    expect(lines[0]).toMatch(/hand-picked root .* nothing staged/);
  });

  it("when on at the default root, stages every pack stage-only, in order, and reports the wall time", async () => {
    const { promise, packVoice, lines } = run({
      voicePacksRoot: OUTPUT_DIR,
      source: "IRACEDECK_DEV_VOICES",
      isDefaultRoot: true,
    });

    expect(await promise).toEqual({ outcome: "staged", staged: ["alpha", "beta"] });

    // Stage-only, every time: a build must never zip or write catalog/.
    expect(packVoice.mock.calls.map(([options]) => [options.pack.id, options.writeArchive])).toEqual([
      ["alpha", false],
      ["beta", false],
    ]);

    expect(lines[0]).toBe(`Development voices: on (IRACEDECK_DEV_VOICES) — staging 2 pack(s) into ${OUTPUT_DIR}`);
    expect(lines).toContain("  staged alpha@1.0.0: 3 clips, 1 callout script");
    expect(lines).toContain("  staged beta@2.1.0: 3 clips, 1 callout script");
    expect(lines.at(-1)).toBe(
      "Development voices: staged 2 pack(s) in 1.5 s — press Rescan voices, or restart the plugin",
    );
  });

  it("removes a staged directory that is no longer an authored pack, and only that", async () => {
    // `alpha` is authored and stays; `gamma` was dropped from VOICE_PACKS and
    // would otherwise keep playing. Zips are files, so the listing never
    // offers them and they are never removed.
    const { promise, lines, listDirectories, removeDirectory } = run(
      { voicePacksRoot: OUTPUT_DIR, source: "IRACEDECK_DEV_VOICES", isDefaultRoot: true },
      ["alpha", "gamma"],
    );

    expect((await promise).outcome).toBe("staged");
    expect(listDirectories).toHaveBeenCalledWith(OUTPUT_DIR);
    expect(removeDirectory.mock.calls).toEqual([[path.join(OUTPUT_DIR, "gamma")]]);
    // Under the "on" line, which says where it is working.
    expect(lines[1]).toBe("  removed gamma/ — not an authored pack, so a stale stage");
  });

  it("on a real directory, removes stale pack directories and leaves files and authored packs alone", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "iracedeck-stage-prune-"));

    try {
      mkdirSync(path.join(root, "alpha"));
      mkdirSync(path.join(root, "gamma", "voice"), { recursive: true });
      writeFileSync(path.join(root, "gamma", "voice", "clip.wav"), "");
      writeFileSync(path.join(root, "alpha-1.0.0.zip"), "");

      await stageDevVoices({
        resolve: () => ({ voicePacksRoot: root, source: "IRACEDECK_DEV_VOICES", isDefaultRoot: true }),
        packVoice: fakePacker(),
        packs: PACKS,
        outputDir: root,
        log: () => {},
      });

      expect(readdirSync(root).sort()).toEqual(["alpha", "alpha-1.0.0.zip"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes nothing when off or at a hand-picked root", async () => {
    for (const resolved of [
      { voicePacksRoot: undefined, source: undefined, isDefaultRoot: false },
      { voicePacksRoot: path.join(REPO_ROOT, "..", "my-voices"), source: "dev.local.json", isDefaultRoot: false },
    ]) {
      const { promise, listDirectories, removeDirectory } = run(resolved, ["gamma"]);

      await promise;
      expect(listDirectories).not.toHaveBeenCalled();
      expect(removeDirectory).not.toHaveBeenCalled();
    }
  });

  it("refuses to stage when the default root and the packer's output have drifted apart", async () => {
    const { promise, packVoice } = run({
      voicePacksRoot: path.join(REPO_ROOT, "somewhere-else"),
      source: "IRACEDECK_DEV_VOICES",
      isDefaultRoot: true,
    });

    await expect(promise).rejects.toThrow(/have drifted apart/);
    expect(packVoice).not.toHaveBeenCalled();
  });

  it("propagates a resolver throw — an invalid variable or marker fails the task", async () => {
    const packVoice = fakePacker();

    await expect(
      stageDevVoices({
        resolve: () => {
          throw new Error('IRACEDECK_DEV_VOICES must be "1" or "0"');
        },
        packVoice,
        packs: PACKS,
        log: () => {},
      }),
    ).rejects.toThrow(/IRACEDECK_DEV_VOICES/);
    expect(packVoice).not.toHaveBeenCalled();
  });

  it("propagates a pack failure and stops before the next pack", async () => {
    const packVoice = vi.fn(async () => {
      throw new Error('pack "alpha": voice "alpha" staged 2 of 3 source clips');
    });

    await expect(
      stageDevVoices({
        resolve: () => ({ voicePacksRoot: OUTPUT_DIR, source: "IRACEDECK_DEV_VOICES", isDefaultRoot: true }),
        packVoice,
        packs: PACKS,
        log: () => {},
        listDirectories: () => [],
        removeDirectory: () => {},
      }),
    ).rejects.toThrow(/staged 2 of 3/);
    expect(packVoice).toHaveBeenCalledTimes(1);
  });

  it("run as a script, exits 1 with the resolver's message on stderr for an invalid variable", () => {
    // The real resolver validates the variable on every call, whatever the
    // worktree's marker says, so this never reaches the packer.
    const child = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, IRACEDECK_DEV_VOICES: "yes" },
      encoding: "utf-8",
    });

    expect(child.status).toBe(1);
    expect(child.stderr).toMatch(/^stage:dev-voices: .*IRACEDECK_DEV_VOICES/);
    expect(child.stdout).toBe("");
  });
});
