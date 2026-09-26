import {
  CALLOUT_SCRIPT_FILE,
  type CalloutScript,
  calloutScriptPath,
  dedupeDeclaredVoices,
  packIdMatchesFolder,
  parseCalloutScriptText,
  parseVoicePackManifest,
  qualifiedVoiceId,
  USABLE_VOICE_CLIP,
  VOICE_PACK_MANIFEST_FILE,
  VOICE_SCRIPT_MAX_BYTES,
} from "@iracedeck/callout-script";
import { join } from "node:path";

import { VOICE_PACK_PROVENANCE_FILE } from "./voice-pack-constants.js";
import { parseVoicePackProvenance, type VoicePackSource } from "./voice-pack-provenance.js";

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
 * A voice a pack provides.
 *
 * `id` is the voice's identity everywhere OUTSIDE the pack folder — the
 * composite `<pack id>::<voice id>` (#1144): what `_raceEngineerVoices` lists,
 * what `raceEngineerVoice` stores, what the label and script maps are keyed
 * by, and the voice segment of the logical clip paths the engine resolves.
 * `packVoiceId` is the bare id the pack's `voice-pack.json` declares, unique
 * within that pack only, and names the `voice/<packVoiceId>/…` folder its
 * clips and script sit under. Two packs may each declare a `matt`; their
 * composite ids differ, so both are listed and both play. `label` is what a
 * user reads and nothing more.
 *
 * `script` is the voice's parsed `voice/<packVoiceId>/callouts.json` (#1064),
 * or `null` for a clips-only voice — one with no script file at all, which is
 * valid and whose callouts are simply all skipped. It is never the raw text: a
 * voice whose file exists but does not parse is not listed at all (see
 * {@link scanVoicePacks}), so a listed voice's script is always usable or
 * absent, never broken. Plain data, like the rest of the pack: the settings
 * window's `_voicePacks` payload must map this OUT rather than publish it — a
 * script is the engine's input, not something a list row renders.
 */
export type InstalledVoice = {
  /** Composite `<pack id>::<voice id>` — the voice's identity everywhere outside the pack folder. */
  id: string;
  /** The bare id the pack's voice-pack.json declares; names the `voice/<packVoiceId>/` folder. */
  packVoiceId: string;
  label: string;
  script: CalloutScript | null;
};

export type InstalledVoicePack = {
  id: string;
  label: string;
  version: string;
  author?: string;
  /** Absolute path to the pack folder — this is the pack's own audio root. */
  dir: string;
  /** The voices this pack actually provides: declared, with usable clips and a readable script. */
  voices: readonly InstalledVoice[];
  /** POSIX paths relative to {@link dir}, always `voice/<packVoiceId>/…` — the pack's own spelling. */
  clips: readonly string[];
  /**
   * Where this pack came from, for the settings window's provenance badge.
   *
   * `sideload` is the ABSENCE of a usable installer record, not a claim any
   * pack makes about itself — see `voice-pack-provenance.ts` for why the source
   * enum deliberately has no such value to write. So a pack that forges a
   * record still cannot describe itself as sideloaded, and one that ships a
   * malformed record reads as sideloaded, which is the truthful answer: nothing
   * we wrote says otherwise.
   *
   * Displayed, never enforced. The badge tells a user that a pack came from
   * someone other than us; it is not a trust decision the plugin acts on. The
   * one thing that withholds a control — the managed pack's missing Remove
   * button — is keyed by the plugin-published `managed` flag
   * (`isManagedVoicePack`), never by this field, so no record a pack author
   * can write reaches it.
   */
  provenance: VoicePackProvenanceKind;
};

/**
 * {@link InstalledVoicePack.provenance}.
 *
 * `development` (#1143) is assigned from where the pack was found — under the
 * scan's `devRoot` — and never read from a record: no folder can claim it, and
 * the on-disk source enum in `voice-pack-provenance.ts` deliberately has no
 * such value to write.
 */
export type VoicePackProvenanceKind = VoicePackSource | "sideload" | "development";

export type VoicePackProblem = { pack: string; reason: string };

export interface ScanVoicePacksOptions {
  root: string;
  /**
   * A development voice root (#1143), scanned BEFORE `root`. Every pack found
   * here is `development` provenance — decided by where it was found, so no
   * folder can claim it — and a pack id it lists SHADOWS the same id under
   * `root`, whole: the packs-root copy is skipped before its manifest is read.
   * `undefined` in every release build.
   */
  devRoot?: string;
  fs: VoicePackFileSystem;
}

export interface ScanVoicePacksResult {
  packs: readonly InstalledVoicePack[];
  problems: readonly VoicePackProblem[];
}

// The rules this scan admits a pack by — the manifest schema and reader, the
// usable-clip grammar (`USABLE_VOICE_CLIP`), the script size cap, the
// id-vs-folder rule and the voice de-duplication — live in
// `@iracedeck/callout-script`'s `voice-pack.ts` (#1134), the leaf `lint:pack`
// and the packer reach too, so the three cannot disagree about what a pack is.
// A refused manifest's reason is the leaf's own text (`parseVoicePackManifest`,
// `VOICE_PACK_NEWER_SCHEMA_REASON` included), so the linter and this scan say
// the same words; every OTHER problem — a folder that does not match the id, a
// repeated voice, a voice with no usable clip or a bad script — is phrased here.

export type VoiceScriptRead = { ok: true; script: CalloutScript | null } | { ok: false; reason: string };

/**
 * Read one voice's `voice/<id>/callouts.json` (#1064), `id` being the bare id
 * the pack declares — the folder name, not the composite.
 *
 * Three outcomes, and the middle one is the point. No file is a CLIPS-ONLY
 * voice — `script: null`, no problem — because a pack built before scripts
 * existed is exactly that shape and is still a valid pack. A file that exists
 * but cannot be opened, is not JSON, or fails the grammar is a problem with
 * THIS VOICE: the caller drops it, exactly as it drops a voice with no usable
 * clips. The alternative — listing the voice with `script: null` — would mute
 * every callout the author wrote and show nothing anywhere saying why.
 *
 * The `reason` is a fragment that follows the file name, so the three read
 * `callouts.json could not be read (EBUSY)`, `callouts.json (document): not
 * valid JSON: …` and `callouts.json scenarios.flag-green.sequence[1]: …` — the
 * grammar's problems are already path-prefixed (a JSON failure is its first
 * one, under the document prefix), so the file name is all that is added.
 * Only the FIRST grammar problem is reported: one line per dropped voice in
 * the Installed Voices list, as the manifest reader does for a pack.
 *
 * The text goes through `parseCalloutScriptText`, the grammar package's one
 * text stage — the packer and the harness read through the same function, so
 * what counts as a readable script is decided once. Two guards are this
 * reader's own: a file over {@link VOICE_SCRIPT_MAX_BYTES} is refused before
 * the grammar sees it, and NOTHING here can throw — the scan runs where a
 * throw ends the plugin, so an error the grammar did not foresee is reported
 * as this voice's problem, never propagated.
 *
 * Exported as deck-core's port-based script reader, for anything else that
 * holds a `VoicePackFileSystem` and a voice folder to read a script from.
 */
export function readVoiceScript(fs: VoicePackFileSystem, dir: string, voiceId: string): VoiceScriptRead {
  try {
    const read = fs.readTextFile(join(dir, calloutScriptPath(voiceId)));

    if (!read.ok) {
      return read.missing
        ? { ok: true, script: null }
        : { ok: false, reason: `${CALLOUT_SCRIPT_FILE} could not be read (${read.reason})` };
    }

    if (read.text.length > VOICE_SCRIPT_MAX_BYTES) {
      return { ok: false, reason: `${CALLOUT_SCRIPT_FILE} is larger than ${VOICE_SCRIPT_MAX_BYTES} bytes` };
    }

    const parsed = parseCalloutScriptText(read.text);

    if (!parsed.ok) return { ok: false, reason: `${CALLOUT_SCRIPT_FILE} ${parsed.problems[0] ?? "invalid shape"}` };

    return { ok: true, script: parsed.script };
  } catch (err) {
    return {
      ok: false,
      reason: `${CALLOUT_SCRIPT_FILE} could not be read (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * Which root a folder was found under, which is all that decides a pack's
 * provenance there (#1143): `development` for the dev root, and the record's
 * own answer (or `sideload`) for the packs root.
 */
type ScanRootKind = "development" | "packs";

/** The accumulators one scan shares across its roots (#1143): one packs list, one problems list. */
type ScanState = {
  fs: VoicePackFileSystem;
  packs: InstalledVoicePack[];
  problems: VoicePackProblem[];
  /**
   * Pack ids the development root LISTED (#1143) — lower-cased, which is what
   * a manifest id already is. A packs-root folder with one of these ids is
   * shadowed whole; see the branch in {@link scanRoot} for why. Listed, not
   * merely present: a dev folder the scan refused (no manifest, a bad id) must
   * not silence the AppData copy in favour of nothing.
   */
  developmentPackIds: Set<string>;
};

/**
 * Read every pack under `root` (issue #1034).
 *
 * Never throws, and never fails the whole scan for one bad folder: this
 * directory is user-writable by design, so a junk folder must cost that folder
 * only. Everything it refuses comes back as a `problem` so the reason can be
 * logged and shown rather than silently swallowed.
 *
 * Voice ids are unique WITHIN a pack only (#1144). Two packs may each declare
 * `matt`; each is listed under its own composite id, `<pack id>::matt`, and
 * nothing here decides between them — there is no claim to win. Folders are
 * still visited in sorted order so the result is independent of
 * directory-listing order. With a `devRoot` (#1143) that root is visited
 * first, and a pack id it lists shadows the same id under the packs root.
 */
export function scanVoicePacks({ root, devRoot, fs }: ScanVoicePacksOptions): ScanVoicePacksResult {
  const state: ScanState = { fs, packs: [], problems: [], developmentPackIds: new Set() };

  if (devRoot !== undefined) scanRoot(devRoot, "development", state);

  scanRoot(root, "packs", state);

  return { packs: state.packs, problems: state.problems };
}

/** One root's folders, appended into the shared `state` — see {@link scanVoicePacks}. */
function scanRoot(root: string, kind: ScanRootKind, state: ScanState): void {
  const { fs, packs, problems, developmentPackIds } = state;

  for (const folder of [...fs.listDirectories(root)].sort()) {
    // Dot-folders are the installer's own working space (`.tmp`, `.trash`) and
    // anything else a tool decided to hide. Never packs.
    if (folder.startsWith(".")) continue;

    // One pack id, one row (#1143). The development root already listed a pack
    // with this id, so this folder is the same pack seen twice and is skipped
    // whole — before its manifest is even read.
    //
    // Whole, not per voice: two `packs` rows carrying one id would leave every
    // consumer of this list — the launch step's `isPackUsable`, the installer's
    // target lookup, the settings window's rows — keyed on an id that names
    // two things, so which copy a lookup found would come down to array order.
    // A voice only the AppData copy declares is not a loss worth that: it is a
    // voice of a pack the developer is in the middle of editing, and the
    // answer is to stage it.
    //
    // Matched on the folder name lower-cased, the same case-insensitive
    // comparison the id-vs-folder check below makes, because the filesystem
    // underneath is. The reason names the FOLDER as it is on disk (`problem.pack`
    // throughout this scan) rather than the manifest id, which is unread here.
    if (kind === "packs" && developmentPackIds.has(folder.toLowerCase())) {
      problems.push({
        pack: folder,
        reason: `pack "${folder}" is provided by the development build; the copy under the packs root is ignored`,
      });
      continue;
    }

    const dir = join(root, folder);
    const read = fs.readTextFile(join(dir, VOICE_PACK_MANIFEST_FILE));

    if (!read.ok) {
      problems.push({
        pack: folder,
        reason: read.missing
          ? `no ${VOICE_PACK_MANIFEST_FILE}`
          : `${VOICE_PACK_MANIFEST_FILE} could not be read (${read.reason})`,
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
    // things — an ambiguity the installer would later have to guess about. The
    // comparison is the leaf's (`packIdMatchesFolder`), case-insensitive
    // because the filesystem underneath is; the reasoning is on that function.
    if (!packIdMatchesFolder(manifest.id, folder)) {
      problems.push({ pack: folder, reason: `declared id "${manifest.id}" does not match its folder name` });
      continue;
    }

    // The installer's record, read for the provenance badge alone. Not a
    // security boundary: a sideloaded pack can write the same file, and packs
    // are deliberately unsigned — the record is displayed, never enforced (see
    // `provenance` on the pack type for what does and does not key off it).
    //
    // Under the development root (#1143) it is not read at all: the provenance
    // there is decided by where the pack was found, and a staged folder that
    // happens to carry a record must not be badged by it.
    const provenanceRead = kind === "packs" ? fs.readTextFile(join(dir, VOICE_PACK_PROVENANCE_FILE)) : undefined;
    const provenance = provenanceRead?.ok ? parseVoicePackProvenance(provenanceRead.text) : undefined;

    // De-duplicated within the pack by the leaf's rule (`dedupeDeclaredVoices`:
    // keyed on `id`, first wins), and every repeat REPORTED, not silently
    // swallowed. Every other malformation in this scan says something; a repeat
    // would otherwise be the one that does not — the author sees their pack
    // install, sees ONE of the two names they wrote, and has nothing anywhere
    // telling them the other was dropped.
    const { voices: declared, repeated } = dedupeDeclaredVoices(manifest.voices);

    for (const id of repeated) {
      problems.push({ pack: folder, reason: `voice "${id}" is declared more than once; the first wins` });
    }

    // Clip presence is checked PER VOICE, not per pack. A pack that declares a
    // voice but ships nothing under it would register an empty pool for every
    // callout — at runtime indistinguishable from a missing clip — and would
    // put a voice in the dropdown that can never make a sound.
    //
    // "Ships something" means something the ENGINE CAN REACH, not merely a file
    // under the right prefix — see `USABLE_VOICE_CLIP`. A gate looser than what
    // the pool builder consumes lets a pack install cleanly, enter the dropdown
    // and then be completely silent, with the only trace at debug level.
    const found = fs.listMp3Files(dir);
    const voices: InstalledVoice[] = [];
    const clips: string[] = [];
    const unusable: string[] = [];
    const badScripts: string[] = [];

    for (const voice of declared) {
      // The declared `id` drives the prefix, so a declared voice with no
      // matching directory still fails as "no clips found under voice/<id>/".
      // That check is not replaced by the declaration — it is what validates it.
      const prefix = `voice/${voice.id}/`;
      const own = found.filter((clip) => clip.startsWith(prefix));
      const usable = own.filter((clip) => USABLE_VOICE_CLIP.test(clip));

      if (usable.length === 0) {
        unusable.push(
          own.length === 0
            ? `no clips found under ${prefix}`
            : `${prefix} has ${own.length === 1 ? "a file" : "files"} the engine cannot play — clips must be ` +
                `${prefix}<group>/<name>.mp3, with a lowercase .mp3 extension`,
        );
        continue;
      }

      // The script is read AFTER the clip gate, so a voice with nothing to play
      // reports that and nothing else — a second line telling the author to fix
      // a script for a voice that cannot make a sound would send them to the
      // wrong file first. A malformed script drops the voice on the same terms
      // as no usable clips (#1064): it is not listed and contributes no clips.
      const scriptRead = readVoiceScript(fs, dir, voice.id);

      if (!scriptRead.ok) {
        badScripts.push(`voice "${voice.id}": ${scriptRead.reason}`);
        continue;
      }

      voices.push({
        id: qualifiedVoiceId(manifest.id, voice.id),
        packVoiceId: voice.id,
        label: voice.label,
        script: scriptRead.script,
      });

      // Appended one at a time rather than spread: `usable` is derived from a
      // directory walk that caps DEPTH but not breadth, and a spread past V8's
      // argument limit throws a RangeError that this function does not catch —
      // costing every pack, which is exactly what the contract above promises
      // cannot happen for one bad folder.
      for (const clip of usable) clips.push(clip);
    }

    if (unusable.length > 0) problems.push({ pack: folder, reason: unusable.join("; ") });

    // One problem PER dropped voice, not one joined line as for the clips: each
    // reason already names its voice and its file, and a script problem is a
    // sentence about one document an author will open, not a list of paths.
    for (const reason of badScripts) problems.push({ pack: folder, reason });

    if (voices.length === 0) continue;

    // Recorded only for a pack that is actually LISTED, so a dev folder the
    // scan refused shadows nothing under the packs root (#1143).
    if (kind === "development") developmentPackIds.add(manifest.id);

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
      // The record must name THIS pack, the same condition the installer's own
      // hash read applies. A folder copied or renamed by hand keeps the
      // previous `.install.json`, and without this the row would read
      // "Downloaded" for a pack that was never downloaded under that id —
      // which contradicts the field's own definition of `sideload` as the
      // absence of a USABLE record.
      //
      // Under the development root the answer is the root itself (#1143).
      provenance:
        kind === "development" ? "development" : provenance?.id === manifest.id ? provenance.source : "sideload",
    });
  }
}
