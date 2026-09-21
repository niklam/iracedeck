> **Issue:** [#1193](https://github.com/niklam/iracedeck/issues/1193) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Two spec rules become mechanical, and one stale template goes

## What was measured

Every spec in `docs/superpowers/specs/` (106) was classified, split at the #621 policy date — 42 authored before 2026-08-25 over roughly five months, 64 after it in 27 days. Detection was by heading at any level plus bold pseudo-headings, and each finding was re-run against the body text so that a result does not rest on one regex. 53 issues carrying a post-policy spec were read through the GitHub API, and every first-parent commit on `master` since the policy was walked.

**What the policy asked for is being done.**

| Property | pre | post |
| --- | --- | --- |
| Header block (`> **Issue:** … Supersedes … Superseded by`) | 0/42 | 63/64 (98 %) |
| Issue number in the filename | 9/42 (21 %) | 64/64 (100 %) |
| Added by a commit on `master`'s first-parent line | — | 64/64 (100 %) |
| That commit touches no file outside `docs/superpowers/specs/` | — | 54/54 commits (100 %) |
| Spec commit timestamp precedes the implementation commit | — | 32/32, zero violations (32 unbuilt) |
| Spec linked from its issue (53 sampled) | — | 46/53 (87 %); since 2026-09-01, 35/35 (100 %) |
| Alternatives weighed and rejected, by body text | 8/42 (19 %) | 53/64 (83 %) |
| Alternatives, by section heading | 3/42 (7 %) | 42/64 (66 %) |

**Two properties went the other way.**

| Property | pre | post |
| --- | --- | --- |
| Out of scope — heading | 21/42 (50 %) | 11/64 (17 %) |
| Out of scope — body phrasing | 27/42 (64 %) | 26/64 (41 %) |
| Testing / Verification — heading | 37/42 (88 %) | 45/64 (70 %) |
| Testing / Verification — body mention | 40/42 (95 %) | 58/64 (91 %) |

**And one stated rule has no check at all.** Of the 56 issues labelled `enhancement` filed since the policy, 47 have a spec (84 %). Four of the nine without — #1033, #1140, #1158, #1185 — are ordinary open features, not exemptions.

`Supersedes` / `Superseded by` is used exactly once in 106 specs, #912 ↔ #1059, correct in both directions. That is under-use or correct use; nothing measurable separates the two, so it is left alone.

## The diagnosis this rests on, and the one it refutes

The intuition going in was that a step backed by a hook holds near 100 % and a prose-only step decays. **The numbers refute it.** Four prose-only rules sit at 98–100 % — the header block, the filename, the alternatives (7 % → 66 % by heading, 19 % → 83 % by body), and the spec link-back, which reached 100 % from 2026-09-01 onwards after seven misses in the four days immediately following the policy. Meanwhile the hooked PR-title rule was already 141/141 in the two and a half months **before** its hook existed, so it is no evidence for hooks either.

What separates the rows is whether `specs-and-plans.md` names the rule. Everything it states is at 98–100 %. Both decaying properties are named nowhere in `.claude/`.

They also decayed for a reason that is not neglect. The spec changed job. Pre-policy it was a design document written at implementation time: 42 in five months. Post-policy it is a decision record written at filing time: 64 in 27 days, **55 of them on days carrying three or more specs**, and **32 of 64 with no implementation commit at all**. A scope fence and a test plan are cheap in a document about work starting tomorrow and easy to skip in a backlog record for a callout nobody has scheduled.

The maintainer's ruling (2026-09-21) is that both are worth having anyway: the new spec shape is leaner than the old one, and those two sections are the part of the old shape worth keeping. Requiring them makes them checkable, and `hooks.md` rule 1 then puts them in a hook rather than in more prose.

## The issue/spec seam is working, and #1187 is the evidence

#1187 was read closely because it looks like the issue absorbing the spec's job. Its body carries the diagnosis, three stacked causes, and a rejected alternative ("No wording, seed or conditioning change removes 3"), and defers the open questions with "To decide when specced". Its spec then opens *"The issue carries the diagnosis."*

That is exactly the division `specs-and-plans.md` states — the issue took what-and-why, the spec took how-and-why-this-way, and neither restates the other. No change is warranted. The only deviation is that its spec link sits in a comment rather than the body, and that comment also carried three decisions the spec made beyond the issue's text. The comment is the better placement, so the rule's wording moves to meet it rather than the other way round.

## What ships

1. **`git worktree add ../ir-<N>` asks when no spec exists for #N.** The rule already parses that path for three other reasons, and it is the one moment where the issue number is known and implementation has not started. An **ask**, never a deny: the exemptions — bug reports, docs fixes, dependency bumps, hygiene sweeps — are judgement a regex cannot make, so the maintainer confirms in one keypress. Where labels are readable and carry no `enhancement` — a bug, a hygiene sweep, a dev-experience fix — it stays silent; labels that cannot be read ask. The specs are listed off `origin/master`, the ref the worktree is cut from and the one the freshness check has just confirmed, not off the local checkout: a spec a cloud session pushed is absent from a checkout nobody has pulled, and one written there but never committed has not reached master.
2. **`git commit` denies a spec it ADDS that is missing the header block, an Out-of-scope section or a Testing/Verification section.** The commit is where the file's content is knowable and the author is still holding it. Heading detection accepts the variants already in the corpus (`Out of scope` / `Non-goals` / `What this deliberately does not do`; `Testing` / `Verification` / `Tests` / `Manual verification`), because the house style has never been uniform and a rule that forces one spelling would rewrite 45 compliant specs' habits for nothing. A heading is a Markdown heading at any level or a line bold from end to end, with code fences stripped first; a paragraph that merely opens in bold is prose. The review of the first implementation found the looser reading: one corpus spec, #1145, had passed on a bold lead-in inside its Decisions with no test section at all.

   **The bytes checked are the bytes committed.** A plain commit takes a spec staged before the command from the index, so that is where it is read; a spec that a chained `git add`, `-a` or a pathspec commit takes is read from the working copy, since a chained add has staged nothing when the hook runs. A broad `git add -A`, `git add .` or `git add <dir>` is expanded against the modified and untracked files, so a new spec it stages is checked rather than invisible — and the existing spec-on-a-branch rule sees it too. Both came from CodeRabbit's review of #1198.

   **A spec already in `HEAD` is skipped, and that carve-out is explicit.** It was not in the first draft of this spec, which assumed "the commit only ever sees the file being committed" was enough to make the rule forward-only. It is not: running the finished check over the corpus showed **6 of 65 post-policy specs would pass it**, and **30 of the 64 have been amended at least once** — so without the skip, the next ordinary amendment of almost any existing spec would be denied until it grew two sections it was never asked for, on the exact path `specs-and-plans.md` protects with "before the work ships — edit freely". The hook therefore asks git whether the path is in `HEAD` and checks only what is new.
3. **The pre-#621 template leaves `.claude/agents/feature-planner.md`**, replaced by a pointer to `specs-and-plans.md`. It tells the planner to write `## User Stories` and `## Out of Scope` documents into `docs/`, with no issue number, no header block and no commit rule. It has produced one file in the repo's history — `docs/plans/2026-03-22-simhub-control-mapper-design.md`, in a third directory — and zero specs. Leaving it would give the required sections two homes, one of them wrong about every other part of the format.
4. **Three words in `specs-and-plans.md`.** "Add the master permalink to the issue body" becomes a link on the issue: a `/blob/master/` URL is not a permalink and 37 of the 45 linking issues use exactly that, and a comment is a legitimate — on the #1187 evidence, better — place for it.
5. **A deny anywhere beats an ask anywhere.** Item 1 is the first ask to sit ahead of most of the deny rules, and `checkBash` returned the first verdict, so a spec-less `worktree add` chained ahead of a denied shape asked, and confirming it ran the denied shape. The tag-push ask already had the same gap. A deny now returns at once and the first ask waits until every rule has run, which makes `hooks.md` rule 2 ("deny beats ask") true by construction rather than by list order.

## Out of scope

- **Backfilling the 53 post-policy specs with no Out-of-scope section.** The requirement is **forward-only**, like the naming convention #621 introduced and for the same reason: a shipped spec is frozen, and `specs-and-plans.md` already forbids retrofitting one. Forward-only is bought by the `HEAD` skip in item 2 above, not by the commit's narrow view — that was the first draft's mistake.
- **A hook on the spec link-back.** 35/35 since 2026-09-01. The only enforcement point is the same `worktree add`, where it would fire mostly on issues that already carry the link.
- **A hook on the changelog.** 32 of 42 user-facing merges since the policy touched `changelog.mdx`; all ten that did not are `kind: hygiene` / `kind: dev-experience` or internal (`fix(hooks)`, `fix(turbo)`, `fix(build)`), which `changelog.md` already exempts. A regex cannot see the exemption, so the rule would be a false-denial generator.
- **A hook on the header block, the filename or the `-design` suffix.** 98–100 % post-policy, and the single miss (`2026-08-25-issue-1035-…-design.md`) was committed on policy day — a boundary artifact, not a trend. The header block rides along in this change only because the commit hook is reading the file anyway.
- **`Supersedes` / `Superseded by`.** Whether more pairs are owed is judgement no regex reaches.
- **Rewriting the nine unspecced `enhancement` issues.** Five are exemptions; the four that are not are open, and the worktree ask catches each one the moment anyone picks it up.

## Testing

- `scripts/claude-hooks/rules-bash.test.mjs` gains cases for both guards, run by `pnpm test scripts/claude-hooks`: a worktree add with no matching spec asks; one with a matching spec passes; a hygiene-labelled issue stays silent; a commit of a spec missing each of the three required pieces denies, naming which; a compliant spec passes; an unreadable spec passes (fail open).
- The existing `passes("git commit -m x", …)` case for a spec on master is what pins the fail-open contract — the injected context returns no text for the file, and the rule must not deny on that. Its survival unchanged is the regression test for the whole content path.
- The corpus itself is the check on the section regexes rather than only the fixtures: running `missingSpecParts` over all 65 post-policy specs must flag the 59 that lack a section and pass the 6 that do not, and this spec must pass its own gate.
- A chained command matching both an ask rule and a deny rule denies, in either order; `specFilenames` is tested against a real temporary repository, where a spec present only on `origin/master` counts and one present only in the working tree does not.
- A spec staged incomplete and then completed in the working copy denies on a plain commit, and the reverse passes; an untracked incomplete spec denies after `git add -A` and after `git add docs/superpowers/specs/`, and `git add -u` leaves it out.
- Both mutating paths are exercised with `IRACEDECK_HOOKS_DRY_RUN=1` per `hooks.md` rule 4, and the guards are then proven by watching them fire in-session per rule 6 — a real `git worktree add` for an issue with no spec, and a real spec commit missing a section — rather than by reading the code.
- The full green set (`install` → `build` → `typecheck` → `format` → `lint` → `test`) by hand, per `issue-workflow.md` step 5.

## Affected artifacts

`scripts/claude-hooks/rules-bash.mjs`, `scripts/claude-hooks/pre-bash.mjs` (five context helpers), `scripts/claude-hooks/lib.mjs` (three readers), `scripts/claude-hooks/rules-bash.test.mjs`, `scripts/claude-hooks/lib.test.mjs`, `.claude/rules/specs-and-plans.md`, `.claude/rules/hooks.md`, `.claude/agents/feature-planner.md`.

No user-facing change: no changelog entry, no website page, no plugin artifact.
