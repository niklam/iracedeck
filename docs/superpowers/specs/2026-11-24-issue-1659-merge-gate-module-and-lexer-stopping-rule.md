# The merge gate as its own module, and the hook lexer's stopping rule

> **Issue:** [#1659](https://github.com/niklam/iracedeck/issues/1659) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Related: #1590 (the first split), #1606, #1607, #1634, #1646 (the four spelling classes), #1783, #1787, #1789, #1739 (the open lexer follow-ups this rule disposes of).

## Context

The issue carries the what and why: `rules-bash.mjs` again holds the merge-gate verdicts and the spec-heading grammar beside the Bash rules, the merge gate's git and gh reads sit in `lib.mjs` with the board helpers, and `shell-lexer.mjs` has grown by one command-spelling class per fix (630 lines at #1590's split, 4,178 on `master` at `0b3d1ab11`). This spec decides three things: the shape of the merge-gate module, how "no behaviour change" is proven, and the lexer's stopping rule, including whether it is applied to #1646's class here.

## Evidence: what agents actually type

The stopping rule is about which forms are worth reading, so it was measured rather than argued. Every Bash and PowerShell tool call recorded in the iRaceDeck session transcripts on this machine (1,305 transcripts, 54,199 distinct commands, 2026-11-24) was read through `master`'s `view()`. Commands written to probe the hooks (QA and review runs: PR numbers like `999999`, `stubcheck` stubs, `ir-integration` and `dev:voices` probes, `\x` escapes) were counted apart.

