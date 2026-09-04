import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OUT_DIR,
  parseArgs,
  publishVoicePacks,
  releaseNotes,
  releaseTitle,
  resolveTargetSha,
} from "./publish-voice-packs.mjs";

const scriptPath = url.fileURLToPath(new URL("./publish-voice-packs.mjs", import.meta.url));

const PACK = Object.freeze({
  id: "default",
  label: "Default",
  version: "1.0.0",
  description: "The Race Engineer voice iRaceDeck ships with.",
  author: "iRaceDeck",
  voices: Object.freeze(["default"]),
  bundled: true,
});

const TAG = "voices-default-1.0.0";
const ASSET = "default-1.0.0.zip";
const SHA = "6087bed024d50e80a0ac9fb84ae5567ea356232c60ee8f183a45809eb724f535";
const BYTES = 7879224;
const OUT_DIR = path.join("C:", "out");
const SCRATCH_DIR = path.join("C:", "scratch");
const ARCHIVE_PATH = path.join(SCRATCH_DIR, "pack", ASSET);

/** A committed catalog entry — the shape `catalog/default.json` has. */
function committedEntry(overrides = {}) {
  return {
    id: "default",
    label: "Default",
    version: "1.0.0",
    voices: [{ id: "default", label: "Default" }],
    bytes: BYTES,
    sha256: SHA,
    url: `https://github.com/niklam/iracedeck/releases/download/${TAG}/${ASSET}`,
    ...overrides,
  };
}

/**
 * Injected deps with every side effect faked. `gh` answers from a script keyed
 * by the subcommand (`view` / `create` / `upload` / `download`) so a test can
 * describe the release's state in one object and then assert on the exact
 * argv each call received.
 *
 * @param {object} [options]
 * @param {Record<string, { ok: boolean; stdout?: string; stderr?: string }>} [options.gh]
 * @param {object | null} [options.entry] — the committed entry (`null` = missing)
 * @param {string} [options.downloadedSha] — what the published asset hashes to
 */
function fakeDeps({ gh = {}, entry = committedEntry(), downloadedSha = SHA } = {}) {
  const deps = {
    pack: vi.fn(async (pack) => ({
      entry: { id: pack.id, version: pack.version, bytes: BYTES, sha256: SHA },
      archivePath: ARCHIVE_PATH,
    })),
    readCommittedEntry: vi.fn(() => entry),
    ensureDir: vi.fn(),
    copyArchive: vi.fn(),
    sha256File: vi.fn(() => downloadedSha),
    gh: vi.fn((args) => gh[args[1]] ?? { ok: true, stdout: "" }),
    log: vi.fn(),
  };

  return deps;
}

function ghCalls(deps, subcommand) {
  return deps.gh.mock.calls.map(([args]) => args).filter((args) => args[0] === "release" && args[1] === subcommand);
}

function run(deps, { publish = false, targetSha, packs = [PACK] } = {}) {
  return publishVoicePacks({ packs, publish, outDir: OUT_DIR, scratchDir: SCRATCH_DIR, targetSha, deps });
}

const RELEASE_MISSING = { view: { ok: false, stdout: "", stderr: "release not found" } };
const releaseWith = (assets) => ({ view: { ok: true, stdout: JSON.stringify({ assets }) } });

describe("parseArgs", () => {
  it("is a dry run into the default output directory with no arguments", () => {
    expect(parseArgs([])).toEqual({ publish: false, outDir: DEFAULT_OUT_DIR });
    expect(DEFAULT_OUT_DIR).toBe("packed/voice-packs");
  });

  it("publishes only when --publish is given", () => {
    expect(parseArgs(["--publish"]).publish).toBe(true);
  });

  it("takes the output directory from --out", () => {
    expect(parseArgs(["--out", "somewhere/else"])).toEqual({ publish: false, outDir: "somewhere/else" });
    expect(parseArgs(["--out", "x", "--publish"])).toEqual({ publish: true, outDir: "x" });
  });

  it("refuses a --out with no directory and any argument it does not know", () => {
    expect(() => parseArgs(["--out"])).toThrow(/--out/);
    expect(() => parseArgs(["--out", "--publish"])).toThrow(/--out/);
    expect(() => parseArgs(["--yes"])).toThrow(/--yes/);
  });
});

describe("resolveTargetSha", () => {
  it("is GITHUB_SHA when the environment carries one, and nothing otherwise", () => {
    expect(resolveTargetSha({ GITHUB_SHA: "abc123" })).toBe("abc123");
    expect(resolveTargetSha({ GITHUB_SHA: "" })).toBeUndefined();
    expect(resolveTargetSha({})).toBeUndefined();
  });
});

