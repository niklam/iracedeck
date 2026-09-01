import { join } from "node:path";

import { parseVoicePackManifest } from "./voice-pack-manifest.js";

/**
 * The outcome of reading a pack's manifest.
 *
 * `missing` is a separate fact from `ok`, because the two failures need
 * different words in front of a user: a folder with no `voice-pack.json` is not
 * a voice pack, while one whose manifest is locked, permission-denied, or is
 * itself a directory IS a pack that iRaceDeck could not open. Collapsing both
 * into `undefined` produced "no voice-pack.json" for a file the user can see
 * sitting there, and sent them to the one paragraph of the docs that cannot
 * help them.
 */
export type VoicePackFileRead =
  | { ok: true; text: string }
  | { ok: false; missing: boolean; /** Short, path-free: an errno code where there is one. */ reason: string };

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
  /** File contents, or why they could not be read. */
  readTextFile(file: string): VoicePackFileRead;
  /** Every `.mp3` under `packDir`, recursive, as POSIX paths relative to `packDir`. */
  listMp3Files(packDir: string): readonly string[];
}

/**
 * A voice a pack provides. `id` is identity and matches the `voice/<id>/…` clip
 * path; `label` is what a user reads and nothing more.
 */
export type InstalledVoice = { id: string; label: string };

export type InstalledVoicePack = {
  id: string;
  label: string;
  version: string;
  author?: string;
  /** Absolute path to the pack folder — this is the pack's own audio root. */
  dir: string;
  /** The voices this pack actually provides, after collisions are resolved. */
  voices: readonly InstalledVoice[];
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
   *
   * REQUIRED, not optional with an empty default. Its failure mode is accepting
   * rather than refusing: a caller that simply omitted it would type-check, log
   * nothing, and let a pack claim `default`. Pass `[]` deliberately when there is
   * genuinely no bundled audio to protect.
   */
  reservedVoices: readonly string[];
}

export interface ScanVoicePacksResult {
  packs: readonly InstalledVoicePack[];
  problems: readonly VoicePackProblem[];
}

const MANIFEST_FILE = "voice-pack.json";

/**
 * A clip the scenario engine can actually reach.
 *
 * Deliberately the SAME grammar `buildManifestPool` compiles —
 * `^voice/<id>/<group>/<base>(-NN)?\.mp3$` — minus the per-pool group and base,
 * because this is where the two are kept in agreement. Two ways a file under the
 * right prefix is nonetheless unreachable, both of which a pack hits by accident:
 *
 * - **A missing `<group>` segment.** `voice/luca/sample.mp3` is one level short
 *   of anything a pool can match, and no scenario references a clip that shape.
 * - **A non-lowercase extension.** `listMp3Files` matches `.mp3` case-INSENSITIVELY
 *   and records the name verbatim, which is right for finding files; the pool
 *   regex and the `clipSet` lookup are both case-SENSITIVE. `blue-01.MP3` — what
 *   plenty of Windows tools emit — would otherwise install, claim its voice and
 *   play nothing.
 *
 * `VOICE_PACK_MAX_DEPTH` already reasons from this grammar for the depth CEILING.
 * This is the same reasoning applied to the floor and to the extension, so a pack
 * that cannot work is refused with a reason instead of being silently mute.
 */
