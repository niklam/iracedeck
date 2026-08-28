# Re-ask the host once per plugin version when a migration was given up on

> **Issue:** [#1047](https://github.com/niklam/iracedeck/issues/1047) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

[#1041](https://github.com/niklam/iracedeck/issues/1041) stopped the settings migration destroying a user's deck-host copy, but it stops short of giving it back.

The shape of it: the plugin reads the deck host's settings exactly once, to migrate an existing installation into its own file. An unanswered read writes a defaults file carrying the `_migrationPending` countdown and retries on later starts; after `MIGRATION_RETRY_STARTS` (3) unanswered starts the file is accepted as-is and the durable `_migrationAbandoned` marker is stamped, which keeps the once-per-start host mirror shut for good. That marker is what stops the plugin writing schema defaults over a copy it was never able to read.

What it does not do is ever look again. The ceiling branch in `onLoaded` returns **before** issuing the read, and it clears the countdown in the same `becomeReady` call that stamps the durable marker — so the persisted file carries no countdown, every later start takes the `unanswered === 0` fast path, and the host is never asked again. An abandoned install therefore sits with its real settings intact and unreadable in the deck host's store while the plugin runs on schema defaults. The only cure is deleting the settings file by hand, which #1041 documents in the changelog and on the Settings page.

That is worst for the exact population #1041 was filed for. A Ulanzi user who ran the broken 3.0 build three times has a ceiling-value countdown and an untouched host copy. Their first start on the 3.1.0 build — whose read is now addressed and answerable — takes the ceiling branch, never asks, and leaves them on defaults permanently. The release that fixed their bug is the release that gives up on them.

## Decision

**Record which plugin version gave up, and re-enter the ordinary retry flow once when the running version differs.**

The event that plausibly changes whether the host answers is the plugin changing. That is exactly what happened here — the read was unanswerable on Ulanzi until #1041 addressed it, and no amount of retrying under the old build would ever have helped. "We have never asked under this build" is precisely the abandoned cohort's state, and it is cheap to detect.

### The marker carries a version instead of a boolean

`_migrationAbandoned` becomes the version string that abandoned the migration (`"3.1.0"`) rather than `true`.

This is backwards compatible by construction, which is the reason for choosing a version string over a second key. `isMigrationAbandoned` already reads any non-`false`, non-empty value as set, so a file written by 3.1.0 carrying `true` still suppresses the mirror under this change with no migration step. And `true` means "abandoned under an unknown version", which necessarily differs from the running one — so the 3.1.0 cohort is re-asked on their first start with this build, which is the outcome the issue exists for. Nothing has to know that `true` was ever the shape.

### The re-ask reuses the countdown rather than inventing a second timeout

On load, a file whose recorded abandoned-version differs from the running version has the marker **stripped** and falls through to the normal migration path — the same `adapter.getGlobalSettings()` and the same `MIGRATION_TIMEOUT_MS` every other unmigrated store uses.

From there the existing machinery does all of it. A host answer migrates and clears; silence writes the countdown at 1 and the mirror stays skipped; three more silent starts reach the ceiling again and stamp `_migrationAbandoned` with the **current** version, so the install goes quiet until the next upgrade.

Resetting the countdown rather than allowing a single attempt is the deliberate choice. One attempt would make a transient failure on upgrade day cost the user until their next upgrade, and it would need new "asked once under this version" bookkeeping. Reusing the countdown adds no new state and no new timeout semantics; the only new behaviour is the decision to re-enter the flow. The cost is bounded and self-limiting: up to three ten-second waits, spread over three starts, once per version, and only for installs that had already given up.

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

Unit, in `packages/deck-core`: a file whose marker records the running version takes the fast path and does not ask; one recording a different version asks, and one carrying the legacy `true` asks too (the 3.1.0 cohort's case); a host answer clears the marker and restores the mirror; silence after a re-ask writes the countdown at 1 with the mirror still skipped, and reaching the ceiling again stamps the **current** version; and the fail-closed reader still treats a hand-edited `"true"` as set.

**Build the chained start→start harness properly, and use it throughout.** #1041's post-mortem was that no test took one start's persisted output as the next start's input — every marker test hand-authored its store, so the persisted shape and the assumed shape drifted, and a recovery path that production could never reach shipped green. This change is the same class of bug waiting to happen: it turns entirely on what one start writes and the next start reads. A helper that resets the module and re-inits on `store.saved.at(-1)` should be the default way these tests are written, not a one-off for the case that already bit.

The version reaches `global-settings.ts` through `InitGlobalSettingsOptions` rather than a direct `getPluginVersion()` call, so tests set it explicitly and nothing depends on `initPluginConfig` having run — it does run first in all three plugins, but the scenario harness and the test suite do not call it, and a module that throws when it has not is a trap for both.

Manual, on any ecosystem: with a settings file carrying `_migrationAbandoned` and settings present in the deck host's store, start the host and confirm the log shows the migration being requested and received rather than the file being loaded as-is — then restart and confirm it does **not** ask again.
