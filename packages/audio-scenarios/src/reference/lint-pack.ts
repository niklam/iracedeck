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
 * reports the pack-author reference is built from, which is the point: the
 * linter names exactly what the reference publishes, through the same
 * `compileVoiceScript` the plugin runs and the same coverage rules the
 * bundled voice is held to (`@iracedeck/callout-script`'s `coverage.ts`).
 *
 * The manifest (`voice-pack.json`) is read as PLAIN JSON and only its
 * `voices[].id` are taken — deck-core's schema, which the plugin validates
 * the whole file with at install time, is unreachable from this package.
 * When the manifest is missing, unparseable or carries no ids, that is
 * reported as a problem AND the voices are taken from the directories under
 * `voice/` instead, so the author still gets clip and script feedback.
 *
 * Per voice, in this order: the clip files under `voice/<id>/` (every one
 * must be `voice/<id>/<group>/<name>.mp3`, lowercase extension — deck-core's
 * `USABLE_CLIP` rule, restated); the script — missing means a clips-only
 * voice, which the plugin accepts and which is silent for every callout, so
 * it is reported (the plugin raises the missing-script banner for exactly
 * this); one larger than the scanner reads (`VOICE_SCRIPT_MAX_BYTES`,
 * restated) is reported as the scanner would refuse it, unread; a script
 * that does not parse is reported with the grammar's own problems; a script
 * that parses is compiled, and every skip the pack did NOT mean is reported
 * with the compiler's reason, as are frames and fragments that fail; then
 * the coverage rules over the clip files — bases the script references that
 * the pack does not ship, and bases the pack ships that nothing references.
 * A base is referenced when an entry or fragment addresses it directly, or
 * when a var whose description names its group exists
 * ({@link descriptionNamesGroup}) — the same heuristic the reference's
 * recording script uses, so the two never disagree about which lines a var
 * accounts for — or when its group is one plugin code plays by path with
 * the active voice (`pluginPlayedGroups`, handed in by the runner: the
 * driver-name clips and the toggle acknowledgments). There is no per-pack
 * allowlist.
 *
 * Two coverage findings are left to the compiler on purpose: a named pool
 * nothing defines and an include of a fragment nothing defines are both
 * reported by `compileVoiceScript` with the ENTRY that made the reference
 * (`unknown pool "x"`, `unknown fragment "x"`), which is the better line;
 * repeating them from the coverage side would say the same thing twice.
 *
 * The compiler needs resolvers for conditions and cases; a lint never runs
 * one, so inert stand-ins are built from the vocabulary report — existence
 * is all the compile checks. `legacyPools` is empty: the catalog registers
 * no named pools since #1065, and `IScenarioEngine` exposes no list of them.
 */
import {
  type CalloutScript,
  calloutScriptPath,
  checkCoverage,
  parseCalloutScriptText,
  type VarDrivenGroup,
} from "@iracedeck/callout-script";

import type { ContractReport, VocabularyReport } from "../interpreter.js";
import { type CompileDeps, compileVoiceScript } from "../script-compiler.js";
import { descriptionNamesGroup } from "./pack-reference.js";

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
  /** A base the script references that the pack does not ship. */
  | "dangling"
  /** A base the pack ships that nothing references. */
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
  fs: LintPackFileSystem;
  /** `engine.contracts()` after the catalog registered. */
  contracts: readonly ContractReport[];
  /** `engine.vocabulary()` after the catalog registered. */
  vocabulary: VocabularyReport;
  /**
   * Clip groups PLUGIN CODE plays with the active voice, outside any script
   * — the driver-name clips and the toggle acknowledgments today. Their
   * bases are never orphans: nothing in a script or the vocabulary names
   * them, and yet a pack that ships them is heard. The list is the plugin's
   * knowledge, so the runner passes it (`scripts/lib/lint-pack-run.mjs`,
   * each entry naming the file that plays it) and this module defaults to
   * none, staying as ignorant of the plugin as the reference builder is.
   */
  pluginPlayedGroups?: readonly string[];
};

// ─── Linting ─────────────────────────────────────────────────────────────────

const MANIFEST_FILE = "voice-pack.json";
const VOICE_ROOT = "voice";

