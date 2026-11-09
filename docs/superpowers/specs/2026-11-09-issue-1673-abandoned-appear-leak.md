# A task the context order abandons is followed by its teardown again

> **Issue:** [#1673](https://github.com/niklam/iracedeck/issues/1673) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

`ContextEventOrder` (#1597) lets an event stop waiting for a task that has run `CONTEXT_EVENT_WAIT_LIMIT_MS` (10 s) and abandons that task without cancelling it (`context-event-order.ts:508`, `abandon`). When the abandoned task is an appear and a `willDisappear` follows it, the teardown runs, then the appear resumes and writes its context back into every per-context map, and no further `willDisappear` ever comes for that appearance. The #1597 spec put cancelling out of scope; this spec decides how the state is removed without it.

**Precondition.** This spec assumes #1599 ([PR #1672](https://github.com/niklam/iracedeck/pull/1672)) has merged first: `BaseAction.contextSettings`, `ConnectionStateAwareAction.liveContexts` and its sim-presence listener are named as they are on that branch, and every line reference below is to its head.

## What the code constrains

1. **Only the order knows arrival order.** Audio Controls awaits two settings writes before `super.onWillAppear` (`audio-controls.ts:302-314`) and AI Spotter Controls one (`ai-spotter-controls.ts:192-193`). When either hangs, the teardown runs before `BaseAction.onWillAppear` has even started, so at the base's entry a resumed stale appear and a real re-appear of the same context id are identical calls.
2. **A hang can sit at any await of the appear chain.** Besides those two, the base awaits its first-appearance `setSettings` (`base-action.ts:370-374`), and about twenty actions await their first render (`setKeyImage` → `setImage`, the same host send) after `super.onWillAppear` and only then subscribe or record the context (`camera-controls`, `chat`, `fuel-service`, the seven `setup-*`, `replay-control`, `replay-markers`, `session-info`, `telemetry-display` among them).
3. **Every teardown but one is re-runnable.** Of the 32 `onWillDisappear` handlers in `deck-core`, `deck-iracing` and `iracing-actions`, 31 are id-keyed deletes, unsubscribes by id, throttle clears and per-context binding releases; none counts or pushes. Car Control is the exception: its escape-mode teardown sends an ESC key-up whether or not this key pressed ESC (`car-control.ts:1043-1045`), as do its key-up and dial-up (`:1126-1130`, `:1163-1167`), and its auto-hold path releases on a timer and on a second press (`:1432-1462`). A second run would release an ESC another key is holding.
4. **Every adapter's disappear task can run twice, and builds its event when it runs.** Elgato wraps the SDK event it captured (`deck-adapter-elgato/src/adapter.ts:609-614`). Mirabox wraps the frame it captured and deletes `contextControllers` (`deck-adapter-mirabox/src/adapter.ts:411-417`), a no-op the second time. Ulanzi reads the controller when the task runs and then deletes the entry (`deck-adapter-ulanzi/src/adapter.ts:617-622`); with no entry, `getControllerType` falls back to `knownEncoderContexts`, which is never pruned (`:471-473`). So a re-run carries the same context and the controller the adapter records for it when the re-run runs — not necessarily the first run's: a promotion that resumes late writes `Encoder` (`:496-499`, `:534-541`) after a teardown that ran as `Keypad`, and the re-run then tears down the `Encoder`. The Ulanzi client's write-through settings cache adds no entry for a context it has cleared (`ulanzi-client.ts:581-585`).
5. **The order already knows the appearance boundaries** — a context is live from its `willAppear` arrival to its `willDisappear` arrival — and already holds the disappear task the adapter built.

## Decisions

### 1. The fix lives in `ContextEventOrder`: a late task is followed by its appearance's teardown again

The order gives every appearance a **lifetime**: one record per `willAppear` arrival, carried by every task that arrives while it is live, which notes the `willDisappear` entry that ends it.

```typescript
interface Lifetime {
  /** The willDisappear entry that ended this lifetime, once it has arrived. */
  teardown: Entry | undefined;
  /** Whether a re-run of its task is owed and not yet started. */
  rerunOwed: boolean;
}
```

When a task that was **abandoned** settles — resolving or rejecting — and its lifetime's teardown **has started**, its writes may have landed after the teardown, so the order runs that teardown's task again. Where the second run goes depends on how far the context has moved on, and in every case the two runs never overlap:

- **The teardown entry has not settled yet.** The entry is marked to run its task once more when the first run settles, and it releases only after the second run. Everything queued behind it — a re-appear included — waits for both runs.
- **The teardown entry has settled, and a re-appear has arrived but not started.** The re-run runs at the start of the re-appear's entry, before the appear's own task, so the appear and everything behind it wait for it.
- **The teardown entry has settled and no re-appear has arrived.** The re-run gets its own exclusive enqueue on the context's chain, bypassing the arrival liveness check (a record is created if the old one was pruned, and pruned again once it drains). A re-appear arriving later waits for it.
- **A re-appear has started.** Nothing runs, and the skip line below is logged: tearing down now would destroy the live appearance. This is the one case left open (Out of scope).

A second late task of the same lifetime adds nothing while a re-run is owed and not started. A late task whose lifetime's teardown has not started needs nothing: that teardown runs after it. A task never abandoned cannot finish after its teardown, which waits for it. The re-run is part of an entry on the chain, so the 10 s bound applies to it too.

**Every abandoned kind, not only the appear — a deliberate widening of #1673, which names the appear alone.** The rule is keyed on the lifetime, not on the event, so it covers a settings change (`BaseAction.onDidReceiveSettings` re-adds the flag overlay and its subscription), Ulanzi's promotion step (whose synthetic `onWillDisappear` can hang before `appear` writes `contextControllers` and runs `onWillAppear` as an Encoder) and an input (a hold armed after the teardown). Restricting it to `willAppear` would leave the same leak one event kind over at no saving.

### 2. A real re-appear still registers

A re-appear that arrives while the teardown runs waits for both of its runs (decision 1, first case), and one that arrives after it settles runs after the re-run (second and third cases), on the same chain, as #1597 decision 3 orders a re-appear behind its teardown. A re-appear that has started is never torn down. None of these paths compares context ids, so a stable id per key placement cannot confuse them.

### 3. One action changes; the base classes and the adapters' code do not

The re-run calls each action's own `onWillDisappear`, so every map an action keeps is cleared by the code that already clears it, whatever await the late write came from. `BaseAction` and `ConnectionStateAwareAction` are unchanged, and so is adapter code (constraint 4); what changes for an adapter is the contract below and its test harness.

**Car Control** is the one action that changes (constraint 3). It records which of its keys pressed ESC, and releases ESC only for that key, in all three paths: the manual release (key-up, dial-up), the auto-hold timer and its second-press cancel, and the teardown. A teardown, or its re-run, for a key that holds nothing sends nothing.

### 4. `IDeckPlatformAdapter`'s behaviour contract changes; its shape does not

`registerAction`'s JSDoc gains: a handler may receive `onWillDisappear` a second time for one appearance, after a task of that appearance abandoned at the limit settles once the teardown has started, and never once a later appearance of the context has started; the adapter's disappear task must be safe to run twice, and the re-run carries the same context and the controller the adapter records for it when the re-run runs. No member is added. Because a published contract's behaviour changes, the implementation is reviewed at `xhigh`, and the second read applies (the per-context queue is a state machine: live, waiting, abandoned, re-run owed).

The action contract gains the matching line in `.claude/rules/stream-deck-actions.md` "Requirements": a teardown touches only what its own context holds, so running it twice, or after a late `onWillAppear` wrote, is safe.

### 5. Log lines

- A re-run, at warn, pairing with the abandon warning: `<event> for <context> settled after its teardown; running willDisappear again`.
- A skipped re-run, at warn: `<event> for <context> settled after its teardown, but the context has appeared again; its next willDisappear clears it`.
- A re-run that rejects, at error, with the error, as each host's dispatch logs a handler that throws: `willDisappear re-run for <context> failed: <error>`. The re-run's promise has no caller to log it, so without this line its failure would go nowhere.

## Per-context state that must end clean, and the test for each

Every test hangs a task, lets the disappear abandon it at the limit under a fake clock (`performance` included, since the limit is timed with `performance.now()`), releases it, and drains. Each carries an **in-test positive control**: a second gate holds the late task after it has written and before it settles, and the test asserts the entry is present there — the leak the re-run must remove is observable — then releases and asserts it is gone.

| State | Owner | Test |
| --- | --- | --- |
| `contexts`, `contextSettings`, `flagOverlayContexts`, `flagOverlayActive`, `titleTemplateContexts`, `lastResolvedTitles`, the title throttle's entry; `flagTelemetrySubId` and `titleTemplateSubId` back to `null` with no subscriber left on the fake sim connection | `BaseAction` | new `deck-core/src/overtaken-appear.test.ts`: a `ConnectionStateAwareAction` subclass with `flagsOverlay` on and a `{{` title, driven through the ordered reference adapter, in two shapes — the base's first-appearance `setSettings` hangs, and a pre-super await hangs (the Audio Controls shape) |
| `liveContexts` empty, `presenceUnsubscribe` `null`, no presence listener left (`connection-state-aware-action.ts:49-52`) | `ConnectionStateAwareAction` | same file |
| the order's records (`size` back to 0) | `ContextEventOrder` | `context-event-order.test.ts` |
| Ulanzi `contextControllers` | Ulanzi adapter | `deck-adapter-ulanzi/src/adapter.test.ts`: the promotion's synthetic `onWillDisappear` hangs, a real disappear abandons the step and tears down as `Keypad`, the step resumes and writes `Encoder` (positive control on that entry), the re-run tears down as `Encoder` and the entry is gone. Mirabox's `contextControllers` is written before its handler is called, so a late settle cannot write it; its suite run covers the re-run's delete |
| Audio Controls: the dial surface's per-context state, `repeat`, the held binding; AI Spotter Controls: `repeat`, the base's `contexts` | the actions | each action's `.test.ts`, under its mocked deck-core: the pre-super settings write hangs, `onWillDisappear` runs, the write resolves and the appear finishes (positive control: its entries present), `onWillDisappear` runs again as the order would, entries gone |
| Car Control's ESC holder | Car Control | `car-control.test.ts`: two escape keys, one holding ESC; the other's teardown, run twice, sends no key-up, and the holder's teardown sends exactly one; the same for a second press cancelling auto-hold and for the timer. Positive control: red against the unchanged action, which sends the stray key-up |

The re-appear cases are in the same files: after the late settle the maps hold exactly the re-appeared context's entries; a final disappear clears them.

## The contract suite gains two scenarios

`CONTEXT_EVENT_ORDER_SCENARIOS` gains:

- **An appear abandoned at the limit and settling after its teardown gets that teardown again.** The action-shaped fake's appear subscribes by id after a gate. The disappear has not run before the limit (delivery check), has run once at it, and after the gate opens has run twice for the same context, and no subscription remains. The scenario asserts the context only; the controller is each host's (constraint 4), checked by Ulanzi's promotion test.
- **A re-appear that has started before the late settle is not torn down.** Same start, the same checks up to the limit; a re-appear runs before the gate opens; after it opens the teardown has still run once and the re-appear's subscription is present.

The harness gains `elapse(ms)`, and a scenario that needs it is marked so each adapter's `it.each` installs Vitest's fake clock (`setTimeout`, `clearTimeout`, `performance`) for it alone; a harness whose `elapse` moves nothing fails at the first scenario's "ran once at the limit" check rather than passing. The positive-control matrix gains a reference built on the order whose disappear task calls the handler only on its first run — an adapter that is not re-runnable — which must fail the first scenario and pass every other; the unordered and serial references fail both new scenarios.

## Rejected alternatives

- **`BaseAction` checks after each await that the context is still live.** Its entry can itself run after the teardown when a subclass awaits first (constraint 1), the issue's typical case, so it would register the stale appear as fresh; it guards only the base's own await, not the twenty actions that subscribe after awaiting their first render (constraint 2); and a liveness check by id cannot tell the old appearance from a re-appear.
- **A lifetime token on the appear event, checked by `BaseAction`, which throws to stop the subclass.** It adds a member every adapter fills to `IDeckWillAppearEvent`, turns every overtaken appear into a rejection the hosts' dispatch logs as an error unless special-cased, and still misses an await after `super.onWillAppear`. Handing the token to actions to check is #1597's rejected per-action liveness check.
- **Cancelling** (an abort signal every action honours) — #1597's out-of-scope item, at the same cost.
- **Re-running the teardown even after a re-appear has started, then replaying the appear.** The replay needs the context's latest settings, which no host hands over on demand (#1597 amendment 3), and an appear with stale settings is worse than the stale writes it replaces.
- **Enqueueing every re-run at the tail of the chain.** A re-appear that arrived while the teardown ran would run first and then be torn down by the re-run; decision 1 places the second run ahead of it instead.
- **Holding a re-appear until the abandoned task settles.** A hung handler would then disable the key until restart, which the 10 s bound exists to prevent.
- **Fixing Audio Controls and AI Spotter Controls** (moving their writes after `super`). It removes two hang points of many (constraint 2).
- **Each adapter replays its own teardown.** Three copies of a rule the order already has the lifetimes for.

## Out of scope

- Cancelling a handler; an abandoned one still runs to its end.
- **A re-appear that already started before the late settle** (the double fault: an appear hung past the limit whose key appears again, and starts, before it settles). Its late writes stand over the new appearance until that appearance's next settings change or teardown; id-keyed entries are cleared then, but a handle the late write overwrote under the same id is not recovered.
- A hung **teardown** that resumes after a re-appear and deletes the new appearance's state — the reverse case, not a leak.
- Host sends a late handler makes to a context the host has removed, as #1597 left them.
- Work a handler detaches and does not await (timers, un-awaited promises); the actions' clear-before-await convention stays.
- The scenario harness's mock adapter, exempt from the suite as before.

## Testing

**The primitive** (`context-event-order.test.ts`), under the fake clock, with the teardown task a spy:

- An appear abandoned by a disappear and settling after the teardown settled: the teardown runs a second time, with one re-run warn line; `size` is 0 after.
- The same, settling by rejection: the same re-run.
- A re-appear queued behind a still-running teardown, then a late settle: the teardown runs twice, then the re-appear runs.
- The second run never overlaps the first: it starts only after the first run's promise settles.
- A late settle after the teardown settled, with a re-appear arrived but not started: the re-run runs before the appear's task, and the appear then runs.
- A re-appear that has started before the late settle: no re-run, the skip warn line, the re-appear's task ran once.
- A re-appear arriving while a re-run is queued runs after it.
- Settling after the disappear arrived but before the teardown started (the appear was abandoned by an input): no re-run.
- Abandoned with no disappear ever arriving: no re-run.
- Two late tasks of one lifetime while a re-run is owed: one re-run.
- A late settle after the record was pruned: the re-run runs and the record is pruned again.
- A settings change, a step and an input abandoned and settling late: each followed by one re-run.
- A hung teardown that settles late: no re-run of itself.
- A re-run that rejects: the error line with its error, and the events behind it still run.
- A re-run that hangs is abandoned at the limit by an event behind it.

**The base classes, the adapters and the actions**: the table above, each with its positive control. **The contract suite**: the two scenarios on every adapter and the reference matrix in deck-core. **Red first**: each new test and both scenarios are run against the unchanged order and the unchanged Car Control, and the failures are recorded in the PR body.

**End to end:** a host send that hangs for 10 s cannot be produced on demand, so the issue's `qa` agent runs the deck-core and adapter suites under the fake clock as the end-to-end check of the re-run. This is plugin runtime, not dev tooling, so it does not replace Niklas's test.

**Manual regression (Niklas, on hardware)**, with debug logging on:

- Flip pages back and forth quickly on a Stream Deck with dials, then on a Mirabox Stream Dock with knobs.
- Change a key's setting in its Property Inspector right after a flip.
- Long-press a key straight after a flip.
- Confirm every key and dial responds afterwards, and the log shows no `has not settled` warning and no `running willDisappear again` or `settled after its teardown` line.

## Changes to the repository

- `packages/deck-core/src/context-event-order.ts` and its test; `context-event-order-scenarios.ts` (two scenarios, `elapse`, the fake-clock marker), the reference adapters and the suite's own test; the new `overtaken-appear.test.ts`; `types.ts`, the `registerAction` JSDoc.
- The three adapters' order-contract harnesses (`elapse`, the fake clock); Ulanzi's promotion test.
- `packages/iracing-actions/src/actions/car-control/car-control.ts` and its test (the ESC holder); Audio Controls' and AI Spotter Controls' tests.
- `packages/deck-core/CLAUDE.md` ("Per-context event order": the re-run, its three log lines, the action contract); the #1597 notes in the three adapter `CLAUDE.md` files; `.claude/rules/stream-deck-actions.md`, one requirement line.
- No website page. One Bug Fixes changelog fragment, for Car Control: an Escape key released ESC even when another key was holding it (for example during ESC auto-hold), which shipped and a user can notice. The context-order change itself is internal and needs none.
