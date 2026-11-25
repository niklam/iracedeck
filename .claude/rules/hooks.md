# Claude Code hooks

The mechanical rules of this repo are enforced by hooks in `.claude/settings.json`, not only described in prose. A hook fires on every tool call in every session, so a rule that lives here cannot be forgotten, rationalised away, or lost in a long context. Prose rules that need judgement (SDK-first, the review cadence, when to ask) stay prose.

The scripts live in `scripts/claude-hooks/` — Node, because `jq` is not installed here and a `jq` pipeline fails silently. Each hook is a thin entry point over a pure `rules-*.mjs` module with colocated tests (`pnpm test scripts/claude-hooks`). A hook that throws denies with its own stack trace rather than passing, so a broken hook is loud.

## What fires when

| Event | Matcher | Script | Does |
| --- | --- | --- | --- |
| SessionStart | startup, resume | `session-start.mjs` | Prints the worktrees with dirty state, where each deck host's plugin link points, whether `origin/master` is behind the remote, and any running watchers. |
| PreToolUse | Bash, PowerShell | `pre-bash.mjs` → `rules-bash.mjs` (+ `shell-lexer.mjs`, `script-runs.mjs`, `merge-gate.mjs`, `spec-sections.mjs`) | The command guards below; a PowerShell command skips the bash-syntax traps. |
| PreToolUse | Skill, Agent, AskUserQuestion, Edit, Write | `pre-tools.mjs` → `rules-tools.mjs` | `/code-review` must name a level, target an `ir-<issue>` tree and never carry `--fix`; an Agent spawn must choose its `model` (`fork` exempt) and never `isolation: "worktree"`; AskUserQuestion options name the actor as "Claude …" / "You …", never "I …"; an Edit or Write carries no raw control byte other than tab, LF and CR (#1103). |
| PostToolUse | Edit, Write | `post-edit.mjs` → `rules-post.mjs` | Runs the generator whose source was edited (changelog or fragment, getting-started page, icon SVGs, comms catalog, Elgato manifest profiles, voice configs) and reports what changed — for a fragment that run is its validation; injects reminders for `global-settings.ts`, the catalog / bundled script, and rule files. |
| PostToolUse | Bash, PowerShell | `post-bash.mjs` | Moves Roadmap cards: into Backlog after `gh issue create`, Planned after a milestone is set, In progress after `git worktree add ../ir-<n>`, Testing after `gh pr merge` (and lists the four post-merge CI runs); `iracedeck/iracedeck` only (`roadmap-board.md`). After `sed -i`: prints `git diff --stat`. |

## The Bash guards

A **deny** refuses the call and tells the model why. An **ask** forces the permission prompt even for an allow-listed command, which is how "the maintainer confirms" is enforced. A hook sees the command and never the conversation, so plain `git push` and `gh pr create` are not asked on (2026-09-08); the manual-test gate on both is prose (`@.claude/rules/issue-workflow.md`).

| Command shape | Verdict | Rule it enforces |
| --- | --- | --- |
| `git push` of a tag | ask | a tag cuts a release |
| `git push` of the `integration` branch | deny | that branch is local (#1520) |
| `gh pr create` | deny on a title that is not `<type>(<scope>): … (#<issue>)` | PR title discipline |
| `gh pr merge` | deny unless OPEN, `--squash` (`--merge` for a `release/*` head), APPROVED, every check green, not BLOCKED/DIRTY and CodeRabbit reviewed the current head; one plain merge per command, in `iracedeck/iracedeck` only; `--admin` passes only a prose-only or wholly-Dependabot PR (`build-and-commit.md` *Merging*), else asks or refuses. Mechanics: `hook-merge-gate.md` | approval and checks are head-specific |
| `git commit` with a spec on a non-master branch | deny | specs commit to master only |
| `git commit` ADDING a spec with no header block, no Out-of-scope section or no Testing/Verification section | deny | the required sections (`specs-and-plans.md`); forward-only |
| `git commit` of any spec carrying a raw control byte other than tab, LF and CR | deny, naming the line | a spec-only push runs no CI (#1466) |
| `git worktree add ../ir-<n>` where `origin/master` carries no `docs/superpowers/specs/*-issue-<n>-*.md` | ask, unless the issue's labels are readable and carry no `enhancement` | a feature gets its spec before its worktree |
| `git commit` with a `package.json` while `pnpm-lock.yaml` is dirty and not included | deny | CI's frozen lockfile |
| a program word that expands or globs (`$GH pr merge`, `$(which git) push`) | deny when any guard would act on it as `gh` or `git` | the hook cannot tell what runs (#1606) |
| text handed to a shell in a form the lexer does not read: piped in, a script or startup file from a stream (here-string, heredoc, `<(…)`, `/dev/stdin`, `<&3`, PowerShell's `-`), `-EncodedCommand`, `eval`, `sudo -s`, `$'…'`, a string in a string, one `xargs` / `parallel` / `find -exec` fills | deny, before any rule | the lexer reads only the forms agents type (#1659) |
| `git commit`, `git worktree add` or a push of the current branch under `--git-dir` / `GIT_DIR` (a commit also under a moved work tree or index) | deny, asking for `git -C <dir>` | the repository is not the tree the hook reads (#1606) |
| `git commit` recording the Elgato `manifest.json` with a `Debug` key in its `Nodejs` block | deny, naming `pnpm debug:plugin off` | the local inspector switch never ships (#1338) |
| `git worktree add` anywhere but a sibling of the main checkout, not named `ir-<issue>` or `ir-integration`, or from a stale `origin/master` | deny | sibling worktrees; verify the base commit |
| `git worktree remove` while a deck host's plugin link points into that tree | deny | never relink on your own — leave the link and the tree, and tell the maintainer |
| a link, unlink or relink, `switch-test-env`, a restart a watch or loop repeats; `dev:voices` in a linked tree; a script by what it runs | ask | nothing relinks a deck host without Niklas's go (#1520); a restart, stop or start waits for his go in chat, not a prompt (#1737) |
| `gh issue create --milestone/--assignee` | deny | both are set when implementation starts |
| `updateProjectV2Field` | deny | rewriting the Status options wipes every card's lane |
| `gh project item-edit`, or a raw write to a Projects v2 item's field or position it can read (the gaps: `hook-internals.md`) | deny, naming the `lib.mjs` helpers | lanes move only through the helpers (`roadmap-board.md`, #1574) |
| `--fix` on a code-review invocation | deny | report only |
| `pnpm build --force`, a piped `pnpm build/test/…` without `pipefail`, `pnpm exec vitest`, `pnpm --filter <pkg> <script>` the package lacks, `--body @-`, a short sha on `gh run list --commit`, `jq`, a heredoc carrying a doubled-backslash Windows path, `IRACEDECK_MOCK=0`, `git show <ref/with/slash>:<.dot-path>` without `MSYS_NO_PATHCONV`, `git diff master..X` | deny with the correction | the command-shape traps recorded in memory |

## Rules

1. **A new mechanical rule goes here, not only in prose.** When a rule file gains a "never do X" that a regex over the tool input can check, add it to `rules-bash.mjs` (or the matching module) with a test in the same change. The prose keeps the why; the hook keeps the rule. This file is loaded into every session, so a guard gets one short table row here; how it decides — the conditions, the edge cases, the incidents behind them — goes in `hook-internals.md`, which loads only with the hook scripts.
2. **Deny beats ask, whatever the order.** `checkBash` returns the first deny at once and holds every ask until every rule has run, then joins them into one prompt, so a chain never runs a denied shape or an ask hidden behind another (#1193, #1307).
3. **Board moves never go backwards.** `BOARD_MOVES` in `lib.mjs` lists the lanes each automated move may start from (`roadmap-board.md`).
4. **Exercise the mutating paths with `IRACEDECK_HOOKS_DRY_RUN=1`.** The board helpers then report what they would do instead of doing it. Every other path is read-only except the merge gate's pure-rebase check and `--admin` file read, which write objects (never refs) to the shared store. This rule exists because the first pipe-test of the merge hook moved a real card.
5. **Hooks read the tree of the session's `CLAUDE_PROJECT_DIR`.** A worktree runs the copy of the scripts it has checked out, so a hook change reaches other worktrees when it lands on `master` and they rebase.
6. **A hook change is proven by watching it fire**, not by reading it: pipe a synthesised payload through the script, then trigger the matching tool in-session and see the deny or the injected context. The settings watcher only reloads `.claude/settings.json` when that directory had a settings file at session start; otherwise open `/hooks` once.
7. **A guard reads the command the shell would run, not a mention of it**, in any spelling of the program and past git's global options; a `git -C <dir>` belongs to one command in a chain. When unsure, the pre-hook errs to deny (`hook-internals.md`).

## What is deliberately not a hook

- Editing files in another worktree. The coordinator's cwd is `master` while it edits the issue's tree, so a path-based guard would fire on every legitimate edit.
- The post-review "every worktree is clean" check. The Skill tool returns before a review finishes, so there is no event to hang it on; the SessionStart report shows dirty trees, and the rule in `code-review.md` stands.
- Formatting at commit (`scripts/format-staged.mjs`, #1402), its gaps (`.ejs`, which neither ESLint nor Prettier reads) and the commit trailer: those belong to husky, where they apply to every committer.
