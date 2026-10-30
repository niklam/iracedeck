# Claude Code hooks

The mechanical rules of this repo are enforced by hooks in `.claude/settings.json`, not only described in prose. A hook fires on every tool call in every session, so a rule that lives here cannot be forgotten, rationalised away, or lost in a long context. Prose rules that need judgement (SDK-first, the review cadence, when to ask) stay prose.

The scripts live in `scripts/claude-hooks/` — Node, because `jq` is not installed here and a `jq` pipeline fails silently. Each hook is a thin entry point over a pure `rules-*.mjs` module with colocated tests (`pnpm test scripts/claude-hooks`). A hook that throws denies with its own stack trace rather than passing, so a broken hook is loud.

## What fires when

| Event | Matcher | Script | Does |
| --- | --- | --- | --- |
| SessionStart | startup, resume | `session-start.mjs` | Prints the worktrees with dirty state, where each deck host's plugin link points, whether `origin/master` is behind the remote, and any running watchers. Replaces four "verify before you act" rules with one report. |
| PreToolUse | Bash | `pre-bash.mjs` → `rules-bash.mjs` | The command guards below. |
| PreToolUse | Skill, Agent, AskUserQuestion, Edit, Write | `pre-tools.mjs` → `rules-tools.mjs` | `/code-review` must name a level, target an `ir-<issue>` tree and never carry `--fix`; an Agent spawn must choose its `model` (`fork` exempt) and never `isolation: "worktree"`; AskUserQuestion options name the actor as "Claude …" / "You …", never "I …"; an Edit's `new_string` or a Write's `content` carries no raw control byte other than tab, LF and CR (#1103). |
| PostToolUse | Edit, Write | `post-edit.mjs` → `rules-post.mjs` | Runs the generator whose source was edited (changelog or a changelog fragment, getting-started page, icon SVGs, comms catalog, Elgato manifest profiles, voice configs) and reports what changed — for a fragment that run is its validation at authoring time, since composing is what checks it; injects reminders for `global-settings.ts`, the catalog / bundled script, and rule files. |
| PostToolUse | Bash | `post-bash.mjs` | After `gh pr merge`: moves the closing issues' Roadmap cards to Testing and lists the four post-merge CI runs. After `gh issue create`: adds the card to the board in Backlog. After `git worktree add ../ir-<n>`: moves the card to In progress. After `sed -i`: prints `git diff --stat`. |

## The Bash guards

A **deny** refuses the call and tells the model why. An **ask** forces the permission prompt even for an allow-listed command, which is how "the maintainer confirms" is enforced. The plain `git push` and `gh pr create` asks were dropped on 2026-09-08: a hook sees the command and never the conversation, so it prompted just as loudly when the maintainer had asked for the push or the PR. The manual-test gate on both stays a prose rule (`@.claude/rules/issue-workflow.md`); the hook keeps the title deny, the tag-push ask and the merge gate.

| Command shape | Verdict | Rule it enforces |
| --- | --- | --- |
| `git push` of a tag | ask | a tag cuts a release |
| `git push` of the `integration` branch | deny | that branch is local (#1520) |
| `gh pr create` | deny on a title that is not `<type>(<scope>): … (#<issue>)` | PR title discipline |
| `gh pr merge` | deny more than one merge per command; deny unless OPEN, `--squash` (`--merge` for a `release/*` head), APPROVED, every check green, not BLOCKED/DIRTY, and CodeRabbit reviewed the current head — by a review object, by its summary comment of a clean incremental review (#1386), or through a pure rebase of what it last reviewed (#1307, a conflicted replay asks); the last two need the full `--match-head-commit <head>`, and a release back-merge gets neither. `--admin` skips only the review checks. Mechanics: `hook-internals.md` | approval and checks are head-specific |
| `git commit` with a spec on a non-master branch | deny | specs commit to master only |
| `git commit` ADDING a spec with no header block, no Out-of-scope section or no Testing/Verification section | deny | the two sections that decayed to 17 % and 70 % because no rule named them; amendments and unreadable text pass, so it is forward-only |
| `git commit` of any spec, new or amended, carrying a raw control byte other than tab, LF and CR | deny, naming the line | a spec-only push runs no CI (#1466); the husky pre-commit step is the guard for every committer |
| `git worktree add ../ir-<n>` where `origin/master` carries no `docs/superpowers/specs/*-issue-<n>-*.md` | ask, unless the issue's labels are readable and carry no `enhancement` | a feature gets its spec before its worktree; the exemptions are judgement, so the maintainer confirms |
| `git commit` with a `package.json` while `pnpm-lock.yaml` is dirty and not included | deny | CI's frozen lockfile |
| `git commit` that would record the Elgato `manifest.json` with a `Debug` key in its `Nodejs` block | deny, naming `pnpm debug:plugin off` | the local inspector switch never ships (#1338) |
| `git worktree add` anywhere but a sibling of the main checkout (inside it, or nested in another worktree), not named `ir-<issue>` or `ir-integration`, or from a stale `origin/master` | deny | sibling worktrees; verify the base commit |
| `git worktree remove` while a deck host's plugin link points into that tree | deny | never relink on your own — leave the link and the tree, and tell the maintainer |
| a restart, relink or watch script, or `integration-build.mjs`; a `pnpm build`/`install` in a deck-linked tree | ask | nothing touches a linked tree without Niklas's go (#1520) |
| `gh issue create --milestone/--assignee` | deny | both are set when implementation starts |
| `updateProjectV2Field` | deny | rewriting the Status options wipes every card's lane |
| `--fix` on a code-review invocation | deny | report only |
| `pnpm build --force`, a piped `pnpm build/test/…` without `pipefail`, `pnpm exec vitest`, `pnpm --filter <pkg> <script>` the package lacks, `--body @-`, a short sha on `gh run list --commit`, `jq`, a heredoc carrying a doubled-backslash Windows path, `IRACEDECK_MOCK=0`, `git show <ref/with/slash>:<.dot-path>` without `MSYS_NO_PATHCONV`, `git diff master..X` | deny with the correction | the command-shape traps recorded in memory |

## Rules

1. **A new mechanical rule goes here, not only in prose.** When a rule file gains a "never do X" that a regex over the tool input can check, add it to `rules-bash.mjs` (or the matching module) with a test in the same change. The prose keeps the why; the hook keeps the rule. This file is loaded into every session, so a guard gets one table row here; how it decides — the conditions, the edge cases, the incidents behind them — goes in `hook-internals.md`, which loads only with the hook scripts.
2. **Deny beats ask, whatever the order.** `checkBash` returns the first deny at once and holds every ask until every rule has run, because one chained command can match an ask rule early in the list and a deny rule late in it — until #1193 the ask won, and confirming it ran the shape the deny exists to stop. The asks are then joined into one prompt (#1307): a chain the maintainer approves runs whole, so an ask hidden behind another would run unseen. Rule order still decides which of two denies is reported.
3. **Board moves never go backwards.** `BOARD_MOVES` in `lib.mjs` lists the lanes each automated move may start from; a card in Testing or Done is never touched, nor its position in the lane. `Next` is entered from Backlog or Planned only. The lane ids are read fresh from `gh project field-list` on every move, never hardcoded.
4. **Exercise the mutating paths with `IRACEDECK_HOOKS_DRY_RUN=1`.** The board helpers then report what they would do instead of doing it. Every other path is read-only except the merge gate's pure-rebase check, which writes objects (never refs) to the shared store. This rule exists because the first pipe-test of the merge hook moved a real card.
5. **Hooks read the tree of the session's `CLAUDE_PROJECT_DIR`.** A worktree runs the copy of the scripts it has checked out, so a hook change reaches other worktrees when it lands on `master` and they rebase. The `pnpm --filter <pkg> <script>` rule reads the package manifests of the checkout holding the session's cwd and does not follow a `cd` inside the command.
6. **A hook change is proven by watching it fire**, not by reading it: pipe a synthesised payload through the script, then trigger the matching tool in-session and see the deny or the injected context. The settings watcher only reloads `.claude/settings.json` when that directory had a settings file at session start; otherwise open `/hooks` once.
7. **A guard reads the command the shell would run, not a mention of it.** Shape traps fire at command position, through a lexer mask that is trusted only when it is sure, and a `git -C <dir>` belongs to one command in a chain. When unsure, the pre-hook errs to deny. How it does this — for anyone editing `rules-bash.mjs` — is in `hook-internals.md`, which loads with `scripts/claude-hooks/`.

## What is deliberately not a hook

- Editing files in another worktree. The coordinator's cwd is `master` while it edits the issue's tree, so a path-based guard would fire on every legitimate edit.
- The post-review "every worktree is clean" check. The Skill tool returns before a review finishes, so there is no event to hang it on; the SessionStart report shows dirty trees, and the rule in `code-review.md` stands.
- Lint-staged gaps (`.ejs`, which neither ESLint nor Prettier reads) and the commit trailer: those belong to husky, where they apply to every committer.
