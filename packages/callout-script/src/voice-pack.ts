/**
 * The voice-pack FORMAT's shared rules (#1034, #1134): the shape of a pack's
 * `voice-pack.json`, a reader for it that never throws, and the handful of
 * rules about what sits beside the manifest — which clip paths the engine can
 * reach, how large a script may be, that the folder is named for the id, that
 * a voice is declared once.
 *
 * Here rather than in `deck-core` for the reason the grammar is: the plugin's
 * scanner admits packs by these rules, `lint:pack` (`@iracedeck/audio-scenarios`)
 * tells an author whether the scanner will, and the packer
 * (`@iracedeck/audio-assets`) refuses to build what the scanner would refuse —
 * three consumers that must not depend on each other. Until #1134 the linter
 * and the packer restated each rule beside a comment saying so, and nothing
 * pinned the copies to the scanner's; a scanner change made the linter lie.
 * One implementation, imported three times, cannot.
 */
import { z } from "zod";

import { declaresNewerSchema } from "./schema-version.js";
import { VOICE_ID_SEPARATOR, VOICE_ID_SEPARATOR_REASON } from "./voice-id.js";

/** The pack manifest's file name, as the archive carries it and the scanner opens it. */
export const VOICE_PACK_MANIFEST_FILE = "voice-pack.json";

/**
 * The manifest format's version — the value `schema` must hold, and the one
 * every writer of a `voice-pack.json` stamps (the packer, and deck-core's
 * installer when it seeds a bundled pack), so a writer and the schema cannot
 * name two versions. A higher number is a pack written by a newer toolchain,
 * reported as such ({@link VOICE_PACK_NEWER_SCHEMA_REASON}); anything else at
 * that key is an author's mistake and is reported as one.
 */
export const VOICE_PACK_MANIFEST_SCHEMA_VERSION = 1;

/** `semver`'s `MAX_LENGTH`. */
const SEMVER_MAX_LENGTH = 256;

