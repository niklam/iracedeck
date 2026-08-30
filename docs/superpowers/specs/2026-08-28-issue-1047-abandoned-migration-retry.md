# Re-ask the host once per plugin version when a migration was given up on

> **Issue:** [#1047](https://github.com/niklam/iracedeck/issues/1047) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

[#1041](https://github.com/niklam/iracedeck/issues/1041) stopped the settings migration destroying a user's deck-host copy, but it stops short of giving it back.

The shape of it: the plugin reads the deck host's settings exactly once, to migrate an existing installation into its own file. An unanswered read writes a defaults file carrying the `_migrationPending` countdown and retries on later starts; after `MIGRATION_RETRY_STARTS` (3) unanswered starts the file is accepted as-is and the durable `_migrationAbandoned` marker is stamped, which keeps the once-per-start host mirror shut for good. That marker is what stops the plugin writing schema defaults over a copy it was never able to read.

What it does not do is ever look again. The ceiling branch in `onLoaded` returns **before** issuing the read, and it clears the countdown in the same `becomeReady` call that stamps the durable marker — so the persisted file carries no countdown, every later start takes the `unanswered === 0` fast path, and the host is never asked again. An abandoned install therefore sits with its real settings intact and unreadable in the deck host's store while the plugin runs on schema defaults. The only cure is deleting the settings file by hand, which #1041 documents in the changelog and on the Settings page.

That is worst for the exact population #1041 was filed for. A Ulanzi user who ran the broken 3.0 build three times has a ceiling-value countdown and an untouched host copy. Their first start on the 3.1.0 build — whose read is now addressed and answerable — takes the ceiling branch, never asks, and leaves them on defaults permanently. The release that fixed their bug is the release that gives up on them.

## Amendment: the first draft was correct against a world that does not exist

Everything below was written on the assumption that #1041 had shipped, so that installs in the field would carry `_migrationAbandoned`. **They do not.** #1041 ships in this same unreleased 3.1.0 — root version `3.1.0-dev.0`, newest tag `v3.0.0`, and the `## 3.1.0 / _Unreleased_` section carries both bullets. The ceiling #1041 replaced wrote only the countdown, so **no file anywhere carries the marker in any form.**

Keying the retry on that marker therefore recovered nobody. The real cohort — a Ulanzi user who ran the broken 3.0 build three times — sits at `_migrationPending: 3` with an intact host copy, and on their first 3.1.0 start `unanswered >= MIGRATION_RETRY_STARTS` fires and stamps them, returning *before* the read. Their first encounter with the fixed read would have been the release that gave up on them.

**That is this spec's own Problem statement, reproduced one layer up by its own fix.** Worth recording as more than a diff: the design was sound about the mechanism and wrong about the world, and it survived the spec, the implementation and the tests because all three inherited the same premise — the tests most damningly, since their fixtures hand-authored a marker shape no build has ever written, which is the identical fault the harness commit was created to prevent one issue earlier. A premise shared by the thing being checked and the check is invisible to any amount of care in either.

**The correction:** a store counts as given-up-on when it carries the marker **or** its countdown has already reached the ceiling. Both mean the same thing — the host did not answer and we stopped waiting — and treating them alike is what reaches the installs that actually exist. The rest of the decision stands, with one change forced by it, described under the countdown heading below.

## Decision

**Record which plugin version gave up, and ask the host exactly once more when a newer version runs.**

The event that plausibly changes whether the host answers is the plugin changing. That is exactly what happened here — the read was unanswerable on Ulanzi until #1041 addressed it, and no amount of retrying under the old build would ever have helped. "We have never asked under this build" is precisely the given-up cohort's state, and it is cheap to detect.

Version comparison is semver `gt` where both sides parse, not string inequality: a rollback cannot fix a read the older build already failed at, and `!==` would leave a downgraded pair re-asking on every transition with each build re-stamping its own version, never converging.

### The marker carries a version instead of a boolean

`_migrationAbandoned` becomes the version string that abandoned the migration (`"3.1.0"`) rather than `true`.

This is backwards compatible by construction, which is the reason for choosing a version string over a second key. `isMigrationAbandoned` already reads any non-`false`, non-empty value as set, so a file written by 3.1.0 carrying `true` still suppresses the mirror under this change with no migration step. And `true` means "abandoned under an unknown version", which necessarily differs from the running one — so the 3.1.0 cohort is re-asked on their first start with this build, which is the outcome the issue exists for. Nothing has to know that `true` was ever the shape.

### ~~The re-ask reuses the countdown~~ — one attempt, and the review is why

The original text argued for restarting the countdown, on the grounds that a single attempt "would make a transient failure on upgrade day cost the user until their next upgrade, and it would need new 'asked once under this version' bookkeeping". Both halves were wrong in a way worth keeping visible.

The bookkeeping already exists — it is the marker being written on the timeout rather than only at the ceiling, which is one branch, not a new mechanism. And the cost was the wrong way round: restarting the countdown means **three** ten-second startups per version, during which `isSettingsStoreReady()` is false, so every key binding reads as unconfigured, keys render the missing-binding glyph and do nothing, and the settings window's server is not yet started. At this project's release cadence a structurally mute host pays that roughly weekly, forever.

It also contradicted every document describing it. The rules file says "re-asks once per plugin version" in the same paragraph that justifies the ceiling as "so a host that genuinely never answers doesn't cost 10 s per launch"; `deck-core/CLAUDE.md` says "once"; the changelog and the Settings page say "once more". **When code and prose disagree, the fix is whichever one is right — and here the prose was.**

So: a given-up store issues **one** read. A host answer migrates. Silence records this build's own give-up and stops, keeping the file authoritative rather than restarting anything. Either way the store is quiet until the next upgrade.

### The retry's merge is not `mergeMigration`

`mergeMigration` encodes "a value still at its default was almost certainly never touched", and its own docstring scopes that to a **defaults-born file a few starts old**. A given-up store has been the authoritative settings for months, so the premise is simply false there: `focusIRacingWindow` deliberately re-enabled to `true`, `debugLogging` turned back off, any `calloutEnabled*` left on — all equal their schema default and would have lost to a pre-give-up host copy, which the mirror then writes back over both stores at once.

On the retry the file wins outright and the host fills only keys the file has never held. This is a different merge for a different precondition, not an inconsistency.

An **empty** answer retires nothing, either. The payload path coerces `null` and non-objects to `{}`, and on a host that cannot distinguish "no bucket" from "empty bucket" an empty reply is no evidence the copy is gone — retiring the guard on one would re-open a whole-object write over a copy nothing was read from, which is #1041 by another route.

### `becomeReady(..., "host")` clears the marker

#1041 wrote that line and the second max review found it unreachable — the ceiling never asked, so `source === "host"` could not follow an abandoned store, and it was deleted as dead code rather than left looking like a safety net. This change is what makes it live, and it comes back for that reason.

## Alternatives rejected

**Re-ask on every start.** The retry ceiling exists precisely to stop a silent host costing ten seconds per launch, and `.claude/rules/global-settings.md` warns against reaching for the timeout or the retry count. Version-gating is what keeps the retry bounded while still making it happen at all.

**Raise `MIGRATION_TIMEOUT_MS` or `MIGRATION_RETRY_STARTS`.** Stated explicitly because it is the tempting lever and #1041 rejected it for the same reason: neither helps a read that cannot be answered, and both cost every healthy install. The failure being fixed here is not slowness.

**Accept a late host answer after the store is ready.** This was considered during #1041 as option B and rejected outright by the maintainer. It would reintroduce post-ready ingest of a host payload — machinery #993 deliberately removed — on the code path where a wrong decision destroys settings the user cannot get back. The version gate reaches the same users while staying entirely inside the existing pre-ready flow, which is the whole argument for it.

**A separate `_migrationAbandonedVersion` key beside the boolean.** Two keys that must agree, where one already carries the information. The version string subsumes the boolean and degrades correctly for files that predate it.

**Prompt the user, or surface a banner.** The condition is not actionable by a user who has not read this spec, and the state is invisible to them by design — their settings work, they are just the wrong ones. A banner also cannot reach an abandoned install's Property Inspectors reliably, since the mirror that would carry it is exactly what is suppressed. If diagnosis becomes a support problem, the log line at the ceiling is the place to improve.

## Consequences

- The #1041 cohort — Ulanzi users abandoned under a build whose read could not be answered — are migrated automatically on their first start with this change, without touching their settings file by hand.
- A store abandoned under the current version stays quiet, so a genuinely silent host still costs nothing per launch.
- An upgrade costs an abandoned install up to three migration timeouts, once. No healthy install is affected: the fast path for a file with no marker is unchanged.
- The hand-deletion rescue documented in #1041's changelog entry and on the Settings page becomes a fallback rather than the only route. Both need rewording, and the changelog needs a line of its own — this is user-visible behaviour, and the wording must not imply it recovers a copy the mirror already overwrote, which remains impossible.
- **A constraint the #1038 file split must satisfy**, raised there in [this comment](https://github.com/niklam/iracedeck/issues/1038#issuecomment-5455765046): `_migrationAbandoned` must stay in a durable store. It looks like `_migrationPending`'s sibling and the split's taxonomy would naturally file both under `runtime.json`, which is documented "safe to delete" — but deleting the durable marker re-arms the data loss, through a step the docs call harmless. The countdown is genuinely disposable; the marker is not. This change makes that sharper, since the marker now also gates whether the install is ever re-asked.

## Verification

Unit, in `packages/deck-core`. **The case that matters most is a file with a countdown at the ceiling and no marker at all** — the only shape that exists in the field, and the one the first draft's fixtures never built. Then: a marker recording the running version takes the fast path; a newer running version asks exactly once; a downgrade does not ask; a legacy `true`, a numeric marker and no record at all all ask; a host answer clears the marker and restores the mirror, while an empty or `null` answer clears nothing; the retry's merge keeps a file value that equals its schema default; silence records this build's give-up without restarting the countdown; a blank or whitespace running version cannot stamp a marker that reads back as unset; and a padded stored version still compares equal to itself.

**Build the chained start→start harness properly, and use it throughout.** #1041's post-mortem was that no test took one start's persisted output as the next start's input — every marker test hand-authored its store, so the persisted shape and the assumed shape drifted, and a recovery path that production could never reach shipped green. This change is the same class of bug waiting to happen: it turns entirely on what one start writes and the next start reads. A helper that resets the module and re-inits on `store.saved.at(-1)` should be the default way these tests are written, not a one-off for the case that already bit.

**The harness was built first and it was not enough**, which is the sharper lesson. It catches a *persisted shape* drifting from an *assumed* one, and it did — but the first draft's fixtures were wrong about which files exist at all, and no amount of faithful chaining detects a fixture that chains a state nothing ever reaches. Ask what the field actually contains before asking whether the test reproduces it faithfully.

The version reaches `global-settings.ts` through `InitGlobalSettingsOptions` rather than a direct `getPluginVersion()` call, so tests set it explicitly and nothing depends on `initPluginConfig` having run — it does run first in all three plugins, but the scenario harness and the test suite do not call it, and a module that throws when it has not is a trap for both.

Manual, on any ecosystem: with a settings file carrying `_migrationAbandoned` and settings present in the deck host's store, start the host and confirm the log shows the migration being requested and received rather than the file being loaded as-is — then restart and confirm it does **not** ask again.
