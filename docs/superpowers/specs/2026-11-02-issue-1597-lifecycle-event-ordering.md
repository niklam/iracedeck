# Per-context ordering of deck lifecycle events

> **Issue:** [#1597](https://github.com/niklam/iracedeck/issues/1597) · **Related:** [#1530](https://github.com/niklam/iracedeck/issues/1530) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

An action's `onWillAppear` is async, and nothing orders a `willDisappear` for the same context that arrives while it is still awaiting. The base classes show the shape of the damage. `ConnectionStateAwareAction.onWillAppear` awaits `super.onWillAppear` and only then subscribes the context's readiness tick (`connection-state-aware-action.ts:70-77`); `BaseAction.onWillAppear` awaits a `setSettings` write on a context's first appearance (`base-action.ts:355-359`); the disappear unsubscribes by id (`connection-state-aware-action.ts:83-84`). If the disappear runs inside the appear's await, its unsubscribe finds nothing, the appear resumes and subscribes, and a context that is gone re-evaluates its readiness on every sim tick for the life of the process. Actions that await a first render before subscribing or arming timers (`replay-navigation.ts:198-201`, `replay-markers.ts:238-256`, `chat.ts:295-303`) widen the window.

No host serialises a context's events, and no adapter does either:

- **Elgato.** The SDK's emitter calls each listener without awaiting it (`@elgato/utils` `event-emitter.js:35-48`, fed by `connection.js:133-138`), and the per-action route awaits only its own listener (`@elgato/streamdeck` `actions/service.js:206-216`). `BridgeAction` awaits the handler for that one event (`deck-adapter-elgato/src/adapter.ts:519-561`).
- **Mirabox.** The socket's message handler calls `routeEvent` without awaiting it (`vsd-client.ts:168-171`); `routeEvent` awaits only the handlers of that one frame (`vsd-client.ts:190-217`).
- **Ulanzi.** `handleFrame` routes each normalised event with `void this.routeEvent(ev)` (`ulanzi-client.ts:428-448`).

The hosts also disagree on liveness. Elgato's SDK keeps an action store updated synchronously at arrival (`actions/service.js:25-42`) and drops input and settings for a context that is not in it (`actions/service.js:110-113`, `settings.js:93-101`). Mirabox and Ulanzi deliver every event, falling back to a default controller for a context they do not track (`deck-adapter-mirabox/src/adapter.ts:342-344`, `deck-adapter-ulanzi/src/adapter.ts:439-441`).

#1530 (merged, `6c21efeb9`) ordered one case of this inside the Ulanzi adapter, for its Keypad-to-Encoder promotion: two promise maps (`encoderPromotions`, `appearsInFlight`, `deck-adapter-ulanzi/src/adapter.ts:216, 223`), a promotion that awaits the in-flight appear (`:478`), a wait at the top of every handler (`:547, 594, 639, 652, 670`, and `pendingPromotion` at `:522`), and a settings re-read for held input (`refreshHeldSettings`, `:620`). Its `CLAUDE.md` records the discipline that made it work: each handler reads the promise synchronously and awaits it itself, because an async wrapper adds a hop that lets a disappear overtake input queued before it. The general case is open on every host, and nothing would check that a fourth adapter orders anything at all.

## What the code constrains

1. **Every host hands an event to the adapter synchronously at arrival.** Elgato's emitter reaches `BridgeAction` in the same call stack (above); Mirabox and Ulanzi call the one registration that matches a frame before their first await (`vsd-client.ts:195-198`, `ulanzi-client.ts:461-464`), and `registerAction` registers one handler per uuid and event. So arrival order can be captured at the adapter without an extra hop.
2. **The deck-core event is built in the adapter, and on Ulanzi it is only right when it runs.** The controller a context reports and the settings it carries change while an event waits: the promotion reads the client's write-through cache after the Keypad appear has finished (`deck-adapter-ulanzi/src/adapter.ts:482`) and every held input event re-reads it (`:620`).
3. **One host event can be several handler calls.** Mirabox turns every host `dialDown` into `onDialDown` then `onDialUp` (`deck-adapter-mirabox/src/adapter.ts:419-428`); Ulanzi's promotion is a synthetic `onWillDisappear` then `onWillAppear` ahead of a dial event (`deck-adapter-ulanzi/src/adapter.ts:460-500`).
4. **Input runs concurrently with input today, and an action relies on it.** Fuel Service's key awaits a fuel step (`fuel-service.ts:760`) that is watched for at least `FUEL_STEP_WATCH_MS` = 300 ms (`fuel-step.ts:63`), and the stepper queues or supersedes a press that lands while a step runs (`fuel-step.ts:442-455`). That only happens if the second press reaches the action while the first is still awaiting.
5. **A legitimate handler can run for seconds.** Chat's send waits up to three delays of at most 2000 ms each (`global-settings.ts:557, 565, 574`) after a focus ask that can spend about 1000 ms (`window-focus-service.ts:86`), so about 7 s.

## Decisions

### 1. One ordering primitive in deck-core, applied at each adapter's dispatch

The rules — what waits for what, liveness, dropping, the bound, the log lines — are written once, in a new deck-core module `context-event-order.ts` exporting `ContextEventOrder`. It imports nothing but the `ILogger` type, so it is host-neutral and sim-neutral (deck-core's lint rule already refuses an iRacing import there). Each adapter creates one instance (context ids are unique per host, and a context belongs to one action UUID, as #1530 already relies on) with a logger scope of its own, and routes every per-context host event of `registerAction` through it.

The adapter is the call site rather than a wrapper around the handler, because that is where the event is built (constraint 2) and where one host event becomes several handler calls (constraint 3). A task is a function the adapter hands the primitive; it builds the deck-core event and calls the handler **when it runs**, not when it arrives. The adapter calls the primitive inside the host callback, before any await of its own (constraint 1), which is the #1530 discipline made structural: arrival order is fixed at the enqueue, and the primitive owns the chaining, so no adapter can add a hop.

When nothing is ahead of a task, the primitive runs it synchronously inside the enqueue call. Events that do not overlap therefore reach the handler at exactly today's moment, including the press sound `withPressSounds` plays right after a handler's synchronous part (`press-sounds.ts`, wrapped around every handler at `plugin-runtime/src/phases/register-actions.ts:65`). The queue sits outside that wrapper: a press that waits, waits with its sound, so the sound still tracks what the action does.

The guarantee becomes part of the documented contract of `IDeckPlatformAdapter` (`types.ts:233-240`, decision 6). The interface gains no member, so the seam's shape is unchanged; its behaviour is now stated, and decision 6 makes it checked.

### 2. Lifecycle events are exclusive; input waits only for lifecycle

| Event | Kind | Waits for | Later events wait for it |
| --- | --- | --- | --- |
| `willAppear` | exclusive | every earlier event of the context | all of them |
| `willDisappear` | exclusive | every earlier event of the context | all of them |
| `didReceiveSettings` | exclusive | every earlier event of the context | all of them |
| an adapter step (the Ulanzi promotion, decision 5) | exclusive | every earlier event of the context | all of them |
| `keyDown`, `keyUp`, `dialDown`, `dialUp`, `dialRotate`, `touchTap` | input | earlier exclusive events only | exclusive events only |

Input waits for an earlier appear, disappear, settings change or step to settle, and does not wait for earlier input: two presses still run concurrently, as Fuel Service needs (constraint 4). An exclusive event waits for input already in flight, so an input handler's continuation can never run after the teardown that follows it. Mirabox's host `dialDown` is one input task that runs `onDialDown` then `onDialUp`, so the atomic press stays atomic. A settings change is exclusive because it rewrites the same state an appear builds (`base-action.ts:364-371` against `:380-398`); the echo of an appear's own `setSettings` (`base-action.ts:353-354`) now runs after that appear instead of inside it.

**The latency cost, named.** An input that arrives while an exclusive event of its context is running waits for the rest of it. Exclusive events are rare at input time: an appear (a page switch), a disappear, a settings change (a Property Inspector edit) and the Ulanzi promotion. An appear's awaits are a settings write on first appearance (`base-action.ts:355-359`) and the action's first render; neither has been measured, so the primitive logs every wait at debug (decision 4) and the field logs measure it. The reverse direction costs nothing visible: a disappear behind a fuel step waits about 300 ms, behind a chat send up to about 7 s, and the teardown is merely late. One visible case remains: a Property Inspector edit made during a chat send reaches the key when the send ends. Both costs are capped by the bound in decision 4. Accepted, because the alternative — input that does not wait — is the bug class this issue exists to close.

Dial input that arrives before the dial surface's `willAppear` now waits for it rather than being dropped. That changes the reason rule 11 of `encoders-and-touchscreen.md` gives for keeping an action's pre-surface await short: it is now queueing latency, not lost input (decision 6).

### 3. Liveness is decided at arrival; events for a context not on the device are dropped

The primitive marks a context live when its `willAppear` **arrives** and not live when its `willDisappear` **arrives**, the moment Elgato's SDK updates its store. An input, a settings change or an adapter step that arrives for a context that is not live is dropped at arrival, and so is a `willDisappear` for a context that is not live. Events that arrived while the context was live still run, in order, before the disappear that followed them.

A context that never appeared is not live, so its input is dropped too. On Elgato that is what the SDK already does; on Mirabox and Ulanzi it replaces delivery with a defaulted controller. It rests on each host sending `willAppear` for every context before its input, including after a plugin restart. The code cannot show that for Mirabox or Ulanzi, so it is measured (Testing), and the drop is logged so that a wrong assumption is visible in a default-level support log (decision 4).

**If the Ulanzi measurement shows input for a context with no `add` before it,** the Ulanzi adapter does not drop that input: it enqueues a Keypad appear for the context (cached settings, falling back to the frame's) ahead of the event, so the context becomes live and the event runs after it. The rule for every other host stays as stated. That fallback is decided now so the measurement settles a branch rather than reopening the design.

A re-appear of the same context id after a disappear makes it live again but stays on the **same** chain: it runs after the disappear has settled. It is a new lifetime, not a fresh queue, because a fresh queue would let the re-appear's subscribe race the teardown's unsubscribe under the same id (`connection-state-aware-action.ts:73-74`, `:84`) — the re-add case #1530 had to handle by hand (`deck-adapter-ulanzi/src/adapter.ts:539-547`). A context's record is pruned once it is not live and nothing it ran is pending, so memory is bounded by the contexts on the device.

The adapter's own per-context bookkeeping moves inside the tasks, so it is ordered with the handlers: an appear task sets the controller entry before it calls the handler, and a disappear task reads it, deletes it and then calls the handler (the order #1530 chose, `deck-adapter-ulanzi/src/adapter.ts:594-608`, for the reasons it gives).

**Broadcasts fire at arrival, for a live context only.** The `onKeyDown` / `onDialDown` / `onDialRotate` callbacks the Mirabox and Ulanzi adapters fire for window focus (`deck-adapter-mirabox/src/adapter.ts:379, 399, 422`; `deck-adapter-ulanzi/src/adapter.ts:659, 696, 715`) fire when the event arrives, before it is enqueued, and only when its context is live. That matches Elgato, whose SDK-wide listeners pass only a context in its store (`actions/service.js:110-113`; `deck-adapter-elgato/src/adapter.ts:567-577`). On Ulanzi this moves the dial broadcast from after the promotion's re-appear to the dial event's arrival.

### 4. A throw settles a task; a task that never settles is abandoned after 10 s; what is logged

**A handler that throws** settles its task like any other outcome: the events behind it run. The promise the primitive returns to the adapter is the task's own, so it still rejects with the handler's error and every host's existing dispatch logging is unchanged (`vsd-client.ts:197-201`, `ulanzi-client.ts:463-467`).

**A handler that never settles** cannot wedge its context. An event waits at most `CONTEXT_EVENT_WAIT_LIMIT_MS` = 10 000 ms for the events ahead of it; at the limit it runs, and every task it stopped waiting for is **abandoned**: logged once at warn (`<event> for <context> has not settled after 10000 ms; later events no longer wait for it`) and never waited for again, so a hung input cannot stall each later lifecycle event in turn. The abandoned handler is not cancelled — nothing can cancel a promise — and it may still finish late, as every handler can today. 10 s is above the longest legitimate handler found (constraint 5, about 7 s), so a correct handler is never overtaken, and it bounds a hung context to one stall of 10 s instead of a dead key until restart. Past the limit the context degrades to today's unordered behaviour for that one pair, with a warning in the log.

**The log lines.**

- Every wait that happens at all, at debug, with its duration and what it waited for (`<event> for <context> waited <n> ms behind <event>`). Waits only occur on overlap, so the line is rare, and it is how the latency in decision 2 gets measured. Timers exist only while something waits and are cleared when the wait ends.
- A drop for a context that disappeared, at debug: `Dropped <event> for <context>: it has disappeared`.
- The **first** drop for a context that never appeared, at warn, and later drops for that context at debug: `Dropped <event> for <context>: it never appeared (the host sent no willAppear for it)`. Warn because that drop is the visible failure of decision 3's assumption, and a support log at the default level must show it; once per context, so a host that really does skip `willAppear` produces one line per key rather than one per press.

**Contract for actions:** a lifecycle handler must never await another event of its own context — a settings echo, an input — because that event is queued behind it; it would wait until the limit. No action does so today: the base appear awaits its `setSettings` write (`base-action.ts:359`), whose promise resolves on the send, not on the echo.

### 5. #1530's Ulanzi ordering is replaced; the promotion stays as one exclusive step

This issue removes the Ulanzi adapter's ordering machinery in favour of the shared primitive: `encoderPromotions`, `appearsInFlight`, `pendingPromotion`, `refreshHeldSettings` and the per-handler promotion awaits (`deck-adapter-ulanzi/src/adapter.ts:216, 223, 522, 620`, and the reads at `:547, 594, 639, 652, 670`). What only Ulanzi knows stays in its adapter:

- `knownEncoderContexts` (`deck-adapter-ulanzi/src/adapter.ts:206`), set at arrival, and `UlanziClient.cachedSettings` (`ulanzi-client.ts:597`).
- **The promotion is one exclusive step**, enqueued at the arrival of a dial event, ahead of that event, when the context is live and not yet known as an Encoder (and the context is added to `knownEncoderContexts` at that moment, so a second dial event queues behind the same step instead of starting another). When it runs, every earlier event of the context — the Keypad appear included — has settled, so it reads `cachedSettings(context)` then, falling back to the dial frame's settings, and runs the synthetic `onWillDisappear` as the previous controller, sets the controller to `Encoder`, and runs the synthetic `onWillAppear` as an Encoder, logging and carrying on past a handler that throws, exactly as the merged code does (`deck-adapter-ulanzi/src/adapter.ts:460-500`). It changes no liveness, so a real `willDisappear` arriving meanwhile queues behind it and tears the Encoder down.
- **Every Ulanzi input task reads its settings when it runs**, `cachedSettings(context)` falling back to the frame's: `refreshHeldSettings` applied uniformly. When nothing waited, that is the same snapshot the client backfilled at arrival (`ulanzi-client.ts:428-447`). An appear and a settings change keep the host frame's own settings, as #1530 decided.
- A disappear frame deletes the client's cache entry at arrival (`ulanzi-client.ts:451`), so a promotion or input task that runs after it falls back to the dial frame's settings. The context is torn down by the disappear queued right behind, so the staler copy is never acted on for long.

### 6. The contract is checked, not only written

The ordering holds only for an adapter that calls the primitive. Three things make that checked:

**A shared ordering contract suite, shipped from deck-core as a testing subpath.** `@iracedeck/deck-core/testing` (precedent: `@iracedeck/replay-engine/testing`, `packages/replay-engine/package.json:13-16`) exports `CONTEXT_EVENT_ORDER_SCENARIOS`, a list of named scenarios. Each scenario is a plain async function over an adapter harness that throws when a rule is broken; it imports nothing from `vitest`, so deck-core's published code takes no test dependency, and an adapter's test file runs the list with `it.each`. The harness each adapter supplies is small: the adapter under test (so the suite can subscribe its broadcasts), and `emit(event, context, payload?)`, which delivers one host event for a context **synchronously**, through the adapter's real dispatch (a fake SDK emitting to the registered `BridgeAction` on Elgato; the client's routed events on Mirabox and Ulanzi, as their tests already do). The suite registers its own recording handler, so it reads the handler calls itself. The scenarios hold every rule:

- a slow appear, then an early disappear: the disappear starts only after the appear settles, and the action-shaped fake (appear subscribes by id after a gate, disappear unsubscribes by id) ends with no subscription;
- no overtaking: with an appear in flight, an input then a disappear; the input runs before the disappear, after the appear;
- input after a disappear is dropped;
- input before any appear is dropped;
- two inputs run concurrently (both start before either settles);
- broadcasts fire only for a live context.

A production-import refusal test, shaped like `packages/replay-engine/src/index.test.ts:24-66`, keeps every non-test file from importing `@iracedeck/deck-core/testing`.

**Lasting positive controls inside the suite.** deck-core's own test of the suite runs every scenario against two test-only reference adapters kept beside it and asserts the outcome scenario by scenario: an **unordered** reference that calls the handler at arrival, as every adapter does today, on which each ordering scenario must fail; and a **strictly serialising** reference that runs every event one after another, on which the concurrency scenario must fail. Every scenario therefore fails on at least one reference, so none can pass vacuously, and a scenario edited into a no-op turns deck-core red. Each real adapter's red result against `master` is still recorded in its PR body.

**A guard that every adapter runs the suite.** `scripts/deck-adapter-order-contract.test.mjs` discovers every `packages/deck-adapter-*` package and every package whose sources declare `implements IDeckPlatformAdapter`, following the discovery in `scripts/runtime-deps-guard.test.mjs:75`, and fails for one whose tests do not import `CONTEXT_EVENT_ORDER_SCENARIOS` from `@iracedeck/deck-core/testing` and run it. The scenario harness's `packages/scenario-harness/src/mock-platform-adapter.ts` is exempt by name: its `registerAction` registers nothing (`mock-platform-adapter.ts:103`). The guard carries a planted control: a fixture adapter package without the suite, which it must report.

**The contract texts.** `IDeckPlatformAdapter`'s JSDoc states the guarantee on `registerAction` (`types.ts:233-234`) and on the three broadcasts (`types.ts:235-240`: they fire at arrival, for a live context only). The Architecture page's SEAM 2 bullet names the suite as part of implementing the interface. The decision 4 action contract becomes one requirement line in `.claude/rules/stream-deck-actions.md` "Requirements" (`:50`) pointing to deck-core's contract.

## Changes to the repository

- `packages/deck-core/src/context-event-order.ts` (new) and its test; the barrel export; the `./testing` subpath with `CONTEXT_EVENT_ORDER_SCENARIOS`, the two reference adapters, the suite's own test and the production-import refusal test.
- `packages/deck-core/src/types.ts`: the JSDoc on `registerAction` and on `onKeyDown` / `onDialDown` / `onDialRotate` (`:233-240`).
- The three adapters' `registerAction` and broadcasts, and their `CLAUDE.md` files; Ulanzi as in decision 5. Each adapter's tests run the suite, which replaces hand-written per-adapter versions of those scenarios. Adapter-specific tests stay: Mirabox's knob press with a disappear arriving between its `onDialDown` and `onDialUp` (it runs after both), and Ulanzi's promotion tests, plus a disappear arriving while the promotion waits for the Keypad appear (it tears down the Encoder).
- **Tests rewritten on purpose**, each to pin the decision it now contradicts:
  - `deck-adapter-ulanzi/src/adapter.test.ts:944` ("never promotes dial input for a context that has disappeared, but still delivers it") → the input is dropped and still never promoted (decision 3).
  - `deck-adapter-ulanzi/src/adapter.test.ts:956` ("never promotes, nor remembers as a dial, a context that never appeared", which delivers the rotate as a Keypad) → the rotate is dropped with the never-appeared warn line, and the context is not remembered as a dial (decisions 3 and 4).
  - `deck-adapter-ulanzi/src/adapter.test.ts:1064` ("fires the dial broadcast callbacks once for the promoted event, after the re-appear") → the broadcast fires once, at the dial event's arrival, before the promotion step (decision 3).
  - `deck-adapter-mirabox/src/adapter.test.ts:271`, `:291` and `:361-407` drive `keyDown` / `dialRotate` with no appear → each makes the context appear first; what they pin (the wrapped event, ticks, broadcast before handler) is unchanged (decision 3).
- `scripts/deck-adapter-order-contract.test.mjs` (new), with its planted control.
- `packages/deck-core/CLAUDE.md`: the module, the testing subpath, and the action contract in decision 4.
- `.claude/rules/stream-deck-actions.md` "Requirements": one line, a lifecycle handler never awaits another event of its own context, pointing to deck-core's contract.
- `.claude/rules/encoders-and-touchscreen.md` rule 11, from "Dropping is safe because…" to the end: input before the surface's `willAppear` now waits for it (decision 2), so the reason to keep an action's await before the surface short is that every input of the context queues behind it, not that input is lost; input after a disappear no longer reaches the action at all (decision 3); the Ulanzi sentence says the promotion is a queued step ahead of the dial event, so the surface sees `willAppear` first; `hasDialInputContext` stays as a second defence (tests and the harness drive surfaces directly).
- The Architecture page (`architecture.md`): the SEAM 2 bullet (`:484`) names the per-context order and the suite as part of implementing the interface; the outbound diagram (`:121-153`) routes `press --> action` through the adapters and the SEAM 2 node, labelled with the per-context order, and the prose under it says so.
- No changelog fragment: no user-visible behaviour is intended to change.

**Review.** The implementation is reviewed at `xhigh`: it changes the behaviour contract of `IDeckPlatformAdapter`, a published contract in `code-review.md`'s table. The second read applies: the per-context queue is a state machine (live, waiting, abandoned).

## Rejected alternatives

- **A wrapper around the handler, composed once in `plugin-runtime` beside `withPressSounds`** (`register-actions.ts:65`). Truly one line, and free for a new host, the property the 2026-11-01 architecture review credits press sounds with (`2026-11-01-architecture-review.md:323`). It orders calls whose arguments the adapter fixed at arrival, which is wrong on Ulanzi (constraint 2). Worse, the wrapper would decide liveness at arrival, so a real disappear arriving while the promotion waits for the Keypad appear would reach it before the synthetic re-appear, and that re-appear would make the context live again — the #1329 leak. To prevent it Ulanzi would keep its own queue holding every event of a promoting context away from the wrapper: two queues with an invariant between them, which is what this issue is meant to remove. It would also split Mirabox's atomic press into two queue entries. What a new host loses by the adapter-level choice is recovered by decision 6: the guard fails until its tests run the suite.
- **Each adapter keeps its own queue**, #1530's pattern three times. Three implementations of the same rules, which is how hosts came to disagree on liveness in the first place.
- **Strict FIFO over every event of a context.** Simplest to state, but a second press would wait for the first one's whole handler: Fuel Service's queue-or-supersede (constraint 4) would never engage, and rapid presses would run one after another at 300 ms or more each — a behaviour change for a user, for no ordering gain between two inputs.
- **Ordering appear and disappear only.** A settings change could still interleave with an appear, and a disappear would not wait for input in flight, so an input's continuation (a hold, a timer, a flash) could still run after the teardown.
- **No bound**, or **a bound that cancels.** Without one, one hung handler disables its key until the plugin restarts. Cancelling would mean an abort signal every action honours, which is the next alternative's cost.
- **Liveness checks in the actions** (a generation token tested after each await). The burden lands on every action and every subclass — 35 action files implement `onKeyDown` alone — and one missed await reopens the leak.
- **A fresh queue on re-appear.** The re-appear would race the teardown under the same subscription id (decision 3).
- **Serialising in the host clients' `routeEvent`.** It would order across contexts and global events too, and Elgato has no client of ours to change.
- **A suite that imports `vitest`** (a `describe…` helper shipped from deck-core). It would put a test framework in deck-core's published code; plain scenario functions run under `it.each` give the same coverage.
- **Per-adapter hand-written ordering tests only.** They prove the three adapters of today and nothing about the fourth, and nothing fails when one is missing.

## Testing

**The primitive** (`context-event-order.test.ts`):

- A task with nothing ahead runs before the enqueue call returns.
- Input waits for an earlier appear and for an earlier settings change; two inputs both start before either settles; a disappear waits for input in flight; a settings change waits for an appear.
- Liveness: input, a settings change and a second disappear after a disappear are dropped with the disappeared debug line; input for a context that never appeared is dropped with one warn line, and a second drop for it logs at debug; a re-appear after a disappear runs only after the teardown settles and makes the context live again.
- A throwing handler: later events run, and the caller's promise rejects with the handler's error.
- A never-settling handler, under fake timers: the next event runs at 10 000 ms with one warning; a later lifecycle event does not wait again; no timer is left pending after an ordinary overlap.
- Pruning: no record remains for a context that disappeared and drained (through an `@internal` size accessor).

**The contract suite** (decision 6): deck-core's test runs every scenario against the unordered and the strictly serialising reference adapters and asserts, scenario by scenario, which reference it fails on; the production-import refusal test; and each adapter's `adapter.test.ts` runs `CONTEXT_EVENT_ORDER_SCENARIOS` through its harness. Each adapter's suite run is first made against the unchanged adapter, and its red result is recorded in the PR body.

**The guard** (`scripts/deck-adapter-order-contract.test.mjs`): it finds all three adapters and passes on them; its planted fixture adapter without the suite is reported; the mock platform adapter is skipped by name.

**The adapter-specific and rewritten tests** listed under *Changes to the repository*, each green against its new decision.

**Measuring the appear-before-input assumption (decision 3), before merge.**

- **Ulanzi**, by the issue's `qa` agent, because there is no Ulanzi device and no `add` has ever been observed (`deck-adapter-ulanzi/CLAUDE.md:71`): read and run the UlanziStudio SDK simulator (`server/clients.js`, the source `deck-adapter-ulanzi/CLAUDE.md:11` already relies on) and record whether every input frame it sends for a context is preceded by that context's `add`, including after the plugin socket reconnects; and, where it adds anything, a raw-frame probe against the live UlanziStudio host on port 3906, with the frames it sends on a plugin connect recorded. The result picks the branch decision 3 already decided, and goes in the PR body.
- **Mirabox**, by Niklas on hardware: restart the plugin with keys visible, press a key and turn a knob, and confirm the keys respond and the log shows no `it never appeared` line.

**Manual (Niklas, on hardware):** flip pages back and forth quickly on an Elgato deck and a Mirabox Stream Dock, then confirm with debug logging on that the keys draw and respond and no `has not settled` warning appears.

## Out of scope

- Cancelling a handler. An abandoned one keeps running.
- Sends an appear makes after the host has already removed its key: the appear still finishes before the teardown, so a late image may go to a context the host has dropped, as today.
- Ordering across contexts, and the global events (global settings, Property Inspector appear, application launch and terminate).
- Ordering input against input, which stays concurrent (decision 2).
- Removing the actions' own defences: `hasDialInputContext`, the clear-before-await convention for action throttles, and the teardown window `base-action.ts:762-770` documents. They stay.
- Enabling Ulanzi dials (#786) and Ulanzi's controller detection itself (#1530).
- Ordering in the scenario harness's mock adapter, which registers nothing and is exempt from the guard.
