/**
 * `lint:pack` (issue #1066): what the plugin would only skip quietly, said
 * loudly to a voice-pack author. With skip-by-default (#1064) quiet failure
 * is the design — an entry naming a var that does not exist is skipped with
 * one warn line in a log the author never reads, a clip nobody references
 * plays never — so a lint pass is the one place anyone is ever told.
 *
 * Pure over an injected filesystem port ({@link LintPackFileSystem}, the
 * same three operations deck-core's pack scanner uses; deck-core is out of
 * reach from here, so the port is restated). The root script
 * (`scripts/lint-pack.mjs`) binds it to `node:fs`, registers the catalog
 * and hands over `engine.contracts()` / `engine.vocabulary()` — the same two
 * reports the pack-author reference is built from — and the engine's own
 * `compileScript`, which is the point: the linter names exactly what the
 * reference publishes, compiles through the very deps the plugin compiles a
 * pack with, and applies the same coverage rules the reference voice is
 * held to (`@iracedeck/callout-script`'s `coverage.ts`).
 *
 * The manifest (`voice-pack.json`) is validated by the very schema the
 * plugin's scanner admits a pack by: `@iracedeck/callout-script`'s
 * `voice-pack.ts` (#1134) holds the manifest schema, the id-vs-folder rule,
 * the voice de-duplication, the usable-clip grammar and the script size cap;
 * this module and the scanner import all of them and the packer the ones it
 * applies, so none of the three can drift from the others. Until #1134 the
 * schema lived in deck-core, out of reach from here, and this module
 * restated each rule as a plain-JSON check beside a comment saying so —
 * nothing pinned the copies, and they had already drifted (the regex here
 * refused a `v1.2.3` the scanner's `semver` accepted).
 * `scripts/lib/lint-pack-scanner-parity.test.mjs` now runs both over the
 * same packs.
 *
 * What stays this module's is the PRESENTATION: the scanner shows a user the
 * first problem of a refused manifest, one line per pack, while an author
 * here gets every one — `validateVoicePackManifest`'s list, the first
 * problem per field (zod reports every failing check of a field, so an id
 * holding `::` would otherwise read twice: the separator, then the
 * kebab-case rule it also breaks). The separator's sentence is
 * `VOICE_ID_SEPARATOR_REASON`, first because the schema checks it first:
 * the plugin names a voice `<pack id>::<voice id>` (#1144), and an author
 * who qualified an id by hand should hear why. The folder comparison is
 * `packIdMatchesFolder` — case-insensitive, as the filesystem is — asked
 * only of an id the schema accepts. A voice id only has to be unique within
 * its pack — another pack's `matt` is a different voice — so nothing is
 * said about one any other pack declares, while one declared twice in the
 * same pack is reported in the scanner's words (the first wins) and linted
 * once. A field problem is reported and the voices are linted anyway — the
 * declared ones whose id the schema's `packId` accepts; when the manifest is
 * missing, unparseable or declares no such id at all, that is reported AND
 * the voices are taken from the directories under `voice/` instead, so the
 * author still gets clip and script feedback.
 *
 * Per voice, in this order: the clip files under `voice/<id>/` (every one
 * must be `voice/<id>/<group>/<name>.mp3`, lowercase extension — the shared
 * `USABLE_VOICE_CLIP`); the script — missing means a clips-only voice, which
 * the plugin accepts and which is silent for every callout, so it is
 * reported (the plugin raises the missing-script banner for exactly this);
 * one larger than the scanner accepts (the shared `VOICE_SCRIPT_MAX_BYTES`)
 * is reported as the scanner treats it — read, then refused before it is
 * parsed; a script that does not parse is reported with the grammar's
 * own problems; a script that parses is compiled, and every skip the pack
 * did NOT mean is reported with the compiler's reason, as are frames and
 * fragments that fail; then the coverage rules over the clip files — bases
 * the script references that the pack does not ship, `sfx/…` literals that
 * name no built-in the plugin ships (`sharedClips`, the bundled manifest's
 * non-voice clips), `pools` aliases nothing names, and bases the pack ships
 * that nothing references. A base is referenced when an entry, frame or
 * fragment addresses it directly, or when a var whose description names its
 * group exists ({@link descriptionNamesGroup}) — the same heuristic the
 * reference's recording script uses, so the two never disagree about which
 * lines a var accounts for; and a base plugin code plays by path with the
 * active voice is never an orphan (`pluginPlayedBases`, handed in by the
 * runner: `group/base` keys, `group/*` for a group the plugin plays every
 * base of). There is no per-pack allowlist.
 *
 * One limitation of the var reading, stated for whoever meets it: the
 * exemption is per GROUP, so a misspelled clip in a group a var also draws
 * from is never reported as an orphan — the linter cannot tell which bases
 * a resolver produces. Declared sources on `defineVar` would close it.
 *
 * Two coverage findings are left to the compiler on purpose: a named pool
 * nothing defines and an include of a fragment nothing defines are both
 * reported by the compile with the ENTRY that made the reference
 * (`unknown pool "x"`, `unknown fragment "x"`), which is the better line;
 * repeating them from the coverage side would say the same thing twice.
 */
