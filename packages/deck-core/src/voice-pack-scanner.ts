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
  /**
   * Voice ids the plugin's own bundled audio already provides — the plugin
   * passes `scanRaceEngineerVoices(<compiled-in manifest>)`.
   *
   * This is the "plugin root wins" half of the collision rule, the sibling of
   * the pack-vs-pack rule below. Plugin-root-first path resolution already wins
   * for every clip the bundle HAS, so a pack sharing a bundled voice id could
   * only ever add EXTRA variants into that voice's pools — a half-merged voice
   * nobody asked for, and one that would change how the bundled engineer sounds
   * without appearing anywhere as a new voice.
   */
  reservedVoices?: readonly string[];
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
export function scanVoicePacks({ root, fs, reservedVoices = [] }: ScanVoicePacksOptions): ScanVoicePacksResult {
  const packs: InstalledVoicePack[] = [];
  const problems: VoicePackProblem[] = [];
  const claimedVoices = new Map<string, string>();
  const bundledVoices = new Set(reservedVoices);

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

    // A voice already provided by the bundle or by an earlier pack is dropped
    // from THIS pack rather than rejecting the pack wholesale: a pack shipping
    // two voices, one of which collides, still contributes the other.
    // De-duplicated first — a manifest repeating a voice id would otherwise
    // claim it twice, duplicate its clips, and list it twice in the settings
    // window.
    const declared = [...new Set(manifest.voices)].filter((voice) => {
      if (bundledVoices.has(voice)) {
        problems.push({ pack: folder, reason: `voice "${voice}" is provided by the plugin's bundled audio` });

        return false;
      }

      const owner = claimedVoices.get(voice);

      if (owner === undefined) return true;

      problems.push({ pack: folder, reason: `voice "${voice}" is already provided by pack "${owner}"` });

      return false;
    });

    if (declared.length === 0) continue;

    // Clip presence is checked PER VOICE, not per pack. A pack that declares a
    // voice but ships nothing under it would register an empty pool for every
    // callout — at runtime indistinguishable from a missing clip — and, worse,
    // would CLAIM that voice, locking out a later pack that really has it.
    const found = fs.listMp3Files(dir);
    const voices: string[] = [];
    const clips: string[] = [];
    const empty: string[] = [];

    for (const voice of declared) {
      const prefix = `voice/${voice}/`;
      const own = found.filter((clip) => clip.startsWith(prefix));

      if (own.length === 0) {
        empty.push(prefix);
        continue;
      }

      voices.push(voice);
      clips.push(...own);
    }

    if (empty.length > 0) problems.push({ pack: folder, reason: `no clips found under ${empty.join(", ")}` });

    if (voices.length === 0) continue;

    for (const voice of voices) claimedVoices.set(voice, folder);

    packs.push({
      id: manifest.id,
      label: manifest.label,
      version: manifest.version,
      ...(manifest.author === undefined ? {} : { author: manifest.author }),
      dir,
      voices,
      // Sorted so the fragment a pack contributes is independent of the order
      // its voices happen to be declared in.
      clips: clips.sort(),
    });
  }

  return { packs, problems };
}
