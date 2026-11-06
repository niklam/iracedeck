---
paths:
  - "scripts/claude-hooks/script-runs*.mjs"
  - "scripts/claude-hooks/rules-bash.test.mjs"
---

# Claude Code hooks — the package-script interpreter

How the deck-host ask reads what a command would run, for whoever edits `scripts/claude-hooks/script-runs.mjs` (moved out of `rules-bash.mjs` with its code in #1590). Which commands ask, the names that ask whatever reads them, and which tree counts as linked are the rule's decisions, in *The integration tree and deck-linked trees* of `@.claude/rules/hook-internals.md`; the names there are the floor, for when nothing can be read. Why the interpreter reaches as far as it does, and when it should grow, is in the module's header.

## Where a script's command line comes from

A pnpm or npm script, a `node --run` and a turbo task not already caught by name are expanded (`deckFindings`): the command line is read from the nearest package.json at or above the directory the script runs in (`ctx.scriptsAt`), or — for a turbo task — from every `packages/*` package of the tree (`ctx.workspaceDirs`, filters not read, so it over-reaches), or for a pnpm `--filter` / npm `-w` from the packages it picks (`runManifests`): a name with or without its scope, a path or `{…}` location exactly, and anything the hook cannot resolve — `-r`, a glob, a dependency or since query, an exclude-only list, npm `--workspaces` — over-reaching to every package plus the root. That line is judged by the same rule in the package's directory, recursively, with `\` read as `/` (cmd.exe's separator). The trail of `<dir>\0<script>` keys is the cycle guard and the depth bound (8, `MAX_SCRIPT_DEPTH`). A missing script or an unparsable package.json leaves the run judged by its name. pnpm's own commands (`install`, `add`, …) are never read as scripts, and pnpm's `verifyDepsBeforeRun` install is not modelled.

A pnpm `/<regex>/` script selector is one run per script name it matches in those manifests, and one more for a script literally named after the pattern (`selectedRuns`); one the hook cannot read, an invalid pattern or no manifest, asks.

## Arguments a runner passes on

The arguments a runner passes on (`pnpm <s> -- --restart`, `npm run <s> -- …`, `node --run <s> -- …`, turbo's after `--`) are appended to the expanded line, so a wrapper cannot hide `integration-build.mjs --restart`; a word there the hook cannot read (`$`, a backtick, `$(…)`, `%X%`, brace expansion, a glob, a PowerShell `@` splat) asks, since it may be that flag, and so does `--restart` written escaped (`--re\start`, a PowerShell backtick, cmd's `^`), which is compared unescaped. A plain branch name containing `restart` passes.

## Runners, shells and watch hooks inside a line

`node`, `pnpm`, `npm` or `npx` behind a runner (`pnpm exec node`, `npx pnpm`, `npm exec npm run …`) is read as it is at command position. A shell wrapper's command string (`bash` / `sh` / … `-c`, `cmd /c` / `/k`, `powershell` / `pwsh -Command` or `-EncodedCommand`, `eval`, `Invoke-Expression`, `npx -c`, pnpm's `-c` / `--shell-mode` before or after `exec`, npm's `--call` / `-c` anywhere) is a command line judged recursively in its own shell (`wrapperRuns`), while a quoted string any other command takes (`git commit -m`, `echo`) is not. Which word is that string is read from the shell's own option spec — `readCommand` over `shellSpec(name)` in `shell-lexer.mjs`, the one table of each shell's valued options, string switch and positional switch, and the same walk the lexer places a shell-fed string with (#1634) — so `bash -eo pipefail -c '…'`, `fish -d 3 -c '…'`, `fish -c'…'`, `pwsh -ep Bypass -c "…"`, `pwsh -c"…"` and `cmd /d /s /c "…"` all reach their string, the lexer's own match of a trap word inside it is skipped because this reader judges it, and the two cannot disagree. The reader takes the command's words with their quotes (`commandWordsRaw`), since the walk needs them to tell `-c"…"` from a flag cluster, and decodes a word as bash reads it only once the walk has chosen it.

A `rollup` watch hook (`--watch.onStart`, `onBundleStart`, `onBundleEnd`, `onEnd`, `onError`, `=`-attached or the next word, any case or kebab form) is a command line too, judged recursively; this rule splits words shell-style (`shell-lexer.mjs`'s `shellWords`) so a quoted hook value stays one word.

So a script that reaches a restart asks whatever it is called: the Stream Deck plugin package's `watch`, whose `rollup --watch.onEnd` runs `streamdeck restart`, asks while a plain `build` passes.
