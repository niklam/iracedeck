# Issue #1211 — Incident and damage callouts wait for a held Voice bus

> **Issue:** [#1211](https://github.com/niklam/iracedeck/issues/1211) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The six `pit-crew.incident-*` contracts (`packages/audio-scenarios/src/catalog/pit-crew/incidents.ts`, `incidentContract` ~line 136) and `pit-crew.damage-repair-needed` (`damage-alerts.ts` ~line 22) run at the default `WEIGHT.NORMAL` and are not `queueable`. A fire that cannot take the Voice bus is therefore dropped, never parked, and it cannot take the bus in two common moments:

- **The spotter's focus floor.** While a car is alongside, `spotter-engine.ts` (`acquireFocus` ~line 330) holds a floor at `WEIGHT.SAFETY` on `AudioBus.Voice`. `attemptFire` (`interpreter.ts` ~line 1254) checks the floor first (~line 1276) and hands a lower-weight non-owner fire to `queueOrDrop` (~line 1363), which drops it unless `queueable`. A car collision nearly always happens with a car alongside, so the collision-car line is close to never heard. The issue's log shows two `collision-car` fires and a `damage-repair-needed` fire dropped "below focus floor (spotter)" within 1.5 s of the floor's release.
- **Any other line playing.** An equal-weight fire of another family meets the "bus busy" branch (~line 1337) and is dropped the same way. The issue comment's log shows two `collision-world` escalations lost behind a `damage-repair-needed` line and a `flag-furled` line. That is the #938 "correction" failing: an escalation replaces the earlier incident only through same-family preemption (~line 1289), which needs the earlier incident to be the line holding the bus.

The same log also shows that damage is detected before the incident is reported (14:54:14.520 damage raised, 14:54:15.157 report byte, 14:54:15.422 count +1, 14:54:16.934 flush), so naive queueing would announce "we need repairs" before the crash that caused it.

## How the engine schedules today (the parts this design leans on)

- One pending fire per bus (`BusState.pending`, ~line 413). `setPending` (~line 1401) keeps the highest weight; ties go to the newest (~line 1446: a newcomer is dropped only when `weight < current.weight`).
- `queueBehind` (#1108) sits ahead of the weight rule in `setPending`: a fire naming the pending fire attaches behind it as its follower, and a pending fire that names the arriving fire moves behind it. When an unrelated newcomer replaces the leader, the follower stays only if the newcomer is lighter than the follower (~line 1459, `weight >= follower.weight` drops it).
- Same-family preemption applies to the PLAYING fire only (~line 1289). The pending slot knows nothing of families.
- A parked fire replays through `drainPending` (~line 2062) when the bus idles or `releaseFocus` releases the floor (~line 1176). Its `where:` is not re-run. Its `speakGate` is asked at replay unless the fire already passed it (`admitted`, set for a fire an `interrupt` cut and `stashRunningIfQueueable` stashed, ~line 1487).
- `pendingHoldMs` (~line 2014) delays the drain after a finishing fire; it exists for trains of related fires (the pit-box count-in).

## Decisions

### 1. Incident contracts become `queueable`, with a speak-time age limit

All six incident contracts gain `queueable: true`. A fire below the floor or behind a busy bus parks and plays at idle, which in the issue's first log is about 1.5 s after the incident flush.

They also gain a `speakGate` that refuses a fire whose event is older than `INCIDENT_SPEAK_MAX_AGE_MS = 10 000` ms at speak time (`ctx.now - ctx.event.timestamp`; an imperative fire with no event is admitted, which keeps the harness test buttons working). The age is measured from the envelope timestamp, which is the translator's flush tick, already about 1.5 s after the last count increment (`INCIDENT_BURST_QUIET_MS`). The gate is pure, so it needs no claim.

**Why 10 s.** It equals #1122's `INCIDENT_SEQUENCE_GAP_MS`, deliberately and for a reason of its own: past it, the incident chain the line belongs to has closed, so a new, unrelated incident can already have begun and a late line would be heard as describing it. It is its own constant rather than an import, because the two answer different questions and may later diverge. What would set the value properly: over a few race sessions with debug logging on, the distribution of time between `Scenario "pit-crew.incident-…" pending` and `Replaying pending scenario` (how long floors and busy lines actually hold an incident), plus a listening check of how late an incident line can arrive before it reads as a new one.

**One accepted gap.** An incident line that started playing and was then cut by an `interrupt` (a spotter call cuts it at `WEIGHT.PROXIMITY`) is stashed with `admitted: true` and replays whole without asking the gate (`PendingFire.admitted`, `dsl.ts` `SpeakGate` doc). A floor held for a long time after such a cut could replay it older than 10 s. Accepted: the driver already heard the line begin, and making the engine re-ask pure gates on an admitted replay is a change to the #1138 contract that this issue does not need.

**`pendingHoldMs` does not apply.** It spaces the drain after a train of related fires; incidents are not a train, and the burst coalescing in the translator already merges a crash into one emission.

**Rejected:** staying non-queueable (the bug); `queueable` without an age limit (a floor held through a long side-by-side battle would deliver a line about a moment long gone); a `where:`-time age check (the fire is fresh at `where:` by construction; the staleness only arises while parked).

### 2. The weight stays `WEIGHT.NORMAL`; the one-slot limit stays #1185's

A parked incident shares the one pending slot with every other queueable Voice fire:

- Lighter fires (CHATTER readouts and readbacks, pit-box 30, pit-status repeats 40) never displace it.
- Heavier queueable fires do: the SAFETY flags that queue (black, meatball, DQ, furled, white-last-lap, yellow-cleared, furled-cleared), the SAFETY fuel tiers, opponent-pit and pit-window at 65. A penalty flag superseding the incident that led to it is the right precedence. Losing an incident to an opponent-pit call is not ideal, but raising the incident weight would only move the loss onto the opponent-pit or pit-window line it then outranks.
- Equal-weight NORMAL queueables replace it (ties go to the newest): gap-threshold, the NORMAL fuel tiers (4–10 laps, at S/F), tire-wear. Gap and overtake are already gated off after a recent incident (`gaps.ts` descriptions, `overtake-gate.ts`), so in practice this is a crash right at S/F meeting a fuel line.

**Rejected:** raising incidents above NORMAL (e.g. 66) — it drops parked pit-window and opponent-pit lines instead, changes the published weight in the pack reference, and buys nothing against the SAFETY flags. **Rejected:** `WEIGHT.SAFETY` or higher — at or above the floor the incident breaks through (~line 1276) and talks during the alongside moment the floor exists to protect. Displacement by a heavier or equal fire is the engine's single-slot limit, which #1185 owns; this issue does not pre-empt that design.

### 3. Escalation replaces a parked incident; it does not queue a second one

- **Playing earlier incident:** unchanged. The same-family rule (~line 1289) replaces it wholesale.
- **Parked earlier incident:** the escalation replaces it in the slot. This already follows from the tie rule, because all six contracts share one weight; the incidents header already demands that uniformity for the `lastIncidentPoints` stash to stay in lockstep with the fire. A test pins it. Keeping both was rejected: the later emission carries the corrected points (#938), the earlier line would say something the later one supersedes, and it would be inconsistent with what happens when the earlier line is playing.
- **Floor held while an earlier incident is playing:** the floor check runs before the family check, so an escalation arriving then parks rather than replacing the playing line. It cannot arise in practice: the floor is raised by the spotter's transition call, which cuts the playing incident (`WEIGHT.PROXIMITY` + `interrupt`); with the incident now `queueable` the cut line is stashed, and the escalation then replaces the stash in the slot as above.
- **Order inside the `where:`** is unchanged in spirit: every refusal (the type check, and the qualifying yield in §4) stays BEFORE the `lastIncidentPoints` write, so a refused fire cannot overwrite a parked fire's count.

### 4. In qualifying, the incident line yields to the lap-invalidation line for the same burst

Depends on #1122 §5 (branch `fix/1122-incident-type-bound`, not yet on `master`): the qualifying contract fires on `incident.scored`, published before `incident.occurred` on the same flush, and wins an idle bus that way. Once incidents queue, that race stops protecting anything. On a busy bus the incident parks and plays after the qualifying line, a double-up that #567 ruled out ("the lap-status news supersedes generic coaching"). Under a floor the qualifying line, which is not queueable, is dropped, while the incident parks and plays alone. That inverts the precedence.

Decision, in three parts:

- **The incident refuses at event time when the qualifying callout approved the same burst.** The qualifying `where:` records the `timestamp` of the `incident.scored` envelope it approved. The incident `where:` refuses an `incident.occurred` whose `timestamp` equals it. Both envelopes come from one `publish(…, now)` loop over the tick's pending emits (`translator.ts` `publish`, ~line 2166 on the #1122 branch), so equal timestamps mean the same flush, and no other flush can share a tick. A read of a stash another contract's `where:` wrote is the shape #1137 allows; the refusal sits before the points stash write.
- **The qualifying contract becomes `queueable`,** so an approved qualifying line survives the floor and the busy bus it has made the incident yield to. Its gate was already built for parking: the per-envelope `WeakMap` exists because "a fire parked as pending … can be overtaken" (`qualifying-invalidation.ts` ~line 110).
- **The qualifying gate also refuses once the driver has left the approved lap** (the live `getSnapshot()` `sessionNum` or `lapCompleted` differs from the stashed one). A parked "this lap will be invalidated" replaying on the next lap would be false, and its laps-left tail, read live, would be off by one. That burst is then silent, which is accepted: it takes a floor held across S/F.

Accepted edge: two bursts on one flying lap while the first qualifying fire is still parked. The second approval replaces the first in the slot (equal weight), both incidents yielded, and one lap-invalidation line plays. That line is the per-lap design, and the generic coaching for the second burst is the only loss.

**Rejected:** `queueBehind` from incident to qualifying, which plays both lines, the double-up itself. **Rejected:** an incident `speakGate` asking whether the qualifying line spoke. The gate runs at speak time and cannot see a qualifying fire the engine dropped, and without a queueable qualifying contract that is the common case. **Rejected:** accepting the inversion. It turns the lost qualifying line under a floor into a wrong line.

### 5. Damage: the incident line first, then the damage line, both queueable (Niklas, 2026-09-24)

**Niklas decided (2026-09-24):** when a crash produces both, the incident line plays first and the damage-repair line after it, and both are queueable. The design question left is the ordering mechanism. The damage edge can settle BEFORE the incident is even reported (the 14:54 log: damage raised 2.4 s before the flush), because `DAMAGE_DEBOUNCE_MS` (3000 ms, `sim-events-iracing/src/diff/damage.ts`) runs from the repair bit rising, while the incident waits for its count increment and then `INCIDENT_BURST_QUIET_MS` (1500 ms; `INCIDENT_BURST_MAX_MS` 3000 ms caps a burst).

Four parts:

- **The translator holds the damage emit behind an incident burst.** When the damage debounce settles on a rising edge, `diffDamage` records it as pending instead of emitting. It emits on the first tick where no incident burst is open (`state.incidentBurstFirstAt === 0`) AND either `DAMAGE_INCIDENT_GRACE_MS` (2000 ms) has passed since the settle or a burst opened and flushed since the settle. `diffIncidents` runs before `diffDamage` in the tick (`translator.ts` ~line 1900), so on a flush tick the order of the emits is `incident.scored`, `incident.occurred`, `damage.repairNeeded.raised`, all on one tick with no timer. A repair bit that falls while the emit is held cancels it, as the falling edge already resets the baseline. The held state resets with the rest of the translator state. The hold is bounded by grace + `INCIDENT_BURST_MAX_MS`, about 5 s. In the 14:54 log the count moved 0.9 s after the damage settled, inside the grace, so the damage line would have followed the collision-world flush.
- **Damage becomes `queueable` with `queueBehind` naming the six incident ids and the qualifying id.** When the bus is held, the incident (published first on the tick) parks, and the damage attaches behind it rather than replacing it on the equal-weight tie (`setPending`, ~line 1419). The reverse relation covers a damage line parked alone (released by the grace, no incident) when an incident flush arrives: the damage line moves behind it (~line 1430). No `speakGate`: the repair bit clears only in the pit stall, so the news stays true for as long as it can be parked.
- **Engine refinement: a follower that names the newcomer stays behind it.** In `setPending`'s replacement branch (~line 1455), a follower whose `queueBehind` names the ARRIVING fire's id is kept behind the newcomer whatever the weights. Without it, §3's escalation (off-track parked, damage behind it, collision-world arrives) drops the damage line, since equal weight fails the `weight < follower.weight` survival test. This holds the #1108 relation to its stated meaning ("a fire whose contract names the waiting fire attaches behind it") across a replacement. It changes nothing for the one existing pair: tire-wear (NORMAL) already outweighs a replacing exit readback (CHATTER). The `queueBehind` doc in `dsl.ts` and the interpreter header gain the sentence.
- **Residual:** a crash whose count moves more than the grace after the damage settles gets the damage line first, with the incident line after it (parked behind the playing damage line, or moved ahead of a parked one by the reverse relation). What would set the grace: across damaging crashes in the `local/telemetry-watch-*.jsonl` captures and new ones, the offset from the damage settle (repair bit rise + 3 s) to the first count increment of the same crash. The single observation (0.9 s) is why 2 s rather than 1 s.

**Rejected:** a fixed delay on the damage line alone, which loses whenever a burst outlasts it (a burst can run to `INCIDENT_BURST_MAX_MS` after an increment that itself lags the settle). **Rejected:** the engine relation alone (`queueBehind` without the translator hold). On an idle bus the damage line plays the moment it is published, and the incident then parks behind the playing line: damage first, the order Niklas ruled out. **Rejected:** raising damage to weight 51 so the follower survives a replacement. It works by accident of numbers, publishes a weight change, and makes damage displace equal-band parked lines; the refinement states the actual rule.

### 6. Scenario harness

Two translator-driven `telemetrySequence` shortcuts (the #1127 shape) under the Incidents category, because the thing to hear is the engine's ordering after the translator's decisions, which a bus-event shortcut steps over:

- **Collision during a spotter call:** set the radar field the radar diff reads to a car alongside (the spotter acquires its floor), set the report byte and move `PlayerCarMyIncidentCount` +4 with a `collision-car` byte, raise the repair bits in `EngineWarnings`, hold past the burst quiet window and the damage debounce, then clear the car. Expected: spotter call, "clear", then the collision-car line, then the damage line.
- **Escalation while another line plays** (the 14:54 repro): an off-track +1, then the repair bits, then a `collision-world` byte and +1 about 4 s after the first increment. Expected: the off-track line, the collision-world line with the corrected points, then the damage line. Neither incident is dropped.

A third, qualifying variant (the same collision during a spotter call with a qualifying snapshot posted first) confirms the lap-invalidation line plays after "clear" and the incident line does not. The #1122 branch adds `incident.scored` to `event-names.ts`; nothing new is needed there.

## Confirmed by Niklas (2026-09-24)

Four choices this spec made on its own were put to Niklas and confirmed as written: the qualifying lap-invalidation contract becomes queueable inside #1211 (§4); the incident speak-time age limit is 10 s (§1); a damage line with no incident burst open waits the 2 s grace (§5); and a lap-invalidation line still parked when the driver crosses start/finish is dropped rather than spoken on the next lap (§4). The remaining loss — a parked incident displaced by an opponent-pit, pit-window or NORMAL fuel line during the hold — stays #1185's.

## Artifacts beyond the code

- `incidents.ts`, `damage-alerts.ts`, `qualifying-invalidation.ts` headers and the `registerPitCrew` comment block in `index.ts`: scheduling paragraphs rewritten, since each describes the drop this removes.
- Contract `description`s: damage gains "after any incident being reported at that moment" (or similar), and `pnpm generate:pack-reference` regenerates `packages/website/src/data/pack-reference.json` (queueability and the new gates appear there).
- `dsl.ts` `queueBehind` doc and the interpreter header for the §5 refinement. `.claude/rules/race-engineer-callouts.md` (4a scheduling list) and an entry in `race-engineer-callout-examples.md`.
- `sim-events-iracing` `diff/damage.ts` header (the hold) and `state.ts` (the held fields).
- Website Pit Crew page where it describes incident or damage timing; changelog: one **Bug Fixes** line (incidents shipped in earlier releases).

## Out of scope

- The single pending slot itself: a bounded queue, and displacement by heavier or equal queueable fires (§2), belong to #1185.
- Re-asking a pure `speakGate` on an admitted replay (§1's accepted gap).
- The Contact (wall) and Contact (car) callouts, silenced by #1122; their redesign is #1122's follow-up.
- The spotter floor's weight and duration, and whether the floor should hold at all when the spotter has nothing to say.
- Opponent incidents, burst cadence constants, and incident or damage wording.

## Testing

Unit, `packages/audio-scenarios`:

- Interpreter: `setPending` keeps a follower that names the replacing newcomer, at equal and at greater newcomer weight; a follower that does not name it keeps today's weight rule; the tire-wear pair's existing tests stay green.
- Incidents: a collision-car fire below the spotter floor parks and plays on `releaseFocus`; a fire behind a playing equal-weight line of another family (damage, furled flag) parks and plays after it; an escalation replaces a parked off-track and speaks the escalation's points; a fire older than `INCIDENT_SPEAK_MAX_AGE_MS` at replay is refused and stamps no cooldown; an imperative `fire()` is admitted.
- Damage behind incident: off-track parked with damage attached, collision-world arrives, and the replay order is collision-world then damage; damage parked alone, and an incident arriving moves ahead of it.
- Qualifying: `incident.scored` then `incident.occurred` on one timestamp under the spotter floor gives one lap-invalidation line after release and no incident line; on an out-lap the incident plays; a parked qualifying fire replaying after `lapCompleted` advanced is refused.

Unit, `packages/sim-events-iracing` `diff/damage.test.ts`:

- A damage settle with no incident emits after `DAMAGE_INCIDENT_GRACE_MS`.
- A settle during an open burst emits on the flush tick, after `incident.scored` and `incident.occurred` in the same tick's emits.
- A burst opening inside the grace (the 14:54 timings replayed) holds the emit to that burst's flush.
- A repair bit falling while held emits nothing.

Harness: the §6 shortcuts get a `scenario-shortcuts.test.ts` entry driving the translator.

Manual, with debug logging on: in an AI race, crash into a car alongside and confirm the log shows `pending — deferred (below focus floor (spotter))` for the incident and then a replay after `Focus released`, and that the engineer says the incident, then the damage. Go off track into a wall and confirm the escalation plays with the corrected points. In an open qualifying session, crash with a car alongside on a flying lap and confirm only the lap-invalidation line plays.
