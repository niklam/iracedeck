/**
 * The package-script interpreter behind the deck-host ask (#1520, #1526,
 * extracted in #1590): what a command line would run, followed through the
 * runners that start a package.json script — pnpm, npm and npx, turbo, `node`
 * and `node --run`, rollup's watch hooks — and the shells a command string is
 * handed to (bash and its kin, cmd.exe, PowerShell, `eval`), recursively to
 * {@link MAX_SCRIPT_DEPTH}. {@link deckFindings} is the entry point: every
 * reason the commands need Niklas's go, which the rule in `rules-bash.mjs`
 * turns into its ask.
 *
 * The deck vocabulary lives here rather than with the rule
 * ({@link DECK_ALWAYS}, {@link DECK_IF_LINKED}, {@link STREAMDECK_CLI},
 * {@link HOST_APP}, {@link NODE_ALWAYS}), because the readers already judge
 * while they read: a Stream Deck CLI verb reached through a runner comes back
 * `always` with its `why`, `node` on `integration-build.mjs` is a run only
 * with `--restart` or a flag it cannot read, `host-app.mjs` only for `start`
 * or `stop`, and `dev-voices.mjs` becomes the `dev:voices` it wraps. A
 * generic walker with an injected judge would leave half of that judgement in
 * each module, or rewrite those readers; this move changes no logic.
 *
 * Pure and context-injected, as the rules are: everything it reads from
 * outside arrives through `ctx` — the nearest package.json's name and scripts
 * at or above a directory (`ctx.scriptsAt`), the workspace's package
 * directories (`ctx.workspaceDirs`), a directory's git top level
 * (`ctx.toplevel`), path containment (`ctx.isInside`) and the deck hosts'
 * plugin links (`ctx.linkTargets`). It imports no `node:fs` or
 * `child_process`, and its lexing is `shell-lexer.mjs`'s.
 *
 * Whether its reach is worth its cost for one ask (#1590): yes as it stands,
 * and no further. Measured on 2026-11-02, it is some 850 lines here and 350
 * of the rules' tests (the deck-host rule's two describes). In this repo it
 * is needed for one script: the Stream Deck plugin package's `watch`, whose
 * `rollup --watch.onEnd` runs `streamdeck restart`, reached through
 * `pnpm -r watch`, `turbo run watch` or `pnpm watch` in that package, at a
 * depth of two. Every root script that touches a host is already caught by its
 * name. npm, npx, `node --run`, the four wrapper languages and the depth of 8
 * answer shapes the reviews of PR #1531 constructed — its `/code-review`
 * raised 9, its second read 3, and CodeRabbit's rounds added the nested
 * runners and the regex selectors — none of them seen in a session. That
 * reach stays because what it guards is what #1520 exists for, a host
 * restarted under Niklas's test, and its errors fall on the safe side: an
 * over-reach is one prompt, and a build, install or test reaches no finding.
 * Since #1590 its cost no longer sits in the module every other guard
 * shares. A new runner or wrapper is added when a real command has slipped
 * past, not because a review can construct one; were it to need another
 * round like #1531's, the better answer is to narrow it to the runners this
 * repo's scripts use.
 */
import { Buffer } from "node:buffer";

import {
  BASH,
  chainCommands,
  cmd,
  commandWords,
  matchesAt,
  POWERSHELL,
  powershellAsBash,
  resolveDir,
  shellWords,
  trustedMask,
} from "./shell-lexer.mjs";

/**
 * The deck-host ask (#1520, narrowed to restarts and relinks by #1526). A
 * restart, a relink, a stop or a start is reached through a runner — pnpm,
 * npm, npx, a bare turbo, `node` on a root script or `node --run`, the
 * `rollup` whose watch hooks run a command, and a shell handed a command
 * string (`bash -c`, `cmd /c`, `pwsh -Command`, `eval`) — each found at
 * command position and read by its own `read(tokens, base, shell)` into the
 * runs it makes: `{ label, script, dir }`, a script or turbo task and the
 * directory it runs in. `DECK_ALWAYS` are the scripts that restart, relink,
 * stop, start or watch-and-restart whatever tree they run in;
 * `DECK_IF_LINKED` is `dev:voices`, which relinks only the hosts already
 * linked to its tree, so it matters only where a host's link points. A build,
 * an install or a clean is on neither list: a host keeps the plugin it loaded
 * until it restarts. The Stream Deck CLI the `restart:` / `link:` scripts wrap
 * is caught too, and so is a `taskkill`, `start` or `Start-Process` /
 * `Stop-Process` naming a host app. A runner's name may carry the `.cmd` /
 * `.exe` / `.ps1` PowerShell resolves it to.
 *
 * The names are only the floor. A run marked `expand` — a pnpm or npm script,
 * `node --run`, a turbo task — is also judged by the command line it runs,
 * read from the package.json of every package it may run in with the
 * arguments it forwards appended ({@link deckFindings}, {@link
 * runManifests}), so a script nobody has listed yet is judged by what it
 * reaches; a run carrying `lines` — a rollup watch hook, a shell's command
 * string — is judged by those command lines, each read as the shell that runs
 * it reads it (`as`, {@link lineAs}).
 */
const BIN = String.raw`(?:\.(?:cmd|exe|ps1))?(?=\s|$)`;
const PNPM = cmd(new RegExp(`pnpm${BIN}`));
const NPM = cmd(new RegExp(`npm${BIN}`));
const NPX = cmd(new RegExp(`npx${BIN}`));
const TURBO = cmd(new RegExp(String.raw`(?:\S*[\\/])?turbo${BIN}`));
const NODE = cmd(new RegExp(`node${BIN}`));
const ROLLUP = cmd(new RegExp(String.raw`(?:\S*[\\/])?rollup${BIN}`));
/**
 * The shells, and the commands, that run a string they are handed: bash and
 * its kin, cmd.exe, Windows PowerShell and pwsh, any case and with a path or
 * `.exe`; bash's `eval` and PowerShell's `Invoke-Expression` / `iex`.
 */
