# Accept the uncorrelated migration read, and correct the record on what the hosts offer

> **Issue:** [#1053](https://github.com/niklam/iracedeck/issues/1053) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

While the one-time settings migration is waiting for the deck host, `initGlobalSettings` accepts **any** `didReceiveGlobalSettings` that arrives. The whole guard is `global-settings.ts:1666`:

```ts
if (storeReady || migrationDone || !migrationRequested) return;
```

`migrationRequested` is a boolean set at `:1761`, before the read goes out. Nothing pairs the read with the reply, so for the length of the window — `MIGRATION_TIMEOUT_MS`, 10 s — a payload from any source is taken as the migration's answer: it sets `migrationDone`, becomes the cache, is persisted, and decides the store's source.

**Ulanzi is where this bites hardest, and it is why the issue was worked now rather than later.** Nothing in the mechanism is Ulanzi-specific, but a store that has been given up on makes no host write at all — `hostMirrorPayload` returns `undefined` for both `publish` and `publishUnavailable` once `_migrationAbandoned` is set — so no `_settingsChannel` is published and **every** Property Inspector on that install is on the fallback path by construction, reading and writing the deck host's copy. The population most exposed to this race is exactly the one [#1041](https://github.com/niklam/iracedeck/issues/1041) and [#1047](https://github.com/niklam/iracedeck/issues/1047) were about.

## The issue body's premise about Elgato is false

The issue says *"Elgato's protocol has no request id for `getGlobalSettings`, so this would mean an adapter-level convention"*, and reasons from there. **That is wrong**, and since the issue is the document a future reader meets first, the correction belongs here in full. Verified against the installed `@elgato/streamdeck` 2.1.x:

- `api/command.d.ts:62` — `GetGlobalSettings` carries an optional `id`.
- `plugin/settings.js:42` — the SDK sends `id: randomUUID()` on **every** `getGlobalSettings()` call.
- `api/events/system.d.ts:16-22` — the reply declares `readonly id?: string`, documented as *"Identifier provided when requesting the settings, used to identify the source of the request. **This is always undefined if the event is received because the settings were changed in the property inspector.**"*

That sentence is precisely the discriminator this issue wants, on the wire, on the record, from the vendor. The protocol separates "a reply to something I asked" from "a Property Inspector changed something" and says so.

What is actually missing is our **access** to it. `DidReceiveGlobalSettingsEvent` copies only `source.payload.settings`, and its base `Event` keeps only `source.event` (`plugin/events/event.js`), so the id is discarded one layer above the wire. `ElgatoPlatformAdapter.onDidReceiveGlobalSettings` then forwards `ev.settings` alone (`adapter.ts:343`), `getGlobalSettings()` calls the SDK's promise-returning method and drops the promise (`adapter.ts:349`), and `IDeckPlatformAdapter.getGlobalSettings()` is typed `void` (`types.ts:137`) — so the seam cannot express a correlated read even if the adapter wanted to.

The accurate claim, which should replace the issue's: **the Elgato protocol correlates and documents it; the SDK's public event object does not expose the id, and our own seam types the read as fire-and-forget.**

The same sweep also settles the hazard's premise on that host. The SDK's own doc comment for `onDidReceiveGlobalSettings` reads *"Occurs when the global settings are requested, **or when the global settings were updated in the property inspector**"* — so a PI's write reaching the plugin is documented behaviour on Elgato, not an assumption.

## What each host actually offers

| Host | Discriminator on the reply | Evidence |
| --- | --- | --- |
| Elgato | `id` — present on our reply, absent on a PI-originated push | **Documented** — SDK types and implementation, read directly |
| Ulanzi | `actionid` — echoed verbatim, unvalidated | **Measured** — [#1039](https://github.com/niklam/iracedeck/issues/1039)'s six-permutation sweep against a live host |
| Mirabox | **none** | Code-verified: the read is `{ event, context: pluginUuid }` (`vsd-client.ts:229`) and the reply path reads only `payload.settings` (`adapter.ts:208`) |

Two things are worth stating precisely rather than collapsing into the table.

**On Ulanzi the correlation would have to fail open.** `actionid` works as a nonce only while the host keeps *echoing* an address it has never seen, and both `deck-adapter-ulanzi/src/adapter.ts:383` and the #1041 spec already name that as the assumption the addressed read rests on — which is why the `willAppear` re-drive was kept as its fallback. A strict filter would drop a good reply on a host version that started resolving the field instead, which is #1041-shaped loss by a new route. A filter that fails open only helps when a correct reply *also* arrives, which is not the failing case.

**Whether a PI write reaches the plugin socket at all is unmeasured on Mirabox and Ulanzi.** #993's own spec lists the Ulanzi case as inferred rather than observed. One Mirabox data point, from `com.iracedeck.sd.core.sdPlugin/log/2026.8.30.log`, shows exactly one `didReceiveGlobalSettings` reaching the plugin in a session where both a read and a write went out — consistent with "the host answered the read and did not echo the write", but one session in one ordering proves nothing, and that client logs no raw frames, so it cannot say which frame it was.

## The obstacle that outranks the options

**On both WebSocket hosts, deck-core's migration read routinely never reaches the host.** Both clients issue an unconditional `getGlobalSettings` in their socket `open` handler (`vsd-client.ts:139`, `ulanzi-client.ts:348`), while deck-core's read fires at store-load time, before `adapter.connect()`, where the socket is still closed and the frame is dropped — silently on Mirabox, deliberately and logged on Ulanzi. Because `migrationRequested` is set unconditionally before the call, the **connect-time read's** reply is what completes the migration.

This is by design, and `ulanzi-client.ts:538` says so: *"Both reads are load-bearing, one per ordering; do not de-duplicate them."*

So the issue's leading option — *"the adapter tags the read it issued and only forwards the first reply that follows it"* — cannot be implemented at the `IDeckPlatformAdapter` boundary on two of three hosts. Keyed to deck-core's read it drops the reply that legitimately migrates; it has to become "a read this *client* issued", which is a weaker rule that admits everything on a host whose connect-time read is unconditional.

## Decision

**Accept the uncorrelated read. Document it, and pin it with a test.** No behaviour change.

The case is not that correlation is impossible — on Elgato and Ulanzi it is possible — but that it buys little where it is available and nothing where it is not:

- Three different mechanisms, one per host, with no shared convention to hold them together: a `id`-based read on Elgato, an `actionid` nonce on Ulanzi, and nothing at all on Mirabox, where only a latch is implementable and a latch does not address the in-window race.
- Two of the three rest on host behaviour this project has already been burned by twice (#1039, #1041), on the code path where being wrong costs settings the user cannot get back.
- The hazard's premise is documented on one host and unmeasured on the other two, and it cannot be measured without a `setGlobalSettings` against a real host's bucket.
- The worst case is already bounded. #1047 left three mitigations standing: the window opens once per version rather than three times per install, an empty or `null` payload retires nothing, and on the retry path the file wins outright (`{ ...raw, ...migrationBase }`), so an errant payload can only *add* keys the settings file has never held.

There is also a reason the realistic bad payload is less bad than it sounds, and it should be recorded so nobody re-derives the alarm: the window is only meaningfully open on a host that is **not** answering the read — on a host that answers, `migrationDone` closes it within milliseconds of the socket opening, long before a PI could bootstrap (3 s) and be saved into. On a host that is not answering, the alternative outcome is a defaults file plus a countdown, and the errant payload is a fallback PI's snapshot of the very bucket the migration wanted to read. It is not a foreign payload; it is the right data obtained through the one reader the host does answer.

That is an argument for accepting, **not** a guarantee — a PI whose own bootstrap read went unanswered would save a truncated snapshot, which is the harmful shape. Post-#1039 that is a pre-3.1 artefact rather than a live path, and it is the reason this is "accept" rather than "harmless".

## Alternatives rejected

**Wire correlation on all three hosts.** The issue's first option and its stated favourite. Rejected on the grounds above: unimplementable on Mirabox, fail-open-only on Ulanzi, and blocked behind a seam change on Elgato — for a hazard that is bounded on every path that reaches it.

**Elgato-only correlation.** The honest alternative, and the one to reach for first if this is ever reopened. It needs three things together: `settings.useExperimentalMessageIdentifiers = true`, which flips `onDidReceiveGlobalSettings` to PI-originated frames only — the exact complement wanted; the migration read moved onto the SDK's promise; and `IDeckPlatformAdapter.getGlobalSettings()` changed from `void` to a returning read. Not taken now because it closes one host while leaving the other two, changes a published seam, and needs a version branch — the flag is gated on Stream Deck ≥ 7.1 and `requiresVersion` throws below it. One residual race survives even then, and it should be known before anyone starts: the SDK's promise is `connection.once("didReceiveGlobalSettings", …)` resolving on `ev.payload.settings` without reading `id`, so it still resolves on the next event of any origin.

**Ignore payloads that arrive while a Property Inspector is known to be open.** `IDeckPlatformAdapter` exposes `onPropertyInspectorDidAppear` and **no disappear** (`types.ts:162`), so "a PI is open" is a one-way latch — adequate for a 10 s window, but the trade is bad in the direction that matters. A plugin restarted by the host with a PI already on screen would latch before the host's genuine answer arrives, and rejecting that answer converts a bounded, non-destructive hazard into the unbounded one #1041 was filed for.

**Shrink the window.** Not a fix — it changes the odds, not the failure — and #1056 shows the budget is already being consumed by connect latency rather than being generous.

**Suppress a fallback-path PI's global-settings write at the router.** Considered because it removes the echo at its source in one shared place, on all three hosts, with no adapter work — and because such a write is already semantically inert: the plugin ignores it and the next start's mirror overwrites it. Rejected for now on its own merits. It trades a PI that *lies* (shows an edit as saved when it is not) for one that silently reverts, which is not obviously better without a banner to explain it; it is a user-visible behaviour change well outside this issue; and on an abandoned store the host copy a fallback PI writes to is the preserved pre-3.0 copy, so the change interacts with #1041's containment and deserves its own review rather than a paragraph here.

## Consequences

- The behaviour is unchanged, and the guard's comment at `global-settings.ts:1667` becomes accurate: it currently reads as though nothing is ever ingested, which is true only outside the window.
- `.claude/rules/global-settings.md` states the rule as *"A payload that arrives without having been asked for … is **ignored**"*. That is right about the closed window and silent about the open one; it should say what "asked for" means — a boolean, not a correlation — so the next reader does not have to find it out from the code.
- The issue body's Elgato premise stands wrong on GitHub. This spec is the correction of record; the issue should link it rather than be rewritten, so the mistake and its correction stay legible.
- Reopening this is cheap: the per-host inventory above is the expensive part of the analysis and it is written down.

## Verification

Unit, in `packages/deck-core`. The suite already contains this case's mirror image at `global-settings.test.ts:1530` — *"a host payload racing the file load never overrides the file"* — which passes because the store has a file, so `migrationRequested` is false and the guard rejects the echo. #1053 is the same payload with the guard **open**, and the missing test is exactly that: with no file, a payload arriving inside the window is accepted as the migration answer. Pin it as deliberate, naming this spec, so a future reader finds a decision rather than an oversight. Add the retry-path pair too — the same payload on a give-up retry can only add keys the file never held — since that is the bound the decision leans on.

Manual, and free whenever anyone next has a host in front of them: **with debug logging on, edit a global setting in a fallen-back Property Inspector and look for `Ignoring host settings payload` in the plugin log.** One line, no writes to any bucket that is not already being edited, and it settles the one question this spec had to leave unmeasured — whether a PI's write reaches the plugin socket on Mirabox and Ulanzi at all. A payload appearing is a positive result; not appearing only says it did not appear in that run.
