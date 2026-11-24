/**
 * Replays every Bash and PowerShell command recorded in Claude Code session
 * transcripts through `checkBash` of a base revision and of a checkout, with
 * one fixed context, and reports each command whose verdict differs (#1659,
 * Decision 3 of `docs/superpowers/specs/2026-11-24-issue-1659-*.md`). It also
 * prints the form census the lexer's stopping rule is measured by: how the
 * lexer read each command's program words, and which of its doubt flags each
 * command raised, split into real commands and the hooks' own QA probes.
 *
 *   node scripts/claude-hooks/replay-corpus.mjs --transcripts <dir>
 *     [--match <substring>] [--base <git ref>] [--show-commands]
 *     [--census-only] [--head-dir <dir>]
 *
 * A developer tool that no test runs over real data, because the transcripts
 * are private to the machine. It prints to stdout and writes nothing but a
 * copy of the base's `scripts/` in a fresh directory under the OS temp
 * directory, removed when it ends. While it judges, spawning a process or
 * writing a file throws, so a rule that reaches past `ctx` shows as a THROW
 * verdict on that side rather than running anything.
 *
 * That guard is no sandbox (USAGE): `--base` and `--head-dir` must name
 * trusted code, since both sides are imported, their top level unguarded,
 * and run in this process.
 *
 * Both sides judge with one context, whose `cwd` and package manifests are
 * the head checkout's (`--head-dir`, or this one).
 *
 * Exit status: 0 when every pair gave the same completed verdict, 1 when one
 * differs, 2 on a usage error, 3 when the run could not be made (the base
 * unreadable, a module that does not load, a corpus or manifest it cannot
 * read) or a comparison skipped a transcript record that did not parse, so
 * compared part of the corpus, 4 when a
 * comparison judged no command at all (a `--match` naming no folder), which
 * proves nothing, 5 when none differs but both sides threw alike on some
 * command, which compares nothing there (USAGE, {@link exitStatus}).
 */
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** The checkout this file lives in: the default head side and the base's repository. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
/** Where `checkBash` and `view` live, relative to a checkout or a copy of one. */
const RULES = "scripts/claude-hooks/rules-bash.mjs";
const LEXER = "scripts/claude-hooks/shell-lexer.mjs";
/** How much of a command `--show-commands` prints. */
const COMMAND_CUT = 2000;

export const USAGE = `Usage: node scripts/claude-hooks/replay-corpus.mjs --transcripts <dir> [options]

  --transcripts <dir>   read every *.jsonl under <dir>, recursively (required)
  --match <substring>   only the files whose path under <dir> contains it
  --base <git ref>      the revision whose checkBash is the base side (default origin/master)
  --head-dir <dir>      the checkout whose scripts/ is the head side, and whose cwd and
                        package manifests both sides judge with (default: this one)
  --census-only         print the census, judge nothing
  --show-commands       print each differing command's text and its verdicts' full text
                        (otherwise only each verdict's kind)
  --help                print this

--base and --head-dir must name trusted code: both sides' scripts are imported and
run in this process. The guard that makes a spawn or file write throw while judging
is not a sandbox: it replaces the fs and child_process exports, not the methods of a
FileHandle already open, and each side's modules are imported before the guard is
installed, so their top-level code runs unguarded.

Exit status:
  0  every pair gave the same completed verdict
  1  a verdict differs
  2  a usage error
  3  the run could not be made, or a comparison skipped a transcript record that did not parse
  4  a comparison judged no command (no commands judged)
  5  none differs, but both sides threw alike on some command`;

// ---------------------------------------------------------------------------
// Reading the transcripts

/**
 * The Bash and PowerShell commands one transcript line records, as `{ tool,
 * command }`: each `tool_use` entry of its `message.content`. A blank line,
 * or a record that holds no such entry, gives none; an entry whose `command`
 * is not a string is skipped. Returns `null` for a nonblank line that does
 * not parse, so the caller can count it: a record cut off before its tool use
 * is named is one too (CLI check of 8086892f8).
 */
export function extractCommands(line) {
  if (!line.trim()) return [];
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (c?.type !== "tool_use" || (c.name !== "Bash" && c.name !== "PowerShell")) continue;
    const command = c.input?.command;
    if (typeof command === "string") out.push({ tool: c.name, command });
  }
  return out;
}

/** Distinct `{ tool, command }` pairs in first-seen order: the same text typed in both tools counts twice. */
export class CommandSet {
  #seen = new Map();

  /** Adds `entry`; true when it was new. */
  add({ tool, command }) {
    const key = `${tool}\u0000${command}`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, { tool, command });
    return true;
  }

  get size() {
    return this.#seen.size;
  }

  list() {
    return [...this.#seen.values()];
  }
}