const SH_NAME = String.raw`(?:\S*[\\/])?(?:ba|z|da|k|fi)?sh(?:\.exe)?`;
const CMD_NAME = String.raw`(?:\S*[\\/])?cmd(?:\.exe)?`;
const PS_NAME = String.raw`(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?`;
const EVAL_NAME = String.raw`eval|invoke-expression|iex`;
const WRAPPER = cmd(new RegExp(String.raw`(?:${SH_NAME}|${CMD_NAME}|${PS_NAME}|${EVAL_NAME})(?=\s|$)`, "i"));
const isSh = (t) => new RegExp(`^${SH_NAME}$`, "i").test(t);
const isCmdExe = (t) => new RegExp(`^${CMD_NAME}$`, "i").test(t);
const isPowerShell = (t) => new RegExp(`^${PS_NAME}$`, "i").test(t);
const isEval = (t) => new RegExp(`^(?:${EVAL_NAME})$`, "i").test(t);
const isWrapper = (t) => isSh(t) || isCmdExe(t) || isPowerShell(t) || isEval(t);
const DECK_ALWAYS =
  /^(?:build:with-restart|build:stream-deck|(?:re|un)?link:.+|restart:.+|watch:.+|start:.+|stop:.+|switch-test-env(?::.+)?)$/;
const DECK_IF_LINKED = /^dev:voices$/;
const STREAMDECK_VERBS = /^(?:restart|stop|link|unlink)$/;
const STREAMDECK_CLI = cmd(
  new RegExp(String.raw`(?:\S*[\\/])?streamdeck(?:\.(?:cmd|exe|ps1))?\s+(?:restart|stop|link|unlink)\b`),
);
/** What stops or starts a process; it asks when its arguments name a host app ({@link HOST_APP}). */
const HOST_CONTROL = cmd(new RegExp(String.raw`(?:taskkill|start|start-process|saps|stop-process|spps)${BIN}`, "i"));
/** The deck host apps (`scripts/lib/deck-hosts.mjs`, and Elgato's own). */
const HOST_APP = /\b(?:StreamDeck|StreamDock|UlanziDeck|Ulanzi ?Studio|VSD ?Craft)(?:\.exe)?\b/i;
/** How deep a script's expansion follows the scripts it runs; past it the name is all that is judged. */
const MAX_SCRIPT_DEPTH = 8;

/** pnpm options whose value is the next word; `-C` / `--dir` move the directory and `--filter` picks packages, read on their own. */
const PNPM_VALUE = new Set(["--reporter", "--loglevel", "--workspace-concurrency"]);
const PNPM_FILTER = new Set(["--filter", "-F", "--filter-prod"]);
/** pnpm's own commands, which never run a package.json script of that name. */
const PNPM_BUILTIN =
  /^(?:install|i|add|remove|rm|uninstall|un|update|up|upgrade|link|ln|unlink|import|rebuild|rb|prune|fetch|dedupe|patch|outdated|list|ls|why|audit|licenses|store|root|bin|config|setup|env|init|publish|pack|deploy|create|self-update|server|doctor|approve-builds|ignored-builds)$/;
/** pnpm's `recursive` command and its aliases, which run what follows in every workspace package. */
const PNPM_RECURSIVE = /^(?:recursive|multi|m)$/;

const binName = (tool) => new RegExp(String.raw`^(?:\S*[\\/])?${tool}(?:@\S*)?(?:\.(?:cmd|exe|ps1))?$`);
/** Whether a word names the turbo binary: `turbo`, `turbo@2.5.0`, `node_modules/.bin/turbo.cmd`. */
const isTurbo = (t) => binName("turbo").test(t);
const isStreamdeck = (t) => binName("streamdeck").test(t) || /^@elgato\/cli(?:@\S*)?$/.test(t);
const isRollup = (t) => binName("rollup").test(t);
const isNode = (t) => binName("node").test(t);
/** The package runners themselves, which an `exec` / `dlx` / `npx` may run in turn. */
const isPnpm = (t) => binName("pnpm").test(t);
const isNpm = (t) => binName("npm").test(t);
const isNpx = (t) => binName("npx").test(t);
/**
 * The binaries a `pnpm <bin>`, `pnpm exec` / `dlx`, `npx` or `npm exec` may
 * run that this rule reads; a bare `pnpm <bin>` with no script of that name
 * runs the binary, as `pnpm exec` does.
 */
const isBinTool = (t) => isTurbo(t) || isStreamdeck(t) || isRollup(t) || isNode(t) || isWrapper(t);

/** The arguments a runner hands its script: what follows the script's name, less the `--` that separates them. */
function forwarded(tokens) {
  const at = tokens.indexOf("--");
  return at < 0 ? tokens : [...tokens.slice(0, at), ...tokens.slice(at + 1)];
}

/**
 * The scripts or tasks a pnpm invocation runs — past its global options, an
 * optional `recursive` and an optional `run` — in `base` moved by `-C` /
 * `--dir` (attached or not). A `pnpm turbo …`, `pnpm exec turbo …` or
 * `pnpm dlx turbo …` runs turbo's tasks there ({@link turboRuns}), and the
 * Stream Deck CLI, `rollup`, `node` or a shell likewise. `[]` when it runs
 * nothing (`pnpm --version`). A script is expanded unless it is one of pnpm's
 * own commands, read from the packages its selectors pick ({@link pnpmPicks}),
 * and what follows its name is appended to its command line, as pnpm does.
 *
 * pnpm reads its options anywhere ahead of the command, a cluster of short
 * ones (`-rc`) among them, and its `recursive` word after a `-r` too (#1526
 * second read: `pnpm -r recursive watch` read `recursive` as the script). A
 * `-c` / `--shell-mode` there puts `exec` in shell mode, as it does after
 * `exec` ({@link binRuns}), and so does a script name pnpm finds no script
 * for, which it runs as `exec` would: such a run is also judged as the command
 * line its words make.
 */