const USABLE_CLIP = /^voice\/[^/]+\/[^/]+\/[^/]+\.mp3$/;

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
export function scanVoicePacks({ root, fs, reservedVoices }: ScanVoicePacksOptions): ScanVoicePacksResult {
  const packs: InstalledVoicePack[] = [];
  const problems: VoicePackProblem[] = [];
  const claimedVoices = new Map<string, string>();
  const bundledVoices = new Set(reservedVoices);

  for (const folder of [...fs.listDirectories(root)].sort()) {
    // Dot-folders are the installer's own working space (`.tmp`, `.trash`) and
    // anything else a tool decided to hide. Never packs.
    if (folder.startsWith(".")) continue;

    const dir = join(root, folder);
    const read = fs.readTextFile(join(dir, MANIFEST_FILE));

    if (!read.ok) {
      problems.push({
        pack: folder,
        reason: read.missing ? `no ${MANIFEST_FILE}` : `${MANIFEST_FILE} could not be read (${read.reason})`,
      });
      continue;
    }

    const parsed = parseVoicePackManifest(read.text);

    if (!parsed.ok) {
      problems.push({ pack: folder, reason: parsed.reason });
      continue;
    }

    const manifest = parsed.manifest;

    // The folder name is how a pack is addressed on disk, so a mismatch would
    // make "the pack called luca" and "the folder called luca" two different
    // things — an ambiguity the installer would later have to guess about.
    //
    // Compared case-INSENSITIVELY, because the filesystem underneath is. The id
    // regex forces lowercase but a folder name never goes through it, so `Luca/`
    // holding `"id": "luca"` would otherwise be refused — on Windows, the only
    // platform the manifests declare (#994), those ARE one directory: the user
    // cannot create both, and the manifest was just read through the capitalised
    // path. Refusing it would reject a working pack over a distinction the OS
    // does not make, with a message that reads as satisfied.
    if (manifest.id !== folder.toLowerCase()) {
      problems.push({ pack: folder, reason: `declared id "${manifest.id}" does not match its folder name` });
      continue;
    }

    // A voice already provided by the bundle or by an earlier pack is dropped
    // from THIS pack rather than rejecting the pack wholesale: a pack shipping
    // two voices, one of which collides, still contributes the other.
    // De-duplicated first — a manifest repeating a voice id would otherwise
    // claim it twice, duplicate its clips, and list it twice in the settings
    // window. Keyed on `id`, never the label: two entries naming the same voice
    // under different labels are still one voice, and the first wins.
    const seen = new Set<string>();
    const declared = manifest.voices.filter((voice) => {
      if (seen.has(voice.id)) return false;

      seen.add(voice.id);

      if (bundledVoices.has(voice.id)) {
        problems.push({ pack: folder, reason: `voice "${voice.id}" is provided by the plugin's bundled audio` });

        return false;
      }

      const owner = claimedVoices.get(voice.id);

      if (owner === undefined) return true;

      problems.push({ pack: folder, reason: `voice "${voice.id}" is already provided by pack "${owner}"` });

      return false;
    });

    if (declared.length === 0) continue;

    // Clip presence is checked PER VOICE, not per pack. A pack that declares a
    // voice but ships nothing under it would register an empty pool for every
    // callout — at runtime indistinguishable from a missing clip — and, worse,
    // would CLAIM that voice, locking out a later pack that really has it.
    //
    // "Ships something" means something the ENGINE CAN REACH, not merely a file
    // under the right prefix — see USABLE_CLIP. A gate looser than what the pool
    // builder consumes lets a pack install cleanly, claim its voice, enter the
    // dropdown and then be completely silent, with the only trace at debug level.
    const found = fs.listMp3Files(dir);
    const voices: InstalledVoice[] = [];
    const clips: string[] = [];
    const unusable: string[] = [];

    for (const voice of declared) {
      // The declared `id` drives the prefix, so a declared voice with no
      // matching directory still fails as "no clips found under voice/<id>/".
      // That check is not replaced by the declaration — it is what validates it.
      const prefix = `voice/${voice.id}/`;
      const own = found.filter((clip) => clip.startsWith(prefix));
      const usable = own.filter((clip) => USABLE_CLIP.test(clip));

      if (usable.length === 0) {
        unusable.push(
          own.length === 0
            ? `no clips found under ${prefix}`
            : `${prefix} has ${own.length === 1 ? "a file" : "files"} the engine cannot play — clips must be ` +
                `${prefix}<group>/<name>.mp3, with a lowercase .mp3 extension`,
        );
        continue;
      }

      voices.push(voice);

      // Appended one at a time rather than spread: `usable` is derived from a
      // directory walk that caps DEPTH but not breadth, and a spread past V8's
      // argument limit throws a RangeError that this function does not catch —
      // costing every pack, which is exactly what the contract above promises
      // cannot happen for one bad folder.
      for (const clip of usable) clips.push(clip);
    }

    if (unusable.length > 0) problems.push({ pack: folder, reason: unusable.join("; ") });

    if (voices.length === 0) continue;

    for (const voice of voices) claimedVoices.set(voice.id, folder);

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