/** Every `*.jsonl` under `dir`, sorted, whose path under `dir` contains `match`; symlinks are not followed. */
export function transcriptFiles(dir, match) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(dir);
  const under = (p) => path.relative(dir, p).split(path.sep).join("/");
  return files.filter((p) => !match || under(p).includes(match)).sort();
}

/** Streams every file into a {@link CommandSet}; `{ commands, unparsed }`, the second counting nonblank lines that were not JSON. */
export async function readCommands(files) {
  const commands = new CommandSet();
  let unparsed = 0;
  const record = (line) => {
    const found = extractCommands(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (found === null) unparsed++;
    else for (const entry of found) commands.add(entry);
  };
  for (const file of files) {
    // Records end at LF (CRLF accepted) only: readline would also split on
    // U+2028 and U+2029, which JSON writes literally inside a string (PR #1798 review).
    let rest = "";
    for await (const chunk of createReadStream(file, "utf8")) {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const line of lines) record(line);
    }
    if (rest) record(rest);
  }
  return { commands, unparsed };
}

// ---------------------------------------------------------------------------
// Probes

/**
 * The marks of a command typed to probe the hooks, by their QA agents and
 * reviewers rather than in the course of work (the spec's Evidence section).
 * Hand-written and deliberately loose: the census reports both columns, so a
 * real command miscounted as a probe stays visible.
 */
export const PROBE_PATTERNS = Object.freeze([
  { name: "a PR number of 99999 or more", test: (c) => prNumbers(c).some((n) => n >= 99999) },
  { name: "a stubcheck stub", test: (c) => /stubcheck/i.test(c) },
  { name: "an exported bash function", test: (c) => /BASH_FUNC_/.test(c) },
  { name: "the integration tree", test: (c) => /\bir-integration\b/.test(c) },
  { name: "the dev:voices script", test: (c) => /\bdev:voices\b/.test(c) },
  { name: "a \\x escape", test: (c) => /\\x[0-9a-fA-F]{2}/.test(c) },
  { name: "a hook module named", test: (c) => /claude-hooks|shell-lexer|pre-bash|rules-bash/.test(c) },
  { name: "a probe placeholder", test: (c) => /zz-probe|qa-nonexistent/.test(c) },
]);

