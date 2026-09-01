# Extend the migration deadline once, from the connect or from the deadline itself, behind an optional seam member

> **Issue:** [#1056](https://github.com/niklam/iracedeck/issues/1056) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

`MIGRATION_TIMEOUT_MS` (10 s) is the budget for the one-time settings migration, and it is armed the moment `deck-core` issues the read — `global-settings.ts:1846` calls `adapter.getGlobalSettings()` and `:1852` arms the timer three lines later.

On both WebSocket hosts that read cannot be answered yet. `initGlobalSettings` runs before `adapter.connect()`, and each client drops a frame written while its socket is closed. What actually reaches the host is the unconditional read each client issues from its own `open` handler (`vsd-client.ts:139`, `ulanzi-client.ts:348`). So the clock starts before the question can be asked, and connect latency comes straight out of the migration's budget.

The consequence is not a benign retry. A migration that runs out of budget while the host was perfectly willing to answer writes a defaults file carrying the `_migrationPending` countdown; three such starts reach the ceiling and stamp the durable `_migrationAbandoned` marker, which shuts the once-per-start host mirror for good. That is the #1041/#1047 failure shape reached through slowness rather than through addressing, on a host whose read works correctly.

(The issue cites `:1766`/`:1762`; those line numbers predate current `master`. The numbers in this spec were read at `d1e58c14`.)

## Decision

Three changes, and deliberately no fourth:

1. **Leave the current arming exactly where it is.** The timer is still armed at `global-settings.ts:1852`, immediately after the read goes out.
2. **Add an optional member to the seam** — `onHostReady?(cb: () => void): void` on `IDeckPlatformAdapter`, optional in the same mould as `supportsApplicationMonitoring?` (`types.ts:155`).
3. **Extend the deadline exactly once**, granted by whichever comes first: the member firing (the host became reachable — clear the deadline and re-arm it for a full budget from that moment), or the deadline expiring while a subscribed member still hasn't fired. One flag for both, so they cannot compound and the worst case stays at twice the budget.

So the budget is either measured from a point where the question could actually be asked, or bounded at twice it.

The expiry-side half was added after the first implementation shipped only the connect-side re-arm and a fake-host harness showed it did not cover the case the issue is about: a handshake slower than the budget expires the deadline before the connect fires, leaving nothing to re-arm. Both halves are needed, and one flag keeps them bounded together.

Mirabox and Ulanzi implement the member from the same `open` handler that already flushes the deferred `setGlobalSettings` (`vsd-client.ts:136-148`, `ulanzi-client.ts:338-357`). **Elgato does not implement it**, and neither does the scenario harness's `MockPlatformAdapter`. Absence is the statement: nothing to wait for, so the initial arming stands.

Excluding Elgato is verified rather than assumed. Its SDK queues the read until the connection exists — `@elgato/streamdeck@2.1.2` (the version `pnpm-lock.yaml` pins), `dist/plugin/settings.js:36-44` routes `getGlobalSettings()` through `connection.send(...)`, and `dist/plugin/connection.js:71-72` is `async send(command) { const connection = await this.connection.promise; … }`. The code is identical in the 2.1.0 copy also present in the store. Until this was checked the claim existed only as three comments asserting each other (`vsd-client.ts:254`, `ulanzi-client.ts:562`, `.claude/rules/global-settings.md`), which is why it is cited here by file and line.

## Named requirements

These are requirements rather than tests, because a test can be deleted around a refactor and a requirement cannot be satisfied by accident.

- **R1 — A host that never connects must still reach the ceiling.** At twice the budget rather than once, but it must still get there: the grace is spent, the deadline fires again, `becomeReady(migrationBase, "fresh")` increments `_migrationPending`, and three such starts stamp `_migrationAbandoned`. Prove it, don't assume it — it is the requirement the whole design exists to protect. **This is why the deadline is re-armed rather than relocated.** "Arm it when the read can be answered", taken literally, silently disables the ceiling: a host that never connects would never arm, never time out, and never give up — trading #1056 for a worse #1041.
- **R2 — One extension per start, whichever path grants it.** Otherwise a reconnecting host, or a slow one that also connects, extends the window without bound.
- **R3 — A synchronous answer still arms nothing.** `global-settings.ts:1850`'s `if (migrationDone) return;` stays, and the hook must not resurrect a deadline for a migration that already completed.
- **R4 — `MIGRATION_TIMEOUT_MS` does not change.** Both #1041 and #1047 rejected a larger value by name: it does not help a read that cannot be answered, and it taxes every healthy install. After this change the constant is honest for the first time — it measures a window in which the question can actually be asked.
- **R5 — Only an adapter that declares the member gets either path.** Elgato's SDK queues the read until it can be sent, so its budget was never spent waiting for a connection; it gives up on the original schedule.

## Why an optional member, on SOLID grounds

The optional-vs-required choice is the whole design, and each principle says the same thing for a different reason.

**Liskov is the decisive one.** Under a *required* member, Elgato's implementation would be a stub: the contract says "call back when the host is ready", Elgato's host does become ready, and the stub never says so. Be precise about the limit of that, because the honest version is the stronger one — today the consequence is benign. Never firing means never re-arming, which is exactly right for Elgato, so the stub is a semantically valid Null Object *for this one consumer*. **The violation is deferred, not absent.** The moment anything else consumes `onHostReady`, Elgato silently does nothing and the failure is invisible at the call site. With an optional member there is no contract to violate, because absence is itself the statement.

**Interface Segregation** is the obvious one: a required member forces Elgato and the harness mock to depend on something they have no use for. The repo already confesses this in a comment — `switchToProfile` is required at `types.ts:185` and no-op'd by both WebSocket adapters with the note that it "exists to satisfy `IDeckPlatformAdapter`" (`deck-adapter-mirabox/src/adapter.ts:382-390`, `deck-adapter-ulanzi/src/adapter.ts:491-499`). Note the cost is four implementers, not three: `scenario-harness/src/mock-platform-adapter.ts:19` implements the interface too.

**Single Responsibility** is why a client-side fix was never viable, and it states the reason better than "the deadline lives in deck-core": `deck-core` owns migration *policy*, adapters own *transport*, and a client-side fix asks transport to own policy. This design asks the adapter only to report a fact it alone knows.

**Open/Closed:** a future adapter that needs the hook implements it; one that does not, does not. No existing file changes to add one.

## The role interface nobody proposed, and the price of skipping it

By-the-book ISP points at a separate role interface — `IHostReadyNotifier`, implemented alongside `IDeckPlatformAdapter`, with a capability check in `deck-core`. Role interfaces over one interface with optional members is the textbook answer, and it is not what this spec chooses.

It was passed over because TypeScript's structural typing makes `adapter.onHostReady?.(cb)` and a type-guarded role interface near-identical at the call site; `supportsApplicationMonitoring?` already establishes the optional-member pattern here; and a whole interface for one optional callback is ceremony at this scale. The price of skipping it is that a second capability of this kind would make the pattern worth revisiting — at two or three optional members the interface has started describing several roles, and that is the point to split rather than to add a fourth.

## Alternatives rejected

- **Solved entirely inside each client.** Not a solution. `deck-core` owns the timer, so only `deck-core` can move it; a client's only lever is *when the frame goes out*, and delaying it does not stop the clock. Stashing the read is also the thing #1046 deliberately did not do — the `open` handler already reissues it, so a stash would only duplicate the frame.
- **A required seam member.** Rejected on Liskov and ISP above.
- **`getGlobalSettings()` returning a promise that resolves when the frame reaches the wire.** It changes a required member's contract for all four implementers; a host that never connects leaves it unresolved, so R1 would need a fallback timer anyway and the promise buys nothing over the re-arm; and on Ulanzi "sent" is not "answerable", since an unaddressed read is discarded (#1039).
- **Granting the grace only when a connect is genuinely in progress.** The attractive refinement: extend for a host that is mid-handshake, but not for one that is never coming, so a dead host keeps costing one budget instead of two. **Rejected on measurement, not on argument** — the two are indistinguishable at the only moment that matters. Probing the real built clients against a fake host, sampling `ws.readyState` at the 10 s mark:

  | condition | Mirabox | Ulanzi |
  | --- | --- | --- |
  | slow host, still mid-handshake | `CONNECTING` | `CONNECTING` |
  | host accepts TCP and never upgrades | `CONNECTING` | `CONNECTING` |
  | nothing listening at all | socket `CLOSED`, `onClose` fired at +1 s | same |

  Only the third is distinguishable, and it never reaches the deadline: the connection is refused, and both clients end the process on close. A gate on "a connect is in progress" would therefore be granted to exactly the hosts it was meant to exclude. Do not re-derive this.

  The same measurement makes the accepted cost smaller than it first appears. A genuinely absent host cannot reach the deadline at all; only a host that accepted TCP can, and of those, the connect-completes-then-silent case was **already** paying two budgets through the connect-side re-arm. The grace adds exactly one reachable case — accepts TCP, never upgrades — rather than doubling the cost of every dead host.

- **A larger `MIGRATION_TIMEOUT_MS`.** See R4.

## Costs accepted

Worst case is twice the budget — roughly 20 s — before the store is ready, reached either by a slow connect or by the expiry-side grace. Throughout that window everything gated on `isSettingsStoreReady()` is degraded: key bindings read as unset, `focusIRacingIfEnabled()` skips the focus, and the plugin's store-ready block has not run, so a Property Inspector opened in that window bootstraps with no `_settingsChannel` and falls back to the deck host's copy, showing edits as saved that never reach the file. Weigh that whole list, not just the bindings, before anyone widens the window further.

That is a real regression in the slow case, and it is accepted deliberately: today's behaviour there is not a fast answer but a *wrong* one — a bogus give-up that can reach the durable marker and leave a user's settings preserved-but-unread until a newer version spends its one retry. Slow and correct over fast and wrong.

## What is not measured

**The 7.18 s is one observation in one ordering, and must not harden into a distribution.** It came from a Mirabox log on a session that had a settings file and therefore armed no deadline at all; what it measures is connect latency on the code path a migration start would share. Nothing says it is typical, a floor, or a ceiling.

To get a real figure someone would have to log the interval between `initGlobalSettings` and socket open across many starts, on both WebSocket hosts, cold and warm. **No number is needed for the fix**, and that is the point: extending from the event — or, failing that, once from the deadline — is what keeps this out of "just raise `MIGRATION_TIMEOUT_MS`", which R4 forbids.

What *was* measured, as opposed to reasoned: the `readyState` table above; that Elgato's SDK awaits its connection (`dist/plugin/connection.js:71-72`); and that the first implementation left the beyond-budget case unfixed, observed by driving the real built plugin against a fake host holding the upgrade for 15 s. That last one is why the expiry-side grace exists — every unit test connected inside the budget, so every measurement that existed was consistent with the fix being complete.

## Affected artifacts

- `packages/deck-core/src/types.ts` — the optional `onHostReady?` member.
- `packages/deck-core/src/global-settings.ts` — subscribe when the migration read goes out; re-arm once on first fire.
- `packages/deck-adapter-mirabox/src/{adapter,vsd-client}.ts`, `packages/deck-adapter-ulanzi/src/{adapter,ulanzi-client}.ts` — expose an open notification from the client and surface it on the adapter. Neither client has one today: `pendingGlobalSettings` is a single-purpose one-slot stash private to the client, not a general "run this on open" queue.
- `packages/deck-adapter-elgato` — unchanged, deliberately.
- `.claude/rules/global-settings.md` — the startup section describes the timeout and must say what it is now measured from, including R1.
- Tests in `packages/deck-core`.

## Test position

Nothing in the suite currently pins *when* the deadline is armed relative to any transport event — that is absent rather than merely unfound. Every fake-timer test treats `initGlobalSettings(...)` as time zero, and no mock adapter models a connection lifecycle at all.

Two existing invariants must survive, and leaving the initial arming untouched preserves both without editing a single existing test: the timeout still fires a budget after init, and it is still suppressed when a synchronous answer sets `migrationDone` — `global-settings.test.ts:1604`'s `expect(vi.getTimerCount()).toBe(0)` is the assertion most exposed to a careless change here.

New coverage: a late connect still migrates; a host that never connects still reaches the ceiling on schedule (R1); the re-arm fires at most once (R2). The first of these needs a mock adapter that models a connection lifecycle, which the suite does not have yet.