function pnpmRuns(tokens, base, shell) {
  let dir = base;
  let runSeen = false;
  let recursive = false;
  let recursiveWord = false;
  let workspaceRoot = false;
  let shellMode = false;
  const filters = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const attached = t.match(/^(?:--dir=|-C)(.+)$/);
    const filter = t.match(/^(?:--filter=|--filter-prod=|-F)(.+)$/);
    if (attached) dir = resolveDir(base, attached[1], { shell });
    else if (t === "-C" || t === "--dir") dir = tokens[i + 1] ? resolveDir(base, tokens[++i], { shell }) : dir;
    else if (filter) filters.push(filter[1]);
    else if (PNPM_FILTER.has(t)) {
      if (tokens[i + 1]) filters.push(tokens[++i]);
    } else if (PNPM_VALUE.has(t)) i++;
    else if (t === "-r" || t === "--recursive") recursive = true;
    else if (t === "-w" || t === "--workspace-root") workspaceRoot = true;
    else if (t === "-c" || t === "--shell-mode") shellMode = true;
    else if (/^-[a-z]{2,}$/.test(t)) {
      recursive ||= t.includes("r");
      workspaceRoot ||= t.includes("w");
      shellMode ||= t.includes("c");
    } else if (t.startsWith("-")) continue;
    else if (PNPM_RECURSIVE.test(t) && !runSeen && !recursiveWord) recursive = recursiveWord = true;
    else if ((t === "run" || t === "run-script") && !runSeen) runSeen = true;
    else if (isBinTool(t) && !runSeen) return binRuns(tokens.slice(i), dir, shell, shellMode);
    else if ((t === "exec" || t === "dlx") && !runSeen) return binRuns(tokens.slice(i + 1), dir, shell, shellMode);
    else {
      const run = {
        label: `pnpm ${t}`,
        script: t,
        dir,
        expand: runSeen || !PNPM_BUILTIN.test(t),
        picks: pnpmPicks({ filters, recursive, workspaceRoot }, dir, shell),
        args: forwarded(tokens.slice(i + 1)),
        selector: SCRIPT_SELECTOR.test(t),
      };
      const fallback = shellMode && !runSeen && !PNPM_BUILTIN.test(t);
      return fallback ? [run, ...binRuns(tokens.slice(i), dir, shell, true)] : [run];
    }
  }
  return [];
}

/**
 * Which packages a pnpm script is read from (#1526 review), as picks for
 * {@link runManifests}; `undefined` for the nearest package.json, which is
 * pnpm's own choice when nothing selects. A `--filter` pnpm resolves by name
 * or by path is resolved the same way; one the hook cannot resolve — a
 * dependency (`foo...`, `...foo`, `^`) or changed-since (`[ref]`) query, a
 * glob path, anything else — picks every package, and so does `-r` or a
 * filter list that only excludes (`!foo`), whose exclusions are not
 * subtracted. Over-reach, never a miss: until #1526's review such a run was
 * judged by its name alone, and the Stream Deck plugin's `watch` restarted
 * the host unprompted through `pnpm -r watch`. `-w` reads the root's script.
 * A filter's path is read from `dir`, which a `-C` anywhere sets.
 */
function pnpmPicks({ filters, recursive, workspaceRoot }, dir, shell) {
  const picks = [];
  if (workspaceRoot) picks.push({ root: true });
  const included = filters.filter((f) => !f.startsWith("!"));
  for (const f of included) picks.push(pnpmFilter(f, dir, shell));
  if ((recursive && !filters.length) || (filters.length && !included.length)) picks.push({ every: true });
  return picks.length ? picks : undefined;
}

/**
 * One pnpm `--filter` as a pick: `{ path }` for a location (`.`, `./…`,
 * `../…`, `{…}`), which pnpm reads as every package at or under it; `{ name }`
 * for a name pattern, `*` its one wildcard; `{ every }` for anything the hook
 * cannot resolve.
 */