/** The numbers a command gives as a PR: after `pr <verb>`, or in a `pull/` or `pulls/` path. */
function prNumbers(command) {
  const out = [];
  for (const m of command.matchAll(/\bpr\s+[a-z-]+\b[^;&|\n]*?#?\b(\d{5,})\b|\bpulls?\/(\d+)\b/gi))
    out.push(Number(m[1] ?? m[2]));
  return out;
}

/** The names of the {@link PROBE_PATTERNS} `command` matches. */
export const probeReasons = (command) => PROBE_PATTERNS.filter((p) => p.test(command)).map((p) => p.name);

/** Whether `command` was typed to probe the hooks ({@link PROBE_PATTERNS}). */
export const isProbe = (command) => probeReasons(command).length > 0;

// ---------------------------------------------------------------------------
// The fixed context

/** Every field `pre-bash.mjs` puts in `ctx`; `replay-corpus.test.mjs` holds the two lists together. */
export const CONTEXT_FIELDS = Object.freeze([
  "cwd",
  "shell",
  "branch",
  "staged",
  "modified",
  "mainRoot",
  "originFresh",
  "specFiles",
  "committedText",
  "toplevel",
  "untracked",
  "tracked",
  "issueLabels",
  "linkTargets",
  "scriptsAt",
  "workspaceDirs",
  "packages",
  "isInside",
  "prView",
  "replayRebase",
  "prChangedFiles",
  "requiredChecks",
  "baseChangedSince",
  "prComments",
]);

/** `lib.mjs`'s `isInside`, restated so the context imports neither side's modules. */
function isInside(candidate, parent) {
  const norm = (p) => {
    const s = path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  const c = norm(candidate);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep);
}

/** No package manifests: what {@link fixedContext} answers without a {@link readWorkspace} snapshot. */
export const NO_WORKSPACE = Object.freeze({ root: undefined, manifests: Object.freeze([]) });

/**
 * The package manifests of the checkout at `root` — its own and each
 * `packages/*` one — read once, before anything is judged: `{ root,
 * manifests }`, each `{ dir, name, scripts }`, or `{ dir, broken: true }` for
 * one that does not parse. {@link fixedContext} answers the workspace reads
 * from it, so a `pnpm --filter <pkg>` reaches the rules after the one that
 * looks the package up, rather than stopping both sides at a false "no such
 * package". A folder with no manifest is no package; a manifest that exists
 * but cannot be read throws, naming it, since skipping it would make the same
 * false stop (CodeRabbit CLI on #1659).
 */
export function readWorkspace(root) {
  const manifests = [];
  const add = (dir) => {
    const file = path.join(dir, "package.json");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if (e?.code === "ENOENT") return;
      throw new Error(`could not read ${file}: ${e instanceof Error ? e.message : e}`, { cause: e });
    }
    try {
      const pkg = JSON.parse(text);
      manifests.push({ dir, name: pkg.name, scripts: { ...(pkg.scripts ?? {}) } });
    } catch {
      manifests.push({ dir, broken: true });
    }
  };
  add(root);
  // `packages/` listed itself: only a missing folder is no packages, and a
  // file in it (`README.md`) no package (CodeRabbit CLI round 2 on #1659).
  const packages = path.join(root, "packages");
  let entries = [];
  try {
    entries = readdirSync(packages, { withFileTypes: true });
  } catch (e) {
    if (e?.code !== "ENOENT")
      throw new Error(`could not list ${packages}: ${e instanceof Error ? e.message : e}`, { cause: e });
  }
  for (const d of entries
    .filter((x) => x.isDirectory())
    .map((x) => x.name)
    .sort())
    add(path.join(packages, d));
  return { root, manifests };
}

/**
 * The one context both sides judge every command with: `pre-bash.mjs`'s
 * shape, with every reader returning a fixed, harmless answer — the checkout
 * `cwd` on `master`, nothing staged, modified or untracked, no spec, no linked
 * deck host, the remote unreachable (so `origin/master` is neither fresh nor
 * stale), every gh read failing as `ghJson` fails (`undefined`) and every git
 * read as its reader fails (`{ ok: false }`). The package manifests are the
 * `workspace` snapshot ({@link readWorkspace}), none by default. Nothing
 * spawns or reads a file, and the same call always answers alike.
 *
 * A field it does not define throws when read, and so does an `in` test of
 * one: a rule that starts reading a new field must not see `undefined` on
 * both sides and agree by accident. It cannot be written to.
 */
export function fixedContext({ cwd, shell, workspace = NO_WORKSPACE }) {
  const failed = (what) => ({ ok: false, reason: `${what} is not read in a corpus replay` });
  const same = (a, b) => isInside(a, b) && isInside(b, a);
  // pre-bash's nearestManifest: the first package.json at or above `dir`, undefined when it does not parse.
  const scriptsAt = (dir) => {
    for (let d = path.resolve(dir); ; d = path.dirname(d)) {
      const m = workspace.manifests.find((x) => same(x.dir, d));
      if (m) return m.broken ? undefined : { dir: m.dir, name: m.name, scripts: { ...m.scripts } };
      if (path.dirname(d) === d) return undefined;
    }
  };
  // lib's workspacePackages: name to { dir, script names }, the root's included.
  const packages = () =>
    Object.fromEntries(
      workspace.manifests
        .filter((m) => !m.broken && m.name)
        .map((m) => [m.name, { dir: m.dir, scripts: Object.keys(m.scripts) }]),
    );
  // pre-bash's packageDirs: every packages/* directory holding a package.json.
  const workspaceDirs = (root) =>
    workspace.root !== undefined && same(root, workspace.root)
      ? workspace.manifests.filter((m) => !same(m.dir, workspace.root)).map((m) => m.dir)
      : [];
  const fields = {
    cwd,
    shell,
    branch: () => "master",
    staged: () => [],
    modified: () => [],
    mainRoot: () => cwd,
    originFresh: () => undefined,
    specFiles: () => [],
    committedText: () => undefined,
    toplevel: () => cwd,
    untracked: () => [],
    tracked: () => false,
    issueLabels: () => undefined,
    linkTargets: () => [],
    scriptsAt,
    workspaceDirs,
    packages,
    isInside,
    prView: () => undefined,
    replayRebase: () => failed("a rebase replay"),
    prChangedFiles: () => failed("a PR's changed files"),
    requiredChecks: () => failed("the required checks"),
    baseChangedSince: () => undefined,
    prComments: () => undefined,
  };
  const unknown = (key) =>
    new Error(
      `replay-corpus: checkBash read ctx.${String(key)}, which the fixed context does not define; add it to fixedContext and CONTEXT_FIELDS`,
    );
  const refuse = () => {
    throw new Error("replay-corpus: the fixed context is read-only");
  };
  return new Proxy(Object.freeze(fields), {
    get(target, key) {
      if (typeof key === "symbol" || Object.hasOwn(target, key)) return target[key];
      throw unknown(key);
    },
    has(target, key) {
      if (typeof key === "symbol" || Object.hasOwn(target, key)) return key in target;
      throw unknown(key);
    },
    set: refuse,
    defineProperty: refuse,
    deleteProperty: refuse,
  });
}

// ---------------------------------------------------------------------------
// Verdicts

/**
 * A verdict as one comparable string: `PASS` for none, `DENY: …` for a
 * refusal, `ASK: …` for a prompt, `OTHER: …` for anything else `checkBash`
 * returns. Two verdicts are the same exactly when these strings are.
 */
export function formatVerdict(v) {
  if (v === null || v === undefined) return "PASS";
  if (typeof v === "string") return `DENY: ${v}`;
  if (typeof v === "object" && typeof v.ask === "string" && Object.keys(v).length === 1) return `ASK: ${v.ask}`;
  return `OTHER: ${JSON.stringify(v)}`;
}

/**
 * `checkBash(command, ctx)` as {@link formatVerdict} prints it; a throw is a
 * verdict too, by its whole message, so two throws alike on their first line
 * only still differ (PR #1798 review at 0dced8c2f). Its newlines are escaped
 * only when printed ({@link cut}).
 */
export function verdictOf(checkBash, command, ctx) {
  try {
    return formatVerdict(checkBash(command, ctx));
  } catch (e) {
    return `THROW: ${messageOf(e)}`;
  }
}

/**
 * How the two sides' verdicts on one command compare (PR #1798 review):
 * `"identical"` for the same completed verdict, `"threw"` when both threw
 * alike, which completes no verdict and so is no agreement, `"different"`
 * for anything else, both sides throwing differently included.
 */
export function comparePair(base, head) {
  if (base !== head) return "different";
  return base.startsWith("THROW: ") ? "threw" : "identical";
}

/**
 * The tool's exit status for a comparison ({@link main}): 1 for a
 * difference, else 3 when a transcript record did not parse, so part of the
 * corpus went unjudged (CLI check of be3d79a4b), else 5 when both sides threw
 * on a command, else 0.
 */
export function exitStatus({ differences, threw, unparsed = 0 }) {
  if (differences) return 1;
  if (unparsed) return 3;
  return threw ? 5 : 0;
}

/** `text` on one line (newlines as `\n`), cut to `n` characters with an ellipsis. */
export function cut(text, n) {
  const one = text.replace(/\r?\n/g, "\\n");
  return one.length > n ? `${one.slice(0, n)}...` : one;
}

/**
 * The lines one difference prints; the command only when asked for. Each
 * says which {@link PROBE_PATTERNS} its command matched ({@link
 * probeReasons}), or that it is real, so the acceptance gate — no real
 * command changes its verdict — is applied by reading the names rather than
 * by trusting a loose heuristic (#1659 review). A verdict prints only its
 * kind ({@link verdictKind}) unless the commands are shown, since a deny's
 * text can quote a command's raw arguments (a refused PR title); the
 * comparison is still on the whole strings (CodeRabbit CLI on #1659).
 */
export function formatDifference(
  { index, tool, command, base, head },
  { showCommands = false, forms = NO_FORMS } = {},
) {
  const reasons = probeReasons(command);
  const kind = (v) => verdictKind(v, forms);
  // Shown, a verdict is printed whole, on one line (PR #1798 review).
  const shown = (v) => (showCommands ? cut(v, Infinity) : kind(v));
  const lines = [
    `#${index} ${tool}`,
    `  probe: ${reasons.length ? reasons.join("; ") : "real"}`,
    `  base: ${shown(base)}`,
    `  head: ${shown(head)}`,
  ];
  if (!showCommands && kind(base) === kind(head)) lines.push("  (same kind, different text)");
  if (showCommands) lines.splice(1, 0, `  command: ${cut(command, COMMAND_CUT)}`);
  return lines;
}

/** No form the stopping rule refuses: every deny prints as plain `DENY` ({@link verdictKind}). */
const NO_FORMS = Object.freeze(new Set());
/** The stopping rule's own deny, up to its form (`stoppingRefusal` in `rules-bash.mjs`). */
const STOPPING_DENY = "DENY: This command hands text to a shell in a form the hook does not read (";

/**
 * A verdict's kind as {@link formatVerdict} spells it — `PASS`, `ASK`,
 * `DENY`, `THROW` or `OTHER` — with the form for a stopping-rule deny: only
 * one that starts with that rule's own message and names a form in `forms`,
 * the sides' `REFUSED_FORMS`, so a deny that quotes the phrase, or a form
 * the hook did not write, prints as plain `DENY` (CodeRabbit CLI on #1659).
 */
export function verdictKind(v, forms = NO_FORMS) {
  const kind = /^[A-Z]+/.exec(v)?.[0] ?? "OTHER";
  if (kind !== "DENY" || !v.startsWith(STOPPING_DENY)) return kind;
  const form = v.slice(STOPPING_DENY.length, v.indexOf("): ", STOPPING_DENY.length));
  return forms.has(form) ? `${kind} (stopping rule: ${form})` : kind;
}

/** The count of `differences`, real commands apart from probes ({@link isProbe}). */
export function differenceSummary(differences) {
  const probes = differences.filter((d) => isProbe(d.command)).length;
  return `differing verdicts: ${differences.length} (real ${differences.length - probes}, probe ${probes})`;
}

// ---------------------------------------------------------------------------
// The census

/** The flags of a `view()` the census counts, each as a test of the view. */
const FLAGS = Object.freeze([
  ["unreadable", (v) => v.unreadable?.length > 0],
  ["respelled", (v) => v.respelled?.length > 0],
  ["spliced", (v) => v.spliced?.length > 0],
  ["unsettled", (v) => Boolean(v.unsettled)],
  ["unclosedLead", (v) => Boolean(v.unclosedLead)],
  // A form the lexer's stopping rule refuses rather than reads (#1659).
  ["refused", (v) => v.refused?.length > 0],
  ["!sure", (v) => !v.sure],
]);

/**
 * A program position's kind as the census names it, from the fifth element of
 * a `view().programs` entry: `command` for a word at command position,
 * `shell:<via>` for the first word a fed shell runs, `wrapper:<via>` for the
 * word a wrapper runs. A shell reading its script on stdin is refused since
 * #1659, so no position is read there.
 */
export function kindName(kind) {
  if (!kind || kind.how === "command") return "command";
  return `${kind.how}:${kind.via ?? "?"}`;
}

/**
 * The census of one transcript `command` typed to `tool`, read through a
 * side's `lexer` as `checkBash` reads it: a PowerShell command as bash, and
 * the `refused` flag from `refusedForms` with the command's shell, the hook's
 * own call, so PowerShell's `iex` counts where the hook refuses it
 * (CodeRabbit CLI on #1659). A lexer from before the stopping rule has no
 * `refusedForms`: its positions still count, with no `refused` flag, while one
 * whose export throws still throws (PR #1798 review at 0dced8c2f).
 */
export function commandCensus(lexer, tool, command) {
  const powershell = tool === "PowerShell";
  const shell = powershell ? lexer.POWERSHELL : lexer.BASH;
  const read = (c) => (powershell ? lexer.powershellAsBash(c) : c);
  const text = read(command);
  let refused = typeof lexer.refusedForms === "function" ? lexer.refusedForms(text, shell) : undefined;
  // A command `checkBash` judges twice for its curly quotes counts as refused
  // when either reading refuses it, once (CodeRabbit on 164de4f80).
  if (refused && !refused.length && lexer.readsCurlyTwice?.(command, powershell))
    refused = lexer.refusedForms(read(lexer.straightQuotes(command)), shell);
  return censusOf({ ...lexer.view(text), refused });
}

/** One command's census: `{ positions: Map<kind, count>, flags: string[] }`, from its `view()`. */
export function censusOf(v) {
  const positions = new Map();
  for (const p of v.programs ?? []) {
    const k = kindName(p[4]);
    positions.set(k, (positions.get(k) ?? 0) + 1);
  }
  return { positions, flags: FLAGS.filter(([, test]) => test(v)).map(([name]) => name) };
}

/** Running census totals: per row, commands and positions, real and probe. */
export class Census {
  rows = new Map();
  totals = { real: 0, probe: 0, threw: 0 };

  #row(key) {
    let r = this.rows.get(key);
    if (!r) this.rows.set(key, (r = { realCommands: 0, realPositions: 0, probeCommands: 0, probePositions: 0 }));
    return r;
  }

  /** Counts one command's {@link censusOf} result, or a view that threw (`census` null). */
  add(census, probe) {
    this.totals[probe ? "probe" : "real"]++;
    const side = probe ? "probe" : "real";
    if (!census) {
      this.totals.threw++;
      this.#row("view threw")[`${side}Commands`]++;
      return;
    }
    for (const [kind, n] of census.positions) {
      const r = this.#row(`program ${kind}`);
      r[`${side}Commands`]++;
      r[`${side}Positions`] += n;
    }
    for (const flag of census.flags) this.#row(`flag ${flag}`)[`${side}Commands`]++;
  }

  /** The census as a fixed-width table, rows sorted: positions are blank for a flag, which counts commands. */
  format() {
    const head = ["row", "real cmds", "real pos", "probe cmds", "probe pos"];
    const body = [...this.rows]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, r]) => {
        const positions = key.startsWith("program ");
        return [
          key,
          String(r.realCommands),
          positions ? String(r.realPositions) : "",
          String(r.probeCommands),
          positions ? String(r.probePositions) : "",
        ];
      });
    const width = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
    const line = (row) => row.map((c, i) => (i === 0 ? c.padEnd(width[i]) : c.padStart(width[i]))).join("  ");
    return [line(head), ...body.map(line)];
  }
}

