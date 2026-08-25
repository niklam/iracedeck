import { join } from "node:path";

import { parseVoicePackManifest } from "./voice-pack-manifest.js";

/**
 * The disk operations the scanner needs, and nothing more.
 *
 * Narrow on purpose: the scan logic is then a pure function of this port, so its
 * tests need no filesystem and no module mocking, and the single `node:fs`
 * implementation ({@link createVoicePackFileSystem}) is the only place in the
 * feature that can throw an I/O error.
 */
export interface VoicePackFileSystem {
  /** Immediate subdirectory names of `dir`; empty when `dir` does not exist. */
  listDirectories(dir: string): readonly string[];
  /** File contents, or `undefined` when missing or unreadable. */
  readTextFile(file: string): string | undefined;
  /** Every `.mp3` under `packDir`, recursive, as POSIX paths relative to `packDir`. */
  listMp3Files(packDir: string): readonly string[];
}

export type InstalledVoicePack = {
  id: string;
  label: string;
  version: string;
  author?: string;
  /** Absolute path to the pack folder — this is the pack's own audio root. */
  dir: string;
  /** The voices this pack actually provides, after collisions are resolved. */
  voices: readonly string[];
  /** POSIX paths relative to {@link dir}, always `voice/<voice-id>/…`. */
  clips: readonly string[];
};

export type VoicePackProblem = { pack: string; reason: string };

export interface ScanVoicePacksOptions {
  root: string;
  fs: VoicePackFileSystem;
}

export interface ScanVoicePacksResult {
  packs: readonly InstalledVoicePack[];
  problems: readonly VoicePackProblem[];
}

const MANIFEST_FILE = "voice-pack.json";

/**
 * Read every pack under `root` (issue #1034).
 *
 * Never throws, and never fails the whole scan for one bad folder: this
 * directory is user-writable by design, so a junk folder must cost that folder
 * only. Everything it refuses comes back as a `problem` so the reason can be
 * logged and shown rather than silently swallowed.
 *
 * Folders are visited in sorted order, which makes the winner of a voice
 * collision deterministic rather than dependent on directory-listing order.
 */
export function scanVoicePacks({ root, fs }: ScanVoicePacksOptions): ScanVoicePacksResult {
  const packs: InstalledVoicePack[] = [];
  const problems: VoicePackProblem[] = [];
  const claimedVoices = new Map<string, string>();

  for (const folder of [...fs.listDirectories(root)].sort()) {
    // Dot-folders are the installer's own working space (`.tmp`, `.trash`) and
    // anything else a tool decided to hide. Never packs.
    if (folder.startsWith(".")) continue;

    const dir = join(root, folder);
    const raw = fs.readTextFile(join(dir, MANIFEST_FILE));

    if (raw === undefined) {
      problems.push({ pack: folder, reason: `no ${MANIFEST_FILE}` });
      continue;
    }

    const parsed = parseVoicePackManifest(raw);

    if (!parsed.ok) {
      problems.push({ pack: folder, reason: parsed.reason });
      continue;
    }

    const manifest = parsed.manifest;

    // The folder name is how a pack is addressed on disk, so a mismatch would
    // make "the pack called luca" and "the folder called luca" two different
    // things — an ambiguity the installer would later have to guess about.
    if (manifest.id !== folder) {
      problems.push({ pack: folder, reason: `declared id "${manifest.id}" does not match its folder name` });
      continue;
    }

    // A voice already provided by an earlier pack is dropped from THIS pack
    // rather than rejecting the pack wholesale: a pack shipping two voices, one
    // of which collides, still contributes the other.
    const voices = manifest.voices.filter((voice) => {
      const owner = claimedVoices.get(voice);

      if (owner === undefined) return true;

      problems.push({ pack: folder, reason: `voice "${voice}" is already provided by pack "${owner}"` });

      return false;
    });

    if (voices.length === 0) continue;

    const prefixes = voices.map((voice) => `voice/${voice}/`);
    const clips = fs.listMp3Files(dir).filter((clip) => prefixes.some((prefix) => clip.startsWith(prefix)));

    // A pack that declares a voice but ships nothing under it would register an
    // empty pool for every callout, which at runtime is indistinguishable from
    // a missing clip. Refusing it here keeps that ambiguity out of the engine.
    if (clips.length === 0) {
      problems.push({ pack: folder, reason: `no clips found under ${prefixes.join(", ")}` });
      continue;
    }

    for (const voice of voices) claimedVoices.set(voice, folder);

    packs.push({
      id: manifest.id,
      label: manifest.label,
      version: manifest.version,
      ...(manifest.author === undefined ? {} : { author: manifest.author }),
      dir,
      voices,
      clips,
    });
  }

  return { packs, problems };
}