describe("publishVoicePacks — pack and verify", () => {
  it("packs into scratch, copies a matching archive to --out and calls gh not at all on a dry run", async () => {
    const deps = fakeDeps();

    const results = await run(deps);

    expect(deps.pack).toHaveBeenCalledWith(PACK);
    expect(deps.ensureDir).toHaveBeenCalledWith(OUT_DIR);
    expect(deps.copyArchive).toHaveBeenCalledWith(ARCHIVE_PATH, path.join(OUT_DIR, ASSET));
    expect(deps.gh).not.toHaveBeenCalled();
    expect(results).toEqual([
      { id: "default", version: "1.0.0", outcome: "dry-run", archive: path.join(OUT_DIR, ASSET) },
    ]);
    expect(deps.log.mock.calls.flat().join("\n")).toMatch(/dry run/i);
  });

  it("fails naming the pack and the fix when the fresh sha256 differs from the committed entry, copying nothing", async () => {
    const deps = fakeDeps({ entry: committedEntry({ sha256: "f".repeat(64) }) });

    await expect(run(deps, { publish: true })).rejects.toThrow(
      new RegExp(
        `^default: the archive built here \\(sha256 ${SHA}, ${BYTES} bytes\\) does not match ` +
          `packages/audio-assets/catalog/default\\.json \\(sha256 ${"f".repeat(64)}, ${BYTES} bytes\\)\\. ` +
          `Run "pnpm --filter @iracedeck/audio-assets pack:voice", bump the pack version in voice-packs\\.mjs ` +
          `if its clips changed, and commit the regenerated entry\\.$`,
      ),
    );
    expect(deps.copyArchive).not.toHaveBeenCalled();
    expect(deps.gh).not.toHaveBeenCalled();
  });

  it("treats a byte-count mismatch the same way", async () => {
    const deps = fakeDeps({ entry: committedEntry({ bytes: BYTES + 1 }) });

    await expect(run(deps)).rejects.toThrow(/default: the archive built here .* does not match .*pack:voice/);
    expect(deps.copyArchive).not.toHaveBeenCalled();
  });

  it("treats a missing committed entry as the same failure", async () => {
    const deps = fakeDeps({ entry: null });

    await expect(run(deps, { publish: true })).rejects.toThrow(
      /^default: .*packages\/audio-assets\/catalog\/default\.json.*pack:voice.*commit/,
    );
    expect(deps.readCommittedEntry).toHaveBeenCalledWith("default");
    expect(deps.copyArchive).not.toHaveBeenCalled();
    expect(deps.gh).not.toHaveBeenCalled();
  });

  it("stops at the first failing pack and never packs the next one", async () => {
    const other = { ...PACK, id: "other", label: "Other" };
    const deps = fakeDeps({ entry: null });

    await expect(run(deps, { packs: [PACK, other] })).rejects.toThrow(/^default:/);
    expect(deps.pack).toHaveBeenCalledTimes(1);
  });
});