import {
  type CalloutScript,
  calloutScriptPath,
  checkCoverage,
  dedupeDeclaredVoices,
  packId,
  packIdMatchesFolder,
  parseCalloutScriptText,
  USABLE_VOICE_CLIP,
  validateVoicePackManifest,
  type VarDrivenGroup,
  VOICE_PACK_MANIFEST_FILE,
  VOICE_SCRIPT_MAX_BYTES,
} from "@iracedeck/callout-script";

import type { ContractReport, VocabularyReport } from "../interpreter.js";
import type { CompiledVoiceScript } from "../script-compiler.js";
import { descriptionNamesGroup, pluginPlayedEntry } from "./pack-reference.js";

// ─── The port ────────────────────────────────────────────────────────────────

/** The outcome of reading one file: `missing` is a separate fact from `ok`, since the two need different words. */
export type LintFileRead = { ok: true; text: string } | { ok: false; missing: boolean; reason: string };

/** The disk operations the linter needs — deck-core's `VoicePackFileSystem`, restated. */
export interface LintPackFileSystem {
  /** Immediate subdirectory names of `dir`; empty when `dir` does not exist. */
  listDirectories(dir: string): readonly string[];
  /** File contents, or why they could not be read. */
  readTextFile(file: string): LintFileRead;
  /** Every `.mp3` under `dir` (any case), recursive, as POSIX paths relative to `dir`. */
  listMp3Files(dir: string): readonly string[];
}

// ─── The report ──────────────────────────────────────────────────────────────

export type LintProblemKind =
  /** The manifest itself, or a voice folder it does not declare. */
  | "manifest"
  /** Clip files the engine cannot play, or a voice with none. */
  | "clips"
  /** `callouts.json` missing, unreadable, or refused by the grammar. */
  | "script"
  /** An entry the compiler skipped for a reason the pack did not mean. */
  | "callout"
  /** A frame that fails to compile. */
  | "frame"
  /** A fragment that fails to compile, or that nothing includes. */
  | "fragment"
  /** A base the script references that the pack does not ship, a built-in it names that the plugin does not, or a literal it cannot place. */
  | "dangling"
  /** A base the pack ships that nothing references, or a `pools` alias nothing names. */
  | "orphan";

/** One thing the plugin would skip quietly. */
export type LintProblem = {
  /** The voice it belongs to; `null` for a pack-level problem. */
  voice: string | null;
  kind: LintProblemKind;
  message: string;
};

export type VoiceLintSummary = {
  id: string;
  /**
   * How far the voice got. `linted`: playable clips found, the script parsed
   * and compiled. `clips-only`: playable clips but no `callouts.json` — valid
   * to the plugin, and silent for every callout. `broken-script`: the script
   * could not be read or did not parse — the plugin drops the voice.
   * `dropped`: nothing the engine can play under `voice/<id>/` — the plugin
   * drops the voice, and its script is not read (the same order the scanner
   * keeps, so the first line an author sees names the file to fix first).
   */
  status: "linted" | "clips-only" | "broken-script" | "dropped";
  /** Contracts the compiled script has a body for. */
  scripted: number;
  /** Every contract the catalog registers. */
  total: number;
  /**
   * Contract ids the voice does not speak, sorted: for a `linted` voice the
   * deliberate skips (`skip: true`, or no entry); for every other status,
   * every contract — a voice with no script, a refused one, or no playable
   * clip speaks nothing, and the summary line says so as `0 of N`.
   */
  skipped: readonly string[];
};