// ---------------------------------------------------------------------------
// No side effects while judging

/**
 * The file writers of `fs`, each also on `fs.promises` but those marked
 * sync-only or `fs`-only: the content, folder and link writers, the ones
 * that change a file's mode, owner or times, and the write stream, which
 * would otherwise return and fail later on its own (PR #1798 review at
 * 0dced8c2f).
 */
const FS_WRITERS = Object.freeze({
  both: [
    "writeFile",
    "appendFile",
    "mkdir",
    "mkdtemp",
    "rm",
    "rmdir",
    "unlink",
    "rename",
    "copyFile",
    "cp",
    "symlink",
    "link",
    "truncate",
    "chmod",
    "chown",
    "lchown",
    "utimes",
    "lutimes",
  ],
  sync: [
    "writeFileSync",
    "appendFileSync",
    "mkdirSync",
    "mkdtempSync",
    "rmSync",
    "rmdirSync",
    "unlinkSync",
    "renameSync",
    "copyFileSync",
    "cpSync",
    "symlinkSync",
    "linkSync",
    "writeSync",
    "writevSync",
    "truncateSync",
    "ftruncateSync",
    "chmodSync",
    "fchmodSync",
    "chownSync",
    "fchownSync",
    "lchownSync",
    "utimesSync",
    "futimesSync",
    "lutimesSync",
  ],
  fsOnly: ["write", "writev", "ftruncate", "fchmod", "fchown", "futimes", "createWriteStream"],
});