function pnpmFilter(f, dir, shell) {
  if (/\.\.\.|\^|\[/.test(f)) return { every: true };
  const braced = f.match(/^\{([^{}]+)\}$/);
  const location = braced ? braced[1] : /^\.\.?(?:[\\/]|$)/.test(f) ? f : undefined;
  if (location !== undefined)
    return /[*?{}]/.test(location) ? { every: true } : { path: resolveDir(dir, location, { shell }) };
  return /^(?:@[\w.*-]+\/)?[\w.*-]+$/.test(f) ? { name: f } : { every: true };
}

/** npm options whose value is the next word; `--prefix` / `-C` move the directory and `-w` / `--workspace` picks packages, read on their own. */
const NPM_VALUE = new Set(["--loglevel", "--cache", "--userconfig", "--registry"]);
/** `npm exec`, `npx`, `pnpm exec` and `pnpm dlx` options whose value is the next word. */
const BIN_VALUE = new Set(["-p", "--package", "-w", "--workspace"]);

/**
 * What an npm invocation runs: a script (`npm run <s>`, `run-script`) or a
 * binary through `npm exec`; an install builds nothing a host has loaded
 * (#1526). The directory is `base` moved by `--prefix` / `-C`, which npm
 * reads anywhere before `--`. A script is expanded, with every word after its
 * name appended — npm hands the script only those after `--`, so this
 * over-reaches rather than misses — and read from the workspaces a `-w` /
 * `--workspace` names, by name or by path, or from every package for
 * `--workspaces` / `-ws` (#1526 review), the root's included, since
 * `include-workspace-root` may be set where the hook does not read it.
 *
 * `--call` / `-c` is a config flag like the rest, read anywhere before `--`,
 * and takes a value — the next word or `--call=…` (#1526 second read: `npm
 * --call "pnpm restart:stream-deck" exec` read the line as the verb). An
 * `exec` it comes ahead of runs that line in a shell; one after `exec` is the
 * exec's own option, read there ({@link binRuns}).
 */
function npmRuns(tokens, base, shell) {
  const end = tokens.indexOf("--") < 0 ? tokens.length : tokens.indexOf("--");
  let dir = base;
  const picks = [];
  let withRoot = false;
  const positional = [];
  const calls = [];
  for (let i = 0; i < end; i++) {
    const t = tokens[i];
    const attached = t.match(/^--prefix=(.+)$/);
    const workspace = t.match(/^--workspace=(.+)$/);
    const callValue = t.match(/^--call=([\s\S]*)$/);
    if (callValue) calls.push({ at: i, line: callValue[1] });
    else if (t === "--call" || t === "-c") {
      if (i + 1 < end) calls.push({ at: i, line: tokens[++i] });
    } else if (attached) dir = resolveDir(base, attached[1], { shell });
    else if (t === "--prefix" || t === "-C") dir = tokens[i + 1] ? resolveDir(base, tokens[++i], { shell }) : dir;
    else if (workspace) picks.push({ workspace: workspace[1], shell });
    else if (t === "-w" || t === "--workspace") {
      if (tokens[i + 1]) picks.push({ workspace: tokens[++i], shell });
    } else if (NPM_VALUE.has(t)) i++;
    else if (/^(?:--workspaces(?:=(?!false$).*)?|-ws)$/.test(t)) picks.push({ every: true });
    else if (t === "--include-workspace-root") withRoot = true;
    else if (!t.startsWith("-")) positional.push(i);
  }
  if (withRoot && picks.length) picks.push({ root: true });
  if (!positional.length) return [];
  const verb = tokens[positional[0]];
  if (/^(?:run|run-script|rum|urn)$/.test(verb)) {
    const script = tokens[positional[1]];
    const args = forwarded(tokens.slice(positional[1] + 1));
    const run = {
      label: `npm run ${script}`,
      script,
      dir,
      expand: true,
      picks: picks.length ? picks : undefined,
      args,
    };
    return script ? [run] : [];
  }
  if (!/^(?:exec|x)$/.test(verb)) return [];
  const ahead = calls.filter((c) => c.at < positional[0]);
  return [
    ...ahead.flatMap((c) => shellModeLine("npm --call", [c.line], dir)),
    ...binRuns(tokens.slice(positional[0] + 1), dir, shell),
  ];
}

/**
 * The binary an `exec` / `dlx` / `npx` runs, past its own options and a `--`:
 * turbo's tasks when it is turbo, the Stream Deck CLI's verb, rollup's watch
 * hooks, what `node` runs ({@link nodeRuns}, #1526 review), a shell's command
 * string ({@link wrapperRuns}), what a nested `pnpm`, `npm` or `npx` runs, read
 * by its own reader (#1526 PR review), nothing otherwise — a command is judged by the
 * tool that runs it, and a `tsc` or `prettier` restarts nothing. `-c` /
 * `--call` (npm, npx) and `--shell-mode` (pnpm, whose `-c` is the same), alone
 * or in a cluster of short options, run a command line in a shell instead of a
 * binary: npm takes it as the next word, pnpm as every word after the flag, so
 * the line is all of them, which over-reaches for npm rather than misses for
 * pnpm. `shellMode` is that flag met earlier — pnpm's ahead of `exec`
 * ({@link pnpmRuns}) — and makes the line of every word here. Either way the
 * line starts past a `--` and the exec options ahead of the command
 * ({@link shellModeLine}), which pnpm does not hand the shell.
 */
function binRuns(tokens, dir, shell, shellMode = false) {
  if (shellMode) return shellModeLine("exec --shell-mode", tokens, dir);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const call = t.match(/^(?:-c|--call|--shell-mode)(?:=([\s\S]*))?$/);
    if (call) return shellModeLine(`exec ${t.replace(/=[\s\S]*$/, "")}`, [call[1] ?? "", ...tokens.slice(i + 1)], dir);
    if (/^-[a-z]{2,}$/.test(t) && t.includes("c")) return shellModeLine(`exec ${t}`, tokens.slice(i + 1), dir);
    if (BIN_VALUE.has(t)) i++;
    else if (t === "--" || t.startsWith("-")) continue;
    else if (isTurbo(t)) return turboRuns(tokens.slice(i + 1), dir, shell);
    else if (isStreamdeck(t)) return streamdeckRuns(tokens.slice(i + 1), dir);
    else if (isRollup(t)) return rollupRuns(tokens.slice(i + 1), dir);
    else if (isNode(t)) return nodeRuns(tokens.slice(i + 1), dir, shell);
    else if (isWrapper(t)) return wrapperRuns(tokens.slice(i), dir, shell);
    else if (isPnpm(t)) return pnpmRuns(tokens.slice(i + 1), dir, shell);
    else if (isNpm(t)) return npmRuns(tokens.slice(i + 1), dir, shell);
    else if (isNpx(t)) return binRuns(tokens.slice(i + 1), dir, shell);
    else return [];
  }
  return [];
}

/** The exec options whose value is the next word, skipped with it ahead of a shell-mode line ({@link shellModeLine}). */
const SHELL_MODE_VALUE = new Set([...BIN_VALUE, ...PNPM_VALUE, ...PNPM_FILTER, "--resume-from"]);

/**
 * The command line a shell-mode exec runs: its words joined, past a leading
 * `--`. When options lead — pnpm's `exec --parallel -c …`, which pnpm reads as
 * its own — the line past them, values and a `--` included, is judged too:
 * both are, so a word mistaken for an option over-reaches rather than hides
 * the command (#1526 second read).
 */
function shellModeLine(label, words, dir) {
  const all = words.filter((w) => w !== "");
  const rest = all[0] === "--" ? all.slice(1) : all;
  let at = 0;
  while (at < rest.length && /^-\S*$/.test(rest[at])) at += SHELL_MODE_VALUE.has(rest[at]) ? 2 : 1;
  const lines = [...new Set([rest, rest.slice(at)].map((w) => w.join(" ")))].filter((l) => l.trim());
  return lines.length ? [{ label, dir, lines }] : [];
}

/** The Stream Deck CLI's `restart`, `stop`, `link` and `unlink`, reached through a runner rather than at command position. */
function streamdeckRuns(tokens, dir) {
  const verb = tokens.find((t) => !t.startsWith("-"));
  return verb && STREAMDECK_VERBS.test(verb)
    ? [{ label: `streamdeck ${verb}`, script: verb, dir, always: true, why: "restarts or relinks a deck host" }]
    : [];
}