export function lintPack({
  packDir: rawPackDir,
  fs,
  contracts,
  vocabulary,
  pluginPlayedGroups = [],
}: LintPackInput): LintReport {
  const packDir = rawPackDir.replace(/[\\/]+$/, "");
  const problems: LintProblem[] = [];
  const packProblem = (message: string): void => {
    problems.push({ voice: null, kind: "manifest", message });
  };

  const onDisk = [...fs.listDirectories(`${packDir}/${VOICE_ROOT}`)].sort();
  const declared = readDeclaredVoices(fs.readTextFile(`${packDir}/${MANIFEST_FILE}`));
  let voiceIds: readonly string[];

  if (declared.ok) {
    voiceIds = declared.ids;

    for (const message of declared.problems) packProblem(message);

    for (const folder of onDisk) {
      if (!voiceIds.includes(folder)) {
        packProblem(`${VOICE_ROOT}/${folder}/ exists but ${MANIFEST_FILE} does not declare it — the plugin ignores it`);
      }
    }
  } else {
    packProblem(`${declared.problem}; the voices under ${VOICE_ROOT}/ were linted anyway`);
    voiceIds = onDisk;
  }

  const context: VoiceContext = {
    packDir,
    fs,
    clips: fs.listMp3Files(packDir),
    deps: compileDepsOf(contracts, vocabulary),
    contractIds: contracts.map((c) => c.id).sort(),
    // A group is nobody's typo to report when a var's description names it
    // (a resolver draws from it) or when plugin code plays it by path.
    varDriven: (group) =>
      pluginPlayedGroups.includes(group) || vocabulary.vars.some((v) => descriptionNamesGroup(v.description, group)),
    problems,
  };
  const voices = voiceIds.map((id) => lintVoice(id, context));

  return { ok: problems.length === 0, problems, voices };
}

type DeclaredVoices =
  { ok: true; ids: readonly string[]; problems: readonly string[] } | { ok: false; problem: string };

/**
 * Pack and voice ids are lowercase kebab-case — deck-core's `packId` rule,
 * restated. Checked here for two reasons: the plugin refuses a manifest with
 * any other id, which an author should hear before installing; and the id
 * becomes a directory segment (`voice/<id>/`) below, so an id that is not
 * one is never used as a path.
 */
const VOICE_ID = /^[a-z][a-z0-9-]*$/;

/**
 * `voices[].id` off the manifest read as plain JSON — see the header for
 * why nothing else in the file is looked at here. An entry with no string
 * id, or one the plugin would refuse, is reported (the plugin refuses such a
 * manifest whole) and the others are kept; no usable id at all falls back to
 * the directories.
 */