/**
 * Whether the `flags` an `open` is given write: a string with `w`, `a` or `+`
 * (`"w"`, `"ax"`, `"r+"`), or a number with a write, create, truncate or
 * append bit. None — `open`'s default `"r"`, or a callback in their place —
 * reads.
 */
export function opensForWriting(flags, constants) {
  if (typeof flags === "number") {
    const { O_WRONLY = 0, O_RDWR = 0, O_CREAT = 0, O_TRUNC = 0, O_APPEND = 0 } = constants;
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  }
  return typeof flags === "string" && /[wa+]/.test(flags);
}

/**
 * Makes every process spawn and every file write throw until the returned
 * function is called, ESM bindings included (`syncBuiltinESMExports`): a rule
 * that reached past `ctx` would otherwise run git or gh, and differ by what
 * the machine answered. The writers are `fs`'s sync, callback, stream and
 * promise ones ({@link FS_WRITERS}), and an `open` whose flags write ({@link
 * opensForWriting}); an `open` for reading still works. So does a read, but
 * one given a flag that writes (`readFileSync(f, { flag: "w+" })`), which
 * Node 24 opens past `open` and truncates, throws (CodeRabbit on 164de4f80).
 */
export function forbidSideEffects() {
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  const refuse = (name) => () => {
    throw new Error(`replay-corpus: ${name} was called while judging`);
  };
  // An open passes through for reading and throws for writing.
  const opener = (name, open) =>
    function (path, flags, ...rest) {
      if (opensForWriting(flags, fs.constants))
        throw new Error(`replay-corpus: ${name} opened a file for writing while judging`);
      return open.call(this, path, flags, ...rest);
    };
  const targets = [
    [require("node:child_process"), "", ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]],
    [fs, "", [...FS_WRITERS.both, ...FS_WRITERS.sync, ...FS_WRITERS.fsOnly]],
    [fs.promises, "fs.promises.", FS_WRITERS.both],
  ];
  const saved = [];
  const replace = (mod, name, fn) => {
    saved.push([mod, name, mod[name]]);
    mod[name] = fn;
  };
  for (const [mod, prefix, names] of targets) for (const name of names) replace(mod, name, refuse(prefix + name));
  replace(fs, "openSync", opener("openSync", fs.openSync));
  replace(fs, "open", opener("open", fs.open));
  replace(fs.promises, "open", opener("fs.promises.open", fs.promises.open));
  // A read passes through unless its options name a flag that writes.
  const reader = (name, read, key) =>
    function (path, options, ...rest) {
      if (options && typeof options === "object" && opensForWriting(options[key], fs.constants))
        throw new Error(`replay-corpus: ${name} opened a file for writing while judging`);
      return read.call(this, path, options, ...rest);
    };
  replace(fs, "readFileSync", reader("readFileSync", fs.readFileSync, "flag"));
  replace(fs, "readFile", reader("readFile", fs.readFile, "flag"));
  replace(fs.promises, "readFile", reader("fs.promises.readFile", fs.promises.readFile, "flag"));
  replace(fs, "createReadStream", reader("createReadStream", fs.createReadStream, "flags"));
  syncBuiltinESMExports();
  return () => {
    for (const [mod, name, fn] of saved.reverse()) mod[name] = fn;
    syncBuiltinESMExports();
  };
}

