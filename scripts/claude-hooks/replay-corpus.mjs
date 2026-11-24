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
 * Exit status: 0 when every verdict is identical, 1 when one differs, 2 on a
 * usage error, 3 when the run could not be made (the base unreadable, a
 * module that does not load).
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
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** The checkout this file lives in: the default head side, the base's repository and the context's `cwd`. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
/** Where `checkBash` and `view` live, relative to a checkout or a copy of one. */
const RULES = "scripts/claude-hooks/rules-bash.mjs";
const LEXER = "scripts/claude-hooks/shell-lexer.mjs";
/** How much of a verdict a difference prints. */
const VERDICT_CUT = 300;
/** How much of a command `--show-commands` prints. */
const COMMAND_CUT = 2000;

export const USAGE = `Usage: node scripts/claude-hooks/replay-corpus.mjs --transcripts <dir> [options]

  --transcripts <dir>   read every *.jsonl under <dir>, recursively (required)
  --match <substring>   only the files whose path under <dir> contains it
  --base <git ref>      the revision whose checkBash is the base side (default origin/master)
  --head-dir <dir>      the checkout whose scripts/ is the head side (default: this one)
  --census-only         print the census, judge nothing
  --show-commands       print each differing command's text
  --help                print this`;

// ---------------------------------------------------------------------------
// Reading the transcripts

/**
 * The Bash and PowerShell commands one transcript line records, as `{ tool,
 * command }`: each `tool_use` entry of its `message.content`. A line that is
 * not JSON, or holds no such entry, gives none; an entry whose `command` is
 * not a string is skipped. Returns `null` for a line that mentions a tool use
 * but does not parse, so the caller can count it.
 */
export function extractCommands(line) {
  if (!line.includes("tool_use")) return [];
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

/** Streams every file into a {@link CommandSet}; `{ commands, unparsed }`, the second counting tool-use lines that were not JSON. */
export async function readCommands(files) {
  const commands = new CommandSet();
  let unparsed = 0;
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      const found = extractCommands(line);
      if (found === null) unparsed++;
      else for (const entry of found) commands.add(entry);
    }
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
 * package".
 */
export function readWorkspace(root) {
  const manifests = [];
  const add = (dir) => {
    let text;
    try {
      text = readFileSync(path.join(dir, "package.json"), "utf8");
    } catch {
      return;
    }
    try {
      const pkg = JSON.parse(text);
      manifests.push({ dir, name: pkg.name, scripts: { ...(pkg.scripts ?? {}) } });
    } catch {
      manifests.push({ dir, broken: true });
    }
  };
  add(root);
  const packages = path.join(root, "packages");
  if (isDirectory(packages)) for (const d of readdirSync(packages).sort()) add(path.join(packages, d));
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

/** `checkBash(command, ctx)` as {@link formatVerdict} prints it; a throw is a verdict too, by the first line of its message. */
export function verdictOf(checkBash, command, ctx) {
  try {
    return formatVerdict(checkBash(command, ctx));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return `THROW: ${message.split("\n", 1)[0]}`;
  }
}

/** `text` on one line (newlines as `\n`), cut to `n` characters with an ellipsis. */
export function cut(text, n) {
  const one = text.replace(/\r?\n/g, "\\n");
  return one.length > n ? `${one.slice(0, n)}...` : one;
}

/** The lines one difference prints; the command only when asked for. */
export function formatDifference({ index, tool, command, base, head }, { showCommands = false } = {}) {
  const lines = [`#${index} ${tool}`, `  base: ${cut(base, VERDICT_CUT)}`, `  head: ${cut(head, VERDICT_CUT)}`];
  if (showCommands) lines.splice(1, 0, `  command: ${cut(command, COMMAND_CUT)}`);
  return lines;
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
 * Makes every process spawn and the usual file writes throw until the
 * returned function is called, ESM bindings included
 * (`syncBuiltinESMExports`): a rule that reached past `ctx` would otherwise
 * run git or gh, and differ by what the machine answered.
 */
export function forbidSideEffects() {
  const require = createRequire(import.meta.url);
  const targets = [
    [require("node:child_process"), ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]],
    [
      require("node:fs"),
      [
        "writeFileSync",
        "appendFileSync",
        "mkdirSync",
        "rmSync",
        "rmdirSync",
        "unlinkSync",
        "renameSync",
        "copyFileSync",
      ],
    ],
  ];
  const saved = [];
  for (const [mod, names] of targets)
    for (const name of names) {
      saved.push([mod, name, mod[name]]);
      mod[name] = () => {
        throw new Error(`replay-corpus: ${name} was called while judging`);
      };
    }
  syncBuiltinESMExports();
  return () => {
    for (const [mod, name, fn] of saved) mod[name] = fn;
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

/** The tool: returns its exit status, printing through `print`. */
export async function main(argv, print = (line) => process.stdout.write(`${line}\n`)) {
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
  const started = Date.now();

  const files = transcriptFiles(opts.transcripts, opts.match);
  const { commands, unparsed } = await readCommands(files);
  const list = commands.list();

  let base;
  let head;
  try {
    head = await loadSide(headRoot);
    if (!opts.censusOnly) {
      base = extractScripts(REPO_ROOT, opts.base);
      try {
        Object.assign(base, await loadSide(base.dir));
      } catch (e) {
        rmSync(base.dir, { recursive: true, force: true });
        throw e;
      }
    }
  } catch (e) {
    print(`replay-corpus: could not load a side: ${e instanceof Error ? e.message : e}`);
    return 3;
  }

  const census = new Census();
  const differences = [];
  let judged = 0;
  let identical = 0;
  const workspace = readWorkspace(REPO_ROOT);
  const contexts = {
    Bash: fixedContext({ cwd: REPO_ROOT, shell: head.lexer.BASH, workspace }),
    PowerShell: fixedContext({ cwd: REPO_ROOT, shell: head.lexer.POWERSHELL, workspace }),
  };
  const restore = forbidSideEffects();
  try {
    list.forEach(({ tool, command }, i) => {
      // What checkBash reads: a PowerShell command as bash (`checkBash`'s own first step).
      let one;
      try {
        one = censusOf(head.view(tool === "PowerShell" ? head.powershellAsBash(command) : command));
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
      if (b === h) identical++;
      else differences.push({ index: i + 1, tool, command, base: b, head: h });
    });
  } finally {
    restore();
    if (base?.dir) rmSync(base.dir, { recursive: true, force: true });
  }

  print(`transcripts read: ${files.length}`);
  print(`tool-use lines not JSON: ${unparsed}`);
  print(`distinct commands: ${list.length} (real ${census.totals.real}, probe ${census.totals.probe})`);
  print(`head: ${headRoot}`);
  print(`context: cwd ${REPO_ROOT}, ${workspace.manifests.length} package manifests`);
  if (!opts.censusOnly) {
    print(`base: ${opts.base} (${base.sha})`);
    print(`commands judged: ${judged}`);
    print(`identical verdicts: ${identical}`);
    print(`differing verdicts: ${differences.length}`);
    for (const d of differences) for (const line of formatDifference(d, opts)) print(line);
  }
  print("");
  print("census (program positions by kind; flags count commands):");
  for (const line of census.format()) print(line);
  print("");
  print(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return differences.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
