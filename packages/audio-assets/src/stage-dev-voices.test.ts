import { spawnSync } from "node:child_process";
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

function run(resolved: { voicePacksRoot: string | undefined; source: string | undefined; isDefaultRoot: boolean }) {
  const packVoice = fakePacker();
  const lines: string[] = [];
  const resolve = vi.fn(() => resolved);
  let clock = 0;
  const promise = stageDevVoices({
    repoRoot: REPO_ROOT,
    resolve,
    packVoice,
    packs: PACKS,
    log: (message) => lines.push(message),
    // 1.5 s between the two readings, so the wall-time line is deterministic.
    now: () => (clock += 1500),
  });

  return { promise, packVoice, lines, resolve };
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
    expect(lines.at(-1)).toBe("Development voices: staged 2 pack(s) in 1.5 s — restart the plugin or Rescan voices");
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