| Form | Real commands | Probes |
| --- | --- | --- |
| `bash -c` / `sh -c` with one literal quoted string (gates under `timeout`, wait loops, scratch scripts) | 306 | 24 |
| `powershell -Command "…"` | 44 | 3 |
| `cmd /c "…"` | 35 | 4 |
| `find … -exec` | 42 | 0 |
| a program word that expands (`$PY x`, `"$FF" …`), judged by stand-ins since #1606 | 371 | 26 |
| `echo` / `printf` piped into a shell (the lexer's piped-stdin feeds are the same commands) | 0 | 7 |
| a shell reading a script from a here-string or a heredoc | 0 | 0 |
| `eval` | 0 | 1 |
| `sudo`, `pwsh -c` | 0 | 2 |
| a reprinted printer, an unclosed lead, an unprintable printer | 0 | 3 |

The classes #1634 and #1646 taught the lexer to read — a printer feeding a shell, `eval` joining words, a here-string or stdin script, ANSI-C and spliced spellings inside a fed string — were typed only by the hook's own QA and reviewers, with one exception the corpus replay found during implementation: a level-1 string spliced with an outer expansion, which is read (Decision 4, item 3). The one-level shell string and the expanding program word are real and common, and must keep being read.

## Decision 1: the merge gate is a pure module and an impure reader beside it

- **`scripts/claude-hooks/merge-gate.mjs`, pure.** It exports the gate's verdict, `mergeGateVerdict(command, ctx)`: the whole body of today's `gh pr merge` rule, with `unreviewedHeadVerdict`, `adminQualifies`, `adminVerdict`, `traceSummary`, `classifyCheck`, `coderabbitReviews`, `plainMergePrefix`, the Dependabot and committer constants, and the gate's reading of its own command (`GH_PR_MERGE`, `MERGE_AT`, `mergeSegments`, `mergeMentions`, `parseMerge`, `firstMerge`, `carriedMerge`, `MERGE_VALUE_FLAGS`). Every git and gh read reaches it through `ctx`, exactly as today, so its tests stay pure.
- **`scripts/claude-hooks/merge-gate-reads.mjs`, impure.** `replayRebase` with `pinnedGit`, `fetchMissingCommits` and `soleMergeBase`, `prChangedFiles`, `requiredStatusChecks`, `baseChangedSince` and `prComments` move out of `lib.mjs`, built on `lib.mjs`'s `run`, `ghJson` and `ghGraphql`, which stay. `pre-bash.mjs` wires them into `ctx` as now. `lib.mjs` keeps the stdin payload, the verdict JSON, the generic `git` / `gh` runners and the board helpers.
- **Two files, not one**, because the repository's split is pure rules over an impure edge (`rules-*.mjs` over `lib.mjs`); a module that both spawns processes and decides would lose the pure tests that make the gate reviewable at `xhigh`.
- **`rules-bash.mjs` keeps one line for the gate**: its rule entry delegates to `mergeGateVerdict`, in the same position in `rules`, so rule order — which deny is reported first, and deny-beats-ask — is unchanged.
- **Imports run one way**: `rules-bash.mjs` → `merge-gate.mjs` → the leaves it already uses (`shell-lexer.mjs`, `coderabbit-summary.mjs`, `change-signature.mjs`, `no-review-paths.mjs`, `rules-post.mjs`). `merge-gate.mjs` imports nothing from `rules-bash.mjs`. The word helpers `parseMerge` shares with `parseIssueEdit` (`segmentTokens`, `literal`, `plainValue`) go to `shell-lexer.mjs`, which already owns words, so neither rule module imports the other. `post-bash.mjs` and `rules-tools.test.mjs` import `firstMerge` from `merge-gate.mjs`.
- **Tests move with their code**: the merge-gate cases out of `rules-bash.test.mjs` into `merge-gate.test.mjs`, the reader cases out of `lib.test.mjs` into `merge-gate-reads.test.mjs`, unedited apart from their imports.

## Decision 2: the spec-heading grammar is its own pure module

`scripts/claude-hooks/spec-sections.mjs`, named for the rule that documents it (`spec-sections.md`): `SECTION_NAMES` and the heading builders, `SPEC_SECTIONS`, `SPEC_HEADER`, `LINE_LEAD`, `withoutInertBlocks`, `headingName`, `specHeadings`, `missingSpecParts` and `specExistsFor`, with `spec-sections.test.mjs`. The spec-commit rule stays in `rules-bash.mjs` and imports it. `TITLE_RE` (the PR title) is not spec grammar and stays.

## Decision 3: "no behaviour change" is proven by replaying the real corpus

#1590 proved its split on 63 recorded payloads. This one replays every distinct command in the local transcripts, the 54,199 above, through `checkBash` of the base and of the branch with one fixed context (no staged files, no linked host, every gh read failing), and requires identical verdicts, byte for byte. The suite is the second proof: every moved test passes unedited, and the test count is the same before and after. The replay is committed as `scripts/claude-hooks/replay-corpus.mjs`, a developer tool (no test runs it, since the corpus is private to the machine): it reads `~/.claude/projects/*/**.jsonl`, writes nothing into the repository, prints counts and the changed verdicts, and also prints the form census above. The stopping rule needs that census to be repeatable, and every later lexer change needs the replay.

## Decision 4: the lexer's stopping rule

**The lexer reads the forms agents type here, and refuses every other form that hands text to a shell.** A form is "typed" when the census finds it in commands that were not probes; it is read exactly, with tests. Anything else that a guard would have to model a second shell, a printer or a decoder to read is denied outright with one message — type the command directly, or write it to a script file — and none of its spellings is learned. The pre-hook is a safety gate that errs to deny; the census says this deny costs agents nothing.

Read (normalised), as today:

1. The program word at the typed level in any literal spelling: a path, an `.exe` / `.cmd` / `.ps1` suffix, case, quotes around the whole word, PowerShell's `&` and dot-source (#1606).
2. A wrapper that runs a program word: `timeout`, `nice`, `env`, `command`, `exec`, `nohup`, `time`, `stdbuf`, `winpty`, `xargs`, `find -exec`.
3. One level of shell string, given as a single quoted argument of `bash` / `sh` / `zsh` / `fish` `-c`, `powershell` / `pwsh -Command`, `cmd /c`, or `su -c`, read with that shell's quote removal (`'…'`, and `"…"` with its `\"`, `\\`, `\$`, `` \` `` escapes), including a string spliced from quoted pieces and outer expansions (`'…'"$VAR"'…'`), re-opened on 7 real commands in the census (wait loops and CI waits under `timeout N bash -c`, 4 of which the refusal would have turned from pass to deny).
4. A program word that expands (`$PY`, `"$FF"`), judged as `gh`, as `git` and as a wrapper (#1606, #1646), since it is common.
5. A directory change with a literal target: `cd`, `Set-Location`, `pushd` / `popd` as a stack, `git -C`, a runner's `-C` / `--dir`. A target that expands, `~`, `cd -`, a bare `pushd` or a `popd` with nothing pushed makes the directory unknown, and the rules that read it err to deny or ask, as for a final-stage `cd` since #1646.

Refused outright, whatever the text holds:

- a printer (`echo`, `printf`) piped into a shell;
- a shell reading its script from stdin, a here-string or a heredoc, a stream (`/dev/stdin`, a descriptor, `pwsh -`), a process substitution (`bash <(…)`, `source <(…)`, a startup file given as one), or an encoded string (`powershell -EncodedCommand`);
- `eval`;
- a `sudo` that runs a shell (`-s`, `-i`, `--shell`, `--login`, or a shell word);
- a shell string that is not one plain level: an ANSI-C `$'…'` or locale `$"…"` string, a string inside a string (a shell feed found inside a level-1 string), and a substitution inside a level-1 string at command position;
- a program word inside a level-1 string whose text is not its name after quote removal (an escape, a splice or an expansion in it);
- a shell string that `xargs -I`, `parallel` or `find -exec` fills from its input (`xargs -I{} sh -c '…{}…'`, `find … -exec sh -c '…{}…' \;`). The input text is substituted before the shell parses the string, so an input line can carry a whole command wherever `{}` sits, and no reading of the string is sound. This is the one refusal that changes real verdicts: 3 commands in the census (worktree inspections, `find … | xargs -I{} sh -c 'echo "== {}"; cat {}'`). It is not re-opened, because the agent can type it another way at the cost of one word: `xargs -I{} sh -c 'cat "$1"' _ {}` or `find … -exec sh -c '…' _ {} \;` passes the input as data and stays read. The refusal's message names that spelling (PO, 2026-11-24).

**A refused form can be re-opened, for one form only**, when the census or a session shows a real, non-probe command of it refused and the agent cannot reasonably type it another way. It is then added to the read list here, with its tests and a census count in the PR. A spelling found by a probe or a review alone is answered with a refusal, never a reader.

**Applied to #1646's class in this issue.** The issue asks to apply the rule or record why the class is worth normalising; the census answers that it is not. So the readers that exist only for refused forms are deleted and replaced by the refusal: the printer model (`printed`, `reprinted`, `unprintable`, echo's option and escape reading, `joinedLevel`), `eval` word joining, here-string and stdin-script reading, ANSI-C level decoding, and level reading below level 1. The quote removal that joins a spliced level-1 string stays, since that form is read (item 3). The detection stays, since the lexer must still find a feed to refuse it: `programKind` already reports `how: "shell"` with `via` and `stdin`. This change is the one behaviour change in the issue. It lands as its own commit after the two moves, and only in the direction of refusal: the corpus replay must show no non-probe command changing verdict apart from the 3 `xargs -I` fills named above and one correction: a quoted heredoc body written to a file is data, no longer misread as commands because a later element runs a shell on another file (2 commands of #1646's QA, deny to pass; a heredoc a shell runs is still refused), and the PR lists every probe verdict that changed. If the replay finds a real command the refusal would catch, that form goes on the read list and the PO is told before the commit.

**What this does to the open follow-ups**, for the PO to re-scope them:

| Item | Disposition under the rule |
| --- | --- |
| #1783 1 (a `$(…)` in a fed string) | Not closed. A `$(…)` at command position in a level-1 string is refused here, but one in argument position is read (106 real commands use one), so reading it correctly is part of #1783's level-1 argument reading |
| #1783 2–4 (a pipeline into a shell inside a string, an escaped program name in a string, printf literal text before `%s`) | Refused outright; closed by this issue's refusal commit |
| #1783 comment (arguments read from the raw text in a fed string) | Still due, for level 1 only: the rules read their arguments from the quote-removed level-1 text. Stays #1783, much smaller |
| #1787 1, 4, 5 (octal `%d`, `echo --`, printf output owner range) | The code they misread is deleted; closed here |
| #1787 2 (`-C` inside a `-c` value in a level-1 string) | A misread of a read form: fix in #1787 |
| #1787 3 (PowerShell refusal names a garbled program) | Message only: fix in #1787 |
| #1787 comment (redirect target `-E`, quoted `pipefail`, a `\x7c` pipe, a redirected printer) | The printer and `$'…'` items are deleted with their code; the quoted or commented `pipefail` excusing the piped-pnpm reminder is a read form: fix in #1787 |
| #1789 (`pushd`, `popd`, `cd -`, an expanding `cd`, `~`) | Rule item 5: follow a literal stack, unknown otherwise. Stays #1789 |
| #1789 comment 1 (`bash -c $'git\x20push …'`, `bash -c "git push origin 'integ'ration"`) | The `$'…'` form is refused here; the spliced refspec in a plain string is argument reading, #1783 |
| #1789 comment 2, 3 (`false && cd` in a string, a printer's repeated `cd`) | 2 is a read form, #1789; 3 is a printer, refused here |
| #1739 (a labelled PowerShell `do` loop) | A read form PowerShell sessions may type: stays #1739 |

## Decision 5: the merge gate's prose moves with it

`hook-internals.md`'s *The merge gate* section moves to a new path-scoped rule, `.claude/rules/hook-merge-gate.md`, loaded with `scripts/claude-hooks/merge-gate*.mjs`, `coderabbit-summary.mjs`, `change-signature.mjs` and `no-review-paths.mjs`. The stopping rule is written into `hook-internals.md` as its own section, ahead of the lexer's mechanics, which shrink with the deleted readers. `CLAUDE.md`'s rule list, `scripts/CLAUDE.md`'s module map and any `hooks.md` row that names a moved file are updated in the same change.

## Out of scope

- Any change to what the merge gate decides. Its verdicts, messages and read order are moved, not edited.
- New readers: no spelling class is learned here.
- #1783's level-1 argument reading, #1787 items 2 and 3 and its quoted-`pipefail` item, #1789's directory stack and #1739: decided above, done in their own issues.
- A script file a shell runs (`bash run.sh`): the hook does not read files, as before.
- Running the corpus replay in CI: the transcripts are local and private.

## Testing

- **Suite.** Every moved test passes unedited apart from its imports, and the per-file counts add up to the same total before and after the moves. The refusal commit adds a test per refused form, each with a positive control that it is refused and failing on the code before it (`printf … | bash`, `echo … | sh`, `bash <<< …`, `bash <<'EOF'`, `eval …`, `sudo -s …`, `bash -c $'…'`, a splice inside the program word (`bash -c 'g'"h"' pr merge 7'`), a nested `bash -c "sh -c '…'"`, a `$(…)` at command position in a string, an escaped program word in a string), and keeps a test per read form proving it is still read (`timeout 1500 sh -c 'pnpm install && pnpm build'`, `timeout 600 bash -c 'until gh run view '"$RUN"' …; do …; done'`, `powershell -NoProfile -Command "…"`, `cmd /c "…"`, `find . -exec …`, `$PY x`).
- **Corpus replay.** `replay-corpus.mjs` over the local transcripts, base against branch: zero changed verdicts after each move commit; after the refusal commit, zero changed verdicts on non-probe commands and the changed probe verdicts listed in the PR.
- **Live fire** (`hooks.md` rule 6, by `qa`). In a live session on the branch: a plain `gh pr merge` of a test PR number is judged by the moved gate with the same refusal text as on `master`; a spec commit missing a section is denied by the moved grammar; `echo 'gh pr list' | bash` and `bash -c $'echo hi'` are refused with the new message; `timeout 60 sh -c 'pnpm --version'` runs.
- **Review.** `/code-review xhigh` (a gate), then the second read (a gate), then the CodeRabbit CLI round.