export type LintReport = {
  /** `problems` is empty. */
  ok: boolean;
  /** Pack-level problems first, then each voice's in summary order. */
  problems: readonly LintProblem[];
  /** One per voice, in manifest order — or directory order when the manifest gave none. */
  voices: readonly VoiceLintSummary[];
};

export type LintPackInput = {
  /** The pack folder — the one that holds `voice-pack.json` and `voice/`. */
  packDir: string;
  /**
   * The pack folder's own name (`path.basename(packDir)`, the runner's to
   * derive — path semantics are `node:path`'s, not this module's), which the
   * scanner requires the manifest's `id` to equal, lowercased.
   */
  packDirName: string;
  fs: LintPackFileSystem;
  /** `engine.contracts()` after the catalog registered. */
  contracts: readonly ContractReport[];
  /** `engine.vocabulary()` after the catalog registered. */
  vocabulary: VocabularyReport;
  /**
   * The engine's own compile — `engine.compileScript.bind(engine)` — so a
   * pack is compiled against the deps the plugin compiles it with, never a
   * rebuild off the public reports (which would miss a code-registered pool
   * and count a legacy scenario as a contract).
   */
  compile: (script: CalloutScript) => CompiledVoiceScript;
  /**
   * The plugin's built-ins: the bundled manifest's clips outside `voice/`
   * (`sfx/IRD-tick-open.mp3`, …), which every `sfx/…` literal in a script —
   * a frame's ticks, typically — is checked against.
   */
  sharedClips: readonly string[];
  /**
   * Clips PLUGIN CODE plays with the active voice by path, outside any
   * script — the connect radio check, the toggle acknowledgments, the Test
   * button's greeting, the driver-name clips — as `group/base` keys, with
   * `group/*` for a group the plugin plays every base of. Never orphans:
   * nothing in a script or the vocabulary names them, and yet a pack that
   * ships them is heard. The list is the plugin's knowledge, so the runner
   * passes it (`PLUGIN_PLAYED_CLIPS` in `scripts/lib/lint-pack-run.mjs`,
   * each entry naming the file that plays it) and this module knows none.
   */
  pluginPlayedBases: readonly string[];
};

// ─── Linting ─────────────────────────────────────────────────────────────────

const VOICE_ROOT = "voice";

export function lintPack({
  packDir: rawPackDir,
  packDirName,
  fs,
  contracts,
  vocabulary,
  compile,
  sharedClips,
  pluginPlayedBases,
}: LintPackInput): LintReport {
  const packDir = rawPackDir.replace(/[\\/]+$/, "");
  const problems: LintProblem[] = [];
  const packProblem = (message: string): void => {
    problems.push({ voice: null, kind: "manifest", message });
  };

  const onDisk = [...fs.listDirectories(`${packDir}/${VOICE_ROOT}`)].sort();
  const declared = readManifest(fs.readTextFile(`${packDir}/${VOICE_PACK_MANIFEST_FILE}`), packDirName);
  let voiceIds: readonly string[];

  if (declared.ids !== null) {
    voiceIds = declared.ids;

    for (const message of declared.problems) packProblem(message);

    for (const folder of onDisk) {
      if (!voiceIds.includes(folder)) {
        packProblem(
          `${VOICE_ROOT}/${folder}/ exists but ${VOICE_PACK_MANIFEST_FILE} does not declare it — the plugin ignores it`,
        );
      }
    }
  } else {
    // Every problem is reported; the last carries the fallback note.
    declared.problems.forEach((message, index) => {
      packProblem(
        index === declared.problems.length - 1
          ? `${message}; the voices under ${VOICE_ROOT}/ were linted anyway`
          : message,
      );
    });
    voiceIds = onDisk;
  }

  const pluginPlayed = pluginPlayedBases.map((key) => {
    const slash = key.indexOf("/");

    return { group: key.slice(0, slash), base: key.slice(slash + 1) };
  });
  const context: VoiceContext = {
    packDir,
    fs,
    clips: fs.listMp3Files(packDir),
    compile,
    sharedClips,
    contractIds: contracts.map((c) => c.id).sort(),
    // A group is nobody's typo to report when a var's description names it — a resolver draws from it.
    varDriven: (group) => vocabulary.vars.some((v) => descriptionNamesGroup(v.description, group)),
    // A clip plugin code plays by path is heard without any script naming it.
    pluginPlayed: (base) => {
      const slash = base.indexOf("/");

      return pluginPlayedEntry(pluginPlayed, base.slice(0, slash), base.slice(slash + 1)) !== undefined;
    },
    problems,
  };
  const voices = voiceIds.map((id) => lintVoice(id, context));

  return { ok: problems.length === 0, problems, voices };
}