// The semver.org grammar, token for token as `semver`'s `internal/re.js`
// spells it (`FULL`), with `v?` in front as that library allows.
const NUMERIC_IDENTIFIER = "0|[1-9]\\d*";
const NON_NUMERIC_IDENTIFIER = "\\d*[a-zA-Z-][a-zA-Z0-9-]*";
const PRERELEASE_IDENTIFIER = `(?:${NON_NUMERIC_IDENTIFIER}|${NUMERIC_IDENTIFIER})`;
const BUILD_IDENTIFIER = "[a-zA-Z0-9-]+";
const SEMVER_FULL = new RegExp(
  `^v?(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})` +
    `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
    `(?:\\+(${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*))?$`,
);

/**
 * What `semver.valid` (the `semver` package, 7.8.5) reads — no more, no less.
 *
 * A hand-written predicate rather than the library because this package stays
 * zod-only, and no tighter than the library because tightening would refuse
 * packs that install today: the scanner accepted `v1.2.3` through `semver`
 * since #1034, and a hygiene change must not make a user's pack disappear. So
 * the rule is the library's, reproduced: the semver.org grammar, plus four
 * behaviours of `semver.valid` that the grammar alone does not give —
 *
 * - an input longer than 256 characters is refused, and that length is
 *   checked BEFORE the trim;
 * - the input is `.trim()`med, so surrounding whitespace, a trailing newline,
 *   a no-break space or a BOM in front is not a problem;
 * - one optional leading lowercase `v` (`V`, `vv`, `=` are refused);
 * - major, minor and patch are each at most `Number.MAX_SAFE_INTEGER`.
 *
 * `semver` compiles its pattern with bounded quantifiers against regex DoS;
 * within 256 characters those bounds cannot bite, so the plain grammar below
 * is the same language. The equality is pinned by deck-core's
 * `voice-pack-semver-parity.test.ts`, which runs both over the same inputs at
 * the version deck-core pins — this package cannot see `semver`, so that is
 * where a library bump that changed a verdict would show.
 */
export function isSemverVersion(value: string): boolean {
  if (value.length > SEMVER_MAX_LENGTH) return false;

  const match = SEMVER_FULL.exec(value.trim());

  if (match === null) return false;

  return (
    Number(match[1]) <= Number.MAX_SAFE_INTEGER &&
    Number(match[2]) <= Number.MAX_SAFE_INTEGER &&
    Number(match[3]) <= Number.MAX_SAFE_INTEGER
  );
}

/**
 * Pack and voice ids share the audio-assets kebab-case rule, so a voice id in a
 * pack is spelled exactly as it is in `configs/<voice-id>.voice.json` and in the
 * `voice/<id>/…` clip paths it produces.
 *
 * The separator check comes FIRST, and is not a new rejection: kebab-case
 * already excludes `::`. It is a better reason. iRaceDeck names a voice outside
 * its pack as `<pack id>::<voice id>` (#1144), and an author who tried to
 * qualify an id by hand should be told that is why, rather than merely that
 * the id is malformed. The reason is `VOICE_ID_SEPARATOR_REASON`, the sentence
 * `lint:pack` reports too.
 */
export const packId = z
  .string()
  .refine((id) => !id.includes(VOICE_ID_SEPARATOR), VOICE_ID_SEPARATOR_REASON)
  .regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case (a-z, 0-9, dashes)");

/**
 * A name a user reads: the pack's, or one of its voices'.
 *
 * Bounded because it is a third party's string rendered straight into a
 * `<option>` and into the Installed Voices row. 60 characters is far more than
 * any engineer's name needs and far less than enough to break the window
 * layout; control characters are refused outright, since a newline inside a
 * dropdown entry has no meaning and one inside a list row costs a line.
 *
 * Set NOW rather than later: a bound added after packs ship rejects packs that
 * already installed, which is a migration. Loosening one never is.
 */
export const displayLabel = z
  .string()
  .min(1)
  .max(60, "must be 60 characters or fewer")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f\x7f]+$/, "must not contain control characters");

/**
 * A voice the pack provides: what it IS, and what it is CALLED.
 *
 * `id` is identity — it matches the `voice/<id>/…` clip path inside the pack,
 * and joined to the pack's id as `<pack id>::<id>` (#1144) it is what
 * `raceEngineerVoice` stores and what the default anchor compares. Unique
 * within the pack only: two packs may each declare a `matt`. `label` is
 * presentation and nothing else: no code resolves, compares or persists it.
 *
 * The pair exists because the pack already had one and its voices did not, so a
 * pack author could name their pack but not their voices — the dropdown fell
 * back to `titleCase(id)` and rendered a hyphenated id as `Aaa-testvoice`.
 */
export const voiceEntry = z.object({ id: packId, label: displayLabel });

export const VoicePackManifestSchema = z.object({
  // A literal, not a minimum: an unknown schema means a pack built by a newer
  // toolchain, and guessing at its shape is worse than declining to load it.
  //
  // Still `1` after `voices` changed shape, deliberately: a version tells apart
  // formats that coexist in the wild, and there is no version 1 in the wild —
  // no released plugin reads this file at all. Bumping would imply a
  // predecessor nobody can find, and would answer a hand-made test pack with
  // "expected 2" where staying at 1 fails on `voices.0` and names the field
  // that actually moved.
  schema: z.literal(VOICE_PACK_MANIFEST_SCHEMA_VERSION),
  id: packId,
  label: displayLabel,
  version: z.string().refine(isSemverVersion, "must be a valid semver version"),
  author: z.string().min(1).optional(),
  voices: z.array(voiceEntry).min(1),
  // No `skipped` here, deliberately. It was reserved for #1033's per-entry skip
  // when a pack meant one voice — but #1064's design has since moved skipping to
  // a `"skip": true` inside each voice's own script file, so a pack-level flat
  // list reserves a slot a newer design already fills, in a format where
  // per-voice data now has no home at this level. Nothing ever read it: the
  // scanner never put it on `InstalledVoicePack`, so removing it costs nothing.
  //
  // The asymmetry is the reason to remove it NOW rather than keep it: adding a
  // field back to an unshipped format is the same free edit as taking one out,
  // while keeping this one means carrying it forever.
});

export type VoicePackManifest = z.infer<typeof VoicePackManifestSchema>;

/**
 * The one problem that is not about a field the author typed: the pack is fine
 * and the plugin is old. The schema literal earns its keep here or nowhere —
 * refusing a pack built by a newer toolchain is the entire reason it is a
 * literal rather than a minimum, so the refusal has to SAY that, in a sentence
 * a user can act on. Left as zod's own text it reads "schema: Invalid input:
 * expected 1", which tells somebody with a perfectly good pack nothing about
 * needing a newer iRaceDeck.
 */
export const VOICE_PACK_NEWER_SCHEMA_REASON =
  "built for a newer version of iRaceDeck — update the plugin to use this pack";

export type VoicePackManifestValidation =
  { ok: true; manifest: VoicePackManifest } | { ok: false; problems: readonly string[] };

/**
 * Validate an already-parsed `voice-pack.json` and report its problems, one
 * string each, in the form `<path>: <message>` — `(root)` for a document that
 * is not an object at all — and ONE per field: the first problem at each path.
 *
 * zod reports every check a field fails, in the order the schema declares
 * them, so an id holding `::` would come back twice — the separator, then the
 * kebab-case rule it breaks as well — and an empty label twice too. The first
 * is what names the fix; the rest would turn one mistake into a list. The
 * de-duplication is keyed on the issue's own `path`, never on the formatted
 * string, so no message text can make two fields collide or one field split.
 *
 * This is the list `lint:pack` shows an author in full; the scanner shows its
 * first entry ({@link parseVoicePackManifest}), which keeping the first per
 * field does not change. One walk serves both, so the linter's list is the
 * scanner's reason followed by the rest, never a second reading of the same
 * file.
 *
 * The newer-version sentence is used only when `schema` is a NUMBER ABOVE the
 * current version — the same rule the callout-script grammar applies to its
 * own `schema` (#1134). Until then any issue at that path got the sentence,
 * so an author who forgot the field, or wrote `0`, was told to update a plugin
 * that was not the problem.
 */
export function validateVoicePackManifest(json: unknown): VoicePackManifestValidation {
  const parsed = VoicePackManifestSchema.safeParse(json);

  if (parsed.success) return { ok: true, manifest: parsed.data };

  const seen = new Set<string>();
  const problems: string[] = [];

  for (const issue of parsed.error.issues) {
    // Keyed on the segments themselves, serialised: two different paths can
    // never produce the same key, whatever their keys spell.
    const key = JSON.stringify(issue.path.map(String));

    if (seen.has(key)) continue;

    seen.add(key);

    if (
      issue.path.length === 1 &&
      issue.path[0] === "schema" &&
      declaresNewerSchema(json, VOICE_PACK_MANIFEST_SCHEMA_VERSION)
    ) {
      problems.push(VOICE_PACK_NEWER_SCHEMA_REASON);
    } else {
      problems.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }

  return { ok: false, problems: problems.length > 0 ? problems : ["invalid shape"] };
}

/**
 * A `voice-pack.json` read from its text. `json` is the parsed document —
 * `undefined` only when the text is not JSON at all — handed back on a refusal
 * too, so a caller that reports every problem can still read what the author
 * wrote (`lint:pack` lints the voices a refused manifest names usably).
 */
export type VoicePackManifestTextRead =
  { ok: true; manifest: VoicePackManifest; json: unknown } | { ok: false; problems: readonly string[]; json: unknown };

/**
 * The manifest's one TEXT stage — BOM strip, `JSON.parse`, then
 * {@link validateVoicePackManifest} — shared by the scanner (through
 * {@link parseVoicePackManifest}) and `lint:pack`, so what counts as a readable
 * manifest is decided in exactly one place. Text that is not JSON is the one
 * problem `not valid JSON: <message>`, with `json` left `undefined`.
 *
 * A leading UTF-8 BOM is stripped before parsing: `JSON.parse` throws on it,
 * and several Windows editors write one. Hand-editing `voice-pack.json` on
 * Windows is the ADVERTISED install path for this feature, so a BOM would
 * reject a pack that is correct in every way a user can see, with "not valid
 * JSON" as the only clue. deck-core's `settings-store.ts` strips one for the
 * same reason — "a BOM must not make a user's backup corrupt" — and the pack
 * format should not be stricter than the settings file about the same
 * accident.
 *
 * Never throws, for the reason {@link parseVoicePackManifest} gives.
 */
export function readVoicePackManifestText(raw: string): VoicePackManifestTextRead {
  let json: unknown;

  try {
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    return {
      ok: false,
      problems: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
      json: undefined,
    };
  }

  const validated = validateVoicePackManifest(json);

  return validated.ok
    ? { ok: true, manifest: validated.manifest, json }
    : { ok: false, problems: validated.problems, json };
}

export type ParseVoicePackManifestResult = { ok: true; manifest: VoicePackManifest } | { ok: false; reason: string };

/**
 * Parse a pack's `voice-pack.json` from its text — the scanner's contract.
 *
 * Never throws. The packs directory is user-writable by design — a hand-placed
 * pack is a first-class install path — so a malformed manifest is a reportable
 * problem with that one pack, never a plugin-startup failure. The reason names
 * the offending field so a sideloader can fix it without guessing, and it is
 * the FIRST problem {@link readVoicePackManifestText} finds: one line per
 * refused pack in the Installed Voices list.
 */
export function parseVoicePackManifest(raw: string): ParseVoicePackManifestResult {
  const read = readVoicePackManifestText(raw);

  if (!read.ok) return { ok: false, reason: read.problems[0] ?? "invalid shape" };

  return { ok: true, manifest: read.manifest };
}

/**
 * Is the folder a pack sits in named for the pack?
 *
 * The folder name is how a pack is addressed on disk, so a mismatch would
 * make "the pack called luca" and "the folder called luca" two different
 * things — an ambiguity the installer would later have to guess about.
 *
 * Compared case-INSENSITIVELY, because the filesystem underneath is. The id
 * regex forces lowercase but a folder name never goes through it, so `Luca/`
 * holding `"id": "luca"` would otherwise be refused — on Windows, the only
 * platform the manifests declare (#994), those ARE one directory: the user
 * cannot create both, and the manifest was just read through the capitalised
 * path. Refusing it would reject a working pack over a distinction the OS
 * does not make, with a message that reads as satisfied.
 */
export function packIdMatchesFolder(id: string, folderName: string): boolean {
  return id === folderName.toLowerCase();
}

/**
 * De-duplicate the voices a manifest declares — a manifest repeating a voice
 * id would otherwise duplicate its clips and list it twice in the settings
 * window. Keyed on `id`, never the label: two entries naming the same voice
 * under different labels are still one voice, and the first wins.
 *
 * `repeated` lists the id of every entry dropped, in declaration order, so the
 * caller can say so. Reported, not silently swallowed: every other
 * malformation in a pack scan says something; a repeat would otherwise be the
 * one that does not — the author sees their pack install, sees ONE of the two
 * names they wrote, and has nothing anywhere telling them the other was
 * dropped. More likely now that a voice carries a label, since two entries
 * differing only by label look like two things.
 */
export function dedupeDeclaredVoices<T extends { id: string }>(
  voices: readonly T[],
): { voices: T[]; repeated: string[] } {
  const seen = new Set<string>();
  const kept: T[] = [];
  const repeated: string[] = [];

  for (const voice of voices) {
    if (seen.has(voice.id)) {
      repeated.push(voice.id);
      continue;
    }

    seen.add(voice.id);
    kept.push(voice);
  }

  return { voices: kept, repeated };
}

/**
 * A clip the scenario engine can actually reach.
 *
 * Deliberately the SAME grammar the engine's `buildManifestPool` compiles —
 * `^voice/<id>/<group>/<base>(-NN)?\.mp3$` — minus the per-pool group and base,
 * because this is where the two are kept in agreement. Two ways a file under the
 * right prefix is nonetheless unreachable, both of which a pack hits by accident:
 *
 * - **A missing `<group>` segment.** `voice/luca/sample.mp3` is one level short
 *   of anything a pool can match, and no scenario references a clip that shape.
 * - **A non-lowercase extension.** The scanner's `listMp3Files` matches `.mp3`
 *   case-INSENSITIVELY and records the name verbatim, which is right for finding
 *   files; the pool regex and the `clipSet` lookup are both case-SENSITIVE.
 *   `blue-01.MP3` — what plenty of Windows tools emit — would otherwise install,
 *   list its voice and play nothing.
 *
 * deck-core's `VOICE_PACK_MAX_DEPTH` already reasons from this grammar for the
 * depth CEILING. This is the same reasoning applied to the floor and to the
 * extension, so a pack that cannot work is refused with a reason instead of
 * being silently mute — by the scanner, by the linter, and by the packer before
 * the pack exists.
 */
export const USABLE_VOICE_CLIP = /^voice\/[^/]+\/[^/]+\/[^/]+\.mp3$/;

/**
 * The most text a `callouts.json` may hold before it is refused unread
 * (#1064). The reference voice's script is under 200 KB and the largest JSON
 * anywhere in the audio pipeline is 480 KB (the numbers deck-core's
 * `VOICE_PACK_ARCHIVE_LIMITS` was calibrated against), so a megabyte is
 * headroom for any pack an author would write and a bound on what a
 * sideloaded file can make the grammar validate — the pack folder is
 * user-writable, and the schema walk is not free. Measured in UTF-16 code
 * units of the decoded text, which never exceeds the file's byte count, so a
 * file this check refuses is always larger than the cap in bytes as well.
 */
export const VOICE_SCRIPT_MAX_BYTES = 1024 * 1024;
