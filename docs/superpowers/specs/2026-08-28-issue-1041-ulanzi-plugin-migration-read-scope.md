# The plugin's Ulanzi migration read needs the same address the PI's read got

> **Issue:** [#1041](https://github.com/niklam/iracedeck/issues/1041) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

On UlanziStudio the plugin's **one-time migration read** — the only chance it ever gets to import a user's pre-3.0 settings out of the deck host and into the plugin-owned file — is sent in the exact frame shape [#1039](https://github.com/niklam/iracedeck/issues/1039) measured the host never answers.

Two frames carry that read today, and both are blank-scoped. `UlanziClient.connect()`'s `open` handler issues one unconditionally, and `deck-core`'s `initGlobalSettings` issues another through `UlanziPlatformAdapter.getGlobalSettings()` when it finds no settings file. Both land on `requestGlobalSettings()`'s default scope, `{ uuid: PLUGIN_UUID, key: "", actionid: "" }` — the blank `actionid` #1039 proved is discarded silently.

The only thing that has ever produced an answerable read from the plugin's main service is the `willAppear` re-drive added in #868, which re-issues the read once with the first appearing action's context. So the migration succeeds only when an action happens to appear within `MIGRATION_TIMEOUT_MS` (10 s) of startup. That is not a property of the migration; it is a property of what the user happens to have plugged in.

**When no action appears in that window the loss is silent, and after three such starts it is permanent.** Each unanswered start writes a defaults file carrying `_migrationPending`; on the fourth, `pendingMigrationStarts(loaded) >= MIGRATION_RETRY_STARTS` accepts the file as-is, `becomeReady(loaded, "file")` drops the marker, and the store is now sourced `"file"` — which is exactly the state in which `hostMirrorPayload` is *allowed* to mirror. The plugin's once-per-start host write then replaces the user's pre-3.0 copy in UlanziStudio with schema defaults. That single write is the moment the data stops existing anywhere, and nothing in any log line or any surface tells the user a migration was ever attempted, let alone abandoned.

## Evidence

**The addressing rule was measured, not inferred.** #1039 probed a live UlanziStudio across all six scope permutations: `actionid` alone decides whether a `getGlobalSettings` is answered at all, `key` alone does not, and `uuid` changes neither the answer nor the bucket that comes back. The host echoes `actionid` rather than resolving it — it answered an `actionid` that has never existed on that machine — so it is a reply address, not a lookup key. That table is reproduced in the #1039 spec and is the whole basis for this change; it is not re-probed here.

**The plugin side never got the fix.** #1039 changed `packages/pi-components/src/ulanzi-bridge/translate.ts`, and its commit message and the docstring it left behind both state the rule plainly. `packages/deck-adapter-ulanzi/src/ulanzi-client.ts` was updated in the same change — but only its *docstring*, which now says outright that "the default scope here (blank `key`/`actionid`) is never answered, and this read depends entirely on the adapter's `willAppear` re-drive to supply a context". The code was left as it was, with the re-drive named as load-bearing rather than as a fallback.

**The re-drive does not fire with no deck attached.** A full local run in the #1040 session, on a machine with no Ulanzi hardware connected, shows the socket connecting and actions refreshing **zero** contexts, with no `add` frame anywhere in the session:

```text
[Ulanzi:WebSocket] Connected to UlanziStudio
[GlobalSettings] Global settings loaded from the settings file
[BlackBoxSelector] Refreshing 0 contexts with overlay=true
[SplitsDeltaCycle] Refreshing 0 contexts with overlay=true
```

No `add` means no `willAppear`, which means the re-drive's `if (!this.globalSettingsReplyReceived && !this.globalSettingsBootstrapSent)` body is never reached — not late, never. That run happened to load from an existing settings file, so it did not exercise the migration at all, and that is precisely why the bug is invisible in normal testing: normal testing has a settings file already.

**A second silent drop sits on the same path.** `UlanziClient.send()` drops any frame written while the socket is not open — the latent bug #993 phase 2 fixed for `setGlobalSettings` by deferring until `open`, and deliberately did not fix for the read. `initGlobalSettings` runs before `adapter.connect()` in `plugin.ts` (L1085 vs L1118) and issues its migration read as soon as the store's file load rejects, which for a missing file is an `ENOENT` a tick or two later — almost always before the WebSocket has opened. So on most starts `deck-core`'s explicit migration read is discarded by `send()` before it is ever a frame, and the read that actually reaches the host is the unconditional one in the `open` handler. Today that distinction is invisible because both are blank and neither is answered. The moment one of them is addressed, it matters a great deal which one it is.

## Decision

**Address the plugin's default read the same way #1039 addressed the PI's, and keep the re-drive as a fallback rather than the mechanism.** Three parts.

### 1. The default read carries an address

`requestGlobalSettings()` called with no context sends the write's scope plus an `actionid`, exactly as the PI bridge does — `uuid` and `key` unchanged, one field different:

```ts
export const PLUGIN_READ_ACTIONID = "iracedeck-plugin-global-read";

requestGlobalSettings(context?: string): void {
  const scope = context
    ? decodeContext(context)
    : { uuid: PLUGIN_UUID, key: "", actionid: PLUGIN_READ_ACTIONID };

  this.send({ cmd: "getGlobalSettings", ...scope });
}
```

This fixes both blank frames at once — the connect-time read and `deck-core`'s migration read are the same call — and it does so in the one place the rule belongs, the client that owns the wire format.

The constant is **deliberately a different value from the PI bridge's `PI_READ_ACTIONID`** (`"iracedeck-pi-global-read"`), even though the host would route either. They are two different sockets asking for two different reasons, and when the next person reads a host-side trace or a debug log the address should say which one asked. There is nothing to keep in sync between them, so there is no parity test; a shared constant would imply a contract that does not exist — the two packages must not depend on each other, and one is bundled into a browser page.

Keeping `uuid: PLUGIN_UUID` and a blank `key` is not a fresh decision, it is #1039's, and its reasoning carries over unchanged: the fields buy nothing observable on this host version, but they keep the read and the write naming the same bucket, so a future host that ever *did* resolve a bucket from the frame would land on the one the writes populate rather than on one nothing has ever written. The reply-scope policy in `UlanziPlatformAdapter` needs no change for the same reason — a reply to this read reports the plugin UUID as its scope, so it is treated as authoritative exactly as it is on Elgato and Mirabox.

### 2. A read requested before the socket opens is an explicit no-op, not a silent drop

```ts
if (this.ws?.readyState !== WS_OPEN) {
  this.logger.debug("Global-settings read requested before the socket was open; the connect-time read covers it");

  return;
}
```

The write's answer to this problem was to stash and flush on `open`. The read must not copy it: the `open` handler already issues this identical plugin-scoped read unconditionally, so a stash would put a duplicate frame on the wire to ask a question that has just been asked. The honest fix is to make the drop deliberate and say why, so the next reader is not left believing `adapter.getGlobalSettings()` always reaches the host — which is what made this failure so hard to see.

Two things make the no-op safe rather than merely convenient, and both are worth stating because they are the assumptions that would break it. A context-carrying re-drive can never be the frame that gets dropped, because it originates in a `willAppear` that arrived over the very socket in question. And `deck-core` does not correlate a reply with its request — it accepts the first `didReceiveGlobalSettings` that arrives while `migrationRequested` is true and nothing has settled — so a reply produced by the `open` handler's read satisfies a migration read that never made it onto the wire.

### 3. The `willAppear` re-drive stays, and is re-documented as a fallback

The issue asks this to be decided rather than defaulted, so: **keep it, unchanged.**

It is already guarded on `!globalSettingsReplyReceived`, so once the first read is answered — milliseconds after `open`, long before any key can appear — it never fires. It therefore costs nothing in the fixed world, which removes the usual argument for deleting a workaround. What it buys is the one failure this change cannot rule out on its own: the addressed read depends on the host continuing to *echo* an `actionid` it has never seen, and a host version that started resolving that field instead would silently take us back to an unanswered read. A real action context is a genuinely different shape, and #1039's table shows it is answered. Deleting six guarded, tested lines to remove a fallback for the exact assumption the fix rests on is a bad trade.

What does change is how it is described. Every comment and doc that presents the re-drive as *the* way an Ulanzi read gets answered is now wrong, and leaving that in place is how a future change deletes the primary path believing the fallback covers it.

## Alternatives rejected

**Lengthen `MIGRATION_TIMEOUT_MS`.** Ruled out in the issue, and rightly: with no deck attached the re-drive never fires at all, so this widens a window that is never entered. It would also make every genuinely fresh install pay the longer wait before its Property Inspectors get a settings channel.

**Retry the migration read on a timer instead of once.** Same objection with more moving parts. It converts a deterministic addressing bug into a race we would have to tune, and the retry has nothing new to say — it would re-send the same unanswerable frame.

**Pass an action context down from `deck-core` to the adapter's read.** This is the shape the #868 re-drive implies, generalised. It is wrong at the seam: `initGlobalSettings` is platform-agnostic and runs at store-load time, when the plugin has no contexts and, with no deck attached, never will. It would push an UlanziStudio addressing rule into the one module that must not know about any host's wire format, to solve a problem the client can solve alone.

**Remove the re-drive.** Argued above. Cheap to keep, and it is the only remaining recovery for the assumption the fix rests on.

**~~Preserve the host copy forever when a migration is abandoned.~~ — REJECTED, THEN ADOPTED. This section was wrong; the change ships.** The original argument is kept below verbatim, because two of its three grounds turned out to be false and the way they failed is the useful part.

> The moment the user's data is destroyed is not the failed read — it is the host mirror that runs one start later, once the marker has cleared and the store is sourced `"file"`. A durable `_migrationAbandoned` marker could suppress that mirror permanently, leaving the pre-3.0 copy intact in UlanziStudio indefinitely. Rejected for this change, on three grounds. It protects only against a host that stays silent for three consecutive starts *despite* an addressed read, which is a host that is not answering the plugin at all. It costs the documented downgrade safety net — the host copy is deliberately refreshed once per start so an older iRaceDeck installed later still finds settings where it expects them, and a permanently suppressed mirror silently retires that promise. And a preserved copy is only useful to a build that would ask for it again, which is the retry loop rejected above. It belongs to the settings-store contract rather than to the Ulanzi adapter, so if a silent host is ever actually observed against an addressed read, it should be its own issue with its own review level.

The max-level review found what that reasoning missed, and it is the whole point of the issue: the retry-ceiling branch in `onLoaded` returns **before** the read is issued. So a user who ran the broken build three times has `_migrationPending: 3` and a still-intact host copy — the mirror was skipped on all three — and their *first start on this very fix* takes that branch, never issues the now-answerable read, clears the marker, and mirrors schema defaults over their real settings. The population is not hypothetical and not future: it is identifiable, it exists today, and the fix as first written destroyed it.

Each ground, and how it failed:

- *"Only protects against a host silent despite an addressed read."* False. It also protects every user whose ceiling was reached under the **un**addressed read — which is every affected Ulanzi user, i.e. the entire subject of this issue. The guard was dismissed as speculative while its actual beneficiaries were the people the issue was filed for.
- *"Costs the downgrade safety net."* Inverted. What the mirror writes in this state is schema defaults; suppressing it leaves the user's **real** settings in the deck host's store. An older iRaceDeck installed later therefore finds something better, not worse. The guarantee was being defended by destroying the thing it guarantees.
- *"A preserved copy is useless without a retry loop."* Wrong twice. Preserved settings are recoverable by a downgrade, by hand, or by a later build — and the countdown does keep asking, so an install whose host starts answering recovers on its own. A real host answer deletes the marker, which is what stops "gave up once" from becoming a one-way door.

One argument survives review and is now the load-bearing one, because it is what makes suppression free rather than a trade: **the marker is only ever set when the host answered nothing, and a host that answers nothing does not answer a Property Inspector's bootstrap read either** — both are the same `getGlobalSettings`. So the `_settingsChannel` the mirror would carry is unreachable by the only party that wants it, and the "PIs channel-less forever" cost the original ceiling comment warned about is not a real cost in the state the marker describes.

The rule that generalises out of this: **gate the mirror on having positively READ the host, never on a counter having run out.** An expired counter says we stopped waiting; it says nothing about what the host holds, and whole-object writes make that distinction destructive.

Scope note, since the original rejection leaned on it: this does belong to the settings-store contract rather than to the Ulanzi adapter, and it ships here anyway. Splitting it would have meant knowingly releasing a fix whose first start destroys the data it exists to save.

**Recover the settings of users already past the retry window.** There is nothing left to recover: their host copy was replaced with schema defaults by the mirror write on the start that accepted the file. Any "re-migration" would import those defaults over a file the user may since have configured by hand, which is strictly worse than doing nothing. This is out of scope by impossibility rather than by choice, and the changelog wording must not imply otherwise.

## Consequences

- The migration read is answered on the connect-time read, milliseconds after the socket opens, whether or not a deck is attached and whether or not any key has ever been placed. Importing a user's existing settings stops depending on what hardware is plugged in at startup.
- **Users still inside the retry window are rescued with no new machinery.** A user who has upgraded to 3.0, lost the read, and started fewer than `MIGRATION_RETRY_STARTS` times still has `_migrationPending` in their file and an untouched host copy — the mirror is skipped while the marker is set. Their first start on this build re-issues the read, now answered, and `mergeMigration` folds the host copy in *under* the file, so bindings the file never had arrive while anything they changed in the meantime survives. That path already exists; this change is what makes it reachable.
- **Users exactly at the ceiling are preserved, though not restored.** With `_migrationAbandoned` in place their still-intact host copy stops being overwritten, so their settings survive in UlanziStudio and stay recoverable — by a downgrade, by hand, or by a later build. They still run on defaults until something reads that copy, which is the honest limit of this change.
- Users whose mirror has already run are not rescued and cannot be: their host copy is schema defaults now, and there is nothing left to read.
- **The empty-payload defence the review proposed alongside this is deliberately NOT taken**, and the reasoning matters because the two interact. Declining an empty migration payload would mean a host whose bucket is legitimately empty — every fresh install — never completes its migration, burns three ten-second starts, and lands on the ceiling. Combined with the mirror gate above, that install's mirror is then shut for good, and unlike the silent-host case its Property Inspectors *would* have been served: the host is answering, it simply has nothing to say. So the pairing would trade a speculative harm (a host that reports empty while holding settings) for a certain one (every new Ulanzi install permanently channel-less). An explicit empty answer is a real answer; treat it as one.
- The re-drive becomes a fallback that should never fire in the field. Its three existing tests are what keep it from rotting.
- Four documentation surfaces assert something that is no longer true and must change with the code: `packages/deck-adapter-ulanzi/CLAUDE.md` and `packages/iracing-plugin-ulanzi/CLAUDE.md` (both describe the re-drive as the mechanism), `.claude/rules/global-settings.md` (its read/write asymmetry section covers the PI read only), and the website's `docs/getting-started/settings.md`, which additionally still carries two #1039 leftovers — it says the Ulanzi Property Inspector link is "pending confirmation" when #1039 confirmed and fixed it, and it promises that "a copy iRaceDeck has not seen is never overwritten", which is exactly what stops being true after three unanswered starts.

## Verification

Unit, in `packages/deck-adapter-ulanzi`: the default read carries a non-empty `actionid`, with `uuid` still `PLUGIN_UUID` and `key` still blank, so it differs from the write in exactly one field; the connect-time read on `open` carries that same address; a read requested before the socket is open sends nothing; the context-carrying form and the write are both untouched; and the re-drive's existing guards still hold. The client test that currently pins the blank default read (`requestGlobalSettings without a context uses the plugin scope`) asserts the bug and must be rewritten rather than extended.

Also in `packages/deck-core`: the retry ceiling leaves the mirror shut and writes the durable marker, a file already carrying that marker keeps it shut on every later start (the countdown is gone by then, so nothing else would), and a host answer retires it and restores the mirror. The existing ceiling test asserts `mirror allowed` and is asserting the bug — rewrite it rather than extend it.

Manual, on UlanziStudio, is the only thing that proves the host answers. Two questions, one session, each with a stated prediction — test against the prediction rather than reading the log for impressions.

**Test 1 — is the migration read answered with no deck attached?** This is the issue itself. Setup: pre-3.0 settings present in the host store, `%LOCALAPPDATA%\iRaceDeck\Settings\Ulanzi\global-settings.json` deleted, **no Ulanzi deck attached** — that last condition is the whole point, since with a deck attached the old `willAppear` re-drive masks the result. Start UlanziStudio and read the plugin log in order. Predicted, verbatim:

```text
[Ulanzi:WebSocket] Connected to UlanziStudio
[GlobalSettings] No settings file yet; requesting the deck host's settings for a one-time migration
[GlobalSettings] Settings received from host for migration
[GlobalSettings] Migrated global settings from the deck host
[SettingsWindow] Mirrored settings + channel to the deck host
```

A `[GlobalSettings] Global-settings read requested while the host socket was not open` line before those is expected, not a fault — it is the pre-open no-op, and its absence merely means the socket won the race. The failure the fix exists to remove is this line, ~10 s in:

```text
[GlobalSettings] Deck host did not answer the migration read; starting fresh
```

Then check the file that appears: the user's real key bindings, and neither `_migrationPending` nor `_migrationAbandoned`.

**Test 2 — does an empty host bucket's reply survive the client's ack filter?** This is the one assumption the mirror gate rests on, so it is no longer optional. The gate is free only because the abandoned marker is set solely when the host answered *nothing* — and a host that answers nothing answers no Property Inspector's bootstrap read either, so the channel the mirror would carry is unreachable anyway. If instead the host answers an empty bucket with a `code`-stamped frame, the `#868` ack filter drops it, every **fresh** install marches through three ten-second starts to the ceiling, and the gate shuts the mirror of an install whose host was talking all along.

Testing an empty bucket directly needs a machine that has never run iRaceDeck on Ulanzi, which is usually impractical. The shape of any reply answers it just as well: with a settings file present and **debug logging on** (Settings window → Diagnostics), restart the plugin and find the client's raw frame log for the connect-time read, which fires on every start whether or not deck-core wants it:

```text
[Ulanzi:WebSocket] Received frame: {"cmd":"didReceiveGlobalSettings",…}
```

If that JSON carries a `code` field, an empty bucket's reply carries one too, and the ack filter drops it — the assumption is broken and the ack-filter change must ship with this. If it carries no `code`, an empty reply reaches deck-core as a real answer, the ceiling is unreachable on a talking host, and the gate is free as designed. Note the trap this test works around: `debugLogging` is applied from the schema-default cache, so on a migration start (no file) the wire log is suppressed exactly when it would be most interesting — which is why this is a second, file-present run rather than something to look for during test 1.