function readDeclaredVoices(read: LintFileRead): DeclaredVoices {
  if (!read.ok) {
    return {
      ok: false,
      problem: read.missing
        ? `${MANIFEST_FILE} is missing — the plugin will not see this folder as a pack`
        : `${MANIFEST_FILE} could not be read (${read.reason})`,
    };
  }

  let json: unknown;

  try {
    json = JSON.parse(read.text.charCodeAt(0) === 0xfeff ? read.text.slice(1) : read.text);
  } catch (err) {
    return {
      ok: false,
      problem: `${MANIFEST_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const voices = json !== null && typeof json === "object" ? (json as { voices?: unknown }).voices : undefined;

  if (!Array.isArray(voices)) {
    return { ok: false, problem: `${MANIFEST_FILE} has no voices[].id list — the plugin reads the voices from it` };
  }

  const ids: string[] = [];
  const problems: string[] = [];

  voices.forEach((entry, index) => {
    const id = entry !== null && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;

    if (typeof id !== "string" || id === "") {
      problems.push(`${MANIFEST_FILE}: voices[${index}] has no string id — the plugin refuses the manifest`);
    } else if (!VOICE_ID.test(id)) {
      problems.push(
        `${MANIFEST_FILE}: voices[${index}].id "${id}" is not lowercase kebab-case (a-z, 0-9, dashes) — the plugin refuses the manifest`,
      );
    } else if (!ids.includes(id)) {
      ids.push(id);
    }
  });

  if (ids.length === 0) {
    return { ok: false, problem: `${MANIFEST_FILE} has no voices[].id list — the plugin reads the voices from it` };
  }

  return { ok: true, ids, problems };
}

/**
 * What the compiler needs, off the two public reports. Existence is all a
 * compile checks — the resolvers only run at fire time, and nothing fires
 * here — so a condition is a predicate that answers `false` and a case a
 * resolver that answers `null`, each with its real declared key set.
 */
function compileDepsOf(contracts: readonly ContractReport[], vocabulary: VocabularyReport): CompileDeps {
  return {
    contracts: new Map(contracts.map((c) => [c.id, { frame: c.frame }])),
    vars: new Set(vocabulary.vars.map((v) => v.name)),
    conds: new Map(vocabulary.conds.map((c) => [c.name, () => false])),
    cases: new Map(vocabulary.cases.map((c) => [c.name, { resolve: () => null, keys: new Set(Object.keys(c.keys)) }])),
    legacyPools: new Set(),
  };
}

type VoiceContext = {
  packDir: string;
  fs: LintPackFileSystem;
  /** Every `.mp3` under the pack, POSIX-relative. */
  clips: readonly string[];
  deps: CompileDeps;
  /** Every contract id, sorted — what a scriptless voice skips. */
  contractIds: readonly string[];
  varDriven: VarDrivenGroup;
  problems: LintProblem[];
};

const MP3 = ".mp3";

/**
 * The largest `callouts.json` the plugin will read — deck-core's
 * `VOICE_SCRIPT_MAX_BYTES` (`voice-pack-scanner.ts`), restated: the scanner
 * refuses a bigger file before parsing it and drops the voice, so a pack
 * that lints clean here must be one the scanner would read.
 */
const VOICE_SCRIPT_MAX_BYTES = 1024 * 1024;

function lintVoice(id: string, ctx: VoiceContext): VoiceLintSummary {
  const total = ctx.contractIds.length;
  const prefix = `${VOICE_ROOT}/${id}/`;
  const problem = (kind: LintProblemKind, message: string): void => {
    ctx.problems.push({ voice: id, kind, message });
  };

  // Clips: exactly `voice/<id>/<group>/<name>.mp3`, the way the engine's
  // pool pattern and deck-core's usable-clip gate both read them.
  const usableClip = new RegExp(`^${escapeRegExp(prefix)}[^/]+/[^/]+\\${MP3}$`);
  const own = ctx.clips.filter((clip) => clip.startsWith(prefix));
  const usable = own.filter((clip) => usableClip.test(clip));

  for (const clip of own.filter((clip) => !usableClip.test(clip)).sort()) {
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
  // it — the same `length` comparison, so the two agree on the boundary.
  if (read.text.length > VOICE_SCRIPT_MAX_BYTES) {
    problem(
      "script",
      `${scriptPath} is larger than ${VOICE_SCRIPT_MAX_BYTES} bytes — the plugin refuses it unread and drops the voice`,
    );

    return brokenScript;
  }

  const parsed = parseCalloutScriptText(read.text);

  if (!parsed.ok) {
    for (const reason of parsed.problems) problem("script", `${scriptPath} — ${reason}`);

    return brokenScript;
  }

  const compiled = compileVoiceScript(parsed.script, ctx.deps);

  for (const skip of [...compiled.skipped].filter((s) => !s.deliberate).sort((a, b) => compare(a.id, b.id))) {
    problem("callout", `"${skip.id}" is skipped — ${skip.reason}`);
  }

  for (const [name, reason] of sortedEntries(compiled.failedFrames)) {
    problem("frame", `"${name}" does not compile — ${reason} — every callout framed by it is skipped`);
  }

  for (const [name, reason] of sortedEntries(compiled.fragmentProblems)) {
    problem("fragment", `"${name}" does not compile — ${reason}`);
  }

  reportCoverage(parsed.script, authored, prefix, ctx.varDriven, problem);

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
  varDriven: VarDrivenGroup,
  problem: (kind: LintProblemKind, message: string) => void,
): void {
  const coverage = checkCoverage({ script, authored }, varDriven);

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

  for (const path of coverage.unrecognisedLiterals) {
    problem(
      "dangling",
      `literal "${path}" cannot be checked against the pack — spell a clip as pool:<group>/<base> or voice/{voice}/<group>/<name>${MP3}`,
    );
  }

  for (const base of coverage.orphans) {
    problem(
      "orphan",
      `"${base}" is shipped as ${prefix}${base}*${MP3} but nothing in the script references it — it never plays`,
    );
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