/**
 * rollup's watch hooks (#1526), each a command line rollup runs at that point
 * of a watch — the Stream Deck plugin's `watch` restarts the host on every
 * rebuild through `--watch.onEnd="streamdeck restart …"`. The value is
 * attached with `=` or the next word, and is judged as a command run in `dir`.
 * Matched in any case and with rollup's kebab spelling too, so a spelling
 * rollup may accept is read rather than missed.
 */
const ROLLUP_HOOK = /^(--watch\.on-?(?:start|bundle-?start|bundle-?end|end|error))(?:=([\s\S]*))?$/i;

function rollupRuns(tokens, dir) {
  const runs = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i].match(ROLLUP_HOOK);
    if (!m) continue;
    const line = m[2] ?? tokens[++i];
    if (line) runs.push({ label: `rollup ${m[1]}`, dir, lines: [line] });
  }
  return runs;
}

/** turbo options whose value is the next word; `--cwd` moves the directory and is read on its own. */
const TURBO_VALUE = new Set([
  "--filter",
  "-F",
  "--concurrency",
  "--cache-dir",
  "--log-order",
  "--output-logs",
  "--env-mode",
  "--ui",
  "--cache",
  "--log-prefix",
  "--graph",
  "--summarize",
  "--profile",
]);

/**
 * The tasks a turbo invocation runs — `turbo run <tasks>`, `turbo watch <tasks>`
 * or the `turbo <tasks>` shorthand — in `dir` moved by `--cwd`. A subcommand
 * that is no task (`prune`, `ls`, `login`) is read as one and matches no rule.
 * Each task is expanded into every workspace package's script of that name,
 * with what follows a `--` appended, as turbo hands it to every task: a
 * `--filter` is not read, so the expansion over-reaches rather than misses.
 */
function turboRuns(tokens, dir, shell) {
  let at = dir;
  const positional = [];
  let args = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      args = tokens.slice(i + 1);
      break;
    }
    const attached = t.match(/^--cwd=(.+)$/);
    if (attached) at = resolveDir(dir, attached[1], { shell });
    else if (t === "--cwd") at = tokens[i + 1] ? resolveDir(dir, tokens[++i], { shell }) : at;
    else if (TURBO_VALUE.has(t)) i++;
    else if (!t.startsWith("-")) positional.push(t);
  }
  const tasks = /^(?:run|watch)$/.test(positional[0] ?? "") ? positional.slice(1) : positional;
  return tasks.map((task) => ({ label: `turbo run ${task}`, script: task, dir: at, expand: true, turbo: true, args }));
}

/**
 * The root scripts a pnpm script wraps, run through `node` (#1520): the ones
 * that restart, relink, stop or start a host always ask, as their pnpm scripts
 * do. `integration-build` asks only with `--restart` ahead of any `--` (#1526):
 * without it the build leaves every host running the plugin it loaded, and
 * with it the hosts linked to its tree are stopped and started; it is a strict
 * `parseArgs` boolean, so `--restart` is the one spelling — and so a word
 * ahead of the `--` that the shell computes (`$R`, `$(…)`, a backtick,
 * cmd.exe's `%R%`) may be it, and asks too (#1526 review). So does one the
 * shell rewrites (#1526 second read): a word that is `--restart` once its
 * escapes are gone ({@link unescaped}: a `\` left inside double quotes, which
 * a PowerShell backtick escape arrives as, or cmd.exe's `^`), a bash brace
 * expansion or glob, and a PowerShell splat (`@a`, `@(…)`). None of these
 * characters can be in a branch name (`git check-ref-format`), so a branch
 * that merely holds the word `restart` still passes. `dev-voices`
 * rebuilds and relinks the hosts already linked to its own tree, so it asks
 * where linked, and both the cwd and the script's own tree are judged.
 * `node --run <script>` runs a package.json script, judged as `pnpm <script>` is.
 */
const NODE_ALWAYS = /^(?:build-with-restart|(?:un)?link-(?:mirabox|ulanzi))$/;
/**
 * A word holding an expansion the hook cannot evaluate, {@link UNREAD} among
 * them: a variable, a substitution, cmd.exe's `%R%`, a brace expansion
 * (`--{restart,}`, `{a..b}`) or a glob (`*`, `?`, `[`).
 */
const COMPUTED = /[$\x60*?[]|%[^%\s]+%|\{[^{}]*(?:,|\.\.)[^{}]*\}/;
/** A PowerShell splat, `@name` or an array `@(…)`, which hands the command words the hook cannot see. */
const PS_SPLAT = /^@[\w(]/;
/**
 * A word with the escapes a shell may leave in it removed: a `\` — bash keeps
 * one before an ordinary character inside double quotes, where a PowerShell
 * backtick escape arrives as one (`powershellAsBash` in `shell-lexer.mjs`) — and cmd.exe's
 * `^`, which a package.json script line runs under. Neither is in a branch
 * name or a script name, so stripping them over-reaches and never misses.
 */
const unescaped = (w) => w.replace(/[\\^]/g, "");

function nodeRuns(tokens, base, shell) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const attached = t.match(/^--run=(.+)$/);
    const script = attached ? attached[1] : t === "--run" ? tokens[i + 1] : undefined;
    if (script) {
      const args = forwarded(tokens.slice(attached ? i + 1 : i + 2));
      return [{ label: `node --run ${script}`, script, dir: base, expand: true, args }];
    }
    if (t === "--run" || !t.startsWith("-")) break;
  }
  const at = tokens.findIndex((t) => !t.startsWith("-"));
  const file = tokens[at];
  const m = file?.match(/^(?:(.*)[\\/])?([\w-]+)\.mjs$/);
  if (!m) return [];
  const label = `node ${file}`;
  const args = tokens.slice(at + 1);
  if (NODE_ALWAYS.test(m[2])) return [{ label, script: m[2], dir: base, always: true }];
  if (m[2] === "integration-build") {
    const end = args.indexOf("--");
    const own = end < 0 ? args : args.slice(0, end);
    const computed = own.find((t) => COMPUTED.test(t) || (shell === POWERSHELL && PS_SPLAT.test(t)));
    if (own.some((t) => unescaped(t) === "--restart"))
      return [
        {
          label: `${label} --restart`,
          script: m[2],
          dir: base,
          always: true,
          why: "stops and starts the deck hosts linked to its tree",
        },
      ];
    return computed
      ? [
          {
            label: `${label} ${computed}`,
            script: m[2],
            dir: base,
            always: true,
            why: "may stop and start the deck hosts linked to its tree: its flags could not be read",
          },
        ]
      : [];
  }
  if (m[2] === "host-app") {
    const action = args.find((t) => !t.startsWith("-"));
    return /^(?:start|stop)$/.test(action ?? "")
      ? [{ label: `${label} ${action}`, script: m[2], dir: base, always: true, why: "stops or starts a deck host app" }]
      : [];
  }
  if (m[2] !== "dev-voices") return [];
  return [
    { label, script: "dev:voices", dir: base },
    { label, script: "dev:voices", dir: resolveDir(base, m[1] ?? ".", { shell }) },
  ];
}

