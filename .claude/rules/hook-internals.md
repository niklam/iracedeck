---
paths:
  - "scripts/claude-hooks/**"
  - ".claude/settings.json"
---

# Claude Code hooks — internals

How the hook guards decide, for whoever edits `scripts/claude-hooks/`. The policy — which guards exist and why — is `@.claude/rules/hooks.md`, which every session loads; this file holds the mechanics that only matter when changing them (moved out of it in #1465 to keep the always-loaded set inside its budget).

## The merge gate (`gh pr merge`)

`rules-bash.mjs` denies more than one merge per command, judged on its own words, and otherwise denies unless all of these hold: the PR is OPEN; the method is `--squash` (or `--merge` for a `release/*` head); `reviewDecision` is APPROVED; every rollup entry is green (it fails closed on unknown node types); the merge state is not BLOCKED or DIRTY; and CodeRabbit has reviewed the current head. `--admin` skips only the review checks.

**A head without a review object of its own.** Thread replies, which GitHub files as empty COMMENTED reviews, are not reviews. For such a head a back-merge is refused, and the merge must be pinned with the full `--match-head-commit <head>` before anything is read; then one of two things stands in for the review.

**CodeRabbit's summary comment** (#1386), which a clean incremental review edits instead of filing a review object, counts as the head's review when:

- exactly one summary exists, authored and last edited by the Bot `coderabbitai`, and every edit in its history (`userContentEdits`: at most 100, complete, newest first, the newest being the body read) was made by that Bot;
- it is not minimized, the PR has at most 100 comments, and there is no other auto-generated block (a `rate limited` one refuses);
- each statement is read only from its own block: one recent-review block whose one range line ends at the head and says no actionable comments, and exactly one `change_assessment_commit` and one `final_review_risk_coverage` (`kind: reviewed`, `sourceCommitId` equal to `coveredCommitId`) marker naming that same commit;
- the range's **start** is shown reviewed too: the newest review object's commit, a clean pure-rebase replay of it, or the range end of an earlier version of the same comment, walked back through its edit history at most 10 steps.

A base retargeted or force-pushed since the newest review object refuses before the summary is used.

**Otherwise a pure rebase** (#1307) of the commit CodeRabbit last saw — a passing summary's commit when the comment was written after the newest review object, else that object's; a summary that fails any condition, a rate-limited one included, is never a replay start. The reviewed change replayed onto the head's base must give the head's exact tree, and every file the replay reports as conflicted gets a line check that at best earns an **ask**. A follow-up push, a base retargeted or force-pushed since the newest review object, and criss-cross history are refused on that path.

A refusal names the condition that failed, so "rate limited, wait" reads differently from "not reviewed, ask `@coderabbitai review`".

Where the code lives: `lib.mjs`'s `replayRebase` (the replay, with `git merge-tree -X no-renames`) and `baseChangedSince`, the pure `change-signature.mjs` for conflicted files, `lib.mjs`'s `prComments` and the pure `coderabbit-summary.mjs` (`readSummary`, tested against verbatim bodies in `__fixtures__/coderabbit-summary/`), and `rules-bash.mjs`'s `unreviewedHeadVerdict`. `scripts/CLAUDE.md` has the module map.

**The replay writes objects.** It is the one path `IRACEDECK_HOOKS_DRY_RUN=1` does not make read-only: it writes the replay's trees, and any reviewed commit the checkout lacks, fetched from `origin` by sha without automatic maintenance, to the shared object store — never a ref or `FETCH_HEAD`.

## The Elgato manifest `Debug` guard

`git commit` is denied, naming `pnpm debug:plugin off`, when it would record the Elgato `manifest.json` with a `Debug` key in its `Nodejs` block (#1338). The manifest is read from the staged copy for a plain commit, from the working copy for `-a`, a pathspec or a chained `git add` that selects it, and from both when the selection is only decided at run time; a manifest dirty with the key but left out of the commit passes. `pack:plugin` and `manifest-no-debug.test.mjs` are the other two guards.

## Which checkout's data a rule reads

Hooks run the scripts of the session's `CLAUDE_PROJECT_DIR`. The `pnpm --filter <pkg> <script>` rule is the one exception about *data*: it reads the package manifests of the checkout holding the session's cwd rather than always the main one (#1021). It does not follow a `cd` inside the command, so a `master` session running `cd ../ir-<n> && pnpm --filter …` is still judged by `master`'s manifests (`hooks.md` rule 5 keeps the short form).

## A shape trap fires at command position, not on a mention

`cmd()` in `rules-bash.mjs` anchors each trap to the start of the string or of a line (after any indent), or to what follows a `|`, `;`, `&`, `(`, `)` or a backtick, with env-var prefixes, the shell keywords that open a command list (`if`, `then`, `do`, `else`, `elif`, `while`, `until`, `!`, `{`) and the wrappers `time`, `command`, `exec`, `env`, `nohup`, `timeout` and `xargs` with their own options allowed in between (#1307: `if …; then gh pr merge …` used to pass every trap unchecked).

A boundary counts only where the shell sees one (#1321): `maskInert` is one recursive lexer that blanks the inert text — single-quoted and `$'…'` text, double-quoted text and unquoted heredoc bodies except their substitutions, quoted-delimiter heredoc bodies, and `#` comments — at the same length, so a `|` in a grep pattern or a line of a commit message is no boundary, and a rule that reads its arguments finds the command in the masked text and reads them from the raw text at the same index (`matchAt`).

**The mask is trusted only when it is sure.** The lexer reports itself unsure whenever a construct runs off the end of the string or a `)` closes nothing — states bash refuses, so reaching one means a misread — and the mask is also set aside when live text hands a string or stdin to a shell (`bash -c`, `sh`, `eval`, `bash <<'EOF'`, `xargs`, `timeout`, `trap` …). Either way the rules read the raw command, as before #1321. The pre-hook is a safety gate, so it errs to deny: a doubt costs a false deny on a mention, never a missed command. For the same reason the one-merge backstop counts raw text, a quoted or substituted PR is refused rather than guessed, and a suppressor (`--dry-run`, `pipefail`, `MSYS_NO_PATHCONV`) counts only in live text that covers the command it excuses.

The post-hook's triggers read the same trusted text, unanchored, so `xargs sed -i` and `timeout 120 gh pr merge` still get their follow-up. A rule that must fire on ANY occurrence stays unanchored and reads the raw text: `updateProjectV2Field`, the doubled-backslash heredoc and `/code-review … --fix` are the three, because there the damage is in the text the command carries rather than in the command being run.

## A `git -C <dir>` belongs to one command in a chain

`gitCwd(command, cwd, re)` reads the `-C` off the segment (split at `&&`, `||`, `;`, `|`, newline in the trusted-masked text) that the rule's own regex matched, and finds each `cd` and `-C` in the masked text before reading its directory raw — so a `git -C ../master` quoted in a commit message moves nothing. Reading the first `-C` anywhere is how `git worktree add ../ir-N … && git -C ../ir-N log` resolved the new tree against itself, failed the repo-root lookup in a directory that did not exist yet, and was denied as "inside the repo". The `mainRoot` fallback in `pre-bash.mjs` is the second half of that fix: a dir git cannot answer for falls back to the session's repo root, never to the dir itself.

The post-hook's worktree trigger reads its target through the rule's own `worktreeAddTarget`, so the card that moves is the tree the rule judged, and a command that merely mentions the shape moves none. The rule's naming check, its spec gate and the trigger all read the issue number through `issueFromWorktreePath`, off the resolved path's last segment — the directory the add creates (#1358). An `ir-<n>` higher up is not the new tree, and reading the first one moved its card instead. The rule also requires a true sibling of the main checkout rather than only a path outside it, since `mainRoot` is the main checkout even when the add runs inside another `ir-*` worktree.
