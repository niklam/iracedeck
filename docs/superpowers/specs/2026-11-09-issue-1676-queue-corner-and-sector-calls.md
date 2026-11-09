# Queue the corner and sector-start calls when they overlap

> **Issue:** [#1676](https://github.com/niklam/iracedeck/issues/1676) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured on `feature/1573-sector-start-calls` at `d4f61928d`, which merges before this issue starts. Amends decision 5 of the #1573 spec (`docs/superpowers/specs/2026-11-01-issue-1573-sector-start-calls.md`); the rest of #1573 stands.

## The problem

#1573 drops a sector call whenever a spoken corner is due within `SECTOR_START_CORNER_CLEARANCE_S` (1.5 s) of its sector start: the contract's `where:` (`audio-scenarios/src/catalog/pit-crew/sector-start.ts`) refuses it while `cornerCallWouldSpeak()` (built in `registerPitCrew`, `pit-crew/index.ts`) says the corner name would play. A sector call that arrives while a corner name plays is dropped too, since it is `queueable: false`. In Niklas's test (2026-11-09) the two overlap often, so many sector starts are never called. His decision, settled: call both, each at its own point, the second queued behind the first; the sector call lands at the sector line and the corner name may come up to about a second late, which is fine because a corner is called as it starts. Timing that does not overlap stays as it is.

## Decisions

### 1. The order is the track's, and the engine's existing queue places the second call

No new mechanism: the voice bus already does this once the suppression is gone. Each call still fires when its own lead point crosses its own marker (#888's sweep, unchanged), and whichever is published first plays first:

- **Sector start before the corner** (the common case). "Sector three." takes the idle bus. The corner fire arrives while it plays; it is heavier (`WEIGHT.NORMAL` over `WEIGHT.CHATTER`) without `interrupt`, so it waits in the bus's queue for the line in flight, queueable or not (`scheduler.ts`, "higher weight, no interrupt"), and plays the moment the sector line ends. The corner is late by the rest of the sector clip: at most 1.02 s with the bundled clips (`sector-number/1`–`10` measure 0.84–1.02 s), less by however far past the sector start the corner sits.
- **Corner before the sector start.** The corner name takes the bus. The sector fire arrives while it plays, lighter, so it needs `queueable: true` to wait instead of being dropped; it plays when the name ends. The sector call is late by the rest of the corner clip: at most 1.62 s with the bundled `corner-names` (439 clips, median 1.02 s, 90th percentile 1.25 s).
- **Both swept on one tick.** Today `diffCornerName` runs first, so the corner would be published first. The `TICK_ORDER` rows swap so `diffSectorStart` runs before `diffCornerName`: a sector start and a corner marker in one tick's swept interval are a corner at the sector line (`nextCornerInS` 0), and the sector call is the one Niklas wants on the line. Publication order across ticks is already the track order; the swap makes the one-tick tie agree with it.

Neither call cuts the other: they keep separate families (`sector-start`, `corner-name`), neither has `interrupt`, and the corner keeps `queueable: false`.

### 2. A call more than 1.5 s late is stale and dropped

One constant, `MARKER_CALL_MAX_LAG_MS = 1500`, exported from `pit-crew/corner-name.ts` and set as `maxQueueWaitMs` on both contracts. The engine measures it from the fire's first deferral, which is its arrival since neither contract has a `triggerDelay`, and drops a fire still waiting past it when the queue is next read, logged `dropped — waited N ms (max 1500 ms)`. So it bounds exactly the lag in decision 1: from the moment a call was due to the moment it starts. That holds for every path but one: a sector call that had started and is then cut by a heavier `interrupt` line is stashed and re-queued with its max wait restarted at the cut (decision 4), so its replay can start up to clip length plus 1.5 s after it was due.

1.5 s clears every measured bundled case with room: the corner behind a sector call waits at most 1.02 s, and the sector behind a corner name at most 1.62 s only when the two markers coincide, a handful of the longest names. At the default 1 s lead a call 1.5 s late starts half a second after the car reaches its marker, which is the latest a corner name is still "called as it starts"; any later and it names a corner the driver is already in, the #888 reason the corner names never replay late. It is the same figure as the clearance it replaces. A static bound rather than one scaled by the lead: `maxQueueWaitMs` is a contract constant, and a pack's longer clips are exactly what it exists to cut off.

The bound also tightens a pre-existing case: a corner name arriving while a lighter line plays (a `CHATTER` position call, say) already waited for it under the same "higher weight, no interrupt" rule, bounded only by the engine's 8 s default. It now drops after 1.5 s, as #888 intended.

### 3. The suppression goes, and with it `nextCornerInS`

Removed: the clearance clause of the sector contract's `where:` (sector one stays refused), `SECTOR_START_CORNER_CLEARANCE_S`, the `CornerCallWouldSpeakResolver` type and `cornerCallWouldSpeak` in `registerPitCrew`, and their exports. `buildSectorStartContract` takes no argument and becomes the constant `SECTOR_START_CONTRACT`.

`nextCornerInS` leaves the `sectorStart.approaching` payload. It existed only for the suppression; nothing else reads it (#1572's spec does not), and the bus is not read outside this repo, so a field kept for no consumer would only cost the translator an input: `diffSectorStart` stops taking the corner markers. This is an event-catalog change and makes the review `xhigh`. If #1573 has shipped in a stable release by then, the removal still stands, since no pack or setting reads a bus payload.

### 4. Other lines on the voice bus

Weights and families stay as #1573 left them: the sector call `WEIGHT.CHATTER`, `family: "sector-start"`, `frame: NO_FRAME`; the corner name `WEIGHT.NORMAL`, `family: "corner-name"`, not queueable. Consequences of the queueable sector call:

- **Heavier lines go first.** The queue plays heaviest first, so a flag, a spotter call or a lap-time call waiting beside a sector call plays before it; the sector call usually expires. A `SAFETY` or heavier line arriving while either call plays waits for it, as today.
- **Behind a line in flight, the sector call now waits.** A sector call arriving while a lap-time readout, a readback or a tire-wear line plays waits up to 1.5 s and plays after it if that line ends in time; #1573 dropped it.
- **Equal weight goes by age.** A `CHATTER` line arriving while the sector call waits plays after it, since ties go to the longest-waiting (`scheduler.ts:31-32`).
- **The spotter's focus floor.** Below the floor the sector call now waits (up to 1.5 s) instead of dropping, and plays if the floor lifts in time. The corner name below a floor is still dropped, as today.
- **The queue cap.** At four waiting fires the cap drops the lightest, then the oldest (`scheduler.ts:35-37`, `pending-queue.ts` cap-victim order): among `CHATTER` lines an older waiting one goes before a newer sector call, and a heavier waiting line is never the victim.
- **A cut sector call overruns the bound.** A heavier `interrupt` line that cuts "Sector three." mid-word stashes it (`stashRunningIfQueueable`, `scheduler.ts:601-621`), and `enqueue` (`scheduler.ts:513-536`) gives the stash a new `queuedAt`, the cut, so its 1.5 s runs again from there. The sector call is not `resumable`, so it replays whole, up to about 1 s (its clip) plus 1.5 s after it was due: at the default 1 s lead, about 1.5 s past the sector line rather than 0.5 s. It needs an interrupt line shorter than 1.5 s to happen at all, since a longer one outlasts the restarted wait. The fix belongs in the engine (Out of scope); until it lands, a cut sector call can arrive that late. The corner name is not queueable and is never stashed.
- **No pile-up.** Each contract's default `supersedeGroup` is its id, so a newer corner fire replaces a corner still waiting and a newer sector fire a waiting sector; neither family stacks.
- **A third line in flight when both come due.** If a line lighter than `NORMAL` is playing when both calls arrive, both wait and the queue plays the heavier corner name first, the sector call after it only if still inside its 1.5 s. Keeping track order there would need the corner name queueable with `queueBehind` on the sector contract, which changes how corner names behave behind every other line; not done (Out of scope).

### 5. The harness

"Sector start with a corner due" becomes a two-event shortcut: `precedingEvents: [sectorStart.approaching { sector: 3, sectorCount: 4 }]`, then `cornerName.approaching` Eau Rouge in the same publish, the worst case of decision 1 (a corner at the sector line). It plays "Sector three." then "Eau Rouge" straight after; with the corner names switched off it plays "Sector three." alone, where #1573 played it only then. A new "Corner then sector start" shortcut publishes the two the other way round and plays "Eau Rouge" then "Sector three.". The other sector shortcuts drop `nextCornerInS` from their data, as does the `event-names.ts` template; the block comment above them loses its 1.5 s clause.

### 6. Artifacts beyond the code

- `sim-events-iracing`: `diff/sector-start.ts` without the markers and `nextCornerInS`, its call site in `translator.ts`, the swapped rows in `tick-order.ts` and `tick-order.test.ts`, and the comment there that says the corner goes first.
- `event-bus`: the payload and its doc comment.
- `audio-scenarios`: `sector-start.ts` (contract, header comment), `corner-name.ts` (`maxQueueWaitMs`, the constant, its header comment), `pit-crew/index.ts`, the package `CLAUDE.md` line.
- Both voices' `callouts.json`: the sector entry's `comment` loses "a corner name due just past the start is spoken instead of the sector"; the archives are repacked and the pack records regenerated, with a `version` bump only if the record says the #1573 version was released.
- `pnpm generate:pack-reference` (the reference renders `queueable`).
- Website: the "Sector starts (practice & test)" paragraph on the Pit Crew page says both calls are heard, the second right after the first; the `1573-sector-start-calls.md` fragment is edited the same way while #1573 is unreleased, otherwise an `Improvements` fragment.
- `race-engineer-callout-examples.md`: the #1573 entry's "collision the translator measures and the catalog decides" is replaced by a #1676 note: two calls that may collide are ordered by publication and the existing queue, bounded by one `maxQueueWaitMs`.

## Approaches weighed and rejected

- **Keeping the suppression with a smaller clearance.** Still drops sector calls; Niklas wants both.
- **One combined line ("Sector three, Eau Rouge").** Rejected in #1573 for joining two opt-ins in one event or script, and it changes nothing about when each is heard.
- **The corner name cutting the sector call (`interrupt`) or sharing its family.** The corner would land on time and "Sector three." would be cut mid-word, the opposite of the decision.
- **Holding the corner fire in the translator until the sector line ends.** The translator would have to know clip lengths; the bus already waits for the line in flight.
- **A lag bound scaled by the corner call lead.** `maxQueueWaitMs` is static, and a dynamic one would need a new engine field for one pair of contracts.
- **Keeping `nextCornerInS` for a future consumer.** None is planned, and the translator would keep computing it.
- **The 8 s engine default as the bound.** A corner name 8 s late names a corner two or three corners back.

## Out of scope

- How either call behaves against other lines beyond the bound: the corner name stays non-queueable, and track order behind a third line in flight is not guaranteed (decision 4).
- The lead, the sweep, sector one, the clips and the opt-ins: all as #1573 and #888 left them.
- Any change to the engine's queue. The stash overrun in decision 4 is for a proposed issue: a stashed fire keeps its original due time for its max wait. That changes every queueable contract with a `maxQueueWaitMs`, so it is its own issue, and #1676 should follow it; until then a cut sector call can land past the bound.

## Testing

**Unit tests**, in `audio-scenarios`' `sector-start.test.ts` on the real scripts and the fake audio (a clip plays until the test ends it with `_triggerChannelEnd`), with fake timers:

- **Sector first:** publish the sector event, then Eau Rouge 0.3 s later while "Sector three." plays; end the sector clip; the corner clip plays next, and the sector clip was never stopped.
- **Corner first:** the same with the order reversed; "Sector three." plays after the name, which was never stopped.
- **Stale drop, with its positive control:** in the sector-first fixture, end the sector clip at 1.4 s and the corner plays; in the same fixture at 1.6 s nothing plays and the debug log names `waited`. The corner-first fixture is checked the same way for the sector call. The 1.4 s half is what proves the drop is the age and not something else in the fixture.
- **Behind other lines:** a sector call arriving while a lap-time line plays is heard after it when that line ends within 1.5 s, and dropped when it ends later; a `CHATTER` line arriving while the sector call waits plays after it.
- **No overlap unchanged:** each call on an idle bus starts at once, as today.
- **No suppression left:** a sector event with a corner due right after it speaks whether the corner names are on or off (the #1573 tests at 0.5 s and 1.5 s turn into this).
- **Bounds pinned:** both contracts carry `maxQueueWaitMs: MARKER_CALL_MAX_LAG_MS`, the sector contract `queueable: true`, the corner contract `queueable: false`.

In `sim-events-iracing`: `diff/sector-start.test.ts` and `translator-track-sectors.test.ts` without `nextCornerInS`; a tick whose swept interval holds a sector start and a corner marker publishes `sectorStart.approaching` before `cornerName.approaching`, and the same tick with the sector removed publishes the corner alone; `tick-order.test.ts` pins the swapped rows. `bundled-scripts.test.ts`, `harness-lists.test.ts`, the pack-record and pack-reference drift tests cover the rest.

**Harness:** "Sector start with a corner due" plays "Sector three." then "Eau Rouge" with no gap and nothing cut; "Corner then sector start" plays the reverse; the other sector shortcuts behave as before.

**Manual offline check**, in an Offline Testing session at Spa or Monza with the corner names on: where a named corner sits just past a sector start, "Sector N." lands at the sector line and the corner name follows straight after it; where a corner sits just before one, the name plays and the sector call follows it; elsewhere both keep their #1573 timing; nothing is cut mid-word.