/**
 * A shell or command handed a string to run (#1526 review), `tokens[0]` its
 * name: the string is a command line, judged as the shell that runs it reads
 * it ({@link lineAs}), as a rollup watch hook's is. Only these commands' own
 * command arguments are read — never a quoted string merely because it is
 * quoted, so `git commit -m "… pnpm restart:stream-deck …"` stays a mention.
 *
 * - bash, sh and their kin ({@link shRuns}): the word after the options when
 *   one of them is `-c`.
 * - cmd.exe: every word after `/c` or `/k` (`//c` from Git Bash, which would
 *   turn `/c` into a path), read as cmd.exe reads it.
 * - Windows PowerShell and pwsh ({@link powershellRuns}).
 * - `eval`: its words joined, read as bash; `Invoke-Expression` / `iex`:
 *   likewise past a `-Command`, read as PowerShell.
 */
function wrapperRuns(tokens, dir, shell) {
  const [name, ...words] = tokens;
  if (isPowerShell(name)) return powershellRuns(name, words, dir, shell);
  if (isSh(name)) return shRuns(name, words, dir);
  if (isCmdExe(name)) {
    const at = words.findIndex((w) => /^\/\/?[ck]/i.test(w));
    const m = at >= 0 ? words[at].match(/^\/\/?([ck])([\s\S]*)$/i) : null;
    return m ? lineRun(`${name} /${m[1].toLowerCase()}`, dir, [m[2], ...words.slice(at + 1)]) : [];
  }
  if (/^eval$/i.test(name)) return lineRun(name, dir, words, BASH);
  return lineRun(name, dir, /^-c/i.test(words[0] ?? "") ? words.slice(1) : words, POWERSHELL);
}

/** The run of a command line made of `words` joined, read as `as` reads it; none for an empty line. */
function lineRun(label, dir, words, as) {
  const line = words.filter((w) => w !== "").join(" ");
  return line.trim() ? [{ label, dir, lines: [line], as }] : [];
}

/**
 * bash, sh, zsh, dash, ksh or fish handed a string: `-c`, alone or in a
 * cluster (`-lc`, `-ec`), makes the first word after the options the line,
 * read as bash; `-o` / `+o` / `-O` / `+O`, `--rcfile` and `--init-file` take a
 * value, and fish's `--command` carries the line itself. A shell run on a file
 * or on its stdin runs nothing the hook can read.
 */
function shRuns(name, words, dir) {
  let command = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const long = w.match(/^--command(?:=([\s\S]*))?$/);
    if (long) return lineRun(`${name} --command`, dir, [long[1] ?? words[i + 1] ?? ""], BASH);
    if (w === "--") return command ? lineRun(`${name} -c`, dir, [words[i + 1] ?? ""], BASH) : [];
    if (/^[-+][oO]$/.test(w) || w === "--rcfile" || w === "--init-file") i++;
    else if (/^-[A-Za-z]+$/.test(w)) command ||= w.includes("c");
    else if (!/^[-+]/.test(w)) return command ? lineRun(`${name} -c`, dir, [w], BASH) : [];
  }
  return [];
}

/** Whether `p` spells PowerShell's parameter `full` — at least its first `min` letters, as `pwsh` accepts an unambiguous prefix. */
const spells = (p, full, min) => p.length >= min && full.startsWith(p);
/** PowerShell's command-line parameters that take a value, besides the ones read on their own. */
const PS_VALUE_PARAMS = [
  ["executionpolicy", 2],
  ["ep", 2],
  ["windowstyle", 1],
  ["inputformat", 3],
  ["if", 2],
  ["outputformat", 1],
  ["of", 2],
  ["configurationname", 6],
  ["configurationfile", 6],
  ["custompipename", 2],
  ["settingsfile", 2],
  ["psconsolefile", 2],
  ["version", 1],
  ["encodedarguments", 8],
  ["ea", 2],
];

/**
 * Windows PowerShell or pwsh handed a string, read as PowerShell: every word
 * after `-Command` (`-c`, any unambiguous prefix, `-CommandWithArgs`, with `-`,
 * `--` or `/`) is the line, and so is the decoded base64 UTF-16 of
 * `-EncodedCommand` (`-e`, `-ec`); `-File` runs a file the hook cannot read.
 * With none of them the first word that is no option starts the line —
 * powershell.exe's default, which over-reaches for pwsh's. When one of them
 * follows such a word, that word may be the value of an option this reader
 * does not know, so both lines are judged. `-WorkingDirectory` (`-wd`) ahead
 * of them moves where the line runs.
 */
