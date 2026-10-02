# Issue #1185 — A bounded queue replaces the one deferred fire per bus

> **Issue:** [#1185](https://github.com/niklam/iracedeck/issues/1185), [#1288](https://github.com/niklam/iracedeck/issues/1288) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The scenario engine keeps one deferred fire per bus (`BusState.pending`, `packages/audio-scenarios/src/interpreter.ts` ~line 415). `setPending` (~line 1405) admits a newcomer to that slot only by evicting the waiting fire: a newcomer of at least its weight replaces it, and a lighter one is dropped. Two callouts that both deserve to be heard therefore cost each other whenever the bus is busy at the moment they fire.

Two shipped cases:

- **#1108's general case.** The exit readback plays and the tire-wear report waits. A flag or spotter call of at least the report's weight arrives, takes the slot, and the stint summary the driver pitted for is never heard. `queueBehind` fixed only the ordered pair known at design time.
- **#1288's caution burst.** `crash-caution-sequence.test.ts` replays a user's race log: a crash, then three queueable `WEIGHT.SAFETY` caution calls within 2.3 s. They replace each other in the slot and push out the damage line, and depending on what held the bus when they began, the incident line too.

The single slot is also a pacing device, and the design has to keep that: the engineer must never work through a backlog of lines about a moment that has passed. Today about twenty queueable contracts rely on being evicted for that and carry no speak-time staleness check of their own (all twelve fuel tiers, the opponent-pit and opponent-flag lines, the readouts, the yellow-cleared/white/penalty flags, the meatball, race-end, the readbacks and the tire-wear report).

Some evictions are features, and a queue must keep them:

- A DQ replaces a waiting black flag (#923, `flag-alerts.test.ts` ~line 965).
- "Go" replaces a waiting "ready" (#867).
- An escalation replaces a waiting incident (#938, #1211 §3).
- A newer qualifying approval replaces a waiting one, and a burst of readout presses yields only the newest (#466).
- Three module-scope stashes assume a single waiting fire per group: `lastIncidentPoints` (`incidents.ts` ~line 159), `pendingNearby` (`opponent-pit.ts` ~line 76) and `pendingAhead` (`opponent-flags.ts` ~line 113). Two fires of one group waiting at once would speak the newer fire's values twice.

## Decisions

### 1. A pure, bounded queue per bus (Niklas, 2026-10-02)

A new module `packages/audio-scenarios/src/pending-queue.ts` holds each bus's waiting fires and replaces `BusState.pending`. It is pure (no timers, no logger; it returns what it dropped and why) so it is unit-tested on its own. The interpreter owns logging and replay.

An entry is today's `WaitingFire` (`id`, `event`, `weight`, `resume?`, `admitted`) plus:

- `queuedAt`: the time the fire was first deferred. A fire that replays and is deferred again keeps its original `queuedAt`.
- `group`: its supersede group (§3).
- `after`: the id of the entry it waits behind, when it attached through `queueBehind`.

`offer(entry, now)` works in this order:

1. **Supersede.** Remove any waiting entry whose `group` equals the newcomer's. Followers of a removed entry stay in the queue: one whose contract's `queueBehind` names the newcomer re-links behind it (the #1211 rule, kept); any other drops its `after` link and becomes an ordinary entry.
2. **Place.** Heaviest first; within a weight, oldest `queuedAt` first. A follower sits immediately after its leader (and after that leader's earlier followers), whatever the weights. A newcomer that a waiting entry names in its `queueBehind` goes ahead of that entry, which then links behind it.
3. **Cap.** With more than `PENDING_QUEUE_CAPACITY = 4` entries, drop the lightest; ties go to the oldest. That can be the newcomer. A dropped leader's followers stay as ordinary entries.

`next(now)` returns the head, first discarding every entry older than its max wait (§2). `remove(id)`, `clear()` and an inspection accessor for tests complete the surface.

**The weight-eviction rule is gone.** A lighter newcomer no longer loses to a heavier waiting fire on arrival, and a heavier one no longer evicts a lighter one; both wait, bounded by the cap and the max wait. CHATTER lines (gap trend, position change, race status, readbacks) therefore now wait behind NORMAL lines instead of being dropped on arrival.

**Why 4.** It bounds a pathological burst; the max wait (§2) is the pacing device. #1288's burst is three caution calls and the incident, with the damage line riding behind the incident. **A follower does not count toward the cap**, or the damage line, the lightest of five, would be the one dropped. The bound stays finite without it: a leader's followers can only be contracts whose `queueBehind` names it, and the supersede rule allows one waiting entry per group.

**Rejected:** arrival order (it would put a safety call behind a fuel line that arrived earlier, inverting the weight rule the engine uses everywhere else); a cap of 2 (#1288's three caution calls alone overflow it); an unbounded queue (nothing would bound a stuck floor).

### 2. Pacing: an engine-wide max wait (Niklas, 2026-10-02)

`DEFAULT_MAX_QUEUE_WAIT_MS = 8000` (exported from `dsl.ts` beside `WEIGHT`). A waiting entry that has not started within its max wait of its `queuedAt` is discarded when the queue is next read, and the interpreter logs it. A contract may override it with a new optional field `maxQueueWaitMs`.

Overrides set by this issue, all 30 000 ms, each a sustained state whose line stays true for as long as it can wait:

- `flag-black`, `flag-disqualify`, `flag-dq-scoring-invalid`, `flag-meatball`: a penalty lasts until served, so losing the line to a busy minute is worse than hearing it late (#923).
- `damage-repair-needed`: its `speakGate` already refuses it once the repair settles as done (#1288).
- `tire-wear-report`: the stint summary the driver pitted to hear (#1108).

The six incident lines take `maxQueueWaitMs = INCIDENT_SPEAK_MAX_AGE_MS` (10 000 ms), matching their event-age `speakGate`. NORMAL lines wait behind SAFETY ones, and in #1288's burst the incident waits behind three caution calls: with two-second lines that is about 8.3 s, which the default would expire, while their own staleness rule says the line is still true. The max wait now also bounds an incident line that was cut by an interrupt and replays `admitted`, which closes the gap #1211 §1 accepted.

The gated caution calls take `maxQueueWaitMs = 20000` (Niklas, 2026-10-02): every `caution-*` contract except the CRITICAL `caution-restart`, and `flag-caution-waving`. In the #1288 log's own case (the holder ends before the caution flag), the incident line takes the bus first and pace-car-out waits about 8.5 s with the bundled voice's clip lengths, past the default. The `caution-*` calls re-check at speak time that the caution is still out, and the lineup and follow calls also check that the lineup still holds, so they stay true for as long as they wait. `flag-caution-waving` has no such gate; its 20 s rests on a full-course caution lasting minutes, not on a re-check.

Everything else takes the default.

**Why 8 s.** A Race Engineer line runs two to four seconds, so 8 s is two or three lines of backlog: enough to clear #1288's burst, short enough that nothing is spoken more than a few seconds after its moment. What would set it properly: across race sessions with debug logging on, the distribution of `queuedAt` to replay for every line that played, and of the expiry log line.

**The queue is cleared on `session.changed`** (new: today the slot survives a session change). The engine clears the Voice queue before it dispatches that event's own contracts, so the session-start briefing and race-start lines, which fire on it, are not cleared by it.

**Rejected:** per-contract opt-in to queueing (every family would need a decision and #1288's caution calls would need opting in; a default with overrides gets the same safety); opt-in plus a backstop (the same cost, for a distinction nobody needs yet).

### 3. Supersede groups (Niklas, 2026-10-02)

A new optional contract field `supersedeGroup: string`, defaulting to the contract's own id, so the same callout never stacks. A newer waiting fire replaces an older one of the same group (§1 step 1). It acts on WAITING fires only; family preemption keeps acting on the playing one.

Groups set by this issue:

| Group | Contracts | What it keeps |
|---|---|---|
| `penalty` | `flag-black`, `flag-disqualify`, `flag-dq-scoring-invalid` | #923: DQ replaces a waiting black flag |
| `start-light` | `start-light-ready`, `start-light-go` | #867: go replaces ready |
| `incident` | the six `incident-*` | #1211 §3 escalation; `lastIncidentPoints` lockstep |
| `readout` | the five `readout-*` | #466: the newest press wins |
| `opponent-flag-ahead` | the four flag-ahead contracts | `pendingAhead` holds one value |
| `fuel` | the twelve `fuel-laps-left-*` | a newer lap count supersedes an older one |
| `pit-window` | `pit-window-opened`, `pit-window-closed` | the newest state wins |
| `furled` | `flag-furled`, `flag-furled-cleared` | a clear supersedes a waiting warning |
| `position` | `position-change`, `race-status`, `overtake-gained-position`, `overtake-lost-position` | one position line at a time (they share a 20 s cooldown claim) |

The caution calls keep their own ids, so a caution burst queues in full. Two groups first proposed here were dropped during implementation (Niklas, 2026-10-02). `opponent-pit`: only `opponent-pit-nearby` reads the `pendingNearby` stash, and its own id already keeps it to one waiting fire; grouping all five would have reduced a queued pit train to its last line. `gap`: a newer CHATTER trend line would have replaced a waiting NORMAL threshold call. Without the group both wait, the threshold call plays first, and the shared gap cooldown claimed in the gate refuses the second line, so it is still one gap line at a time. The qualifying lap-invalidation contract keeps its id: a newer approval replaces the older one, as today.

The implementation verifies each assignment against the contract's stash and gate before applying it; a group that turns out wrong is a spec amendment, not an improvisation.

**Rejected:** reusing `family` (the caution calls share `family: "flag"` with the penalty flags, so lineup-changed would still erase caution-waving: #1288's loss inside the caution set); an explicit `supersedes: [ids]` list per contract (long lists that must stay in sync as callouts are added).

### 4. `queueBehind` stays, as an ordering constraint

It is a different relation from supersede: it orders two fires that should both be heard. Its guarantees carry over: a follower never plays ahead of its waiting leader, and a leader that fails at replay leaves its follower to play next. "It is a pair, not a queue" and "a second follower replaces the first" go away: a leader may have several followers (damage behind an incident is one; nothing else lists more today), placed in arrival order behind it.

A follower whose `queueBehind` names several waiting fires links behind one of them for placement, but the drain serves it only once none of the fires it names is still waiting. That is the same deferral `attemptFire` applies on an idle bus, so "never ahead of a waiting leader" holds for every leader it names. In the catalog this concerns only `damage-repair-needed`, which names the incident lines and the qualifying line. A `queueBehind` cycle between two contracts would leave both waiting until they expire, so registration warns about one.

### 5. Engine integration

- **When a fire is deferred is unchanged.** `queueOrDrop` for a queueable fire below a floor or behind a busy bus, the higher-weight-without-interrupt path (~line 1322) for any fire, and the interrupt stash (`stashRunningIfQueueable`, ~line 1493) all call `offer` where they called `setPending`.
- **Draining pops one entry at a time.** `drainPending` asks `next(now)` and replays that entry through `attemptFire`, as today. If the replay fails (gate refused, expansion aborted, no script entry, disabled), it drains the next entry. A replay that is deferred again (a floor still held, a busy bus) is re-offered with its original `queuedAt`, and the drain stops.
- **The focus floor.** While a floor is held, the drain skips entries below it (the same `focusOwner` / `weight < floor` test `attemptFire` applies) and replays the first entry the floor admits; the skipped entries keep their places. `releaseFocus` drains as today. A behaviour change follows: a non-queueable fire that reached the queue through the higher-weight path (the pit-status nags) used to be dropped when it replayed below a floor. It now waits for the floor like any entry, bounded by its max wait. Those fires re-check live state through their `speakGate` when they speak.
- **The pit-box hold.** `pendingHoldMs` holds the drain of the whole queue, exactly as it holds the slot today.
- **An idle bus with waiting entries** (a hold, or entries below a floor): a new fire plays at once as today, unless a waiting entry is its `queueBehind` leader, in which case it is offered behind it.
- **`stopAll`, `setEnabled(false)`.** `stopAll` clears the queue. Disabling a contract removes its entries; its followers become ordinary entries.

### 6. Logging

Every way a fire leaves the queue without playing names its reason, at debug level, in the existing `Scenario "X" …` form:

- `pending (n of N) — <reason>` on offer.
- `dropped — superseded by "Y"`.
- `dropped — queue full (lightest)`.
- `dropped — waited N ms (max M ms)` on expiry.
- `Replaying pending scenario "X"` on replay, unchanged.

The skip on a disabled replay, silent today, gets a log too.

## Artifacts beyond the code

- `dsl.ts`: `supersedeGroup`, `maxQueueWaitMs`, `DEFAULT_MAX_QUEUE_WAIT_MS`, and the `queueable` / `queueBehind` docs rewritten for the queue.
- The interpreter header's scheduling section.
- The contracts named in §2 and §3, and the headers that describe the single slot (`flag-alerts.ts`, `incidents.ts`, `damage-alerts.ts`, `tire-wear.ts`, `readout*.ts`, `opponent-pit.ts`, `opponent-flags.ts`, `caution.ts`, and the `registerPitCrew` comment block). The comments that cite "#1185 owns that slot" are rewritten.
- The pack reference (`pnpm generate:pack-reference`) if the new fields appear in it.
- `.claude/rules/race-engineer-callouts.md` 4a (queueable, queueBehind, the new fields) and `race-engineer-callout-examples.md` (a new entry; the #923, #1108 and #1211 entries get a forward pointer); `packages/audio-scenarios/CLAUDE.md`.
- Website: the Pit Crew page sentences added by #1211 that say a more urgent waiting call can take a line's place; the changelog (a **Bug Fixes** line, since the losses shipped).
- #1288 closes with this issue.

## Out of scope

- Playing two lines at once, or any mixing change.
- Weight changes, and new wording for any line.
- Speak-time staleness gates for the contracts that have none: the max wait is their pacing now; a contract that needs more gets its own issue.
- Buses other than Voice beyond sharing the mechanism (no catalog contract uses another bus today).
- The spotter floor's weight and duration.

## Testing

Unit, `pending-queue.test.ts` (pure):

- Placement by weight, then age; a follower immediately after its leader whatever the weights; a newcomer named by a waiting entry goes ahead of it.
- Supersede by group, including a superseded leader's follower re-linking to a newcomer it names and dropping its link otherwise.
- The cap: the lightest-then-oldest is dropped, the newcomer can be the one, and followers do not count.
- Expiry at `maxQueueWaitMs` and at the default; a re-offered entry keeps its `queuedAt`.

Interpreter (`interpreter.test.ts`): the single-slot assertions (the `queueBehind (issue #1108)` block's weight-rule cases, ~lines 2573–3005) rewritten to queue semantics; drain one-at-a-time, a failed replay draining the next, the floor skipping lighter entries, the hold, `stopAll`, the session-change clear before the event's own contracts, and the new log lines.

Catalog, each feature the single slot provided, re-proven under the queue:

- DQ over a waiting black flag (`flag-alerts.test.ts`), go over ready (`start-lights.test.ts`), the escalation over a waiting incident with damage still behind it (`incidents.test.ts`, `damage-alerts.test.ts`), the newest readout (`telemetry-readout.test.ts`), the newer qualifying approval (`qualifying-invalidation.test.ts`).
- `crash-caution-sequence.test.ts` flips: in all three holder variants measured during #1211 (holder ends before the caution, still playing, cut by it), all five lines are heard (caution-waving, lineup-changed, pace-car-out, the incident, the damage line), with the test's two-second clips. A variant with clips long enough to push the incident past 10 s asserts the expiry log line and the damage line still playing; that is the pacing working, not a loss. Amended after #1297 (Niklas, 2026-10-02): #1297 moved the lineup-change call out of the flag family, so the pace-car call no longer cuts it and it plays in full, adding about 4.6 s to the burst. With the replay wired so the lineup change is genuine (a caution episode whose first follow car differs), the holder-ends-first variant still hears all five lines. In the two variants where the caution calls arrive while the holder is still on the radio, the incident line reaches the bus at about 11.3 s and is dropped by its 10 s limit, while the damage line still plays. That is accepted: #1211's 10 s rule stands, because an incident line that late can be mistaken for a new incident. Rejected: making the lineup change wait behind the incident lines, which couples a caution call to the incident family; and raising the incident limit, which reverses #1211.
- A new #1108 replay: the exit readback plays, the tire-wear report waits, a blue flag arrives, and the readback, the flag and the report are all heard.
- `caution.test.ts` ~lines 1042/1051, `gaps.test.ts` ~line 573, `tire-wear.test.ts` ~lines 310/587, `pit-status.test.ts` ~lines 631–652: updated to the queue's behaviour, each change named in the commit.

Harness: the #1211 shortcuts still produce their documented order; a new shortcut replays the #1288 caution burst (crash, then the three caution calls) for listening.

Manual, with debug logging on: in an AI race, crash so a full-course caution comes out and confirm the caution calls, the incident and the damage line are all heard, and the log shows no `queue full` or `waited` drop for them. Pit and leave the box into traffic so a flag or spotter call lands during the exit readback, and confirm the tire-wear report still plays.
