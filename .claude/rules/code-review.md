# Code Review

How to run `/code-review` here: which effort level to ask for, what to point it at, and what to check afterwards.

## Pick the effort level from the table — `xhigh` is not the default

State a level explicitly on every invocation. The skill reuses the last level typed when none is given, so a bare call silently inherits whatever the previous review needed, which is how every review ended up at `xhigh`.

| Level  | When |
|--------|------|
| max    | Authorization, tenancy, credentials — anything whose failure mode is accepting rather than refusing. Money, billing, audit trails. |
| xhigh  | Published contracts; database constraints, migrations, indexes; and any document that decides one of the above |
| high   | Ordinary domain code |
| medium | Prose that describes rather than decides |
| low    | Comment-only, formatting, mechanical renames |

Two tie-breakers: a diff that spans rows takes the **highest** row any changed file falls into (the level is per review, not per file), and an honest choice between two rows takes the **higher** one.

### What each row means in this repo

- **max** — the loopback settings server's request guard (`deck-core/src/settings-window-guard.ts`, `settings-window-server.ts`): token/`Origin`/cookie authorization and static-path confinement, where the failure mode is accepting a request that should have been refused. This repo has no money, billing, or audit trails; its stand-in for "irreversible user loss" is the settings-store write path (`settings-store.ts` — atomic replace, the corrupt-file aside, the fail-closed unreadable-file load), where a wrong decision destroys settings the user cannot get back. Review those at `max` too.
- **xhigh** — the published contracts: `GlobalSettingsSchema` and its passthrough keys (persisted user data, plus the forward-compat rules in `global-settings.md`), the `@iracedeck/event-bus` sim-event catalog, `IDeckPlatformAdapter`, action UUIDs and manifest entries, and action settings schemas (a stored setting is a persisted contract). The migration/index analogues are the one-shot settings migrations (`global-settings-migrations.ts`), the host-migration path behind `_migrationPending`, and the changelog parser/generator (`scripts/lib/changelog-parse.mjs` → the shipped `changelog.json`). "Any document that decides one of the above" covers a spec in `docs/superpowers/specs/` settling one of them, and the `.claude/rules/` files that pin a format others must follow (`global-settings.md`, `changelog.md`).
- **high** — ordinary domain code: actions and their dial surfaces, the `sim-events-iracing` diff modules, the audio-scenarios catalog, icon assembly, PI templates and `ird-*` components.
- **medium** — prose that describes rather than decides: website docs and action pages, `README.md`, package `CLAUDE.md` overviews, changelog bullet text. (Changing the changelog **format** or its parser is xhigh; adding a bullet is medium.)
- **low** — comment-only edits, formatting, mechanical renames, and regenerated artifacts committed unchanged in shape (icon previews, `icon-defaults.json`, `action-comms.json`).


## Report only — `--fix` is not part of the command

Never pass `--fix`. A review reports; applying is a separate step taken afterwards, finding by finding, once each one has been checked against the code.

Two reasons it isn't a convenience worth having. Findings are candidates, not verdicts — a review produces confident-sounding findings about behavior that is deliberate, and an auto-applied one rewrites a decision nobody re-litigated. And the edits land in whatever tree the run targeted, so a mis-targeted review doesn't merely report on the wrong branch, it modifies it: one bare invocation put eight files of unrelated edits into the `master` checkout.

So: read the findings, verify each against the code, apply the ones that hold as your own edits, and say which you declined and why. Any review-ish subagent gets the same instruction — read-only, report only.

## Always target the worktree that holds the work

The session's working directory is the `master` checkout, so a bare invocation reviews `master`'s diff — not the `ir-<issue>` worktree the work lives in. Pass the absolute path plus an explicit scope block:

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

Before opening a PR — `build-and-commit.md` has the ask-first step. Pick the level from the table at that point, and say which row the change landed in when proposing the review.

## How reviews are staged inside an issue

Decided by Niklas on 2026-09-06 after #1066, where an eight-task branch ran five task reviews, five scoped re-reviews, a whole-branch review and the `/code-review` — 3.4M of the 6.8M agent tokens the issue cost, with the five re-reviews (1.2M) finding nothing new in any of them. The evidence from that branch is what the rules below rest on.

1. **Review at a consumer seam, before the consumer starts.** A task whose OUTPUT another task builds on — an artifact shape, a public type, a generated file a page renders — gets a task-scoped review as soon as it lands, and the dependent task is dispatched only afterwards. On #1066 that was the generator (Task 30) → the website (Task 40): its review changed the artifact's shape three times, and each change would otherwise have been a rewrite of the page that rendered it. This is the one place a staged review paid for itself.
2. **A leaf task gets no review of its own.** Descriptions, prose pages, a linter nobody else consumes, rule edits: their findings surface in the full read at the end a few hours later, and their fixes were small. Skipping the four leaf reviews on #1066 would have saved about 1.2M with the same final result.
3. **Fix diffs are verified by the coordinator, never by a scoped re-review agent.** A fix round is 30–200 lines. Read the diff, run the covering tests, check the finding is gone. Dispatching a re-reviewer for that costs a quarter-million tokens per round and, on #1066, five rounds found nothing.
4. **The whole branch gets exactly one full read: the `/code-review`,** at the level from the table above, targeted at the worktree, report-only. It is not optional — on #1066 the full read found the three things no task review could see (a stale voice-pack catalog entry that would have failed the release, a version stamped into a freshness-tested artifact that would have turned `master` red at every bump, a clip the plugin plays that the linter called dead). But do not run a second full-branch reviewer beside it; the `superpowers` plan-execution skill's own "final review" step is that duplicate, and this rule replaces it.
5. **Reviewer models follow the same complexity rule as workers** (`CLAUDE.md`): a review that must weigh a claim against the code runs on `opus`; a mechanical check runs on `sonnet`; the `/code-review` picks its own.

The repo's skills and the `superpowers` plugin describe a per-task review cadence; this section overrides it for issue work here.