describe("publishVoicePacks — --publish", () => {
  it("creates the release with --latest=false, the tag, the title, the notes, --target and archive#asset when there is none", async () => {
    const deps = fakeDeps({ gh: RELEASE_MISSING });

    const results = await run(deps, { publish: true, targetSha: "abc123" });

    expect(ghCalls(deps, "view")).toEqual([["release", "view", TAG, "--json", "assets"]]);
    expect(ghCalls(deps, "create")).toEqual([
      [
        "release",
        "create",
        TAG,
        "--title",
        "Voice pack: Default 1.0.0",
        "--notes",
        releaseNotes(PACK),
        "--latest=false",
        "--target",
        "abc123",
        `${ARCHIVE_PATH}#${ASSET}`,
      ],
    ]);
    expect(ghCalls(deps, "upload")).toEqual([]);
    expect(ghCalls(deps, "download")).toEqual([]);
    expect(deps.copyArchive).toHaveBeenCalledWith(ARCHIVE_PATH, path.join(OUT_DIR, ASSET));
    expect(results[0].outcome).toBe("published");
  });

  it("omits --target when there is no GITHUB_SHA", async () => {
    const deps = fakeDeps({ gh: RELEASE_MISSING });

    await run(deps, { publish: true });

    const [create] = ghCalls(deps, "create");

    expect(create).not.toContain("--target");
    expect(create).toContain("--latest=false");
  });

  // The website's plugin download links resolve through
  // /releases/latest/download/, and GitHub hands a new release the latest slot
  // by default — so a voice-pack release created without this flag would 404
  // every plugin download. The argv assertion above pins it; this one pins
  // that it cannot be dropped by a refactor of how the argv is built.
  it("never creates a release without --latest=false", async () => {
    const deps = fakeDeps({ gh: RELEASE_MISSING });

    await run(deps, { publish: true, targetSha: "abc123" });
    await run(deps, { publish: true });

    for (const create of ghCalls(deps, "create")) expect(create).toContain("--latest=false");
    expect(ghCalls(deps, "create")).toHaveLength(2);
  });

  it("uploads to an existing release that lacks the asset", async () => {
    const deps = fakeDeps({ gh: releaseWith([{ name: "something-else.zip" }]) });

    const results = await run(deps, { publish: true });

    expect(ghCalls(deps, "create")).toEqual([]);
    expect(ghCalls(deps, "upload")).toEqual([["release", "upload", TAG, `${ARCHIVE_PATH}#${ASSET}`]]);
    expect(ghCalls(deps, "download")).toEqual([]);
    expect(results[0].outcome).toBe("published");
  });

  it("downloads a present asset, and skips when its bytes match", async () => {
    const deps = fakeDeps({ gh: releaseWith([{ name: ASSET }]), downloadedSha: SHA });

    const results = await run(deps, { publish: true });

    const [download] = ghCalls(deps, "download");
    const downloaded = download[download.indexOf("--output") + 1];

    expect(download.slice(0, 3)).toEqual(["release", "download", TAG]);
    expect(download).toContain("--pattern");
    expect(download[download.indexOf("--pattern") + 1]).toBe(ASSET);
    expect(download).toContain("--clobber");
    expect(downloaded.startsWith(SCRATCH_DIR)).toBe(true);
    expect(deps.sha256File).toHaveBeenCalledWith(downloaded);
    expect(ghCalls(deps, "create")).toEqual([]);
    expect(ghCalls(deps, "upload")).toEqual([]);
    expect(results[0].outcome).toBe("already-published");
    expect(deps.log.mock.calls.flat().join("\n")).toMatch(/already published/);
  });

  it("fails with the bytes-never-change message when the published asset differs", async () => {
    const deps = fakeDeps({ gh: releaseWith([{ name: ASSET }]), downloadedSha: "0".repeat(64) });

    await expect(run(deps, { publish: true })).rejects.toThrow(
      `${ASSET} is already published on ${TAG} with different bytes. A published version's bytes never change: ` +
        "bump the pack version in voice-packs.mjs, re-run pack:voice, and commit.",
    );
    expect(ghCalls(deps, "create")).toEqual([]);
    expect(ghCalls(deps, "upload")).toEqual([]);
  });

  it("fails naming the pack and gh's own message when create, upload or download fail", async () => {
    const failing = { ok: false, stdout: "", stderr: "HTTP 422: Validation Failed" };

    await expect(run(fakeDeps({ gh: { ...RELEASE_MISSING, create: failing } }), { publish: true })).rejects.toThrow(
      /default: gh release create .*HTTP 422/,
    );
    await expect(run(fakeDeps({ gh: { ...releaseWith([]), upload: failing } }), { publish: true })).rejects.toThrow(
      /default: gh release upload .*HTTP 422/,
    );
    await expect(
      run(fakeDeps({ gh: { ...releaseWith([{ name: ASSET }]), download: failing } }), { publish: true }),
    ).rejects.toThrow(/default: gh release download .*HTTP 422/);
  });

  it("fails rather than guessing when gh's release listing is not JSON", async () => {
    const deps = fakeDeps({ gh: { view: { ok: true, stdout: "not json" } } });

    await expect(run(deps, { publish: true })).rejects.toThrow(/default: .*gh release view/);
    expect(ghCalls(deps, "create")).toEqual([]);
  });
});

describe("release metadata", () => {
  it("titles the release after the pack and keeps the notes to one paragraph naming it", () => {
    expect(releaseTitle(PACK)).toBe("Voice pack: Default 1.0.0");
    expect(releaseNotes(PACK)).toContain("Default");
    expect(releaseNotes(PACK)).toContain("1.0.0");
    expect(releaseNotes(PACK)).not.toContain("\n");
  });
});

/**
 * Structural guard, the technique `voice-pack-no-window.test.ts` uses for the
 * plugin side of this feature: the script runs unattended on a CI runner and
 * must never put anything on a screen — not a browser through `openUrl` or the
 * `open` package, not an Explorer window. It DOES spawn a child process (gh),
 * so that is not on the list; the positive control below proves the file being
 * read is the real one and that every pattern can match at all.
 */
describe("publish-voice-packs.mjs opens nothing", () => {
  const source = readFileSync(scriptPath, "utf-8");

  const FORBIDDEN = [
    { pattern: /\bopenUrl\b/, what: "the deck host's openUrl (opens a browser tab)", sample: "adapter.openUrl(url)" },
    {
      pattern: /from\s+["']open["']/,
      what: "the `open` package (opens a browser)",
      sample: 'import open from "open";',
    },
    {
      pattern: /settings-window|chromium-browser|open-folder/,
      what: "a window launcher",
      sample: "./settings-window.js",
    },
    {
      pattern: /xdg-open|explorer\.exe|\bstart\s+["']?https?:/,
      what: "a shell command that opens a URL",
      sample: "xdg-open",
    },
  ];

  it("reads the real script and its patterns can match", () => {
    expect(source).toContain("spawnSync");
    expect(source).toContain("--latest=false");
    for (const { pattern, sample } of FORBIDDEN) expect(pattern.test(sample)).toBe(true);
  });

  it.each(FORBIDDEN)("never references $what", ({ pattern }) => {
    expect(pattern.test(source)).toBe(false);
  });
});
