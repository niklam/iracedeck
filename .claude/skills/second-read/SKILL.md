---
name: second-read
description: Use after /code-review has run and its findings are applied, when the branch's diff changes a gate or guard, a build, release or publish path, or a state machine. Runs one read-only reviewer that hunts defects that are only wrong for a particular order of events, failure or input. Not a replacement for /code-review or CodeRabbit, and not for prose, icons, generated artifacts, PI templates or renames.
---

# Second read

A second, differently shaped review pass. The `/code-review` and CodeRabbit both read a diff in general; this one lists the changed behaviours and puts each through fixed questions about ordering, lifecycle, mid-way failure, mistimed state, bad values, leaky checks, missing siblings and external commands. Design record and the measurements behind every rule here: `docs/superpowers/specs/2026-10-10-issue-1396-second-read-review-pass.md`.

It finds a different class from the other two, and it misses most of what they find. Never run it instead of either.

## When it runs

After the `/code-review` findings that hold are applied, before manual testing, when the branch's diff changes any of:

- **a gate or guard** — `scripts/claude-hooks/**`, the guard tests under `scripts/` and the `scripts/lib/` modules they read, the settings window's request guard and server, lint rules that enforce a boundary;
- **a build, release or publish path** — `.github/workflows/**`, the build, release and publish scripts under `scripts/`, `turbo.json`, `packages/plugin-build/**`, a new package or a changed workspace dependency edge;
- **a state machine** — `packages/sim-events-iracing/src/**`, the interpreter and catalog in `packages/audio-scenarios/src/**`, the settings store and migrations, `packages/replay-store/**`, the audio device lifecycle.

Not for prose, icons, regenerated artifacts, PI templates or mechanical renames. An action is not on the list; run it on one only when the action adds a state machine of its own.

The list is a judgement, not a path filter: a comment edit under `scripts/` does not need one, and a state machine added somewhere unlisted does. Say which of the three kinds the diff is when you announce the review.

## How to run it

1. Note `git status --porcelain` in every worktree, so a tree the reviewer dirtied is visible afterwards.
2. Spawn **one** agent — `general-purpose`, `model: "opus"`, no isolation — with the brief below, `WORKTREE` filled in. One agent even for a wide diff; the brief tells it what to skip.
3. Verify every finding against the code yourself. A finding is a candidate, exactly as with `/code-review`.
4. Dispose of each:
   - **reachable now, and it holds** — fix it on the branch before manual testing;
   - **narrow, and it holds** — fix it on the branch when the fix is small and inside the change's scope; otherwise file an issue, or decline it with the reason;
   - **does not hold** — decline it; if the reviewer will raise the same class again, add a non-finding line to `learnings.md`.
5. Tell the maintainer the tally and anything that needs a decision. Never forward the raw report.
6. Put one line in the PR body: `Second read: N findings — A applied, F filed, D declined.`
7. Check every worktree's `git status --porcelain` against step 1.

Expect about ten minutes and roughly 220k tokens.

## The brief

Give the reviewer this text, with `WORKTREE` replaced by the absolute path of the issue's worktree.