function powershellRuns(name, words, dir, shell) {
  const param = (w) => {
    const m = w.match(/^(?:--?|\/)([A-Za-z]+)(?::([\s\S]*))?$/);
    return m && { p: m[1].toLowerCase(), value: m[2] };
  };
  const kind = (p) =>
    p === "c" || p === "cwa" || spells(p, "commandwithargs", 3)
      ? "command"
      : p === "e" || p === "ec" || spells(p, "encodedcommand", 2)
        ? "encoded"
        : spells(p, "file", 1)
          ? "file"
          : p === "wd" || spells(p, "workingdirectory", 2)
            ? "dir"
            : PS_VALUE_PARAMS.some(([full, min]) => spells(p, full, min))
              ? "value"
              : "switch";
  const explicit = words.some((w) => /^(?:command|encoded|file)$/.test(kind(param(w)?.p ?? "")));
  const runs = [];
  let at = dir;
  for (let i = 0; i < words.length; i++) {
    const opt = param(words[i]);
    if (!opt) {
      if (!runs.length) runs.push(...lineRun(name, at, words.slice(i), POWERSHELL));
      if (explicit) continue;
      return runs;
    }
    const k = kind(opt.p);
    const value = opt.value ?? words[i + 1];
    if (k === "command")
      return [...runs, ...lineRun(`${name} -Command`, at, [opt.value ?? "", ...words.slice(i + 1)], POWERSHELL)];
    if (k === "encoded") {
      if (!/^[A-Za-z0-9+/]+=*$/.test(value ?? "")) return runs;
      const line = Buffer.from(value, "base64").toString("utf16le");
      return [...runs, ...lineRun(`${name} -EncodedCommand`, at, [line], POWERSHELL)];
    }
    if (k === "file") return runs;
    if (k === "dir" && value) at = resolveDir(dir, value, { shell });
    if ((k === "dir" || k === "value") && opt.value === undefined) i++;
  }
  return runs;
}

/**
 * Where the deck rule's words come from: `shellWords(args)` for a runner, or
 * — `whole` — `commandWords` in `shell-lexer.mjs` from where its arguments start, preceded by
 * the command's own name, for a shell wrapper whose string must stay one word.
 */
const RUNNERS = [
  { re: PNPM, read: pnpmRuns },
  { re: NPM, read: npmRuns },
  { re: NPX, read: binRuns },
  { re: TURBO, read: turboRuns },
  { re: NODE, read: nodeRuns },
  { re: ROLLUP, read: rollupRuns },
  { re: WRAPPER, read: wrapperRuns, whole: true },
];

/**
 * The word that stands for the words a substitution cut off ({@link
 * chainCommands}' `cut`): the hook cannot read them, and a reader that must see
 * every argument — integration-build's `--restart` — finds this one instead.
 */
const UNREAD = "$(…)";

/**
 * Every reason the commands of `c`, run from `cwd`, need Niklas's go (#1520,
 * #1526): the deck-host rule's whole judgement, recursive so a script — or a
 * rollup watch hook, or a shell's command string — is judged by what it runs.
 * `trail` holds the `<package dir>\0<script>` keys being expanded, which is
 * both the depth ({@link MAX_SCRIPT_DEPTH}) and the cycle guard. A script the
 * hook cannot read — no `ctx.scriptsAt`, no package.json, no such script — is
 * judged by its name alone; a selector it cannot resolve reads every package
 * instead ({@link runManifests}).
 */
export function deckFindings(c, cwd, ctx, shell, trail = []) {
  const found = [];
  const links = ctx.linkTargets().filter((l) => l.target);
  for (const m of matchesAt(c, STREAMDECK_CLI)) found.push(`\`${m[0].trim()}\` restarts or relinks a deck host`);
  for (const { head, args } of chainCommands(c, cwd, HOST_CONTROL, shell)) {
    const app = args.match(HOST_APP);
    if (app) found.push(`\`${head.replace(/^[\s|;&()`]+/, "").trim()} … ${app[0]}\` stops or starts a deck host app`);
  }
  for (const { re, read, whole } of RUNNERS)
    for (const { base, start, args, at, cut } of chainCommands(c, cwd, re, shell)) {
      // A shell wrapper's name as the rewritten text spells it (#1606): `bash`
      // for `"/usr/bin/bash"`, `pwsh` for `pwsh.exe`.
      const name = () =>
        trustedMask(c)
          .slice(start, at)
          .match(/[^\s|;&()\x60]+$/)?.[0] ?? "";
      const tokens = whole ? [name(), ...commandWords(c, at)] : shellWords(args);
      // A substitution cut the arguments short: it and what follows it are
      // unread. Glued to a word (`$(`, `--x=\``), it ends that word.
      if (!whole && (cut === "(" || cut === "\x60"))
        if (tokens.length && !/\s$/.test(args)) tokens.push(tokens.pop().replace(/\$$/, "") + UNREAD);
        else tokens.push(UNREAD);
      for (const run of read(tokens, base, shell).flatMap((r) => selectedRuns(r, ctx, found))) {
        // A name is judged with its leftover escapes gone ({@link unescaped}):
        // `pnpm "re\`start:stream-deck"` in PowerShell runs the script.
        const name = unescaped(run.script ?? "");
        if (run.always || DECK_ALWAYS.test(name)) {
          found.push(`\`${run.label}\` ${run.why ?? "restarts or relinks a deck host"}`);
          continue;
        }
        if (DECK_IF_LINKED.test(name)) {
          const root = ctx.toplevel?.(run.dir) ?? run.dir;
          const held = links.filter((l) => ctx.isInside(l.target, root));
          if (held.length) {
            found.push(
              `${held.map((l) => l.host).join(" and ")} plugin link points into ${root}: \`${run.label}\` there relinks the running plugin`,
            );
            continue;
          }
        }
        if (trail.length >= MAX_SCRIPT_DEPTH) continue;
        // A hook's or a shell's command line is no script: it has no key a
        // cycle could repeat, so its empty one only counts towards the depth.
        const lines = run.lines?.map((line) => ({ dir: run.dir, line, key: "", as: run.as })) ?? [];
        if (run.expand) lines.push(...scriptLines(run, ctx));
        for (const { dir, line, key, as } of lines) {
          if (key && trail.includes(key)) continue;
          const [text, lineShell] = lineAs(line, as);
          for (const f of deckFindings(text, dir, ctx, lineShell, [...trail, key]))
            found.push(`\`${run.label}\` → ${f}`);
        }
      }
    }
  return found;
}

