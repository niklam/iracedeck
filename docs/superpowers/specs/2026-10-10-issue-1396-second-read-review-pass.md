> **Issue:** [#1396](https://github.com/niklam/iracedeck/issues/1396) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# A second read after the code review

The issue carries the problem and the list of defects the backtest found. This spec settles what the second read is, when it runs, how its findings are handled, what it remembers, and how it is judged — and records the measurements those choices rest on.

## What was measured

On 2026-10-10 a reviewer agent was run blind on eleven merged PRs, each at the commit CodeRabbit had reviewed, reading only git objects at that commit. Its report was scored against the major findings CodeRabbit had raised on that commit, and every further finding it rated major was checked against the code.

| Round | Brief | PRs | CodeRabbit majors re-found | Further findings | Tokens |
| --- | --- | --- | --- | --- | --- |
| 1 | strict: report only what is reachable | #1150, #1154, #1189, #1198, #1368 | 1 of 8 | 4 major, 4 minor | 1.27M |
| 2 | revised: report every confirmed mechanism, state its reach | #1093, #1121, #1174, #1178, #1313, #1360 | 4 of 10 | 27, nearly all narrow | 1.33M |

Three things in those numbers decide the design.

- **It does not do CodeRabbit's job.** 5 of 18 across both rounds. What it missed is operational hygiene (a `curl` with no timeout, workflow permissions, a release flag) and domain edge cases (a player holding a stray pace line).
- **It finds what the other two do not.** Of the further findings checked, none was wrong and two could not be settled without the simulator or a reproduction: seven are filed as #1390–#1395, and three more had already been found the hard way and fixed (the pnpm pin on the voice-pack publish path, which two reviewers reached from two different PRs, and two merge-gate parsing holes closed by #1321). Eighteen of round two's twenty-seven were not checked.
- **The first brief saw the defects and talked itself out of them.** In round one the reviewer noticed six of the seven majors it did not report, and dropped each: a code comment called the cost accepted, the window was small, today's callers did not reach it, or the ordering was blamed on the simulator. Each of those had been fixed when CodeRabbit raised it, one of them in part. The filter was stricter than the maintainer's own bar.

The measurement has limits, stated so nobody reads more into it. Eleven PRs is a small sample, and nine of them are tooling. The brief's questions were written after the September–October findings had been seen, grounded in July–August ones. The agents loaded today's rule files, which describe later fixes to the hooks; the one hit on #1313 may have been helped by that.

## Decisions

### 1. A different method, not a second full review

`code-review.md` allows a branch exactly one full read, and names a second full-branch reviewer as the duplicate to avoid. That rule rests on #1066, where five scoped re-reviews cost 1.2M tokens and found nothing. The second read is admitted as the one named exception because it is not the same read again: it does not look for bugs in general. It lists the changed behaviours, then puts each through a fixed set of questions about ordering, lifecycle, mid-way failure, mistimed state, bad values, checks that let something through, missing siblings and external commands, and reports only what it can turn into a concrete trigger sequence. The backtest is the evidence that this finds something the full read does not; the exception stands only while that stays true (decision 7).

### 2. It runs on three kinds of diff, by the coordinator's judgement

The second read runs when the branch's diff changes any of:

- **a gate or guard** — `scripts/claude-hooks/**`, the guard tests under `scripts/` and the `scripts/lib/` modules they read, the settings window's request guard and server, lint rules that enforce a boundary;
- **a build, release or publish path** — `.github/workflows/**`, the build, release and publish scripts under `scripts/`, `turbo.json`, `packages/plugin-build/**`, a new package or a changed workspace dependency edge;
- **a state machine** — `packages/sim-events-iracing/src/**`, the interpreter and catalog in `packages/audio-scenarios/src/**`, the settings store and migrations, `packages/replay-store/**`, the audio device lifecycle.

It does not run for prose, icons, regenerated artifacts, PI templates or mechanical renames. Actions and their dial surfaces are not on the list because the backtest covered none; the coordinator may run it on one that adds a state machine of its own.

This is a judgement and stays prose. A path list in a hook would fire on a one-line comment edit under `scripts/` and stay silent on a state machine added somewhere unlisted. The coordinator says, in the same place it names the `/code-review` level, whether a second read applies and which of the three kinds the diff falls under.

### 3. After the code review's findings are applied, before manual testing

It reads the code that will be tested and shipped, so it runs once the `/code-review` findings that hold have been applied. Running it first would spend it on defects the full read catches anyway, and a fix round after it would leave the final code unread by it.

### 4. One agent, `opus`, read-only, pointed at the worktree

One fresh agent per run, on `opus` (a review that weighs a claim against the code), told to edit nothing, given the worktree path and `origin/master...HEAD`. It reads the working tree normally; the git-objects-only reading in the backtest existed to hide later fixes and has no purpose on a live branch. A wide diff is still one agent: the brief tells it to skip generated files and spend its effort on what carries logic, which is how #1174's 1,221-file diff was read.

### 5. The brief reports every confirmed mechanism and states its reach

The full brief lives in the skill. Its reporting rule is the part the backtest changed, and each clause answers one way the first brief failed:

- A finding is reported when the mechanism is confirmed in the code, however narrow its reach. Reach ("reachable now", or "narrow" with the condition that exposes it) is stated beside it, never used to drop it.
- Text written or changed in the same diff — a comment, a rule file, a doc — is part of what is under review. It cannot excuse a finding. The reviewer quotes it and says what the accepted cost concretely is.
- Before blaming an ordering on the simulator or an external system, the reviewer looks for a way the user or developer alone can produce it.
- A candidate is dropped only when the mechanism is false.

What it still does not report: a deviation that sibling code outside the diff also makes, anything the diff did not introduce, the rules of tools this repo does not run, product behaviour that a spec or rule the diff did not touch calls deliberate, and style.

The cost of this rule is noise: round two averaged four to five further findings per PR. Decision 6 is what keeps that from reaching the maintainer.

### 6. The coordinator verifies every finding before anyone else sees it

Findings are candidates, as with `/code-review`. The coordinator checks each against the code, and then:

- **reachable now, and it holds** — fixed on the branch before manual testing;
- **narrow, and it holds** — fixed on the branch when the fix is small and inside the change's scope; otherwise filed as an issue, or declined with the reason;
- **does not hold** — declined, and if it is a class the reviewer will raise again, recorded (decision 8).

The maintainer hears the tally and anything that needs a decision, never the raw report. The PR body carries one line: how many findings the second read raised, how many were applied, how many filed.

### 7. It is removed if it stops finding things

After ten runs on real branches, count the findings that held. If none did in those ten, the exception in decision 1 is withdrawn and the skill deleted. The count comes from the PR bodies' one-line tallies. Ten is chosen because the backtest averaged more than one held finding per PR on diffs of these kinds; ten empty runs would mean the real work does not look like the backtest.

### 8. What it remembers is a committed file, and only what changes the next run

`.claude/skills/second-read/learnings.md` is read by the reviewer at the start of every run. An entry is one line with the PR it came from, and there are two kinds:

- **a miss** — a defect of this class that CodeRabbit, a later bug or the maintainer found on a diff the second read had run on. If it shows a question is missing, the question is added to the brief and the entry says so. Round one's missed `git ls-tree` call is the pattern: it became the question about external commands.
- **a non-finding** — a class of finding that was raised, checked and declined for a reason that will hold again, so it is not raised a third time.

A run that teaches nothing adds nothing. The file is committed with the skill rather than kept in an agent's private memory, because every session and every maintainer's machine must read the same record, and because a change to what the reviewer is told should be visible in a diff. It is seeded from the backtest: the misses in the table above, and the classes of finding declined in CodeRabbit threads before September (a consistent repo convention, a defect the diff did not introduce, hardening against our own build output).

## Rejected alternatives

- **Replacing CodeRabbit with it.** 5 of 18. It would also need an identity that can approve a PR, which the author's own token cannot, and a rewrite of the merge gate.
- **Running it on every PR.** About 220k tokens and ten minutes a run, plus the triage of what it raises. The diffs it paid off on are the three kinds in decision 2.
- **Keeping the strict brief.** Quieter, and it reported one of eight while seeing seven.
- **Folding the questions into `/code-review`.** That skill is not ours to edit, and one pass asked to do both reads the diff once with the general read's anchoring.
- **A hook that requires it.** When it applies is a judgement (decision 2), and `hooks.md` keeps judgement in prose.
- **Running it in CI as a bot.** A different project: an identity, a token budget, and a place for its findings to go. Nothing here rules it out later.
- **Keeping the learnings in agent memory.** Private to one machine, and invisible to review.

## Out of scope

- Any change to CodeRabbit's role, to the merge gate, or to how often CodeRabbit reviews. #1386 and #1388 own those.
- Any change to the `/code-review` effort table or to when the full read runs.
- Checking the eighteen backtest findings that were not verified. They were raised against old commits; the ones that still matter will be raised again when those files next change.
- A reviewer for the classes this one misses (operational hygiene in workflows, domain edge cases).

## Testing

The step is prose and a prompt, so it is proven by use rather than by a suite.

- **The backtest above is the acceptance evidence for the brief.** Its eleven reports, the answer key and the scoring are summarised in the table; the brief committed in the skill is the round-two text.
- **A positive control before the PR.** Run the committed skill once, end to end, on the worktree that adds it against a known case: the #1391 commit (`973822ca4`, the spec gate) with the brief's reading rules restored to git-objects-only. It must report the title-matches-Testing defect. A skill that cannot re-find what its own backtest found is not the skill that was measured.
- **The rule edits are shown in full and approved** before the PR, which is the manual-test gate for a rules change.
- **`pnpm test scripts/claude-rules-frontmatter`** passes: `code-review.md` and `issue-workflow.md` are always-loaded, so the additions stay short and the always-loaded set stays under its limit.
- **Decision 7 is the continuing check**: the ten-run count.

## Rules and docs that change

- `.claude/skills/second-read/SKILL.md` and `learnings.md` — new.
- `.claude/rules/code-review.md` — rule 4 of *How reviews are staged inside an issue* names the second read as its one exception and points at the skill; a short section says which diffs get one.
- `.claude/rules/issue-workflow.md` — step 7 and its paragraph name it, between applying the review's findings and manual testing.
