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
