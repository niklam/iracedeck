# A cut line keeps its original due time

> **Issue:** [#1681](https://github.com/niklam/iracedeck/issues/1681) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

File: `docs/superpowers/specs/2026-11-10-issue-1681-stash-keeps-due-time.md`. Measured on `master` at `9dda4b51f`. The contract list below was read off the registered catalog (a `defineContract` spy over `registerPitCrew`, the built dist, which matched the sources for every queueable contract); clip lengths are the bundled `voice/default` clips, measured with the repo's `ffmpeg-static`. #1676 follows this issue and relies on it.

## The problem

`maxQueueWaitMs` is meant to say how late a line may be heard. It does, for a fire that waits its turn: the queue measures the wait from the fire's first deferral, and a replay deferred again keeps that time. It does not for a fire an `interrupt` cuts. `stashRunningIfQueueable` (`scheduler.ts`) re-queues the cut line through `enqueue` with no `queuedAt`, so `enqueue` stamps the moment of the cut and the max wait starts again there. A cut line can therefore start its replay up to (time it waited before it played) + (time it played before the cut) + `maxQueueWaitMs` after it was due. #1676's sector call is the first contract where that matters to the words: with a 1.5 s bound, a cut "Sector three." could replay about a second past the sector line. The same restart applies to every queueable contract.

## Decisions

### 1. A fire's due time is the moment it was first offered to its bus

One definition for every path: the due time is when `attemptFire` first saw this fire, which is when the triggers handed it over (after any `triggerDelay` or `settle` wait, which are the contract's own choice of when to decide) or when an imperative `fire()` was made.

- **Played first, then cut.** It took an idle bus (or cut a lighter line) on its first offer, so its due time is the moment it took the bus.
- **Deferred, then played, then cut.** Its due time is its first deferral, which is the same instant as its first offer, not the moment it later started playing. Taking the start of play instead would let a fire that waited 7 s, played 0.5 s and was cut wait a fresh 8 s: 15.5 s late against an 8 s bound.
- **Resumed or replayed whole, then cut again.** It keeps the due time it was stashed with. A fire is the same fire across every stash, resume and re-park, which is already how `admitted` travels (#1138).

The issue's wording, "when it first started playing or was first deferred", is the same instant in both branches; the definition above says it once.

### 2. The due time travels with the fire, and the queue's age field is renamed for it

Today the time a fire was first deferred lives only on the waiting fire (`WaitingFire.queuedAt`, the queue entry's `queuedAt`) and is lost when the fire takes the bus. It now rides the playing fire too: `ActiveFire` (and `FireStart`) carry `dueAt`, set in `executeFire` from the replay's `queuedAt` when there is one and from the offer's `now` otherwise, and the stash passes the playing fire's `dueAt` to `enqueue` instead of letting it stamp the cut. A cut tail an end plays (#1407) carries its fire's `dueAt`, since it is the same fire, though it is never stashed; the frame preview, never stashed either, takes its start.

The field is renamed `dueAt` wherever it means this: `WaitingFire`, the queue's `QueuedFire` and `OfferInput`, and the waiting entries `describeState()` reports into the Telemetry Snapshot (`ScenarioEngineState`'s `waiting[].queuedAt` becomes `waiting[].dueAt`). For a stash, "queued at" would now name a time before the fire was ever queued, and the snapshot is read by people diagnosing exactly this. The snapshot field is not a published contract (nothing outside the repo parses it; `debug-state.test.ts` is its one reader), so the rename needs no compatibility shim.

### 3. A cut line already past its ceiling is dropped at the cut, by the queue

When the stash reaches the queue, its `dueAt` may already be more than its max wait ago (a line that waited, then played a long way, then was cut). `PendingQueue.offer` refuses any newcomer already past its max wait, under the same predicate the queue expires entries by (`now - dueAt > maxWaitMs`; exactly at the bound is still served): it is not placed, supersedes nothing in its group, does not count toward the cap, and comes back as an `expired` drop. The scheduler logs it through `logQueueDrops` like every other queue drop, at debug: `Scenario "<id>" dropped — waited <N> ms (max <M> ms)`, where N now counts from the due time, so for a cut line it includes the time it played. Nothing is logged at info, as for every other drop. Its resume is discarded with it.

The rule is the queue's, not the stash's, so one predicate decides expiry wherever a fire enters. Today an ordinary first deferral can never trip it (its due time is now), and a re-deferred replay already left the queue unexpired in the same call, so in practice only a stash reaches it.

The wording stays "waited": #1676's tests look for it, and the max wait's own name is the wait. A stash that is accepted keeps its line, `pending (<p> of <n>) — stashed (preempted)`.

### 4. One clock: the due time also orders the queue and picks the cap's victim

The queue plays heaviest first, then the oldest `queuedAt`, and the cap drops the lightest, then the oldest. Both now read `dueAt`. Two consequences, both accepted:

- **A stash now goes ahead of an equal-weight fire deferred while it played.** Today that fire, deferred before the cut, is older than the stash and plays first. Now the stash, due first, plays first. A line the driver has already half heard finishing before the next line of its weight starts is the better order, and for a resumable line it is what #758 meant.
- **A stash is now the first equal-weight victim of the cap.** The cap takes the oldest of the lightest because it is the nearest its max wait; a stash is exactly that now.

### 5. Whose window shrinks

Every queueable contract is stashed when an `interrupt` cuts it, so every one of them now gets less time after a cut: the window shrinks by the time it waited before playing plus the time it played before the cut. A non-queueable contract is never stashed and is unchanged (the pit-box count-in, both spotter calls, the corner names, the pit-status nags, and the sector call until #1676 makes it queueable).

What can cut what, on the Voice bus: the spotter's `spotter-call` (`PROXIMITY` 120) cuts every queueable line; the `CRITICAL` interrupt lines (`flag-meatball`, `caution-restart`, `fuel-laps-left-1`, `fuel-laps-left-box`, `start-light-ready`, `start-light-go`) cut everything below 100; `spotter-info` ("Clear." and the still-there reminder, `SAFETY` 70 with `interrupt`) cuts everything below 70; the pit-box count-in (30) cuts the `CHATTER` lines, the pit readbacks among them.

| Max wait | Queueable contracts (`pit-crew.` omitted) | Cut by |
|---|---|---|
| 1.5 s (#1676) | `sector-start`, once #1676 makes it queueable | every interrupt line |
| 8 s (default), weight 100 | `caution-restart`, `fuel-laps-left-1`, `fuel-laps-left-box`, `start-light-ready`, `start-light-go` | the spotter call |
| 8 s, weight 70 | `flag-furled`, `flag-furled-cleared`, `flag-white-leader`, `flag-white-last-lap`, `flag-yellow-cleared`, `fuel-laps-left-2`, `fuel-laps-left-3` | the spotter call, the `CRITICAL` interrupts |
| 8 s, weight 40–65 | `opponent-pit-*` (5), `pit-window-opened`, `pit-window-closed` (65); `fuel-laps-left-4`…`-10`, `fuel-laps-left-race-covered`, `gap-threshold`, `limiter-missing`, `limiter-on-track`, `opponent-flag-*` (9), `pit-status-nothing-to-do`, `qualifying-invalidation-lap-invalidated`, `race-start`, `session-start` (50); `readout-*` (5, 40) | the above and `spotter-info` |
| 8 s, weight 10 | `gap-trend`, `lap-time-last`, `overtake-gained-position`, `overtake-lost-position`, `position-change`, `race-end`, `race-status` | the above and the count-in |
| 10 s | `incident-*` (6, `INCIDENT_SPEAK_MAX_AGE_MS`) | the spotter call, the `CRITICAL` interrupts, `spotter-info` |
| 20 s | `caution-catch-up`, `caution-extra-lap`, `caution-field-caught`, `caution-follow`, `caution-lineup-changed`, `caution-one-to-go`, `caution-pace-car-off`, `caution-pace-car-out`, `caution-position`, `flag-caution-waving`, `flag-one-pace-lap-to-go`, `rolling-start-lineup-changed`, `rolling-start-pace-car` | the spotter call, the `CRITICAL` interrupts; those below 70 also `spotter-info` |
| 30 s | `flag-black`, `flag-disqualify`, `flag-dq-scoring-invalid`, `flag-meatball`, `damage-repair-needed`, `fastest-lap-race`, `tire-wear-report`; and `pit-readback-entry`, `pit-readback-exit` under decision 6 | the spotter call; all but the meatball also the `CRITICAL` interrupts; the 50s and the readbacks also `spotter-info`; the readbacks also the count-in |

In practice:

- **The sector call (1.5 s)** is the case the issue is for: a cut "Sector three." has played most of its 0.84–1.02 s clip, so it replays only behind an interrupt line shorter than about half a second, which is to say almost never. That is the intent: past 1.5 s it names a sector line already behind the car.
- **The 8 s lines** lose 1–2 s of their window to a 2–4 s line cut midway, more when they had already waited behind another line. The longest of them, the session-start and race-start briefs, are not resumable, so a brief cut late used to replay whole from the top. Decision 9 now drops a cut brief outright.
- **The incident lines (10 s)** gain the most consistency. Their `speakGate` refuses an incident older than 10 s, but a cut line replays `admitted` and is never asked again, so today a cut incident line could be heard up to the cut plus 10 s. It is now bounded by its due time, which for an incident is its event's arrival: the queue and the gate finally agree.
- **The 20 s and 30 s lines** are sustained states or re-checked conditions; losing a few seconds of their window changes nothing audible.
- **The pit readbacks** would break, which is decision 6.

### 6. The pit readbacks wait 30 s, in a shared supersede group

Niklas confirmed the 30 s on 2026-11-10, accepting that a readback only waiting its turn can play up to 30 s late, so that one cut by the count-in still finishes.

The readback is the one line whose documented behaviour depends on the restart. #758 made the pit-box count-in cut the entry readback and made the readback `resumable`, so it continues from the cut clip once the count-in train is done, with `pendingHoldMs` (2.5 s) holding the drain between marks and after the last one. From the cut to that resume: the car covers the 100 m from the "five" mark (120 m) to "pit now" (20 m), the last clip plays (0.84 s), then the hold runs (2.5 s). At a 60 km/h pit limit that is about 6 s + 0.84 s + 2.5 s ≈ 9.3 s before the queue is read again, longer with the braking into the box; at 80 km/h about 7.8 s. Under the readbacks' 8 s default, that already drops the resume at any pit limit below about 75 km/h, measured from the cut (an estimate from clip lengths and pit-lane speeds, not yet observed; Testing names the check). Measured from the due time it fails everywhere: add the readback's own playing time before the cut, up to about 12.5 s for a full readback (limiter opener 1.62 s, opener 1.49 s, fuel 1.02 s, tires up to 3.06 s, a 0.3 s pause, fast repair 3.19 s, windshield 1.49 s), and the resume lands around 15–25 s after the readback was due.

So both readback contracts declare `maxQueueWaitMs: READBACK_MAX_QUEUE_WAIT_MS` (30 000, exported from `readback.ts`), the same 30 s as the tire-wear report that queues behind the exit readback. It meets the rule for a longer wait, a line that stays true while it waits: the readback re-expands from the live pit-service snapshot at replay and replays whole and fresh when the snapshot moved (#481), so what it says is current when it is said. 30 s covers the worst measured case above with room; 20 s would not cover a full readback cut at its end at a 60 km/h lane.

A longer wait opens one wrong order: an entry readback still waiting when the stop is over. Both readbacks therefore share `supersedeGroup: "pit-readback"`. The exit readback is newer news about the same stop, so when it waits or takes the bus it removes a waiting entry readback (logged `superseded by "pit-crew.pit-readback-exit"`), and an entry stash cut after an exit readback had queued yields to it (`yieldsToGroup`). That is the rule for a shared group: a newer line that makes the waiting one wrong. The tire-wear report's `queueBehind` names the exit readback by id and is untouched.

### 7. User-audible: yes, and two changelog fragments

Two things a driver can hear change, so two fragments, in the same PR:

- `changelog.d/1681-cut-callouts-stay-timely.md`, `Improvements`, weight 30: "A Race Engineer callout cut short by an urgent call, such as the spotter, is now repeated only while it is still on time, within the same limit it has for waiting its turn, rather than up to several seconds after its moment." This was deliberate behaviour (#1185 stated the restart), so it is an improvement, not a fix.
- `changelog.d/1681-readback-after-count-in.md`, `Bug Fixes`, weight 40: "The **pit entry readback** that the pit-box count-in cuts short now finishes once you stop in your box on slower pit lanes too, where it could be dropped. See [Pit Service Readback](/docs/actions/audio-voice/pit-crew/#pit-service-readback)." A Bug Fixes fragment needs the loss to have shipped: it rests on decision 6's arithmetic, and the master check in Testing confirms it. If master plays the tail at a 60 km/h lane, this fragment is dropped (the change then fixes nothing a user heard), and the other stands alone.

The Pit Crew page's "Pit-box count-in" section gains one sentence: a pit entry readback the count-in cuts short continues once the count is done. The page never said so, and the fragment links to it.

### 8. Artifacts beyond the code

- `audio-scenarios`: `scheduler.ts` (module header's max-wait bullet, `enqueue`, `stashRunningIfQueueable`, `executeFire`), `pending-queue.ts` (the newcomer check, header, field docs), `engine-types.ts` (`WaitingFire`, `ActiveFire`), `playback.ts` (`FireStart`), `interpreter.ts` (`ScenarioEngineState`), `readback.ts` (the constant, the group, its comment), the package `CLAUDE.md` (the `maxQueueWaitMs` bullet: "an interrupt-cut fire starts a new one" becomes "a cut fire keeps its due time"; the override list gains the readbacks and the already-missing `fastest-lap-race`; the `pending-queue.ts` bullet).
- `.claude/rules/race-engineer-callouts.md`: the same two sentences in the `maxQueueWaitMs` bullet, and the readbacks in its list of 30 s lines.
- `.claude/rules/race-engineer-callout-examples.md`: a #1681 note on the #758 and #1185 entries: a stash keeps its due time, so a resumable line whose resume waits on a train needs a max wait that covers the train.
- `pnpm generate:pack-reference` only if the reference's output moves; it does not publish `maxQueueWaitMs` or `supersedeGroup`, so it should not, and its drift test says so either way.
- The #1676 spec is amended on `master` beside this one: decision 4's "A cut sector call overruns the bound" bullet and the stash paragraph of its Out of scope say the bound now holds on every path.

### 9. A cut session-start or race-start brief is dropped, never replayed

Niklas, 2026-11-10: "Session-start and race-start briefs should be dropped if cut off. I've been in situation where the race-start brief played like 4 times due to lights, then traffic." A brief is a long, one-off summary of the session. Replaying it whole after the start lights or a spotter call cut it repeats what the driver has already half-heard, at the busiest moment of the session. So both brief contracts are not stashed when an interrupt cuts them: the cut ends the brief, logged at debug as dropped. A brief that only waits its turn and was never cut still plays within its 8 s window, as today. This applies to the session-start and race-start briefs only. Every other queueable line keeps the stash, bounded by decision 3.

The mechanism is a contract field, `dropWhenCut?: boolean`, declared in `dsl.ts`. Validation requires `queueable` with it and refuses it alongside `resumable`. The stash checks it and, instead of stashing, logs `Scenario "<id>" dropped — cut` at debug. `session-start.ts` and `race-start.ts` set it. It is not surfaced in `contracts()` or the pack reference. It is not the rejected restart-on-cut flag, which would exempt a line from the due-time rule; this one only says "never replay me after a cut". Decision 8's artifacts gain `dsl.ts`, `validation.ts`, `session-start.ts` and `race-start.ts`. (Amended 2026-11-10, from the #1681 lead's plan. Its run of master's engine confirmed that the readback resume is dropped below about 77 km/h today, so the Bug Fixes fragment stays.)

## Approaches weighed and rejected

- **Keep the restart.** Then `maxQueueWaitMs` bounds the wait, not the lateness, and #1676's 1.5 s is not a bound.
- **Count only the time spent waiting, not the time spent playing.** Bounds the total wait, but a cut line still replays its full play time late: the sector call would still land about a second past the line.
- **Due at the start of play for a deferred fire.** Lets a fire that waited most of its window start a fresh one by playing a moment (decision 1).
- **Due at the event's arrival.** Ignores `triggerDelay` and `settle`, which are the contract's own decision of when to decide, and an imperative `fire()` has no event. Event age is a `speakGate`'s business, as the incident lines show.
- **Two clocks, a due time for expiry and the cut for ordering.** Two notions of a fire's age that would disagree about which fire is oldest; the oldest-first rule exists because the oldest is the nearest its ceiling.
- **Keep the field named `queuedAt`.** It would name, for a stash, a time before the fire was ever queued, in the snapshot people read to diagnose this.
- **Offer the expired stash and let the next read drop it.** Until then it counts toward the cap, so a live fire could be the cap's victim to keep a dead one, and the snapshot lists it as waiting.
- **Exempt resumable fires, or a per-contract "restart on cut" flag.** An engine rule shaped around one consumer; how long the readback stays true is a fact about the readback, which `maxQueueWaitMs` already expresses.
- **Leave the readbacks at 8 s.** #758's resume after the count-in would be dropped at every pit lane.
- **The readbacks at 30 s without a shared group, or `endsOn: pitLane.exited` on the entry readback.** Without the group a stale entry readback can wait into the exit; `endsOn` would also cut a playing entry readback with "never mind" at pit exit, a change to what the driver hears that this issue does not need.

## Out of scope

- Any contract's weight, `interrupt`, `queueable`, `resumable` or max wait other than the two readbacks and the briefs' no-stash rule (decision 9).
- The 8 s default and the cap of four.
- A `dueAt` on the playing fire in `describeState()`'s `active` entry; only the waiting entries report it.
- Telling a cut drop apart from a waiting drop in the log; the reason and figures are the same kind of fact.
- #1676's own changes; it follows this issue.

## Testing

**Unit tests**, with fake timers; each drop half has a replay half in the same fixture as its positive control, and every drop half fails on `master`, where the wait restarts at the cut:

- `pending-queue.test.ts`: a newcomer whose `dueAt` is more than its max wait ago is not placed, comes back as an `expired` drop with `waitedMs = now - dueAt`, leaves a waiting entry of its group in place and drops no cap victim; the same newcomer exactly at its max wait is placed.
- Briefs (decision 9): the session-start and race-start briefs, cut by an interrupt, are dropped at the cut and never replayed, with a debug line; the same brief waiting its turn without a cut still plays within 8 s; and another queueable line cut the same way is still stashed (positive control).
- `scheduler.test.ts` / `interpreter.test.ts`, contract with an 8 s max wait:
  - **Played, then cut:** it takes the idle bus at 0 s, is cut at 3 s by a 4 s interrupt line and replays at 7 s; with a 6 s interrupt line it is dropped when the bus idles at 9 s and the debug log reads `waited 9000 ms (max 8000 ms)`.
  - **Deferred, played, then cut:** deferred at 0 s behind a 5 s line, it plays at 5 s and is cut at 6 s; behind a 1.5 s interrupt line it replays at 7.5 s, behind a 2.5 s one it is dropped at 8.5 s. The second half is the one that proves the due time is the deferral and not the start of play.
  - **Past its ceiling at the cut:** a `NORMAL` fire deferred 7 s behind another line plays at 7 s and is cut at 9 s; it is dropped at the cut with the `waited` line, `describeState()` lists no waiting entry for it, and four `CHATTER` fires deferred while it played all stay (placed, it would have made one of them the cap's victim).
  - **Cut twice:** a resumable fire resumed and cut again keeps its first due time.
  - **Order:** a stash plays before an equal-weight fire deferred while it played.
  - The existing session-generation, ended-fire and `yieldsToGroup` stash tests stay green unchanged.
- `readback.test.ts` (or an interpreter test on the real readback contract): the entry readback plays at 0 s, the count-in's "five" cuts it at 3 s, the marks follow every 1.2 s to "pit now", then the 2.5 s hold, and the readback resumes from the cut clip at about 12.3 s ("pit now" at 9 s, its 0.84 s clip, the hold). The same timing against a test-local copy of the contract without the override is dropped; and the same timing on `master` (wait measured from the cut, about 9.3 s) is dropped too, which is the unit-level evidence for the Bug Fixes fragment. An exit readback taking the bus drops a waiting entry readback, logged `superseded`. Both readback contracts are pinned to `maxQueueWaitMs: READBACK_MAX_QUEUE_WAIT_MS` and `supersedeGroup: "pit-readback"`.
- `debug-state.test.ts`: the waiting entry reports `dueAt`.

**Gates:** `bundled-scripts.test.ts`, `pnpm typecheck` (the renamed field), the pack-reference drift test.

**Manual (Niklas, in iRacing):**

- On `master` first, at a pit lane with a 60 km/h limit and a box within about 150 m of pit entry: queue fuel, four tires, fast repair (with damage) and windshield, and drive in. Note whether the readback the count-in cuts finishes after the car stops. This decides the Bug Fixes fragment (decision 7).
- The same on the branch: the readback finishes once the count is done and the car is stopped.
- In traffic in a race with debug logging on: a callout cut by a "Car left" call either finishes within its window or is dropped with a `waited` line; nothing is repeated many seconds after its moment.

**Review:** the `high` row (the scheduler is ordinary domain code; the snapshot field is not a published contract), and the second read applies: the queue and the stash are a state machine.