```text
You are the second reader of a change that has already had a general code review. Do not repeat that review. Your job is the class of defect a general read misses: behaviour that is only wrong for a particular order of events, a particular failure, or a particular input.

READ-ONLY. Edit nothing, run no build or test, do not spawn other agents.

WHAT TO READ
The change is `origin/master...HEAD` in the worktree at WORKTREE. Start with `git -C WORKTREE diff --stat origin/master...HEAD`, then read the diff and whatever surrounding code you need, in that worktree only — never in the master checkout or another ir-* worktree.
First read WORKTREE/.claude/skills/second-read/learnings.md: the misses are classes to look for, the non-findings are classes not to raise.

METHOD
1. Read the diff. Skip generated artifacts, audio clips, capture fixtures and prose. List the changed BEHAVIOURS, not the files: each unit that holds state, makes a decision, or guards something.
2. For each one write down: what state it holds, who writes it, which events or callers reach it, and what it promises its callers.
3. Put each behaviour through the eight questions below. When one suggests a problem, read the surrounding code (callers, sibling implementations, the rule file) until you know whether the MECHANISM is real: the code really does the wrong thing when the sequence happens.

THE EIGHT QUESTIONS
1. Out of order. Two calls in flight, a result arriving after a newer request, an event landing between a read and the write that depends on it. Which one wins, and is that the right one?
2. Lifecycle. Disconnect and reconnect, a second initialise, teardown after a start that failed. What is still subscribed, cached or half-built?
3. Failure in the middle. A step throws, a callback rejects, the process is killed between two writes. Is success still reported? Does a loop or queue stop for everyone behind it? Is the state left consistent and retryable?
4. State changed at the wrong moment. State written as a side effect of deciding (inside a predicate or filter), consumed on a path that then bails out, or shared across occurrences when it belongs to one.
5. One bad value. A malformed, non-finite, empty or missing field, or one that is valid but unusual. Is it refused on its own, or does it take down what sits beside it? Does the code say something untrue about it?
6. A check that lets something through. For a guard, validator, filter, parser or gate: write down what it must refuse, then look for an input of that kind it accepts — another spelling, another option, another way to reach the same effect.
7. The Nth instance. Where the diff adds another instance of an existing pattern, does it do everything the existing ones do (scoping, construction, registration, dependency declaration, layer boundary)?
8. External commands. For each call the diff adds to an external tool (git, gh, curl, tsc, ffmpeg, npm, rollup, the shell): write down exactly what it returns for the arguments the code gives it — for a directory, an empty result, a non-zero exit, a hang — and check the code handles that shape, and that every option that changes its behaviour is accounted for.

WHAT TO REPORT
Report every finding whose MECHANISM you have confirmed, however narrow its reach. Reach is reported, not used as a filter:
- Do not drop a finding because the window is small, because today's callers happen not to trigger it (startup order, a queue that is empty in production, a list with one entry), or because it needs an unlucky interruption. Report it and state the condition that exposes it.
- Do not drop a finding because a comment, rule file or doc says the cost is accepted, when that text was written or changed in this same diff. That text is the author's own view of the change under review, not evidence. Report the finding, quote the text, and say concretely what the accepted cost is.
- Before attributing a required ordering to an external system or the simulator, look for a way the user or developer alone can produce it: a second press inside a debounce window, two commands in one chain, an edit between two steps.
Drop a candidate only when the mechanism is false — the code does not do what you suspected.

STILL DO NOT REPORT
- A deviation from general best practice that sibling code outside this diff also makes. A consistent convention is a decision.
- Anything the diff did not introduce or change.
- Rules of tools this repo does not run (markdownlint, stylelint).
- Product behaviour that a spec or rule file NOT touched by this diff says is deliberate.
- Style, naming, comments, missing tests.
- Anything you have not confirmed by reading the code. If a claim rests on how the simulator or an external tool behaves, say so and mark it medium.

REPORT (your final message; it is read by the coordinator, not shown to the user)
"Reachable now" findings first, then the narrow ones. For each:
  file:line | which question
  Consequence: major or minor — judged by what happens IF it triggers. major = wrong behaviour the user or maintainer would hit, or a gate accepting what it should refuse.
  Reach: "reachable now" or "narrow: <the condition that exposes it>"
  Trigger: numbered steps from a starting state to the wrong result
  Confirmed by: what you read that establishes each step
  Confidence: high or medium
Then "Dropped, mechanism false": one line each.
Finally one line confirming you edited nothing.
No findings is a valid result. Do not pad.
```

## Changing the brief

The brief is the text that was measured, so a change to it is proven the way the original was: run it blind on a past commit whose defects are known and see whether it still finds them.

For a blind run, replace the `WHAT TO READ` paragraph with a base and head sha and restrict the reviewer to git objects at those two commits (`git diff <base> <head>`, `git show <head>:<path>`, `git grep <pattern> <head>`), forbidding the working tree, `git log`, `gh` and the network — the working tree holds the later fix. The standing known case is `b3b0b5857..973822ca4`: the reviewer must report that the spec gate's Testing check is satisfied by a title containing the word (#1391).

A question is added when a miss shows one is absent, never to make the list feel complete.

## What it remembers

`learnings.md`, beside this file, is read by the reviewer at the start of every run. One line per entry, with the PR it came from:

- **a miss** — a defect of this class that CodeRabbit, a later bug or the maintainer found on a diff the second read had run on;
- **a non-finding** — a class of finding that was raised, checked and declined for a reason that will hold again.

A run that teaches nothing adds nothing. Keep it short enough to read in a minute; when two entries say the same thing, merge them.

## When it stops

After ten runs on real branches, count the findings that held (the PR bodies' tally lines). If none did, remove this skill and the exception for it in `.claude/rules/code-review.md`.
