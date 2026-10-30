# Code Review

How to run `/code-review` here: which effort level to ask for, what to point it at, and what to check afterwards.

## Pick the effort level from the table — `xhigh` is not the default

The hook refuses an invocation that names no level, because the skill otherwise reuses the last level typed — which is how every review ended up at `xhigh`.

| Level  | When |
|--------|------|
| xhigh  | Authorization, tenancy, credentials — anything whose failure mode is accepting rather than refusing. Published contracts; database constraints, migrations, indexes; and any document that decides one of the above |
| high   | Ordinary domain code |
| medium | Prose that describes rather than decides |
| low    | Comment-only, formatting, mechanical renames |

Two tie-breakers: a diff that spans rows takes the **highest** row any changed file falls into (the level is per review, not per file), and an honest choice between two rows takes the **higher** one.

**`xhigh` is the top level; `max` is not used** (Niklas, 2026-10-17: "The highest level of review should be xhigh, I don't want us to use max anymore. I'm seeing everywhere that max provides not as good results as xhigh."). What used to be the `max` row is reviewed at `xhigh`, and the hook refuses `/code-review max`.

### What each row means in this repo

- **xhigh** — the loopback settings server's request guard (`settings-window/src/settings-window-guard.ts`, `settings-window-server.ts`): token/`Origin`/cookie authorization and static-path confinement, where the failure mode is accepting a request that should have been refused. The settings-store write path (`settings-store.ts` — atomic replace, the corrupt-file aside, the fail-closed unreadable-file load), where a wrong decision destroys settings the user cannot get back. And the published contracts: `GlobalSettingsSchema` and its passthrough keys (persisted user data, plus the forward-compat rules in `global-settings.md`), the `@iracedeck/event-bus` sim-event catalog, `IDeckPlatformAdapter` and the `SettingsHost` it extends from `@iracedeck/settings`, action UUIDs and manifest entries, and action settings schemas (a stored setting is a persisted contract). The migration/index analogues are the one-shot settings migrations (`global-settings-migrations.ts`), the host-migration path behind `_migrationPending`, and the changelog parser/generator (`scripts/lib/changelog-parse.mjs` → the shipped `changelog.json`) together with the fragment format, its parser and composer (`changelog-fragments.mjs`, `changelog.d/README.md`) and the stable-release fold (`changelog-fold.mjs`, `release-hooks.mjs`), which writes the dated section a release ships. "Any document that decides one of the above" covers a spec in `docs/superpowers/specs/` settling one of them, and the `.claude/rules/` files that pin a format others must follow (`global-settings.md`, `changelog.md`, `changelog-internals.md`).
- **high** — ordinary domain code: actions and their dial surfaces, the `sim-events-iracing` diff modules, the audio-scenarios catalog, icon assembly, PI templates and `ird-*` components.
- **medium** — prose that describes rather than decides: website docs and action pages, `README.md`, package `CLAUDE.md` overviews, changelog fragment text. (Changing the changelog or fragment **format**, its parser or the fold is xhigh; adding or editing a fragment is medium.)
- **low** — comment-only edits, formatting, mechanical renames, and regenerated artifacts committed unchanged in shape (icon previews, `icon-defaults.json`, `action-comms.json`).


## Report only — `--fix` is not part of the command

