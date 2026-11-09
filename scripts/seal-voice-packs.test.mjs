import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import url from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPackRecord,
  computePackInputs,
  readPackRecord,
  serializePackRecord,
  writePackRecord,
} from "../packages/audio-assets/src/build/pack-record.mjs";
import { VOICE_PACKS } from "../packages/audio-assets/src/build/voice-packs.mjs";
import { sealVoicePacks, USAGE } from "./seal-voice-packs.mjs";

const scriptPath = url.fileURLToPath(new URL("./seal-voice-packs.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

const ALPHA = Object.freeze({
  id: "alpha",
  label: "Alpha",
  version: "1.2.3",
  author: "iRaceDeck",
  voices: Object.freeze(["alpha"]),
  bundled: false,
});
const BETA = Object.freeze({ ...ALPHA, id: "beta", label: "Beta", version: "2.0.0", voices: Object.freeze(["beta"]) });
const PACKS = Object.freeze([ALPHA, BETA]);

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** @type {string[]} */
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A two-pack tree under a temporary root: a clip and a config per voice, a
 * catalog entry per pack, and a fresh record agreeing with both — unsealed
 * unless `sealed` names the pack ids to seal at their version.
 */
function fixture({ sealed = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ird-seal-voice-packs-"));
  tempDirs.push(root);
  const roots = {
    srcRoot: path.join(root, "voice"),
    configsDir: path.join(root, "configs"),
    catalogDir: path.join(root, "catalog"),
    recordsDir: path.join(root, "pack-records"),
  };
  mkdirSync(roots.configsDir);
  mkdirSync(roots.catalogDir);
  const shaOf = (pack) => (pack === ALPHA ? SHA_A : SHA_B);

  for (const pack of PACKS) {
    for (const voiceId of pack.voices) {
      mkdirSync(path.join(roots.srcRoot, voiceId, "numbers"), { recursive: true });
      writeFileSync(path.join(roots.srcRoot, voiceId, "numbers", "1.mp3"), `${voiceId} one`);
      writeFileSync(
        path.join(roots.configsDir, `${voiceId}.voice.json`),
        JSON.stringify({ label: `Voice ${voiceId}` }),
      );
    }
    writeFileSync(
      path.join(roots.catalogDir, `${pack.id}.json`),
      `${JSON.stringify({ id: pack.id, version: pack.version, bytes: 3, sha256: shaOf(pack) })}\n`,
    );
    writePackRecord(
      buildPackRecord(pack, {
        sha256: shaOf(pack),
        inputs: computePackInputs(pack, roots),
        released: sealed.includes(pack.id) ? { version: pack.version, sha256: shaOf(pack) } : undefined,
      }),
      roots.recordsDir,
    );
  }

  const recordBytes = (pack) => readFileSync(path.join(roots.recordsDir, `${pack.id}.json`), "utf-8");
  const sealedBytes = (pack) => {
    const record = readPackRecord(pack.id, roots.recordsDir);
    return serializePackRecord(
      buildPackRecord(pack, {
        sha256: record.sha256,
        inputs: record.inputs,
        released: { version: pack.version, sha256: record.sha256 },
      }),
    );
  };
  const allBytes = () =>
    Object.fromEntries(readdirSync(roots.recordsDir).map((name) => [name, recordBytes({ id: name.slice(0, -5) })]));

  return { root, roots, recordBytes, sealedBytes, allBytes };
}

/** Run the command over the fixture, capturing both streams. */
async function run(fx, argv, options = {}) {
  const log = vi.fn();
  const error = vi.fn();
  const status = await sealVoicePacks(argv, { packs: PACKS, roots: fx.roots, root: fx.root, log, error, ...options });
  return {
    status,
    out: log.mock.calls.map(([line]) => line).join("\n"),
    err: error.mock.calls.map(([line]) => line).join("\n"),
  };
}

describe("sealVoicePacks", () => {
  it("seals every pack when none is named, printing each record and the commit hint", async () => {
    const fx = fixture();
    const expected = { alpha: fx.sealedBytes(ALPHA), beta: fx.sealedBytes(BETA) };

    const { status, out, err } = await run(fx, []);

    expect(err).toBe("");
    expect(status).toBe(0);
    expect(fx.recordBytes(ALPHA)).toBe(expected.alpha);
    expect(fx.recordBytes(BETA)).toBe(expected.beta);
    expect(readPackRecord("alpha", fx.roots.recordsDir).released).toEqual({ version: "1.2.3", sha256: SHA_A });
    expect(readPackRecord("beta", fx.roots.recordsDir).released).toEqual({ version: "2.0.0", sha256: SHA_B });
    expect(out.split("\n")).toEqual([
      `Sealed pack-records/alpha.json: alpha 1.2.3 released (sha256 ${SHA_A})`,
      `Sealed pack-records/beta.json: beta 2.0.0 released (sha256 ${SHA_B})`,
      "Commit packages/audio-assets/pack-records/ to master before dispatching the Publish voice packs workflow with publish on; a publish refuses a pack whose version is not sealed.",
    ]);
  });

  it("seals only the named packs and leaves the others byte-untouched", async () => {
    const fx = fixture();
    const alphaBefore = fx.recordBytes(ALPHA);

    const { status, out } = await run(fx, ["beta"]);

    expect(status).toBe(0);
    expect(fx.recordBytes(ALPHA)).toBe(alphaBefore);
    expect(readPackRecord("beta", fx.roots.recordsDir).released).toEqual({ version: "2.0.0", sha256: SHA_B });
    expect(out).toContain("Sealed pack-records/beta.json");
    expect(out).not.toContain("alpha");
  });

  it("names a pack given twice once", async () => {
    const fx = fixture();

    const { status, out } = await run(fx, ["alpha", "alpha"]);

    expect(status).toBe(0);
    expect(out.match(/Sealed /g)).toHaveLength(1);
  });

  it("says so and writes nothing when every chosen pack is already sealed at its version", async () => {
    const fx = fixture({ sealed: ["alpha", "beta"] });
    const before = fx.allBytes();

    const all = await run(fx, []);
    const one = await run(fx, ["beta"]);

    expect(all.status).toBe(0);
    expect(all.out).toBe("Nothing to seal: alpha 1.2.3, beta 2.0.0 are already sealed as released.");
    expect(one.status).toBe(0);
    expect(one.out).toBe("Nothing to seal: beta 2.0.0 is already sealed as released.");
    expect(fx.allBytes()).toEqual(before);
  });

  it("seals the packs not yet sealed and skips the one that is", async () => {
    const fx = fixture({ sealed: ["alpha"] });
    const alphaBefore = fx.recordBytes(ALPHA);

    const { status, out } = await run(fx, []);

    expect(status).toBe(0);
    expect(fx.recordBytes(ALPHA)).toBe(alphaBefore);
    expect(out).toContain("Sealed pack-records/beta.json");
    expect(out).not.toContain("Sealed pack-records/alpha.json");
  });

  it("refuses an unknown pack, naming the known ones, before checking or writing anything", async () => {
    const fx = fixture();
    const before = fx.allBytes();

    const { status, out, err } = await run(fx, ["beta", "gamma"]);

    expect(status).toBe(1);
    expect(err).toBe('unknown pack "gamma" — known packs: alpha, beta');
    expect(out).toBe("");
    expect(fx.allBytes()).toEqual(before);
  });

  it("refuses an option it does not know, with the usage", async () => {
    const fx = fixture();

    const { status, err } = await run(fx, ["--dry-run"]);

    expect(status).toBe(1);
    expect(err).toBe(`unknown option "--dry-run" — ${USAGE}`);
    expect(readPackRecord("alpha", fx.roots.recordsDir).released).toBeUndefined();
  });

  it("prints the usage and the known packs for --help and -h, sealing nothing", async () => {
    const fx = fixture();

    for (const flag of ["--help", "-h"]) {
      const { status, out, err } = await run(fx, [flag]);
      expect(status).toBe(0);
      expect(err).toBe("");
      expect(out).toContain(USAGE);
      expect(out).toContain("alpha, beta");
    }
    expect(readPackRecord("alpha", fx.roots.recordsDir).released).toBeUndefined();
  });

  // The command is the hook's seal without the release: the same checks over
  // EVERY pack first, so a stale record anywhere in the tree seals nothing, not
  // even the pack that was named and is fine.
  it("seals nothing and prints every problem with its fix when any pack's record is stale", async () => {
    const fx = fixture();
    writeFileSync(path.join(fx.roots.srcRoot, "alpha", "numbers", "1.mp3"), "re-recorded");
    const before = fx.allBytes();

    const { status, out, err } = await run(fx, ["beta"]);

    expect(status).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("voice-pack records are not clean, so nothing was sealed:");
    expect(err).toContain(
      "  alpha: the clips under voice/alpha changed (1 clips as recorded, with different bytes or paths)",
    );
    expect(err).toContain(
      "  fix: version 1.2.3 is not released yet: run `pnpm --filter @iracedeck/audio-assets pack:voice alpha`, and commit catalog/alpha.json and pack-records/alpha.json",
    );
    expect(fx.allBytes()).toEqual(before);
  });

  it("prints paths relative to the root it is given, with forward slashes", async () => {
    const fx = fixture();

    const { out } = await run(fx, ["alpha"]);

    expect(out).toContain("Sealed pack-records/alpha.json:");
    expect(out).not.toContain("\\");
    expect(out).not.toContain(fx.root);
  });
  // The unknown-id check is the shared `selectPacks`, run before a record is
  // read: a stale record elsewhere in the tree does not change the answer.
  it("refuses an unknown pack before the record checks, even with a stale record in the tree", async () => {
    const fx = fixture();
    writeFileSync(path.join(fx.roots.srcRoot, "alpha", "numbers", "1.mp3"), "re-recorded");

    const { status, err } = await run(fx, ["gamma"]);

    expect(status).toBe(1);
    expect(err).toBe('unknown pack "gamma" — known packs: alpha, beta');
  });

  // On an unbuilt or cleaned tree the record module cannot be imported, since it
  // reaches @iracedeck/callout-script's dist/. The loader turns that into one
  // sentence naming `pnpm build`; the command prints it and seals nothing.
  it("prints the loader's pnpm build message and exits 1 when the record module cannot be loaded", async () => {
    const fx = fixture();
    const before = fx.allBytes();
    const load = vi.fn(async () => {
      throw new Error("The voice-pack record module could not be loaded: Cannot find package … Run `pnpm build` …");
    });

    const { status, out, err } = await run(fx, ["alpha"], { load });

    expect(status).toBe(1);
    expect(err).toContain("The voice-pack record module could not be loaded");
    expect(err).toContain("pnpm build");
    expect(out).toBe("");
    expect(fx.allBytes()).toEqual(before);
  });
});

// The real script, with arguments that return before any record is read, so
// this checkout's records are never touched: the direct-exec guard runs
// `sealVoicePacks`, and its exit code is the command's.
describe("seal-voice-packs.mjs as a command", () => {
  const node = (...args) => spawnSync(process.execPath, [scriptPath, ...args], { cwd: repoRoot, encoding: "utf-8" });

  it("exits 1 on an unknown pack, naming the registry's packs", () => {
    const result = node("no-such-pack");

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      `unknown pack "no-such-pack" — known packs: ${VOICE_PACKS.map((pack) => pack.id).join(", ")}`,
    );
    expect(result.stdout).toBe("");
  });

  it("exits 0 with the usage for --help", () => {
    const result = node("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(USAGE);
  });

  it("is the root script seal:voice-packs", () => {
    const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));

    expect(scripts["seal:voice-packs"]).toBe("node scripts/seal-voice-packs.mjs");
  });
});