/**
 * The manifest as the linter read it: the voice ids to lint — `null` when
 * the file gave none and the `voice/` directories stand in — and every
 * problem found on the way, in the order the scanner meets them.
 */
type DeclaredVoices = { ids: readonly string[] | null; problems: readonly string[] };

const REFUSED = "the plugin refuses the manifest";

/**
 * The manifest checked by the scanner's own rules (see the header): the
 * shared schema, then the folder, then the repeats — the scanner's order,
 * with every problem reported where the scanner stops at the first.
 *
 * When the schema refuses the file, the voices are still linted wherever the
 * manifest names them usably: each entry whose `id` the schema's `packId`
 * accepts. That is the same rule that keeps an id off the filesystem — a
 * voice id becomes a directory segment (`voice/<id>/`) below, so an id the
 * plugin would refuse is never used as a path. No such entry at all falls
 * back to the directories, the schema's problems intact.
 */
function readManifest(read: LintFileRead, packDirName: string): DeclaredVoices {
  if (!read.ok) {
    return {
      ids: null,
      problems: [
        read.missing
          ? `${VOICE_PACK_MANIFEST_FILE} is missing — the plugin will not see this folder as a pack`
          : `${VOICE_PACK_MANIFEST_FILE} could not be read (${read.reason})`,
      ],
    };
  }

  let json: unknown;

  try {
    // A leading BOM is stripped as the scanner's reader strips it
    // (`parseVoicePackManifest`, which has the reason): several Windows
    // editors write one, and hand-editing this file is an advertised path.
    // Parsed here rather than through that reader because it returns the
    // FIRST problem only, and an author is owed the list.
    json = JSON.parse(read.text.charCodeAt(0) === 0xfeff ? read.text.slice(1) : read.text);
  } catch (err) {
    return {
      ids: null,
      problems: [`${VOICE_PACK_MANIFEST_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const validated = validateVoicePackManifest(json);
  const problems = validated.ok
    ? []
    : firstPerField(validated.problems).map((problem) => `${VOICE_PACK_MANIFEST_FILE}: ${problem} — ${REFUSED}`);
  const raw: { id?: unknown; voices?: unknown } = json !== null && typeof json === "object" ? json : {};

  // Only an id the schema accepts is compared with the folder: a malformed id
  // already has its line above, and a second telling the author it also
  // misses the folder would send them to the wrong fix first.
  const id = packId.safeParse(raw.id);

  if (id.success && !packIdMatchesFolder(id.data, packDirName)) {
    problems.push(
      `${VOICE_PACK_MANIFEST_FILE}: id "${id.data}" does not match the pack folder name "${packDirName}" — the plugin refuses the pack`,
    );
  }

  // The scanner's words for a repeat: it keeps the first entry and reports
  // the rest, and the pack still loads — so no REFUSED. Said here rather than
  // folded away, because unique within the pack is the one rule a voice id
  // still has.
  const { voices, repeated } = dedupeDeclaredVoices(
    validated.ok ? validated.manifest.voices : usableEntries(raw.voices),
  );

  for (const repeat of repeated) {
    problems.push(`${VOICE_PACK_MANIFEST_FILE}: voice "${repeat}" is declared more than once; the first wins`);
  }

  return { ids: voices.length === 0 ? null : voices.map((voice) => voice.id), problems };
}

/**
 * The first problem per field. zod reports every check a field fails, in the
 * order the schema declares them, so an id holding `::` comes back twice —
 * the separator, then the kebab-case rule it breaks as well — and an empty
 * label twice too. The first is what the scanner would show were that field
 * the only one wrong, and the one that names the fix; the rest would turn one
 * mistake into a list. A problem reads `<path>: <message>` and a path holds
 * no `": "`; the newer-schema sentence carries no path and is kept whole.
 */
function firstPerField(problems: readonly string[]): string[] {
  const seen = new Set<string>();

  return problems.filter((problem) => {
    const colon = problem.indexOf(": ");
    const field = colon === -1 ? problem : problem.slice(0, colon);

    if (seen.has(field)) return false;

    seen.add(field);

    return true;
  });
}

/** The declared entries of a manifest the schema refused, kept where their `id` is one the schema accepts. */
function usableEntries(voices: unknown): { id: string }[] {
  if (!Array.isArray(voices)) return [];

  return voices.flatMap((entry: unknown) => {
    const id = packId.safeParse((entry as { id?: unknown } | null)?.id);

    return id.success ? [{ id: id.data }] : [];
  });
}

type VoiceContext = {
  packDir: string;
  fs: LintPackFileSystem;
  /** Every `.mp3` under the pack, POSIX-relative. */
  clips: readonly string[];
  compile: (script: CalloutScript) => CompiledVoiceScript;
  sharedClips: readonly string[];
  /** Every contract id, sorted — what a scriptless voice skips. */
  contractIds: readonly string[];
  varDriven: VarDrivenGroup;
  /** Whether plugin code plays a `group/base` by path — never an orphan. */
  pluginPlayed: (base: string) => boolean;
  problems: LintProblem[];
};

const MP3 = ".mp3";

function lintVoice(id: string, ctx: VoiceContext): VoiceLintSummary {
  const total = ctx.contractIds.length;
  const prefix = `${VOICE_ROOT}/${id}/`;
  const problem = (kind: LintProblemKind, message: string): void => {
    ctx.problems.push({ voice: id, kind, message });
  };

  // Clips: exactly `voice/<id>/<group>/<name>.mp3` — the shared
  // `USABLE_VOICE_CLIP`, the gate the scanner admits a voice's clips by and
  // the grammar the engine's pool pattern reads, under this voice's prefix.
  const own = ctx.clips.filter((clip) => clip.startsWith(prefix));
  const usable = own.filter((clip) => USABLE_VOICE_CLIP.test(clip));

  for (const clip of own.filter((clip) => !USABLE_VOICE_CLIP.test(clip)).sort()) {
    problem("clips", `${clip} is not ${prefix}<group>/<name>${MP3} (lowercase ${MP3}) — the engine cannot play it`);
  }

  if (usable.length === 0) {
    problem("clips", `no ${own.length === 0 ? "" : "playable "}clips under ${prefix} — the plugin drops the voice`);

    // A dropped voice speaks nothing, so every contract is what it skips.
    return { id, status: "dropped", scripted: 0, total, skipped: ctx.contractIds };
  }

  const authored = usable.map((clip) => clip.slice(prefix.length, -MP3.length));

  // The script.
  const scriptPath = calloutScriptPath(id);
  const read = ctx.fs.readTextFile(`${ctx.packDir}/${scriptPath}`);
  const brokenScript: VoiceLintSummary = { id, status: "broken-script", scripted: 0, total, skipped: ctx.contractIds };

  if (!read.ok) {
    if (read.missing) {
      problem(
        "script",
        `no ${scriptPath} — a clips-only voice: every callout is skipped in it, and the plugin shows the missing-script banner when it is selected`,
      );

      return { id, status: "clips-only", scripted: 0, total, skipped: ctx.contractIds };
    }

    problem("script", `${scriptPath} could not be read (${read.reason})`);

    return brokenScript;
  }

  // The scanner's size gate, applied BEFORE parsing as the scanner applies
  // it — the same shared cap and the same `length` comparison, so the two
  // agree on the boundary.
  if (read.text.length > VOICE_SCRIPT_MAX_BYTES) {
    problem(
      "script",
      `${scriptPath} is larger than ${VOICE_SCRIPT_MAX_BYTES} bytes — the plugin refuses it before it is parsed and drops the voice`,
    );

    return brokenScript;
  }

  const parsed = parseCalloutScriptText(read.text);

  if (!parsed.ok) {
    for (const reason of parsed.problems) problem("script", `${scriptPath} — ${reason}`);

    return brokenScript;
  }

  const compiled = ctx.compile(parsed.script);

  for (const skip of [...compiled.skipped].filter((s) => !s.deliberate).sort((a, b) => compare(a.id, b.id))) {
    problem("callout", `"${skip.id}" is skipped — ${skip.reason}`);
  }

  for (const [name, reason] of sortedEntries(compiled.failedFrames)) {
    problem("frame", `"${name}" does not compile — ${reason} — every callout framed by it is skipped`);
  }

  for (const [name, reason] of sortedEntries(compiled.fragmentProblems)) {
    problem("fragment", `"${name}" does not compile — ${reason}`);
  }

  reportCoverage(parsed.script, authored, prefix, ctx, problem);

  return {
    id,
    status: "linted",
    scripted: compiled.scenarios.size,
    total,
    skipped: compiled.skipped
      .filter((s) => s.deliberate)
      .map((s) => s.id)
      .sort(),
  };
}

function reportCoverage(
  script: CalloutScript,
  authored: readonly string[],
  prefix: string,
  ctx: Pick<VoiceContext, "sharedClips" | "varDriven" | "pluginPlayed">,
  problem: (kind: LintProblemKind, message: string) => void,
): void {
  const coverage = checkCoverage({ script, authored, sharedClips: ctx.sharedClips }, ctx.varDriven);

  for (const name of coverage.unincludedFragments) {
    problem(
      "fragment",
      `"${name}" is defined but nothing includes it — a fragment nothing includes is checked by nobody`,
    );
  }

  for (const base of coverage.dangling) {
    problem(
      "dangling",
      `"${base}" is referenced but the pack ships no ${prefix}${base}*${MP3} — a required step that resolves to nothing aborts the whole callout at fire time`,
    );
  }

  for (const path of coverage.missingSharedClips) {
    problem(
      "dangling",
      `literal "${path}" names a built-in clip the plugin does not ship — a step that resolves to nothing aborts the callout at fire time, and in a frame every callout it wraps`,
    );
  }

  for (const path of coverage.unrecognisedLiterals) {
    problem(
      "dangling",
      `literal "${path}" cannot be checked against the pack — spell a clip as pool:<group>/<base> or voice/{voice}/<group>/<name>${MP3}`,
    );
  }

  // The plugin-played exemption is applied HERE, by base, on top of the
  // shared rule — the coverage module's predicate is per group and means
  // "a var draws from it", which this is not.
  for (const base of coverage.orphans.filter((base) => !ctx.pluginPlayed(base))) {
    problem(
      "orphan",
      `"${base}" is shipped as ${prefix}${base}*${MP3} but nothing in the script references it — it never plays`,
    );
  }

  for (const name of coverage.unusedAliases) {
    problem("orphan", `pool alias "${name}" is defined but nothing uses it — a name that decides nothing`);
  }
}

// ─── Printing ────────────────────────────────────────────────────────────────

/** How wide a wrapped id list may run — a terminal's worth, so a three-callout pack's 146 skips read as a block, not a wall. */
export const SUMMARY_WIDTH = 100;

/**
 * The report as the root script prints it: the problems grouped by voice —
 * pack-level first, under `pack:` — then one summary per voice, then the
 * problem count. Deliberate skips are listed in full, wrapped under the
 * summary line: the count says how many, and the ids are what an author
 * checks against their plan.
 */
export function formatLintReport(report: LintReport): string[] {
  const lines: string[] = [];
  const groups = new Map<string | null, LintProblem[]>();

  for (const problem of report.problems) {
    const group = groups.get(problem.voice);

    if (group) group.push(problem);
    else groups.set(problem.voice, [problem]);
  }

  for (const [voice, problems] of groups) {
    lines.push(voice === null ? "pack:" : `voice ${voice}:`);

    for (const { kind, message } of problems) lines.push(`  ${kind}: ${message}`);

    lines.push("");
  }

  for (const voice of report.voices) {
    const skipped = voice.skipped.length === 0 ? "none" : String(voice.skipped.length);
    lines.push(`${voice.id}: ${voice.scripted} of ${voice.total} callouts scripted; skipped: ${skipped}`);
    lines.push(...wrapList(voice.skipped, "  ", SUMMARY_WIDTH));
  }

  lines.push("");

  const count = report.problems.length;
  lines.push(count === 0 ? "No problems" : `${count} problem${count === 1 ? "" : "s"}`);

  return lines;
}

/** Comma-separated items packed into indented lines no wider than `width` (a single item may still exceed it). */
function wrapList(items: readonly string[], indent: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const item of items) {
    const candidate = current === "" ? `${indent}${item}` : `${current}, ${item}`;

    if (current !== "" && candidate.length > width) {
      lines.push(`${current},`);
      current = `${indent}${item}`;
    } else {
      current = candidate;
    }
  }

  if (current !== "") lines.push(current);

  return lines;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Code-point order, like every list the reference publishes. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedEntries(map: ReadonlyMap<string, string>): [string, string][] {
  return [...map].sort(([a], [b]) => compare(a, b));
}