// ---------------------------------------------------------------------------
// The base side

/** `git` in `cwd`, its stdout as a Buffer; throws with git's stderr on failure. */
function git(args, cwd, input) {
  const require = createRequire(import.meta.url);
  const r = require("node:child_process").spawnSync("git", args, {
    cwd,
    input,
    maxBuffer: 1 << 30,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

/**
 * Writes `ref`'s `scripts/` into a fresh directory under the OS temp
 * directory and returns `{ dir, sha }`: one tree listing and one
 * `cat-file --batch`, so no shell, `tar` or worktree is involved.
 */
export function extractScripts(repo, ref) {
  const sha = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repo)
    .toString()
    .trim();
  const listing = git(["ls-tree", "-r", "-z", sha, "--", "scripts/"], repo).toString("utf8");
  const blobs = [];
  for (const entry of listing.split("\u0000")) {
    if (!entry) continue;
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (!m) throw new Error(`unexpected ls-tree entry: ${entry}`);
    if (m[2] === "blob") blobs.push({ sha: m[3], file: m[4] });
  }
  if (!blobs.length) throw new Error(`${ref} has no scripts/`);
  const out = git(["cat-file", "--batch"], repo, blobs.map((b) => `${b.sha}\n`).join(""));
  const dir = mkdtempSync(path.join(os.tmpdir(), "replay-corpus-"));
  try {
    let at = 0;
    for (const { sha: blob, file } of blobs) {
      const eol = out.indexOf(0x0a, at);
      const [got, type, size] = out.subarray(at, eol).toString().split(" ");
      if (got !== blob || type !== "blob") throw new Error(`cat-file answered ${got} ${type} for ${blob}`);
      const start = eol + 1;
      const end = start + Number(size);
      const target = path.resolve(dir, file);
      if (!target.startsWith(dir + path.sep)) throw new Error(`refusing a path outside the copy: ${file}`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, out.subarray(start, end));
      at = end + 1;
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { dir, sha };
}

/** A checkout's (or copy's) `checkBash` and lexer. */
async function loadSide(root) {
  const rules = await import(pathToFileURL(path.join(root, RULES)).href);
  const lexer = await import(pathToFileURL(path.join(root, LEXER)).href);
  if (typeof rules.checkBash !== "function") throw new Error(`${path.join(root, RULES)} exports no checkBash`);
  return { checkBash: rules.checkBash, view: lexer.view, powershellAsBash: lexer.powershellAsBash, lexer };
}

// ---------------------------------------------------------------------------
// The command line

/** The options of `argv`, or `{ error }` for a usage error. */
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        transcripts: { type: "string" },
        match: { type: "string" },
        base: { type: "string", default: "origin/master" },
        "head-dir": { type: "string" },
        "census-only": { type: "boolean", default: false },
        "show-commands": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch (e) {
    return { error: e.message };
  }
  if (parsed.help) return { help: true };
  if (!parsed.transcripts) return { error: "--transcripts <dir> is required" };
  if (!parsed.base) return { error: "--base needs a ref" };
  return {
    transcripts: parsed.transcripts,
    match: parsed.match,
    base: parsed.base,
    headDir: parsed["head-dir"],
    censusOnly: parsed["census-only"],
    showCommands: parsed["show-commands"],
  };
}

const isDirectory = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The tool: returns its exit status, printing through `print`. `root` is the
 * checkout whose manifests and directory the context answers with, the head
 * checkout by default, and
 * `onBaseCopy` hears the folder the base's copy is written to: a test may
 * point the one elsewhere and track the other (@internal).
 */
export async function main(argv, print = (line) => process.stdout.write(`${line}\n`), { root, onBaseCopy } = {}) {
  const opts = parseCli(argv);
  if (opts.help) {
    print(USAGE);
    return 0;
  }
  if (opts.error) {
    print(`replay-corpus: ${opts.error}\n\n${USAGE}`);
    return 2;
  }
  if (!isDirectory(opts.transcripts)) {
    print(`replay-corpus: --transcripts ${opts.transcripts} is not a directory\n\n${USAGE}`);
    return 2;
  }
  const headRoot = path.resolve(opts.headDir ?? REPO_ROOT);
  if (opts.headDir && !isDirectory(path.join(headRoot, "scripts", "claude-hooks"))) {
    print(`replay-corpus: --head-dir ${opts.headDir} holds no scripts/claude-hooks\n\n${USAGE}`);
    return 2;
  }
  // The context is the head checkout's, for both sides, unless the caller names one (CLI check of be3d79a4b).
  const contextRoot = root ?? headRoot;
  const started = Date.now();

  let files;
  let commands;
  let unparsed;
  try {
    files = transcriptFiles(opts.transcripts, opts.match);
    ({ commands, unparsed } = await readCommands(files));
  } catch (e) {
    // An unlistable folder or an unreadable file names its path (CodeRabbit CLI on #1659).
    print(`replay-corpus: could not read the transcripts: ${messageOf(e)}`);
    return 3;
  }
  const list = commands.list();

  // The base copy is removed whatever stops the run once it exists (CodeRabbit CLI on #1659).
  let base;
  try {
    let head;
    try {
      head = await loadSide(headRoot);
      if (!opts.censusOnly) {
        base = extractScripts(REPO_ROOT, opts.base);
        onBaseCopy?.(base.dir);
        Object.assign(base, await loadSide(base.dir));
      }
    } catch (e) {
      print(`replay-corpus: could not load a side: ${messageOf(e)}`);
      return 3;
    }
    let workspace;
    try {
      workspace = readWorkspace(contextRoot);
    } catch (e) {
      print(`replay-corpus: could not read the workspace: ${messageOf(e)}`);
      return 3;
    }

    const census = new Census();
    const differences = [];
    let judged = 0;
    let identical = 0;
    let threw = 0;
    const contexts = {
      Bash: fixedContext({ cwd: contextRoot, shell: head.lexer.BASH, workspace }),
      PowerShell: fixedContext({ cwd: contextRoot, shell: head.lexer.POWERSHELL, workspace }),
    };
    // The guard is restored only once installed.
    let restore;
    try {
      restore = forbidSideEffects();
      list.forEach(({ tool, command }, i) => {
        // What checkBash reads: a PowerShell command as bash (`checkBash`'s own first step).
        let one;
        try {
          one = commandCensus(head.lexer, tool, command);
        } catch {
          one = null;
        }
        census.add(one, isProbe(command));
        // pre-bash.mjs judges only a non-blank string, and hands it over raw.
        if (opts.censusOnly || !command.trim()) return;
        judged++;
        const ctx = contexts[tool];
        const b = verdictOf(base.checkBash, command, ctx);
        const h = verdictOf(head.checkBash, command, ctx);
        const pair = comparePair(b, h);
        if (pair === "identical") identical++;
        else if (pair === "threw") threw++;
        else differences.push({ index: i + 1, tool, command, base: b, head: h });
      });
    } finally {
      restore?.();
    }

    print(`transcripts read: ${files.length}`);
    print(`records not JSON: ${unparsed}`);
    print(`distinct commands: ${list.length} (real ${census.totals.real}, probe ${census.totals.probe})`);
    print(`head: ${headRoot}`);
    print(`context: cwd ${contextRoot}, ${workspace.manifests.length} package manifests`);
    if (!opts.censusOnly) {
      print(`base: ${opts.base} (${base.sha})`);
      // A comparison over nothing proves nothing (CodeRabbit CLI round 2 on #1659).
      if (!judged) {
        print("replay-corpus: no commands judged: check --transcripts and --match");
        return 4;
      }
      print(`commands judged: ${judged}`);
      print(`identical verdicts: ${identical}`);
      print(`both sides threw alike: ${threw}`);
      print(differenceSummary(differences));
      // The forms either side names, so a renamed form still prints as one.
      const forms = new Set([...(base.lexer.REFUSED_FORMS ?? []), ...(head.lexer.REFUSED_FORMS ?? [])]);
      for (const d of differences) for (const line of formatDifference(d, { ...opts, forms })) print(line);
      if (unparsed)
        print(
          `replay-corpus: ${unparsed} record${unparsed === 1 ? "" : "s"} did not parse, so the comparison is partial`,
        );
    }
    print("");
    print("census (program positions by kind; flags count commands):");
    for (const line of census.format()) print(line);
    print("");
    print(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return opts.censusOnly ? 0 : exitStatus({ differences: differences.length, threw, unparsed });
  } finally {
    if (base?.dir) rmSync(base.dir, { recursive: true, force: true });
  }
}

/** An error's message, or the thrown value as text. */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
