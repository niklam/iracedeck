# The caution lineup change, judged against the car last named

> **Issue:** [#1286](https://github.com/niklam/iracedeck/issues/1286) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

Under a full-course caution, "Change — you're behind car N" is spoken only when the car ahead differs from the car the engineer last told the driver about in this caution. The memory of that car lives in the caution contracts, recorded in the `speakGate` of each call that names the car, at the moment that call is certain to play. The change call leaves the `flag` family, drops one notch below it, and waits behind its caution siblings instead of competing with them for the pending slot, so it can no longer cut or evict the phase call it would duplicate. The hold before a change is decided grows from 1.5 s to 2 s.

The issue and its log comment describe four mechanisms: a follow car that flickers A → B → A and returns to the car already named; a re-form landing within a few ticks of a phase call that already names the new car, and cutting or evicting it through same-family preemption; the first lineup being provisional, so a change is spoken before the follow call has named anyone; and no memory of the last-named car at all. All four come from one fact: the change is judged against the previous pace-row reading, never against what was said.

## What counts as naming the car

Four contracts name the car ahead, in the reference voice's scripts: the follow call (`pit-crew.caution-follow`), two to green (`pit-crew.caution-field-caught`), one to go (`pit-crew.caution-one-to-go`) and the change call itself (`pit-crew.caution-lineup-changed`). Each records the lineup's `followCarIdx` (which is the pace car's index when the pace car is what is ahead) when its `speakGate` admits the fire and the lineup is readable. A refused gate records nothing, and neither does a gate that admits against an unreadable lineup; the previous record then stands.

The record is made in the gate and nowhere else, because the gate is the one place a claim may be committed (#1137): it runs after the script expanded and immediately before the ops take the bus, and a fire that finds the bus busy is parked unexpanded and meets the gate only when it replays. A `where:` record would mark a car named for a call that was later dropped, aborted or evicted.

The gate reads the same live lineup the script's vars read during the expansion it follows, so what is recorded is what was said.

## When the change call speaks

At speak time — on the first attempt that takes the bus, and again on every replay of a parked fire — the change call's gate admits only when all of these hold:

1. the caution is still out and the player still holds a pace row (today's `stillLinedUp`, unchanged);
2. there is a reference car for this caution (below);
3. the live `followCarIdx` differs from it.

On admission it records the car it names, like the other three.

**The reference car** is the last car named in this caution. Before anything has been named:

- **with the follow call switched on**, there is no reference and the change stays silent. The follow call is what answers "who do I follow" for this caution, and it reads the lineup live when it plays, so a reshuffle between the flag and that call is reported by the call itself. This is the provisional first lineup of the log comment ("Change — behind 76" and then "Line up behind 76").
- **with the follow call switched off**, the reference is the first readable lineup of the caution, read from the translator (below). The driver who switched the follow call off still hears the first genuine change, rather than nothing until two to green (maintainer ruling, 2026-09-30).

The gate reads the follow call's opt-in live through the `getCautionCalloutEnabled` resolver `registerPitCrew` already holds, passed into `buildCautionContracts`. It does not read whether the follow call actually played: an enabled follow call that is dropped (it loses the pending slot to the caution announcement by design) or refused leaves the change silent until two to green or one to go names the car.

### How that settles the four mechanisms

- **A → B → A.** The return to A is itself a `caution.lineup.changed` event, and a fresh event replaces the pending hold, so the decision is taken 2 s after the return and reads A — the car already named. Silent. Only a B leg that holds for the whole 2 s is decided on B; that car really was ahead, and the return is then a genuine change too. The road fixture's longest flicker is 1.07 s.
- **A change on top of a phase call.** The phase call reads the lineup live and records the new car when it plays; the change decided afterwards finds nothing new and drops. Its gate is asked before any bus take, so a refused change never cuts anything.
- **The provisional first lineup.** Nothing named yet, follow call on: silent.
- **No memory.** The reference is the named car, so 37 → 85 → 37 is spoken where each leg was a genuine change, and the "Change — behind 37" that duplicated two to green 171 ms earlier is not.

The `oneToGoAt` stand-down in the change call's `where:` is deleted. The one-to-go call records the re-formed car when it plays, which is the same answer from the thing that was actually said, and it holds on either side of the flag — the log comment found the re-form emitted after one to go at both one-to-go calls, where the stand-down never applied. The documented behaviour with the one-to-go call switched OFF is kept: its gate never runs, nothing is recorded, and the re-form change speaks its lane and car.

## Scheduling

The change call keeps `queueable: true` and loses `family: "flag"`, drops to `weight: WEIGHT.SAFETY - 1`, and declares `queueBehind` on the other caution contracts except the restart.

- **No family.** Same-family preemption replaces the in-flight fire before any weight comparison, which is how a change cut the two-to-green and one-to-go calls mid-sentence. Without the family, a change arriving while a phase call plays cannot cut it (lower weight, no `interrupt`); it parks and replays when the call ends, and its gate then finds the car already named.
- **One notch below.** The pending slot replaces on `weight >= pending.weight` without asking the arriving fire's gate. At equal weight a change evicted a waiting one-to-go call (01:21:33) even though it would have refused itself at replay. One notch below, it can never evict a waiting `SAFETY` call — the caution announcement included. This is the treatment the follow and position calls already have.
- **`queueBehind`.** One notch below also means a waiting change is evicted by any `SAFETY` sibling arriving, which loses it for good when that sibling names no car (pace car out, extra lap, pace car off), and ties it with the follow and position calls. Declaring the siblings in `queueBehind` (#1108) makes each pair play in order instead: the change attaches behind a waiting sibling, and a sibling arriving to wait is put back ahead of it. The restart is left out: it is `CRITICAL` with `interrupt`, and a change after the green is refused by the caution gate anyway.

A change still cannot cut anything, so a genuine change arriving mid-call is heard after it — the same wait every lower-priority caution line already has.

## The hold

`CAUTION_LINEUP_CHANGE_DELAY_MS` goes from 1500 to 2000 (maintainer ruling, 2026-09-30). The margin over the fixture's longest round trip (1.07 s) grows from 0.43 s to 0.93 s, at the cost of half a second on every genuine change — nothing against the minute a mid-caution reorder has before the green. Its role in the re-form case changes: it no longer has to outlast the gap to the one-to-go flag, since the memory settles that; it only coalesces a reshuffle into one decision.

## The episode, from the translator

The memory must be scoped to one caution. The audio module's state does not reset on a session change, and a car recorded in the last caution compared in the next one reproduces the provisional-lineup bug. The translator owns the episode, so it answers for it: one new accessor, `getCautionEpisode(): CautionEpisode | null`, `null` while no caution is out, otherwise:

- `id` — an identity that never repeats in the process (a module-level counter incremented as an episode begins, never reset by a session change, so an id from an earlier session cannot match a later one);
- `firstFollowCarIdx` — the first readable non-null `followCarIdx` of the episode: the reading `diffLineup` already treats as "the first lineup" and does not report. `null` until the lineup is readable.

The contracts record `{ episodeId, followCarIdx }` and treat a record from another episode as nothing named. `buildCautionContracts` takes the resolver as a new dependency beside `getCautionPhase` and `getCautionLineup`, wired the same way in the three plugins, the scenario harness and `registerPitCrew`'s defaults.

## Alternatives rejected

- **The memory in the translator.** It can move a baseline at each phase event it emits, but it cannot know whether the call spoke: switched off, dropped for a busy bus, or silent by design (two to green on a road course). Advancing the baseline anyway would silence the re-form change for a driver with the one-to-go call off, which #1127 deliberately made speak. What was said is the audio layer's fact.
- **A settle debounce in the translator instead of the gate.** It removes short round trips but still judges against a reading rather than against what was said, so it fixes none of the phase-call or provisional-lineup cases.
- **Keeping the change in the `flag` family and fixing only the gate.** The gate is not asked of a fire parked on a busy bus, so the eviction at 01:21:33 would remain, and a change deciding while its duplicate is still playing would still cut it through the family.
- **Seeding the reference from the first lineup whether or not the follow call is on.** That is the reported bug: the reshuffle after the flag was spoken as a change before the follow call named anyone.
- **Asking whether the follow call actually played, rather than whether it is switched on.** No event says a fire was dropped. The opt-in is the decision the driver made; the dropped-follow case is a residual below.

## Residuals

- **Recording follows the reference voice's scripts.** A pack whose one-to-go or two-to-green line does not name the car still records it, and a numbered clause dropped as optional (no clip for that car number) records a car the driver did not hear. The contract decides which moments count as naming; the pack decides the words.
- **Admitted and then cut still counts as named.** A call cut mid-sentence after its gate admitted it (by the restart, or by another `flag`-family call) may not have reached the number.
- **An enabled follow call that never plays** leaves change calls silent until two to green or one to go names a car.
- **The harness shortcut "Caution → lineup change"** swaps pace rows with no naming call before it, so with the follow call on it goes silent. Its sequence or description changes with this issue, so the button still demonstrates a spoken change.

## Out of scope

- Which calls are dropped "bus busy" during a caution burst (`incident-collision-car`, `damage-repair-needed` in the log) — the note on the issue says it is not this issue.
- The single pending slot itself (#1185), and the follow call losing that slot to the caution announcement.
- Any change to the translator's `caution.lineup.changed` emission: it still reports every change of the held follow car after the first lineup, and the payload is unchanged.
- The scripts' wording. No clip, var, condition or case is added.

## Testing

Suite:

- **The road fixture's round trips.** Replay the second caution of `__fixtures__/caution-road-20260918.json` through the translator into the real contracts with the reference script loaded, and assert that none of the 13 A → B → A round trips speaks a change naming the car already named — and, as the vacuity guard, that the fixture still carries 13 round trips and the translator still emits two `caution.lineup.changed` per trip.
- **One test per log row:** a change deciding while two to green is playing and naming the same car (01:20:23, 01:25:54) is silent and the two-to-green call plays out; a change deciding 165 ms after one to go, naming the same car (01:09:51), is silent; a change arriving while one to go waits in the pending slot does not evict it, and one to go plays (01:21:33).
- **The provisional lineup:** follow call on, a change before the follow call has played is silent, and the follow call then names the new car.
- **Follow call off:** the first change after the first readable lineup speaks, and a change back to the first lineup's car is silent.
- **A genuine change is still spoken**, and a B leg held past 2 s followed by the return speaks both.
- **Episode scoping:** a car recorded in one caution does not silence the first change of the next, including across a session change.
- **The translator accessor:** `id` differs between consecutive episodes and across a session reset, and `firstFollowCarIdx` is the first readable follow car, `null` before it.
- **Scheduling:** a change arriving during any caution sibling does not cut it, and a waiting change is played after a sibling that arrives, not dropped.
- **One to go switched off:** the re-form change still speaks.

By hand: the harness "Caution → lineup change" and "Caution → restart" buttons. In the sim, a full-course caution on an oval (the double-file re-form at one to go) and on a road course, listening for no "Change" after a call that already named that car, and for a change that is genuine still being heard.

## Affected artifacts

- `packages/audio-scenarios/src/catalog/pit-crew/caution.ts` + `caution.test.ts` (the contract changes, the recording gates, the new dependency, the hold, the module header's finding 2 rewritten), and `index.ts` (passing the episode resolver and the opt-in resolver).
- `packages/sim-events-iracing` — `getCautionEpisode` in `translator.ts`, the first-lineup field in `state.ts` (type and `createInitialState`), exports, tests.
- The three plugins' `plugin.ts` and `packages/scenario-harness/src/main.ts` (wiring), and the harness shortcut in `scenario-shortcuts.ts`.
- The generated pack reference (`pnpm generate:pack-reference`) — the change call's `description`, `weight` and `family` are published.
- `packages/website/src/content/docs/changelog.mdx` — a Bug Fixes line (shipped in 3.3.0), and the Pit Crew action page's caution section if it describes when the change call plays.
- `.claude/rules/race-engineer-callout-examples.md` — the #1127 entry gains the last-named rule.
