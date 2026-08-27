# Telling the user when the settings file was rejected

> **Issue:** [#1036](https://github.com/niklam/iracedeck/issues/1036) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

`createFileSettingsStore`'s `load()` has three outcomes, and the user can only perceive one of them.

| Outcome | What the plugin does | What the user sees |
| --- | --- | --- |
| Parsed | Cache from file | Their settings |
| **Corrupt** | Move aside, return `undefined`, re-migrate from the deck host | Settings silently change |
| **Unreadable** | Retry 6×, then run on defaults and never save | Settings appear reset; every edit is silently discarded |

Both failure rows report at `error` to a log file, which is not a user-facing surface. `_warnings` exists precisely to make plugin-side state visible in every Property Inspector and in the settings window, and neither `settings-store.ts` nor `global-settings.ts` calls `setWarning`.

The design question is not *whether* to raise a banner. It is **where a failure detected before the settings cache exists can be raised from**, whether raising it there survives the cache being built underneath it, and whether the recovery that follows should change. The third question turns out to answer itself in the opposite direction to first instinct, and the second turns out to be already solved.

## Evidence

A real incident on 2026-08-27 (Mirabox), which is what prompted the issue. Key bindings were copied from the Stream Deck settings file into the Mirabox one; the hand-edit left a trailing comma before the closing brace. The plugin log records the whole chain twice in four minutes:

```text
04:34:42 INFO  [GlobalSettings] No settings file yet; requesting the deck host's settings for a one-time migration
04:34:42 INFO  [GlobalSettings] Migrated global settings from the deck host
04:38:11 ERROR [SettingsStore] Settings file is not valid JSON; moving it aside and starting fresh
04:38:11 INFO  [GlobalSettings] No settings file yet; requesting the deck host's settings for a one-time migration
04:38:15 INFO  [GlobalSettings] Migrated global settings from the deck host
```

The first episode was a genuinely absent file (it had been renamed aside by hand); the second was the rejection. Both ended in the same place, and from outside they are indistinguishable — which is the user-facing complaint, verbatim: *"Mirabox ignores the settings file and resets to old settings."*

Three facts from the forensics shaped the decisions below.

**The rejected file was intact and one character from valid.** It repaired with a single comma removed, yielding 321 keys against the 241 in the file that replaced it — 80 bindings that appeared to have vanished. Nothing was lost; the aside file held all of it. The user simply had no way to know that file existed.

**The precise cause was already computed and then thrown away.** `JSON.parse` produced `Illegal trailing comma before end of object: line 327 column 120`, which `load()` logs at `debug` and discards. That string is the entire difference between a mystery and a ten-second fix.

**Hand-editing these files is an expected input class here, and the code already concedes it.** `load()` strips a UTF-8 BOM before parsing, with a comment citing PowerShell's `Set-Content` and editors that write one, and the explicit reasoning that "a BOM must not make a user's backup 'corrupt'". A file people are expected to open in an editor will sometimes come back with a syntax slip.

## Decisions

### 1. Report the failure; do not repair the file

Trailing-comma tolerance is the obvious-looking move and is rejected. The BOM precedent does not extend to it: stripping a BOM discards bytes that carry no meaning and that no user typed, leaving the document's structure untouched. Deleting a comma edits structure and guesses intent — and the guess is unverifiable, because a trailing comma is equally consistent with "finished editing" and "half-pasted a block". Worse, a repair would not stay in memory: a successful load re-saves the file to heal salvage drops, so the plugin would silently rewrite the user's file into something they did not type. Once trailing commas are accepted there is also no principled line before comments and unquoted keys.

Reporting is strictly better than repairing here **because the report is actionable**: with the parse position in hand the fix takes seconds, and the user stays the author of their own file.

### 2. Keep the host re-migration — it is a restore, not a reset

The first instinct was that treating a corrupt file as "no file" is the bug, since it lets the stale host copy overwrite the user's settings, and that a file's existence proves the one-time migration already ran for this install.

That is wrong, for a reason that only became clear from #993's mirror. Since #993 the plugin writes its **full cache** to the deck host once per start (`hostMirrorPayload`), so the host copy is not a stale first-install artifact — it is the settings as of the last successful start. Re-migrating from it is close to restoring a same-day backup, and it is the best available recovery. The alternative — refusing to migrate — lands on pure schema defaults, which is strictly worse for the user.

The behaviour was only *perceived* as destructive because nothing named it. So the fix is the explanation, not the mechanism: the banner states that the settings were restored from the deck host and points at the aside file.

This is the load-bearing decision of the design, and it inverts the issue's own first framing. Recorded here so it is not re-litigated.

### 3. Raise it from the load path — the ordering already works

The warning must be raised while the store is loading, before the cache exists. That looks like it needs new machinery and does not: `becomeReady()` strips run-scoped keys from the loaded/migrated raw **before** applying early writes, and says why in a comment already in the tree — *"a producer that reported while the store was still loading recorded an early write, and that one is current."*

So `setWarning` during the rejection lands in `earlyWrites`, survives the run-scoped strip that follows, and is present in the cache the moment the store goes ready. The `_warnings` run-scoping (#1014) also means it is never persisted, so the banner cannot outlive the run that observed it — which is right, since a later start with a fixed file must come up clean.

### 4. Shape: two modules, one id, `error`, and the detail in the message

Follow the established split — a pure evaluator returning `PiWarning | null`, plus a thin reporter that is the only part touching the warning store — exactly as `elevation-check.ts` and `settings-window-warning-reporter.ts` do. One id at level `error`, page-wide in the top strip; this is not advice about a single control, so it takes no `only`/`except` placement filter.

The message carries the aside filename and the parse position, and must not begin with an emoji (`ird-warnings` prepends a per-level icon).

### 5. Scope: the corrupt path only

Deliberate, and forced by the constraint below rather than chosen for convenience.

## The constraint that sets the scope

**On the unreadable path, a banner has no route to any surface.** The chain is structural: out of read attempts, the store deliberately never becomes ready (so that `save` cannot overwrite a file it merely failed to read) → each plugin's store-ready block never runs → `settingsWindow.ensureStarted()` is never called, so the loopback server never starts and no `_settingsChannel` is published → and `hostMirrorPayload` returns `undefined` for a not-ready store, so the once-per-start deck-host mirror is skipped too. With neither the loopback channel nor the mirror, a `_warnings` record reaches no Property Inspector and no settings window.

That is the worse of the two failures — settings look reset *and* every subsequent edit is silently discarded until a restart — and it cannot be fixed by adding a producer. It needs the settings server to start independently of store readiness, which is a startup-ordering change with its own blast radius. It belongs in its own issue, not smuggled into this one.

The corrupt path has no such problem: it proceeds through migration to ready, so the channel and the mirror both exist by the time anything renders. One nuance to carry into implementation — if the corrupt rejection is followed by a host that never answers the migration read, `becomeReady` runs with source `fresh`, and the mirror is skipped for that case by design. The banner then reaches loopback-connected surfaces but not a fallen-back Property Inspector. Acceptable: it is a double failure, and the loopback path is the one that matters.

## Alternatives rejected

- **Leave it at the `error` log.** The status quo. A log file is not a user-facing surface; this incident is the proof.
- **Tolerate trailing commas.** Decision 1.
- **Stop a corrupt file re-triggering the migration.** Decision 2 — it would replace a working restore with schema defaults.
- **Cover the unreadable path in the same change.** Structurally impossible without a startup-ordering change; see above.
- **Put the detail only in the log and keep the banner generic.** Halves the value. The parse position is the actionable part, and it already exists.

## Open question

Whether the unreadable-path gap is filed now or after this ships. Recommendation: file it separately once this lands, so the startup-ordering discussion happens on its own terms.
