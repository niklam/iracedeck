# ScenarioEngine is split into modules behind a thin facade

> **Issue:** [#1514](https://github.com/niklam/iracedeck/issues/1514) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Amended 2026-10-31 after the architect's seams review: the pool store and script set now meet through two callbacks, the contract registry is a leaf whose registration sequence the facade runs, the frame preview gets `expansion.prepareFrame`, the voice reset stays a direct write at pick time, line ends reaches the scheduler through `dropWaiting` / `drain`, the other modules see an `ActiveFireView`, manifest reads stay live, Decision 6 gains items 11–16, and the regrowth guard names the facade's allowed fields; line numbers in the amended text are at `053195bf8`.

The issue carries the problem and the goal: `ScenarioEngine` (`packages/audio-scenarios/src/interpreter.ts:707-3353`) does several jobs over one set of private fields, and the split must move code without changing behaviour. This spec decides where the boundaries run, what state crosses them, how the modules are composed, the order they come out in, and how the unchanged tests prove the move. Line numbers are `master` at `1b1224074`.

## What the code says about the jobs

The issue's five-job table is a good first cut, and the field map below corrects it in four places. The map was built by reading which private fields each method reads and writes.

- **Expansion is a sixth job, not part of playback.** `expandSequence` (3010), `expandFrame` (2419), `expandCutTail` (2522) and `prepareOps` (2265) read the compiled scripts, the vocabulary, the pools and the frame switches, and touch no bus state. `stepNext` (2764), `takeBus` (2829), `cancelActiveFire` (2952) and `playCutTail` (1855) drive `IAudioService` and the active fire's cursor, and read no pool, var or script. The only playback-side reads of the clip library are `manifest.ambientLoop` (2794) and, for a legacy body, `manifest.ticks.open` (2673). If expansion stays with playback, playback cannot be tested without registering vocabulary and loading scripts, which is the issue's own goal turned around.
- **`prepareOps` splits along the gate.** Its first 75 lines expand (2270-2342); its last 20 ask the contract's `speakGate` (2350-2356) and only then commit the pool picks (2359). The gate is arbitration's question ("may this fire speak now"), and committing the picks after it is the #1138 rule. So expansion hands back an uncommitted result and arbitration asks the gate and commits.
- **Two things the issue files under arbitration are separate stages.** `subscribeToEvent` (1636-1739: `where`, `triggerDelay`, `settle`) never reads bus state. It turns an event into a call to `attemptFire`, or not. `endFires` (1784-1834) is neither arbitration nor playback: its first pass clears trigger timers and removes waiting fires (1791-1808), and its second cuts or silences the playing fire and drains (1810-1829). It is the one feature that crosses every boundary, so it gets its own module that calls the others through their interfaces.
- **The state that crosses the arbitration/playback line is smaller than the issue lists.** In `BusState` (569-584) only the active fire crosses: playback writes it, arbitration and the ends read it. The queue, the focus floor and the hold timer are arbitration-only. The one exception is that `takeBus` clears the hold (2830). `playingId` is redundant: its only writers (2831-2832, 2838-2842, 2966-2968) always set it to `activeFire?.id ?? null`. The other fields the issue names do not cross that line (Decision 3):
  - `generation` (765) is the version of what an expansion depends on.
  - `sessionGeneration` (772) is arbitration's alone.
  - `expansionPicks` (785) lives only for the length of one expansion.
  - The once-per warn sets (796-814) are shared by compilation and expansion: `warnedFrameAborts` is written by `compileScripts` (1422-1431) and by `expandFrame` / `expandCutTail` (2471, 2554).

## Decision 1: the modules

Each module is a class or a set of pure functions in its own file. It owns the fields listed for it, and no other module writes them.

| Module | File | Owns | Moved from |
| --- | --- | --- | --- |
| Engine types | `engine-types.ts` | `CompiledScenario`, `WaitingFire`, `ResumeState`, `ActiveFire`, `ExecOp`, `FrameSide`, `ExpandedFrame`, `PreparedFire`, `ExpansionAbort`, `BusState` and the bus table (Decision 2), `fireContext` | 466-705, 1917, 2991 |
| Once-per warnings | `once-warnings.ts` | the five warn sets as one object with named keyspaces and one `reset()` | 796-814, 1307-1311 |
| Contract registry | `contract-registry.ts` | `scenarios`; a leaf: `get`, `store(s, resolved) → entry`, `warnCrossBusQueueBehind`, `warnQueueBehindCycle`, `validate(entry, { pools, vars, manifest })` taking read-only views per call, `contracts()`, `entries`, `waitsBehind` | 725, 934-980, 997-1065, 1234-1255, 2165 |
| Vocabulary | `vocabulary.ts` | `vars`, `varDescriptions`, `conds`, `cases`; `defineVar` / `defineCond` / `defineCase`, `vocabulary()`, `pickCaseBranch` | 727-734, 1202-1232, 3224-3257 |
| Pool store | `pool-store.ts` | `manifest`, `clipSet`, `pools`, `manifestPoolSources`, `scriptPoolState`; `definePool*`, `setManifest`'s pool half, `buildManifestPool`, the pickers, `restoreHeadPoolIndices`, `substituteVoice`, `poolMemberPattern` | 710, 726, 737, 743, 778, 888, 1067-1200, 2731-2761, 3207-3222, 3264-3352, 3476 |
| Script set | `script-set.ts` | `scripts`, `compiled`, `scriptsDirty`, `generation`; `setScripts`' compile, `ensureCompiled`, `compileDeps`, `compileScripts`, `compileScript`, `isScripted`, `markScriptsDirty` | 746-765, 902, 1290-1435 |
| Expansion | `expansion.ts` | the frame switches accessor; `prepareOps` up to the gate, `expandFrame`, `expandCutTail`, `expandSequence`, `assertClipAvailable`, `pushClip`, `channelForPath`, `applyFrame`, `canProducePlay`, `filterFrameSteps` | 723, 2265-2342, 2419-2577, 3010-3192, 3505-3593 |
| Resume | `resume.ts` | pure: `buildResumeState`, `planResume` (`resumeBlocker`, `reopenPreroll` and the slice in `executeFire`), `opsEqual` | 2597-2612, 2666-2709, 3365, 3618 |
| Playback | `playback.ts` | the active fire's transport fields; `takeBus`, `stepNext`, `finishFire`'s first half, `cancelActiveFire`, `settle`, `playCutTail`, `collectUsedChannels`, `opLabel`. It is the only module that calls `IAudioService` | 1855-1892, 2764-2845, 2952-2989, 3643-3669 |
| Scheduler (arbitration) | `scheduler.ts` | `sessionGeneration`, the queue, focus and hold of every bus; `attemptFire`, the gate and commit (2344-2361), `admits`, supersede, `belowFloor`, `queueOrDrop`, `enqueue`, `logQueueDrops`, the session-change clear, the stash, `executeFire`'s scheduling half, `finishFire`'s hold half, `drainPending`, `playableAtIdle`, `replayWaiting`, the focus calls, `stopAll`, `setEnabled`'s runtime half, `playFramePreview` and `yieldPreview` | 772, 1462-1475, 1500-1632, 1929-2207, 2344-2380, 2579-2644, 2846-2945 |
| Triggers | `triggers.ts` | the per-contract `unsubscribe` and `pendingTriggerTimer`; `subscribeToEvent`, `settlePending`; `attach`, `detach`, `cancelPending` | 1636-1739, 1900-1914 |
| Line ends | `line-ends.ts` | `endSubscriptions`; `subscribeToEnd`, `endFires`, `startedSourceOps`, `wordsHeard`, `lineFinished` | 823, 1741-1834, 3374-3426 |
| Facade | `interpreter.ts` (unchanged path) | the module instances; the constructor's session-change subscription, `dispose`, every `IScenarioEngine` method as a short sequence of module calls, `describeState` and `describeBus`, the singleton and every public type | 133-454, 825-878, 1257-1288, 3433-3460, 3671-3710 |

Thirteen files, the largest (expansion, scheduler) around 600 lines with their doc comments. Vocabulary and the pool store are separate even though the issue names them as one job. The registries are fixed once registered, while the pool store is where the no-repeat rules of #1136 and #1138 live (commit on acceptance, put back the takes of a resumed head). Those rules are tested today only through the whole engine, and they are the part worth unit-testing on its own.

**The interfaces between them**, stated by what crosses:

- `expansion.prepare(entry, event)` returns `{ fire: PreparedFire; ctx: ScenarioContext; commit(): void }` or `null`. `null` covers every outcome that plays nothing (no script for the voice, an abort, a throw, an empty body), each logged inside exactly as today (2283, 2324, 2329, 2339). The scheduler then runs the gate against `ctx` (which carries the resolved vars) and calls `commit()` only once the gate has admitted the fire. This keeps today's order: empty check, then gate, then commit (2338-2361).
- `expansion.prepareFrame(frameName, voice, script)` returns `{ frame: ExpandedFrame; commit(): void }` or `null`, owning the session and both preview log lines. The scheduler keeps the order: is there a frame (1510-1519), is the bus busy (1523), `prepareFrame`, `commit()` at once on a non-null result, then the empty check. It is part of step 5's seam review.
- **The pool picks become an explicit session the pool store hands out**, replacing the `expansionPicks` field. `pickFromPool` takes the session (consulted first, as 3340 does), `expandCutTail` snapshots and restores it (2530-2542), and `commit()` writes `lastIndex`. The direct-commit branch for "a pick outside an expansion (none today)" (3348-3349) goes, because every pick now has a session. Every pick comes from `expandSequence`, reached only through `prepare` and `prepareFrame`, each of which opens a session. The no-repeat reset on a voice change (`lastVoice`, `lastIndex = -1`, 3327-3330) stays a direct write at pick time, not part of `commit()`: today it applies even to a fire that later aborts or is refused by the gate.
- **Playback reports to arbitration through a listener it is constructed with**: `busTaken(bus)`, which clears the hold as `takeBus` does at 2830, and `fireFinished(bus, id)`, which runs `finishFire`'s second half at 2846-2863 (hold, else drain). Playback imports nothing from the scheduler. A cut (`cancel`) reports nothing, as today: its callers drain explicitly (1474, 1825).
- **Line ends reaches the scheduler and the triggers through their interfaces.** `endFires`' first pass removes from the queue (1810) and calls `logQueueDrops` with `{kind:"ended"}` (1814), and records "pending" only when a timer was pending (1803-1806); `setEnabled` makes the same queue write (1479). The scheduler exposes `dropWaiting(bus, id, reason) → boolean` (removes and logs) and `drain(bus)`; `triggers.cancelPending(entry)` returns whether a timer was pending. Line ends sees `transport` read-only and `schedule` not at all.
- **Only playback writes the transport fields** of an `ActiveFire` (`index`, `cancelled`, `pauseTimer`, `usedChannels`, `onSettled`, which `settle` clears, 2991). Whoever starts a fire passes the scheduling fields (`id`, `bus`, `weight`, `event`, `sessionGeneration`, `cutTail`, the resume mapping), and playback fills in the transport fields. Today three places build a fire literal (1554, 1872, 2616).
- **Cross-module invalidation is sequenced by the facade, not by the modules.** `defineVar` is `vocabulary.define…` and then `scripts.markDirty()`. `definePool` marks dirty only when the store accepted the pool, because today's rejection returns before 1106. `setManifest` is the pool store's half and then `scripts.invalidate()` (the `generation++` at 1138, with no dirty flag, as today). `setScripts` resets the warnings and then compiles (1306-1312). A module never reaches sideways to keep another one fresh, with the one exception of the script set's `clearScriptPools` callback below.
- **The pool store and the script set meet through two narrow callbacks.** The pool store is constructed with `scriptPoolSource(voice, name) => { group, base } | undefined` (the facade wires it to the class field at step 3 and to the script set from step 4); the active voice is still read live on every pick. The script set is constructed with `{ registeredPoolNames(), clearScriptPools() }`, the names for `compileDeps` (1375). `clearScriptPools` is the one allowed cross-module write, because a compile redefines what a script pool holds, and the compile is lazy so the facade cannot sequence it.
- **Manifest reads stay live.** Playback (`ambientLoop`, 2803), resume (`ticks.open`, 2682) and expansion (`clipSet`, ticks, 3181, 3198) read through a pool-store accessor on every use, never a manifest captured at construction, because `setManifest` swaps both (1142-1143).

## Decision 2: the bus state is one declared table, with an owner per half

`engine-types.ts` declares one `BusTable`: the lazily created `Map<AudioBus, BusState>` that `getBusState` (2991-3006) keeps today, with `get(bus)` (creates the bus's state) and `peek(bus)` (does not, for `describeState`, 1276-1277). Every module that iterates buses iterates this one table, so the insertion order every per-bus loop runs in stays what it is. That covers `stopAll`, `setEnabled`, the session-change clear and both passes of `endFires`. Two maps, one per module, would let that order drift between them, and the order decides which bus's `onSettled` runs and which bus drains first.

```typescript
type BusState = {
  /** Written only by playback. */
  transport: { active: ActiveFire | null };
  /** Written only by the scheduler. */
  schedule: { queue: PendingQueue<WaitingFire>; focus: { ownerId: string; floor: number } | null; holdTimer: ReturnType<typeof setTimeout> | null };
};
```

- **The owner rule is enforced by types, not only stated.** Playback is handed the table typed so that `schedule` is not visible. The scheduler and the line-ends module change the active fire only by calling playback. The other modules see an `ActiveFireView`: every field read-only, `ops`, `sourceOps` and `cutTail` as `ReadonlyArray`.
- **`playingId` is derived** (`transport.active?.id ?? null`), not stored. The three writer pairs above show the two never differ. `describeState` keeps reporting it as a field.
- The queue's constructor still takes `waitsBehind` from the registry (2997). The table takes the factory from the scheduler.

## Decision 3: the other state that looked shared

- **`generation` belongs to the script set.** It is bumped when anything an expansion depends on changes: every registration that marks scripts dirty (902-905), `setScripts` (1306) and `setManifest` (1138). Only a resume reads it: the stash stamps it (2205) and `planResume` compares it (2704). The scheduler reads it through `scripts.generation` when it stamps a stash.
- **`sessionGeneration` belongs to the scheduler.** It bumps it on `session.changed` (2156) and compares it in the stash (2198). Playback only carries the stamp on the fire (2629), and the cut tail copies it (1885).
- **The five warn sets are one `OnceWarnings` object** with the keyspaces `skips`, `fragments`, `caseKeys`, `legacyFrames` and `frameAborts`, and one `reset()` that `setScripts` calls. Compilation, expansion and the vocabulary each take it at construction. The key spellings stay byte for byte: `frameAborts` is shared on purpose. The compile-time cut warning and the runtime cut-tail warning both use `<voice>|<frame>|cut`, so only one of them is ever said for a frame (1417-1431, 2552-2559).
- **The per-contract runtime fields stay on `CompiledScenario`**, and each has one writer module:
  - `enabled`: the facade only, when `validate` reports errors (977) and in `setEnabled` (1448).
  - `lastFireAt`: the scheduler (1991, 2033).
  - `unsubscribe` and `pendingTriggerTimer`: the triggers module. The line ends, `setEnabled`, a redefinition and `dispose` clear a timer through `triggers.cancelPending` (1457-1460, 1794-1797, 941-944, 871-874).

  Splitting them off into maps per module would add a lookup to every fire for no gain.

## Decision 4: `ScenarioEngine` stays, as a thin facade

The facade class keeps the name, implements `IScenarioEngine`, builds the modules in its constructor and turns each interface method into a short, ordered sequence of module calls. It holds no state of its own other than the module instances and the session-change unsubscribe, beside its three injected read-only dependencies (`logger`, `getActiveVoice`, `getFrameOptions`). It does not grow a new field when a feature lands; the feature's state goes in the module that owns its concern.

Alternatives weighed:

- **No class: `initializeAudioScenarios` returns an object assembled from bound module methods.** Rejected. The cross-module sequences (`defineVar` then mark dirty, `setScripts`' reset then compile, registration's detach / validate / attach / watch, `dispose`'s order) would still need a home, and they would sit in a factory function instead: a facade without a name or a doc comment. `debug-state.test.ts:373` spies on `engine.describeState`, which works either way, so the tests do not decide it.
- **Split `IScenarioEngine` into per-module interfaces and compose them with mixins.** Rejected. The interface is what 75 files in the package import from `interpreter.js`, and changing its shape is out of scope. TypeScript mixins also share one `this`, which would bring back the god class's shared fields under a new name.
- **Modules talking through an internal event emitter.** Rejected. Every ordering this split must keep (below) would then depend on the order subscribers were attached in. That is the class of hazard #1499 exists to pin for the translator, and this split should not add a second instance of it inside the engine.
- **The scheduler as the entry point, owning the others.** Rejected. Registration, vocabulary and compilation have nothing to do with buses. Hanging them off the scheduler would make arbitration the new god class one level down.

## Decision 5: file layout

- Flat files in `packages/audio-scenarios/src/`, beside `pending-queue.ts` and `script-compiler.ts`. Those two are the precedent the issue cites, and they stay where they are.
- `interpreter.ts` keeps its path and every export it has today, including the `AudioAssetsManifest` / `manifestVoices` re-export (124) and `poolMemberPattern`, which is re-exported from the pool store for the 29 test files that import it. No importer changes.
- The new modules are not exported from the package index. They are internal, and their tests import them by relative path.
- **No new package.** The modules share types that are no published contract (`CompiledScenario`, `ExecOp`, `ActiveFire`), and a package boundary would publish them. #1467's reason for a package was a dependency boundary to guard: the replay engine had to stay free of the deck layer. This engine already imports no deck package, so the boundary would guard nothing.
- No `engine/` subfolder. It would leave the two existing engine modules outside it, or move them and change four import sites for nothing.

## Decision 6: what must not move while the code does

These are the constraints a builder could break while the suite stays green. Steps 0 and 7 below say how each is proven.

1. **The session-change clear is subscribed before any contract** (847-849), so a `session.changed` clears the queues before that event's own contracts run. It stays in the facade constructor, ahead of building anything that subscribes.
2. **A cutting fire expands before it cuts** (1979-1989, #835): `prepare`, then the stash, then the cancel.
3. **The gate runs after expansion, and the picks commit only after the gate** (2338-2361, #1138).
4. **The frame expands before the body** (2310-2321, #1064).
5. **Registration keeps its order statement for statement** (934-987), and the facade runs it, since validation reads pools, vars and the manifest, marking dirty sits between store and warnings, and the detach and timer clear belong to the triggers: the replacement warning and `triggers.detach` / `cancelPending`, then the registry's `store`, `scripts.markDirty()`, the two `queueBehind` warnings, the registry's `validate` (on errors it disables and returns; `markDirty` stays before that return, 987), `triggers.attach`, then `lineEnds.watch`. A redefinition still subscribes again at the end of the bus's dispatch list, while an existing end subscription keeps its place. That is the race `subscribeToEnd`'s comment documents (1741-1755), and it is moved with the comment, not fixed.
6. **`endFires` keeps its two passes**: every pending timer and waiting fire goes first, then the playing fires (1780-1782). Each pass loops over contracts outside and buses inside, in table order.
7. **`playCutTail` marks the old fire cancelled before it stops a channel** (1856, 1866-1870), and the tail's bus take still clears the hold, now through `busTaken`.
8. **The scheduler keeps `executeFire`'s log-then-step order**: take the bus, log `Playing` / `Resuming`, then the first step (2616-2643). The frame preview keeps its order too: is there a frame, is the bus busy, then expand (1506, 1514, 1524).
9. **Logging is unchanged in text and level, through the one logger the engine is handed.** No module calls `createScope`. The interpreter tests' logger stub returns `undefined` from it (`interpreter.test.ts:22`), so a sub-scope would throw there rather than pass, and it would also change every line's prefix in a user's log.
10. **Time stays `Date.now()` and `setTimeout`, called directly.** The suites spy on `Date.now` and use fake timers (`interpreter.test.ts:1437`, 2370, 3234). An injected clock is a separate change.
11. `finishFire` clears the active fire, then runs `onSettled`, then hold-or-drain (2849-2872): the listener's `fireFinished` comes after `settle`.
12. Listener calls are synchronous, never deferred: the scheduler is re-entered inside playback's call stack (a failed `playOnChannel` 2794-2796, a complete callback 2789-2791), and `stopChannel` can complete synchronously (1851-1853), which is why `cancelActiveFire` sets `cancelled` before it stops channels (2966-2973), as `playCutTail` does (item 7).
13. The pool picks commit before `restoreHeadPoolIndices` (≈2368 before ≈2615).
14. `yieldPreview` runs only after `prepare` returns non-null (2036-2040), item 2's rule for the preview.
15. `stepNext` registers `onChannelComplete` before it calls `playOnChannel` (2789-2792).
16. The per-bus loops of `stopAll` (1615-1622), `setEnabled` (1474-1484) and `endFires`' second pass (1822-1836) stay one loop in one module (the scheduler, or line ends for `endFires`), calling playback once per bus, never a playback-wide loop, so outside `onSettled` callbacks keep their place among other buses' clears and drains.

## Decision 7: the order of extraction

One issue, one worktree (`../ir-1514`), one branch, one commit per step. Each step moves code and leaves a one-line delegation in the class where a caller remains. Each commit passes `pnpm typecheck`, `pnpm lint` and `pnpm test packages/audio-scenarios/` on its own. The order follows the dependencies: each module depends only on modules extracted before it.

0. **Pin the orders that no test pins yet**, in its own commit before anything moves. One gap is known: no `interpreter-ends-on.test.ts` case has two `endsOn` contracts on one event with one playing and one waiting on the same bus, which is the case the two passes exist for (Decision 6, item 6). Add that test. Then check every other item of Decision 6 by inverting it once: if the suite stays green, add the test that would have caught it. That covers items 11–16 too, with the same invert-once check. Items 1, 2, 3 and 4 are known to be pinned (`interpreter.test.ts:3564-3640`, the #835 block from 729, 247, 5086).
1. **Engine types and once-per warnings.** A pure move, and the five sets become `OnceWarnings`.
2. **Contract registry**, as a leaf. Every later module reads it. The registration sequence (Decision 6, item 5) stays in the class, which is where the facade keeps it, and `validate` is handed the pools, vars and manifest per call.
3. **Pool store and vocabulary.** The pick session replaces `expansionPicks`. This is the first step with a reshaped API, so it gets its module tests in the same commit.
4. **Script set**, owning `generation`.
5. **Expansion.** `prepareOps` splits into `expansion.prepare` and the class's gate and commit. *This is a seam:* the scheduler and the preview are built on `prepare`'s return shape, so it gets a task-scoped review before step 6 starts (`code-review.md`, *How reviews are staged*).
6. **Resume, playback and the bus table.** `playingId` becomes derived, and the listener goes in. *Also a seam* (the scheduler is built on playback's interface), reviewed the same way.
7. **Scheduler.**
8. **Triggers and line ends.** What is left in the class is the facade.
9. **Docs** (below).

## Relationship to #1499, #1378 and #1468

- **#1499 lands first.** It pins, in a test, the translator order that `endsOn` relies on. That order is the most delicate thing this split moves across a boundary (`endFires` and `subscribeToEnd` move to `line-ends.ts`). With #1499's test in place, a regression in a manual test of the cut tail points at the split and not at the translator. #1499 may also edit the `endsOn` paragraph of `audio-scenarios/CLAUDE.md`, `dsl.ts`'s `EndsOn` doc and possibly `validation.ts`. Landing it first means step 2 extracts the registry against `validateScenario`'s final signature, and step 9's rewrite of the CLAUDE.md engine section keeps #1499's addition instead of conflicting with it. The split changes nothing about the in-engine half of that order (Decision 6, items 5 and 6).
- **#1378 has no code in common with this split.** It edits the catalog's sim reads, `race-engineer-wiring` and `plugin-runtime`. `IScenarioEngine` and `registerPitCrew` are unchanged by both. They meet only in docs: the catalog half of `audio-scenarios/CLAUDE.md` against this split's engine-modules half, and different rows of `race-engineer-callouts.md`. Either can go first, and the second rebases a paragraph.
- **#1468 touches only `sim-events-iracing`.** No overlap here. It does reorder `translator.ts`, which is one more reason for #1499 to land before it as well.

## Docs

- `packages/audio-scenarios/CLAUDE.md`: the `interpreter.ts` bullet (one paragraph of about 2,270 words today) becomes one bullet per module. The text is mostly re-filed rather than rewritten, with each rule under the module that now owns it. The facade gets a short bullet that says it holds no state.
- `.claude/rules/race-engineer-callouts.md:58` points at `vocabulary.ts` for `defineVar` / `defineCond` / `defineCase` and `vocabulary()`. `race-engineer-callout-examples.md:72` points at `scheduler.ts` for the interrupt rule.
- The Architecture page names no engine internals (no mention of `interpreter`, verified), and neither does `README.md`. Both are unchanged.
- No changelog fragment: nothing a user can see changes, and a Maintenance line for an internal split is the churn `changelog.md` says not to list.

## Delivery and the regrowth guard (decided by Niklas, 2026-10-28)

Both recommendations below were accepted: one PR with the ten commits, and the facade-field guard test.

- **One PR or a stack.** Decided: one PR with the ten commits, as #1467 did. That means one `/code-review` (at `high`: ordinary domain code), one second read (the scheduler is a state machine), and one manual test. The cost is a large diff for CodeRabbit to read, though most of it is moved lines. The alternative is a stack of three PRs (steps 0-4, 5-6 and 7-9): smaller reviews, but three manual tests of a change that has no visible behaviour.
- **A guard against regrowth.** The goal is that a new feature lands in the module that owns it, and nothing enforces that once the split is done. Decided: a small test that fails when the facade class declares a field other than the module instances, `unsubscribeSessionChanged`, and the three injected read-only dependencies (`logger`, `getActiveVoice`, `getFrameOptions`), which is cheap and catches the first step back. The facade keeps the logger for its own lines (the "rejected" log 923, "not found" 1450, 1492) and both raw accessors for `describeState` (1273, 1283). The alternative is no guard: prose in the package `CLAUDE.md` plus the next architecture review. A line-count budget was considered and not recommended, because it would fail on doc comments.

## Out of scope

- Any change to `IScenarioEngine`, `initializeAudioScenarios`, `getScenarioEngine`, `isAudioScenariosInitialized`, `_resetAudioScenarios`, the package index or anything a catalog family calls.
- Any behaviour change, including a log line's text or level. The legacy `defineScenario` / include / `resolvedSequence` path moves as it is. Retiring it is a separate decision.
- The contents of `pending-queue.ts`, `script-compiler.ts`, `validation.ts` and `dsl.ts`, apart from import paths.
- Moving or deleting tests from `interpreter.test.ts` and `interpreter-ends-on.test.ts`. The new module tests are added on top.
- An injected clock, scoped sub-loggers, and fixing the same-event race `subscribeToEnd` documents.
- The translator (#1468), the catalog's sim reads (#1378), and contract-level quiet conditions.

## Testing

- **The proof of no behaviour change is suites that did not change.** Across the branch, `git diff --stat origin/master...HEAD` must list no existing test file in `packages/audio-scenarios/src`, `catalog/pit-crew/` (45 test files, which drive the real engine through `registerPitCrew`) or `packages/scenario-harness`. The only exception is step 0's added cases. The per-file test counts must match before and after, read from the reporter rather than inferred from a green run. Every suite reaches the engine only through `initializeAudioScenarios` and `IScenarioEngine` (`interpreter.test.ts:10-11`, `interpreter-ends-on.test.ts:15-16`). Nothing reaches a private member, so none needs editing for the move. The `describeState` cases (`interpreter.test.ts:3803`) pin the snapshot shape the facade now composes.
- **Positive controls on the orders.** Each item of Decision 6 has a test that fails when the item is inverted. Step 0 establishes this for each item and records it in the PR body: which test fails for which inversion, and the one test added for the gap.
- **New module tests, on top:**
  - **The pool store:** commit on acceptance and not on the pick; snapshot and restore of a session; `setManifest` re-deriving manifest pools and dropping cached refs; the no-repeat reset on a voice change, including a fire refused by the gate after the change; `restoreHeadPoolIndices` putting back only the pools the remaining ops do not draw.
  - **`resume.ts`, table-driven:** `opsEqual` by pool and by path, a frame tag mismatch, each `planResume` blocker, the legacy preroll by path.
  - **`line-ends.ts`'s predicates:** `startedSourceOps`, `wordsHeard` and `lineFinished` over fresh and resumed fires, in the preroll, mid-body, in a trailing pause and in the close.
  - **The scheduler, over a fake expansion and a fake playback:** weight and interrupt, queue-or-drop, the focus floor, the hold, a session-change stash drop and the gate-then-commit order. This is the issue's "arbitration without expanding frames or playing clips".
  - **Playback, over a fake `IAudioService`:** stepping, pauses, a cancel stopping only `usedChannels`, the cut tail marking cancelled before it stops, and the listener calls. This is "playback without the gates".
  - **Triggers, over a fake bus and a spy:** the delay, the settle polls and deadline, and a `where` that throws.
  - **Expansion with no scheduler:** the frame switches by position, the cut tail's fallback to the close, and every abort returning `null`.
- **The full gate** on the final branch: `install`, `build`, `typecheck`, `format`, `lint`, `test`.
- **Manual (Niklas), in the scenario harness:**
  - A framed callout with beeps and ambience toggled.
  - A pit-entry readback cut by the count-in and then resumed.
  - A queued penalty flag behind a spotter call.
  - The `endsOn` audition shortcut, both the mid-word and the early variant.
  - The Background Test preview.

  Then one pit stop in the sim with the limiter dropped before the exit. Nothing should sound different from `master`.
