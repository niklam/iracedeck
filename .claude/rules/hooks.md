# Claude Code hooks

The mechanical rules of this repo are enforced by hooks in `.claude/settings.json`, not only described in prose. A hook fires on every tool call in every session, so a rule that lives here cannot be forgotten, rationalised away, or lost in a long context. Prose rules that need judgement (SDK-first, the review cadence, when to ask) stay prose.

The scripts live in `scripts/claude-hooks/` — Node, because `jq` is not installed here and a `jq` pipeline fails silently. Each hook is a thin entry point over a pure `rules-*.mjs` module with colocated tests (`pnpm test scripts/claude-hooks`). A hook that throws denies with its own stack trace rather than passing, so a broken hook is loud.

## What fires when

| Event | Matcher | Script | Does |
| --- | --- | --- | --- |
| SessionStart | startup, resume | `session-start.mjs` | Prints the worktrees with dirty state, where each deck host's plugin link points, whether `origin/master` is behind the remote, and any running watchers. Replaces four "verify before you act" rules with one report. |
| PreToolUse | Bash | `pre-bash.mjs` → `rules-bash.mjs` | The command guards below. |
| PreToolUse | Skill, Agent, AskUserQuestion | `pre-tools.mjs` → `rules-tools.mjs` | `/code-review` must name a level, target an `ir-<issue>` tree and never carry `--fix`; an Agent spawn must choose its `model` (`fork` exempt) and never `isolation: "worktree"`; AskUserQuestion options name the actor as "Claude …" / "You …", never "I …". |
| PostToolUse | Edit, Write | `post-edit.mjs` → `rules-post.mjs` | Runs the generator whose source was edited (changelog, getting-started page, icon SVGs, comms catalog, Elgato manifest profiles, voice configs) and reports what changed; injects reminders for `global-settings.ts`, the catalog / bundled script, and rule files. |
| PostToolUse | Bash | `post-bash.mjs` | After `gh pr merge`: moves the closing issues' Roadmap cards to Testing and lists the four post-merge CI runs. After `gh issue create`: adds the card to the board in Backlog. After `git worktree add ../ir-<n>`: moves the card to In progress. After `sed -i`: prints `git diff --stat`. |

## The Bash guards

A **deny** refuses the call and tells the model why. An **ask** forces the permission prompt even for an allow-listed command, which is how "Niklas confirms" is enforced.

| Command shape | Verdict | Rule it enforces |
| --- | --- | --- |
| `git push` of anything but a spec-only diff on `master` | ask | pushes are confirmed after the manual test; spec-only pushes are pre-approved |
| `git push` of a tag | ask | a tag cuts a release |
| `gh pr create` | ask, and deny on a title that is not `<type>(<scope>): … (#<issue>)` | PR title discipline, PR gated on the manual test |
| `gh pr merge` | deny unless: OPEN, `--squash` (or `--merge` for a `release/*` head), `reviewDecision` APPROVED, a CodeRabbit review at the current head plus an approval, every rollup entry green (fails closed on unknown node types), not BLOCKED/DIRTY. `--admin` skips only the review checks. | approval and checks are head-specific |
| `git commit` with a spec on a non-master branch | deny | specs commit to master only |
| `git commit` with a `package.json` while `pnpm-lock.yaml` is dirty and not included | deny | CI's frozen lockfile |
| `git worktree add` inside the repo, not named `ir-<issue>`, or from a stale `origin/master` | deny | sibling worktrees; verify the base commit |
| `git worktree remove` while a deck host's plugin link points into that tree | deny | relink to master first, or leave it if another session holds it |
| `gh issue create --milestone/--assignee` | deny | both are set when implementation starts |
| `updateProjectV2Field` | deny | rewriting the Status options wipes every card's lane |
| `--fix` on a code-review invocation | deny | report only |
| `pnpm build --force`, a piped `pnpm build/test/…` without `pipefail`, `pnpm exec vitest`, `pnpm --filter <pkg> <script>` the package lacks, `--body @-`, a short sha on `gh run list --commit`, `jq`, a heredoc carrying a doubled-backslash Windows path, `IRACEDECK_MOCK=0`, `git show <ref/with/slash>:<.dot-path>` without `MSYS_NO_PATHCONV`, `git diff master..X` | deny with the correction | the command-shape traps recorded in memory |

## Rules

1. **A new mechanical rule goes here, not only in prose.** When a rule file gains a "never do X" that a regex over the tool input can check, add it to `rules-bash.mjs` (or the matching module) with a test in the same change. The prose keeps the why; the hook keeps the rule.
2. **Deny beats ask.** In `rules-bash.mjs` the first verdict wins, so a rule that denies a shape must come before one that would ask about it.
3. **Board moves never go backwards.** `BOARD_MOVES` in `lib.mjs` lists the lanes each automated move may start from; a card in Testing or Done is never touched. The lane ids are read fresh from `gh project field-list` on every move, never hardcoded.
4. **Exercise the mutating paths with `IRACEDECK_HOOKS_DRY_RUN=1`.** The board helpers then report what they would do instead of doing it. Every other path is read-only. This rule exists because the first pipe-test of the merge hook moved a real card.
5. **Hooks read the tree of the session's `CLAUDE_PROJECT_DIR`.** A worktree runs the copy of the scripts it has checked out, so a hook change reaches other worktrees when it lands on `master` and they rebase.
6. **A hook change is proven by watching it fire**, not by reading it: pipe a synthesised payload through the script, then trigger the matching tool in-session and see the deny or the injected context. The settings watcher only reloads `.claude/settings.json` when that directory had a settings file at session start; otherwise open `/hooks` once.
7. **A shape trap fires at command position, not on a mention.** `cmd()` in `rules-bash.mjs` anchors each one to the start of the string or of a line, or to what follows a `|`, `;`, `&&`, `(` or `$(`, with env-var prefixes allowed — so a `grep`, an `echo` or a docs edit that merely names a trapped shape passes rather than being denied for talking about it. A rule that must fire on ANY occurrence stays unanchored: `updateProjectV2Field` and the doubled-backslash heredoc are the two, because there the damage is in the text the command carries rather than in the command being run.
8. **A `git -C <dir>` belongs to one command in a chain, not to the whole string.** `gitCwd(command, cwd, re)` reads the `-C` off the segment (split at `&&`, `||`, `;`, `|`, newline) that the rule's own regex matched. Reading the first `-C` anywhere is how `git worktree add ../ir-N … && git -C ../ir-N log` resolved the new tree against itself, failed the repo-root lookup in a directory that did not exist yet, and was denied as "inside the repo". The `mainRoot` fallback in `pre-bash.mjs` is the second half of that fix: a dir git cannot answer for falls back to the session's repo root, never to the dir itself. The post-hook's worktree trigger uses the same anchored regex, so a command that merely mentions the shape moves no card.

## What is deliberately not a hook

- Editing files in another worktree. The coordinator's cwd is `master` while it edits the issue's tree, so a path-based guard would fire on every legitimate edit.
- The post-review "every worktree is clean" check. The Skill tool returns before a review finishes, so there is no event to hang it on; the SessionStart report shows dirty trees, and the rule in `code-review.md` stands.
- Lint-staged gaps (`.ejs`, `.mjs` formatting) and the commit trailer: those belong to husky, where they apply to every committer.