The hook refuses `--fix`, because findings are candidates rather than verdicts: a review produces confident-sounding findings about behavior that is deliberate, and an auto-applied one rewrites a decision nobody re-litigated — in whatever tree the run targeted, which is how one bare invocation put eight files of unrelated edits into the `master` checkout. So read the findings, verify each against the code, apply the ones that hold as your own edits, and say which you declined and why. The author of the code never declines a finding alone (#1528): every finding they would not fix goes to one fresh read-only `opus` judge per review round, given only the code, the finding and the reason, whose ruling binds (brief in the `issue-lead` skill, step 7). Any review-ish subagent gets the same instruction — read-only, report only.

## Always target the worktree that holds the work

The hook refuses an invocation that names no `ir-<issue>` path, since the session's working directory is the `master` checkout and a bare call would review `master`'s diff. Pass the absolute path plus an explicit scope block:

```text
/code-review high C:/Users/Niklas/Projects/iRaceDeck/ir-<issue>

SCOPE:
- Worktree to review: C:/Users/Niklas/Projects/iRaceDeck/ir-<issue>
- Branch / diff: origin/master..HEAD in that worktree
- Read-only: report findings, edit nothing
- Do NOT read or modify master or any other ir-* sibling worktree
```

Confirm the run echoed the right target before trusting a finding, and cross-check its findings against `git -C ../ir-<issue> diff --stat origin/master...HEAD` — findings naming files outside that set mean it reviewed the wrong tree. Nothing should have been written anywhere, so verify that afterwards with `git status --porcelain` in **every** worktree, not just the target: a dirty tree means the run edited something it was told not to (recover with `git stash push -m "…"` in that checkout, then inspect or drop it). The agent's own account of what it touched is not evidence.

## When to run one

Before manual testing, which comes before the PR. The issue lead runs it without asking (#1520), picks the level from the table at that point, and says in its report which row the change landed in.

## How reviews are staged inside an issue

Decided by Niklas on 2026-09-06 after #1066, whose reviews cost half of its 6.8M agent tokens while its five scoped re-reviews found nothing new.

1. **Review at a consumer seam, before the consumer starts.** A task whose OUTPUT another task builds on — an artifact shape, a public type, a generated file a page renders — gets a task-scoped review as soon as it lands, and the dependent task is dispatched only afterwards. On #1066 the generator's review changed its artifact's shape three times before the page rendering it was written — the one place a staged review paid for itself.
2. **A leaf task gets no review of its own.** Descriptions, prose pages, a linter nobody else consumes, rule edits: their findings surface in the full read at the end a few hours later, and their fixes were small.
3. **Fix diffs are verified by the issue lead, never by a scoped re-review agent.** A fix round is 30–200 lines. Read the diff, run the covering tests, check the finding is gone.
4. **The whole branch gets exactly one full read: the `/code-review`,** at the level from the table above, targeted at the worktree, report-only. It is not optional — on #1066 it found three defects no task review could see, one of which would have failed the release and one of which would have turned `master` red at every bump. But do not run a second full-branch reviewer beside it; the `superpowers` plan-execution skill's own "final review" step is that duplicate, and this rule replaces it. The one named exception is the second read (below): a different method, on the kinds of diff named there, after this read's findings are applied.
5. **Reviewer models follow the same complexity rule as workers** (`CLAUDE.md`): a review that must weigh a claim against the code runs on `opus`; a mechanical check runs on `sonnet`; the `/code-review` picks its own.

The repo's skills and the `superpowers` plugin describe a per-task review cadence; this section overrides it for issue work here.

## The second read

Once the `/code-review` findings that hold are applied, a branch whose diff changes **a gate or guard**, **a build, release or publish path**, or **a state machine** gets one more pass before manual testing: the `second-read` skill, which says what counts as each and carries the reviewer's brief. It is one read-only `opus` agent that puts each changed behaviour through fixed questions about ordering, lifecycle, failure half-way and bad input. That is the class both the full read and CodeRabbit missed on the eleven PRs measured in the #1396 spec, where it found #1390–#1395; it re-found only 5 of CodeRabbit's 18 majors there, so it replaces neither. It does not run on prose, icons, generated artifacts, PI templates or renames.

Say whether a second read applies, and which of the three kinds the diff is, when naming the `/code-review` level. Its findings are candidates like any review's: verify each against the code; fix what holds and is reachable; fix, file or decline with the reason what holds and is narrow; and put the tally in the PR body, counting how many held. After ten runs in which none held, the step is removed — the skill lists every place that names it.