/** A pnpm script selector, `/<regex>/`: pnpm runs every script whose name the pattern matches. */
const SCRIPT_SELECTOR = /^\/(.+)\/$/;

/**
 * The runs a pnpm script selector stands for (#1526 PR review): `pnpm run
 * "/^restart:/"` runs `restart:stream-deck`, which the hook would otherwise
 * look up as a script literally named `/^restart:/`. Each script the pattern
 * matches in the run's manifests ({@link runManifests}) becomes a run of its
 * own, judged by name and by what it runs. A pattern the hook cannot read — not
 * a valid regex, or no manifest to match it against — is a finding in itself,
 * pushed onto `found`, since it may select a restart. The selector is also
 * judged as the literal script name it spells, whichever pnpm would prefer
 * when a manifest defines one, so a script named `/^build$/` cannot hide
 * behind the harmless `build` it matches. Any other run is itself.
 */
function selectedRuns(run, ctx, found) {
  if (!run.selector) return [run];
  const literal = { ...run, selector: false };
  let re;
  try {
    re = new RegExp(run.script.match(SCRIPT_SELECTOR)[1]);
  } catch {
    re = null;
  }
  const manifests = re && ctx.scriptsAt ? runManifests(run, ctx).filter(Boolean) : [];
  if (!manifests.length) {
    found.push(`\`${run.label}\` runs every script its pattern matches, which could not be read`);
    return [literal];
  }
  const names = [...new Set(manifests.flatMap((m) => Object.keys(m.scripts ?? {})))].filter((n) => re.test(n));
  return [
    literal,
    ...names.map((name) => ({ ...run, script: name, label: `pnpm ${name} (${run.script})`, selector: false })),
  ];
}

/**
 * A command line a run hands on, as the hook lexes it, with the shell it is
 * judged as. A package.json script, a rollup hook and a `cmd /c` string (`as`
 * unset) run under cmd.exe on Windows, where `\` is a path separator and no
 * escape: read as `/` so the bash lexer keeps it. A bash string is lexed as it
 * stands, and a PowerShell one through `powershellAsBash` in `shell-lexer.mjs`.
 */
function lineAs(line, as) {
  if (as === POWERSHELL) return [powershellAsBash(line), POWERSHELL];
  return [as === BASH ? line : line.replace(/\\/g, "/"), BASH];
}

/**
 * A forwarded word as the appended command line spells it: bare when it is
 * plain, otherwise single-quoted with each `'` written `'"'"'` — closed,
 * double-quoted, reopened — so the line lexes as the shell reads it and
 * `shellWords` in `shell-lexer.mjs` gives the word back whole (#1526 review: a word holding
 * both quote kinds was wrapped in bare double quotes, and its own quotes
 * unbalanced the line). A backslash escape would not survive: a script line's
 * `\` is read as `/` ({@link lineAs}).
 *
 * @internal Exported for testing
 */
export const shellQuote = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'"'"'`)}'`);

/**
 * The command lines an expandable run executes, each with the package
 * directory it runs in ({@link runManifests}). The words the runner forwards
 * are appended to each line, as the runner does.
 */
function scriptLines(run, ctx) {
  if (!ctx.scriptsAt) return [];
  const tail = run.args?.length ? ` ${run.args.map(shellQuote).join(" ")}` : "";
  return runManifests(run, ctx)
    .filter((m) => m && typeof m.scripts?.[run.script] === "string")
    .map((m) => ({ dir: m.dir, line: m.scripts[run.script] + tail, key: `${m.dir}\0${run.script}` }));
}

/**
 * The package.json manifests a run's script may be read from: a turbo task's
 * in every workspace package of the tree, any other script's in the nearest
 * package.json above its directory — unless the runner's selectors pick
 * packages (`run.picks`, {@link pnpmPicks}, {@link npmRuns}), each a pick out
 * of the tree's root and its packages:
 *
 * - `every`: all of them, the root's included — the over-reach for a selector
 *   the hook cannot resolve (#1526 review).
 * - `root`: the root's.
 * - `path`: each package at or under that directory, as pnpm reads a location.
 * - `name`: each package whose name matches the pattern, `*` its wildcard;
 *   when none does and the pattern has no scope, each whose name does under
 *   any scope — pnpm reads `--filter core` as `@scope/core` when no package is
 *   named `core` and exactly one is so named, which this widens to all.
 * - `workspace`: npm's `-w`, a package name, or a path from the run's
 *   directory or the root naming a package or a folder holding packages; a
 *   glob reads every package.
 */
function runManifests(run, ctx) {
  if (!run.turbo && !run.picks) return [ctx.scriptsAt(run.dir)];
  const root = ctx.toplevel?.(run.dir) ?? run.dir;
  const packages = (ctx.workspaceDirs?.(root) ?? []).map((d) => ctx.scriptsAt(d)).filter(Boolean);
  if (run.turbo) return packages;
  const rootManifest = ctx.scriptsAt(root);
  const all = rootManifest ? [rootManifest, ...packages] : packages;
  const under = (dir) => all.filter((m) => ctx.isInside(m.dir, dir));
  const named = (pattern) => all.filter((m) => m.name && globName(pattern).test(m.name));
  const pick = (p) => {
    if (p.every) return all;
    if (p.root) return rootManifest ? [rootManifest] : [];
    if (p.path) return under(p.path);
    if (p.name) {
      const exact = named(p.name);
      return exact.length || p.name.startsWith("@") ? exact : named(`@*/${p.name}`);
    }
    if (/[*?[\]{}]/.test(p.workspace)) return all;
    const from = (base) => under(resolveDir(base, p.workspace, { shell: p.shell }));
    return [...all.filter((m) => m.name === p.workspace), ...from(run.dir), ...from(root)];
  };
  const chosen = new Map();
  for (const p of run.picks) for (const m of pick(p)) chosen.set(m.dir, m);
  return [...chosen.values()];
}

/** A pnpm name pattern as a regex: `*` matches any run of characters, every other character itself. */
const globName = (pattern) =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`))}$`);
