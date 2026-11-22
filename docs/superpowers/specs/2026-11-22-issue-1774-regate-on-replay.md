# A read-only speak gate is asked again after a cut

> **Issue:** [#1774](https://github.com/niklam/iracedeck/issues/1774) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Read on `master` at `103451943`, with the fuel contracts as they stand on `feature/1702-fuel-countdown-every-session` (`11ebd0f75`), which is not merged yet.

## Where it stands

A fire that has passed its contract's `speakGate` (#1138) is never asked it again. When an `interrupt` cuts a queueable fire, `stashRunningIfQueueable` (`scheduler.ts`) queues it with `admitted: true`, and `prepareOps` skips the gate for an admitted fire (`gate !== undefined && !admitted && …`). That holds on every path the stash can come back by: replayed whole from the top (a non-`resumable` contract), resumed from the cut clip (`resumable`, #758), or replayed whole because the fresh expansion no longer matched the stashed one (the #481 fallback inside `planResume`). The same applies to a stash a key-press acknowledgment makes through `cutForClips` (#1698), and to a stash the drain defers again, which keeps its admission.

The reason is sound for the gates that claim something. A gate that commits a cooldown or a marker on the way in (the gap cooldown in `gaps.ts`, the position readout's claim, the qualifying latch, the sector comparison, the traffic `markIntroduced`, the named-car record, the furled spoken marker) would refuse its own claim on a second ask and drop a line the driver had already begun to hear.

It is wrong for a gate that only reads live state. #1702 gives every fuel contract the gate `stillBeforeTheFinalLap`, which admits unless `getPlayerFinalLapStarted()` answers `true` and writes nothing. A fuel count cut mid-sentence by an `interrupt` (the 1-lap and box calls are `CRITICAL` and interrupt themselves, and the spotter's `PROXIMITY` calls cut everything) is stashed as admitted and replays within its 8 s wait without that check. On a lap shorter than about 16 s the replay can land after the player's final lap has started, which is the case the gate exists to stop. The #1702 fuel module header names this as a known gap. `dropWhenCut` was rejected on #1702 (judge-upheld): it would drop every interrupted count on every track, and the translator never re-announces a count it has spoken.

## Decisions

### 1. The opt-in is a field on the gate: `askAgainAfterCut: true`

`SpeakGate` (`dsl.ts`) gains one optional member:

```typescript
export type SpeakGate = {
  description: string;
  admit: VocabularyResolver<boolean>;
  /**
   * Issue #1774: this gate only reads, so it is asked again when a fire an
   * `interrupt` cut comes back — replayed whole, resumed or replayed whole
   * after a changed expansion. Only `true` is accepted; omit it for a gate
   * that claims or marks anything.
   */
  askAgainAfterCut?: true;
};
```

The type is the literal `true`, not `boolean`, so the only way to write it is the opt-in, and `askAgainAfterCut: false` cannot appear as a second spelling of the default.

Why on the gate and not on the contract, as the issue sketched (`regateOnReplay: true`): the property it declares is a property of `admit`, the function it sits beside, and a gate object is often shared (the fuel family builds one gate and spreads it over all twelve contracts). On the gate, the field cannot exist without a gate, so the issue's "refused at load time when the contract has no `speakGate`" becomes a type error instead of a validation rule, and a family that marks its gate marks every contract carrying it. On the contract it would separate the purity claim from the code it is about, need a load-time check to tie it to a gate, and let two contracts sharing one gate disagree about it.

Why "after a cut" and not "on replay": the only admitted fires are stashes a cut made. A fire deferred before it ever expanded (`admitted: false`) is already asked at replay today and is unchanged, so "on replay" would suggest the field changes something it does not.

Rejected names: `regateOnReplay` (see above), `pure` (names the claim, not what the engine does with it, and reads as a guarantee the engine checks; it cannot).

### 2. What "side-effect-free" means, and how it is held

The rule, as it goes into the `SpeakGate` doc and `race-engineer-callouts.md`: a gate that sets `askAgainAfterCut` must read only, and answer the same way when asked twice in a row about the same fire. It may read the fire's context and live state through the family's deps. It must not claim a cooldown, set a latch or a marker, record a car, advance a tracker or write a stash, and it must not call a function that does.

No mechanism can prove a JavaScript closure is pure, at compile time or at load time. TypeScript sees no side effects, and calling `admit` at registration would run it with no fire and against real state. So the rule is held in three layers:

1. **Structure.** The field lives on the gate (decision 1), so it can only be set by the code that writes `admit`, in the same object literal. Gates are code-owned: a voice pack cannot declare one or set the field (#1064), so every gate that can carry it is in this repository and in the catalog's registration.
2. **A catalog probe, in `pnpm test`.** A new `packages/audio-scenarios/src/catalog/pit-crew/speak-gate-ask-again.test.ts` runs the real `registerPitCrew` with its `DEFAULT_DEPS`, collects every registered contract through a `defineContract` spy (the #1681 spec's method), and for every gate with `askAgainAfterCut` asks `admit` twice with one `ScenarioContext` and checks three things: the first answer is `true`, the second answer equals the first, and `readRaceEngineerState().families` (the Telemetry Snapshot's family readers, #1387) serialises identically before the first ask and after the second. The first check is required because a gate that refuses never reaches its claim, so a refusal proves nothing; the repo's convention that an unknown answer admits (`getPlayerFinalLapStarted` is `null` under `DEFAULT_DEPS`) means a read-only gate admits here. A claim-and-check gate (`tryClaimGapCallout`) fails the second check, and a gate that marks state while still answering `true` (`markIntroduced`) fails the third, because `debug-state.test.ts` already forces every module-level state in `catalog/pit-crew/` to have a reader in that aggregate. The test has a floor of twelve opted-in contracts (the fuel family), so it cannot pass with nothing to check, and a positive control: the same probe run on the gap family's gate, which claims, must fail.
3. **Prose.** The `SpeakGate` doc, the `speakGate` bullet of `race-engineer-callouts.md` and the package `CLAUDE.md` state the rule and name the probe.

What the probe cannot see, stated in its header: state held in a closure that no snapshot reader exposes, and a gate whose claim is reached only under deps other than `DEFAULT_DEPS`. Both are the same limits `debug-state.test.ts` already names for its own guard.

Rejected:

- **Documentation only.** A gate can be marked by someone who has not read the rule, and the failure is a silent drop of a line in the sim, which no test would catch.
- **A separate gate type** (`ReadOnlySpeakGate` in a union with the claiming kind, or a branded constructor). It moves the same promise into a type name and proves no more than the field does, since TypeScript cannot see what a closure does; it would also put a discriminant on every existing gate.
- **A load-time refusal by probing.** Asking `admit` at registration needs a fire context that does not exist yet and would run real claims against real state.
- **A runtime double-ask.** Asking an opted-in gate twice at replay and warning when the answers differ would detect a misdeclared gate in the field, but it spends a second claim in production for a defect the probe already finds for every gate that can exist, and it still has to pick one of the two answers.
- **Re-asking every gate after a cut, or marking the claiming ones instead (`claims: true`).** Both make re-asking the default, so a new claiming gate whose author forgets the mark gets the silent-drop bug #1138 designed against. The opt-in fails safe: forgetting it leaves today's behaviour.
- **Splitting `admit` into a pure check and a separate claim** so the engine could re-ask the check. A claiming gate's pure half still refuses after its own claim (the cooldown it just started), so the split would not make those gates re-askable, and it reshapes every gate for no gain here.

### 3. Every path a cut fire comes back by is asked again

The change is one condition in `prepareOps`:

```typescript
const askGate = gate !== undefined && (!admitted || gate.askAgainAfterCut === true);
```

Every caller reaches the gate through `prepareOps`, so every path follows from it:

| Path | Today | With `askAgainAfterCut` |
| --- | --- | --- |
| Stash of a non-`resumable` contract, replayed whole from the top | not asked | asked once, after the fresh expansion |
| Stash of a `resumable` contract whose expansion is unchanged, resumed from the cut clip | not asked | asked once, before `planResume` runs |
| Stash of a `resumable` contract whose expansion changed, replayed whole (#481) | not asked | asked once, before `planResume` runs |
| Stash made by a key-press acknowledgment (`cutForClips`, #1698) | not asked | asked, as any stash |
| Stash deferred again at replay (below a focus floor, behind a `queueBehind` leader) | not asked, keeps `admitted` | not asked while it waits; asked when it next replays |
| Fire deferred before it ever expanded (`admitted: false`) | asked at replay | unchanged: asked at replay |
| Fire on its first offer | asked | unchanged |

The gate is asked once per replay attempt, with the replay's own context (the fresh expansion's resolved vars, a fresh `now`), and before the resume plan, so whether the replay continues from the cut clip or starts again does not change whether it is asked. A stash that is cut again after replaying is stashed again, still `admitted`, and asked again when it next comes back.

`WaitingFire.admitted` keeps its meaning (the fire has passed its gate once) and its name. What changes is what `prepareOps` does with it, so its doc comment says that an opted-in gate is asked whatever it says.

### 4. A refusal at replay is an ordinary gate refusal

When the gate refuses an admitted replay, `prepareOps` returns `null` exactly as it does for any refused fire:

- **Nothing plays.** The fresh expansion's pool picks are not committed, so the pool trackers keep the takes the driver heard before the cut. A `resume` is discarded with the fire, and `restoreHeadPoolIndices` is never reached.
- **The log** is one debug line, worded so a search for "speak-time gate" finds both kinds of refusal: `Scenario "<id>" skipped after a cut — speak-time gate: <description>`. A first refusal keeps its line, `Scenario "<id>" skipped — speak-time gate: <description>`. It is not a queue drop (`QueueDropReason`): the queue had already handed the fire out, as for any replay that fails to take the bus. A throwing `admit` is logged at error and read as a refusal, as today.
- **No cooldown, no supersede.** `lastFireAt` is not stamped (the fire stamped it when it first played), and nothing waiting is superseded (an admitted replay never supersedes its group).
- **The drain goes on.** The bus is still idle, so `drainPending` takes the next entry at once, as it does after any refused replay.
- **A `queueBehind` follower** of the refused fire is already a root, because `PendingQueue.next` freed it when it handed the leader out, so it plays next as an ordinary entry. That is the existing "a leader that fails to take the bus at replay leaves its follower" rule, unchanged.
- **`pendingHoldMs`** is not armed: the refused fire never took the bus, so it never finishes, and the hold is armed only at a finish. A hold another fire armed has already been cleared by the drain that handed this fire out.
- **No cut tail.** The line already ended at the interrupt; nothing is playing to cut, so a refusal is silent. This differs from `endsOn` (#1407), which acts on a playing fire.

### 5. With `resumable`: allowed, and the tail may be dropped

A gate with `askAgainAfterCut` may sit on a `resumable` contract. The consequence is deliberate and goes into the `resumable` bullet: such a contract may lose the rest of a line the driver began to hear, when what made it true has stopped being true while it waited. That is the trade the field exists for: a fuel count spoken after the final lap has started is wrong whether it is the whole line or its second half. The #1138 sentence "one that reads live state must not drop the tail of a line the engineer has already begun" stays true for every gate that does not opt in, and the rule files say the opt-in is the exception to it.

Refusing the combination at load time was rejected: nothing in the pair is contradictory, and the pit readback, the one `resumable` consumer today, has no gate, so the refusal would guard nothing real.

### 6. Load-time validation: refuse the two silent no-ops

`validation.ts` follows the repo's rule that a scheduling field which can never take effect is an error, as it does for `resumable` without `queueable`. When the contract's `speakGate.askAgainAfterCut` is set:

- the contract must be `queueable: true` (`askAgainAfterCut requires queueable: true (only a queueable fire is stashed after a cut)`), since a non-queueable fire is never stashed;
- the contract must not set `dropWhenCut: true` (`askAgainAfterCut and dropWhenCut are mutually exclusive (a fire dropped when cut is never replayed)`).

Errors disable the contract, as every validation error does. A gate shared between a queueable and a non-queueable contract therefore cannot carry the field; the fuel family's twelve contracts are all queueable and none is `dropWhenCut`.

`contracts()` (`ContractReport`), the pack reference and the Telemetry Snapshot do not report the field, as they do not report `resumable` or `dropWhenCut`. The gate's `description` the reference already renders stays the one sentence about what is re-checked.

### 7. The fuel contracts opt in, after #1702 lands

`stillBeforeTheFinalLap(deps)` in `fuel-laps-left.ts` returns its gate with `askAgainAfterCut: true`, so all twelve contracts (the eleven counts and the enough-fuel confirmation) carry it. The gate qualifies: `admit` is `() => deps.getPlayerFinalLapStarted() !== true`, and the reader behind it (`SimRuntime.isPlayerFinalLapStarted`, #1702 decision 5) reads the translator's state without writing any. The module header's "two known gaps" paragraph loses the first gap; the second (#1773) stays.

The enough-fuel confirmation opts in with the rest because it shares the gate, and that is right for it too: "enough fuel to finish" heard after the final lap has started is late rather than false, but the gate refuses it today on a first ask in the same case, so a replay should agree.

The fuel opt-in needs #1702's gate, which is on an unmerged branch. The #1774 worktree is cut from `origin/master` after #1702 has merged. If #1774 has to go first, the engine change, the validation and the probe land alone (the probe's floor is then zero and must be raised to twelve with the opt-in), and the fuel opt-in goes into #1702's branch.

### 8. Documentation and changelog

Updated in the same change:

- `dsl.ts`: the `SpeakGate` doc (the field, the rule, the probe) and the `resumable` doc.
- `scheduler.ts`: the `prepareOps` doc, the `stashRunningIfQueueable` doc and the module header's bullet on the deferred-replay gate; `engine-types.ts`: `WaitingFire.admitted`.
- `.claude/rules/race-engineer-callouts.md`: the `speakGate`, `resumable`, `dropWhenCut` and `where:` bullets, which each say an admitted fire is never asked again.
- `packages/audio-scenarios/CLAUDE.md`: the `scheduler.ts` module bullet and the `speakGate` and `resumable` field bullets.
- `.claude/rules/race-engineer-callout-examples.md`: one entry for the pattern (a read-only gate opts in to be asked after a cut; a claiming gate never does).

Changelog: the gap is in #1702's own feature. If #1702 has not been released when #1774 merges, there is no fragment, because a fix to a change still in development is not a second bullet (`changelog.md`). If #1702 has shipped in a release by then, a `Bug Fixes` fragment, weight 40: a fuel count cut off by another line is no longer repeated after your final lap has started.

## Out of scope

- **Opting in any other family.** Several gates only read (`damage-alerts.ts`, `pit-limiter.ts`, `pit-status.ts`, the caution and rolling-start formation gates, `incidentStillFresh`), but each opt-in changes what a driver hears after a cut and is that family's own decision. The furled pair, the traffic first call and every claiming gate cannot opt in.
- **Re-running `where:`** at replay. It decided at event time, and a stash a `where:` wrote must keep its meaning (#1138, #922).
- **The final-lap marker going unset on a crossing just after the white heads-up** (#1773).
- **A "never mind" or other spoken ending** for a stash its gate refuses. The line ended at the cut.
- **A runtime check that a declared gate really is read-only.** Rejected in decision 2.
- **The queue's max wait and `dropWhenCut`.** Unchanged; #1681 and #1702 settled them for the fuel lines.

## Testing

Unit, `packages/audio-scenarios`:

- `interpreter.test.ts`, beside the existing `admitted` cases ("a queueable fire cut by an interrupt keeps its admission…", "admit runs exactly once for a fire that plays, and is skipped on a resume"), with a contract whose gate sets `askAgainAfterCut`:
  - a non-`resumable` stash replays whole when the gate still admits, and the gate was asked twice (first offer, replay);
  - the same stash is dropped when the gate refuses at replay: nothing plays, the debug line `skipped after a cut — speak-time gate` is logged, the pool's `lastIndex` is the take heard before the cut, and `lastFireAt` is unchanged;
  - a `resumable` stash with an unchanged expansion is asked before it resumes, resumes when admitted, and is dropped with its resume when refused;
  - a `resumable` stash whose expansion changed is asked once and replays whole when admitted;
  - a stash made by `playClips` with `whenBusy: "interrupt"` is asked when it comes back;
  - a refused stash that leads a `queueBehind` follower lets the follower play next, and a refused stash arms no `pendingHoldMs` hold;
  - a stash re-parked below a focus floor is not asked while it waits, and is asked when the floor drops;
  - without the field the existing cases pass unchanged: an admitted fire is not asked again, the claiming-gate cases ("Claimed once.") included.
- `validation.test.ts`: `askAgainAfterCut` on a non-queueable contract is an error naming the rule, so is it with `dropWhenCut`, and with `resumable` it is accepted.
- `dsl.test.ts` or a type test: `askAgainAfterCut: false` does not compile (`@ts-expect-error`, its one honest use per `testing.md`).
- `catalog/pit-crew/speak-gate-ask-again.test.ts` (decision 2): every opted-in gate admits under `DEFAULT_DEPS`, answers the same twice and leaves the family state unchanged; at least twelve contracts are checked; the probe run on the gap family's gate fails (positive control).
- `catalog/pit-crew/fuel-laps-left.test.ts`: every fuel contract's gate carries `askAgainAfterCut`, and through the real engine a fuel count cut by a heavier `interrupt` replays when `getPlayerFinalLapStarted` stays `false` and is dropped when it turns `true` while the count waits — the scenario the issue describes.
- `bundled-scripts.test.ts` and the registration tests pass unchanged: no fuel contract is disabled by the new validation.

Harness, `packages/scenario-harness`: play a fuel count (Fuel shortcut, 3 laps), cut it with a spotter or flag shortcut heavier than it, and hear it replay; repeat after setting the final-lap state the #1702 harness presets expose (the white flag on the player's last lap), and hear nothing come back. If no shortcut can set that state, the interpreter-level test above is the proof and the harness run covers only the replay half.

Manual, by Niklas in the sim, on a short oval (a lap under about 16 s) with a small fuel load: let a count be cut by a spotter call on the final laps and confirm it is not heard once the final lap has started; earlier in the stint, confirm a cut count still comes back.
